// Тонкий клиент к sing-box clash-API на 127.0.0.1:9090.
// Через Rust, чтобы избежать CORS-ограничений WebView2.

use serde_json::Value;

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
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    r.json::<Value>().await.map_err(|e| format!("decode: {e}"))
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
    let r = c.get(path).send().await.map_err(|e| format!("request: {e}"))?;
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
    let r = c.get(path).send().await.map_err(|e| format!("request: {e}"))?;
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
