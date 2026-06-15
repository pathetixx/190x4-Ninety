// Тонкий клиент к sing-box clash-API на 127.0.0.1:9090.
// Через Rust, чтобы избежать CORS-ограничений WebView2.

use serde_json::Value;
use std::sync::OnceLock;

// Секрет clash-API: генерируется один раз за жизнь процесса, инжектится в
// конфиг sing-box (vpn::harden_config) и отправляется в каждом запросе как
// Bearer. Без него любой локальный процесс мог бы рулить ядром через 9090
// (смена ноды, чтение конфига, статистика). 127.0.0.1 + секрет закрывают это.
pub fn clash_secret() -> &'static str {
    static SECRET: OnceLock<String> = OnceLock::new();
    SECRET.get_or_init(|| {
        use rand_core::RngCore;
        let mut b = [0u8; 16];
        rand_core::OsRng.fill_bytes(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect()
    })
}

// ── Public IP info (через прокси, если активен) ────────────
// Возвращает то, что вернул ipwho.is — обычно содержит {ip, country, city, ...}.
#[tauri::command]
pub async fn fetch_public_ip(proxy: Option<String>) -> Result<Value, String> {
    let mut b = reqwest::Client::builder()
        .user_agent("Ninety/0.1")
        .timeout(std::time::Duration::from_secs(8));
    if let Some(p) = proxy {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            let pr = reqwest::Proxy::all(trimmed)
                .map_err(|e| format!("proxy: {e}"))?;
            b = b.proxy(pr);
        }
    }
    let c = b.build().map_err(|e| format!("client: {e}"))?;
    let r = c
        .get("https://ipwho.is/")
        .send()
        .await
        .map_err(|e| format!("req: {e}"))?;
    r.json::<Value>().await.map_err(|e| format!("json: {e}"))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client: {e}"))
}

fn base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[tauri::command]
pub async fn clash_get_proxies(port: u16) -> Result<Value, String> {
    let c = client()?;
    let r = c
        .get(format!("{}/proxies", base(port)))
        .bearer_auth(clash_secret())
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    r.json::<Value>().await.map_err(|e| format!("decode: {e}"))
}

// Кумулятивный трафик с момента старта ядра: /connections отдаёт uploadTotal/
// downloadTotal (байты). Сбрасывается при перезапуске sing-box — накопление между
// сессиями ведёт фронт (traffic-meter.js, дельты в localStorage per-source).
#[tauri::command]
pub async fn clash_traffic_total(port: u16) -> Result<Value, String> {
    let c = client()?;
    let r = c
        .get(format!("{}/connections", base(port)))
        .bearer_auth(clash_secret())
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let v = r.json::<Value>().await.map_err(|e| format!("decode: {e}"))?;
    let up = v.get("uploadTotal").and_then(|x| x.as_u64()).unwrap_or(0);
    let down = v.get("downloadTotal").and_then(|x| x.as_u64()).unwrap_or(0);
    Ok(serde_json::json!({ "up": up, "down": down }))
}

// Живые соединения с привязкой к процессу и outbound'у — для монитора правил
// маршрутизации (что куда сейчас идёт: напрямую/через VPN/блок). Возвращаем
// компактный список [{ process, processPath, host, destinationIP, outbound }];
// outbound нормализован в "direct"|"proxy"|"block" по chains (block — если в
// цепочке reject/block). metadata.process/processPath заполнены, т.к. в конфиге
// есть форсирующее process-правило (buildRoute в singbox.js) — sing-box резолвит
// процесс у каждого соединения. Если по какой-то причине процесс не определился
// (системный сокет и т.п.) — process=null, путь пуст.
#[tauri::command]
pub async fn clash_get_connections(port: u16) -> Result<Value, String> {
    let c = client()?;
    let r = c
        .get(format!("{}/connections", base(port)))
        .bearer_auth(clash_secret())
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let v = r.json::<Value>().await.map_err(|e| format!("decode: {e}"))?;
    let mut out = Vec::new();
    if let Some(conns) = v.get("connections").and_then(|x| x.as_array()) {
        for conn in conns {
            let md = conn.get("metadata");
            let field = |k: &str| {
                md.and_then(|m| m.get(k))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let process = {
                let p = field("process");
                if p.is_empty() {
                    Value::Null
                } else {
                    Value::String(p)
                }
            };
            let chains = conn.get("chains").and_then(|x| x.as_array());
            let has = |tag: &str| {
                chains
                    .map(|a| a.iter().any(|x| x.as_str() == Some(tag)))
                    .unwrap_or(false)
            };
            let outbound = if has("reject") || has("block") {
                "block"
            } else if has("direct") {
                "direct"
            } else {
                "proxy"
            };
            out.push(serde_json::json!({
                "process": process,
                "processPath": field("processPath"),
                "host": field("host"),
                "destinationIP": field("destinationIP"),
                "outbound": outbound,
            }));
        }
    }
    Ok(Value::Array(out))
}

#[tauri::command]
pub async fn clash_test_node(
    port: u16,
    name: String,
    url: Option<String>,
    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    let c = client()?;
    let test_url = url.unwrap_or_else(|| "https://www.gstatic.com/generate_204".to_string());
    let t = timeout_ms.unwrap_or(5000);
    let path = format!(
        "{}/proxies/{}/delay?url={}&timeout={}",
        base(port),
        urlencoding::encode(&name),
        urlencoding::encode(&test_url),
        t
    );
    let r = c.get(path).bearer_auth(clash_secret()).send().await.map_err(|e| format!("request: {e}"))?;
    r.json::<Value>().await.map_err(|e| format!("decode: {e}"))
}

#[tauri::command]
pub async fn clash_test_group(
    port: u16,
    group: String,
    url: Option<String>,
    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    let c = client()?;
    let test_url = url.unwrap_or_else(|| "https://www.gstatic.com/generate_204".to_string());
    let t = timeout_ms.unwrap_or(5000);
    let path = format!(
        "{}/group/{}/delay?url={}&timeout={}",
        base(port),
        urlencoding::encode(&group),
        urlencoding::encode(&test_url),
        t
    );
    let r = c.get(path).bearer_auth(clash_secret()).send().await.map_err(|e| format!("request: {e}"))?;
    r.json::<Value>().await.map_err(|e| format!("decode: {e}"))
}

// Переключение активной ноды Selector-группы.
// PUT /proxies/{group}  body: {"name": "<node-tag>"}
// В sing-box clash-API это работает только для Selector (не URLTest).
#[tauri::command]
pub async fn clash_select_proxy(
    port: u16,
    group: String,
    name: String,
) -> Result<(), String> {
    let c = client()?;
    let body = serde_json::json!({ "name": name });
    let path = format!(
        "{}/proxies/{}",
        base(port),
        urlencoding::encode(&group)
    );
    let r = c
        .put(path)
        .bearer_auth(clash_secret())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let status = r.status();
    if !status.is_success() {
        let text = r.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }
    Ok(())
}
