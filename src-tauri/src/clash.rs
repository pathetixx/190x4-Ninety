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
// Возвращает нормализованный {ip, country, country_code, asn, connection:{asn},
// success}. Один провайдер — единая точка отказа (free-tier лимиты, досягаемость
// из-под конкретного exit): перебираем несколько, у каждого свой формат ответа,
// сводим к общему виду. Фронт (ip-info.js) и localAsn читают именно эти поля.
// Все эндпоинты — HTTPS: fetch_public_ip зовётся и напрямую (localAsn, мимо
// туннеля), plaintext-HTTP там дал бы ISP/ТСПУ видеть и подменять IP-lookup.
// ip-api.com в пул НЕ входит намеренно — у него только http-эндпоинт (https за
// платой), а plaintext здесь неприемлем. Его формат (query/as/countryCode) в
// normalize_ip/extract_asn всё же разобран: это резерв на случай возврата и
// покрыто юнит-тестами (normalize_ipapi_com) — сама ветка в проде не срабатывает.
const IP_PROVIDERS: &[&str] = &[
    "https://ipwho.is/",
    "https://api.ip.sb/geoip",
    "https://ipapi.co/json/",
];

// Достаёт номер ASN из любого формата провайдера: ipwho.is — connection.asn
// (число); ipapi.co — "asn":"AS13335"; ip-api.com — "as":"AS13335 Cloudflare".
fn extract_asn(v: &Value) -> Value {
    if let Some(a) = v.get("connection").and_then(|c| c.get("asn")) {
        if a.is_number() || a.is_string() {
            return a.clone();
        }
    }
    for key in ["asn", "as"] {
        let Some(val) = v.get(key) else { continue };
        // Числовой ASN (api.ip.sb: "asn":13335) — берём как есть; строковый
        // ("AS13335"/"AS13335 Cloudflare") — выдираем цифры.
        if val.is_number() {
            return val.clone();
        }
        if let Some(s) = val.as_str() {
            let digits: String = s
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(n) = digits.parse::<u64>() {
                return serde_json::json!(n);
            }
        }
    }
    Value::Null
}

// Сводит ответ конкретного провайдера к единому виду. None — провайдер явно
// сигналит неуспех (ipwho success:false, ip-api status:"fail") или нет IP →
// пробуем следующего.
fn normalize_ip(v: &Value) -> Option<Value> {
    if v.get("success").and_then(|x| x.as_bool()) == Some(false) {
        return None;
    }
    if v.get("status").and_then(|x| x.as_str()) == Some("fail") {
        return None;
    }
    let ip = v
        .get("ip")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("query").and_then(|x| x.as_str()))?;
    // Полное имя страны: ipapi.co кладёт его в country_name, остальные — в country.
    let country = v
        .get("country_name")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("country").and_then(|x| x.as_str()))
        .unwrap_or("");
    // 2-буквенный код: ipwho — country_code, ip-api — countryCode, ipapi.co —
    // country (там country это как раз код).
    let country_code = v
        .get("country_code")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("countryCode").and_then(|x| x.as_str()))
        .or_else(|| {
            v.get("country")
                .and_then(|x| x.as_str())
                .filter(|s| s.len() == 2)
        })
        .unwrap_or("");
    let asn = extract_asn(v);
    Some(serde_json::json!({
        "ip": ip,
        "country": country,
        "country_code": country_code,
        "asn": asn,
        "connection": { "asn": asn },
        "success": true,
    }))
}

#[tauri::command]
pub async fn fetch_public_ip(proxy: Option<String>) -> Result<Value, String> {
    let mut b = reqwest::Client::builder()
        .user_agent("Ninety/0.1")
        // connect_timeout отдельно от общего: недосягаемый провайдер отваливается
        // за 3с вместо того чтобы съесть весь бюджет запроса.
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(6));
    if let Some(p) = proxy {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            let pr = reqwest::Proxy::all(trimmed).map_err(|e| format!("proxy: {e}"))?;
            b = b.proxy(pr);
        }
    }
    let c = b.build().map_err(|e| format!("client: {e}"))?;

    // Ступенчатая гонка: приоритетный провайдер стартует сразу, каждый следующий
    // — через STAGGER_MS (успеет только если предыдущие молчат). Первый
    // нормализовавшийся ответ побеждает; остальные фьючи дропаются вместе со
    // стримом — их запросы отменяются. Прежний join_all бил ВСЕ три эндпоинта
    // на каждый вызов (по одному GEO-сервису каждые 5 минут сессии — лишние
    // метаданные третьим сторонам) и ждал самого медленного даже при мгновенном
    // ответе первого.
    use futures_util::StreamExt;
    const STAGGER_MS: u64 = 800;
    let mut requests: futures_util::stream::FuturesUnordered<_> = IP_PROVIDERS
        .iter()
        .enumerate()
        .map(|(i, &url)| {
            let c = c.clone();
            async move {
                tokio::time::sleep(std::time::Duration::from_millis(STAGGER_MS * i as u64)).await;
                let v = c.get(url).send().await.ok()?.json::<Value>().await.ok()?;
                normalize_ip(&v)
            }
        })
        .collect();
    while let Some(res) = requests.next().await {
        if let Some(v) = res {
            return Ok(v);
        }
    }
    Err("все провайдеры IP недоступны".to_string())
}

fn client() -> Result<reqwest::Client, String> {
    // Клиент один на процесс (внутри Arc, clone дешёвый): не пересоздаём
    // TLS-конфиг и пул соединений на каждый запрос UI к clash-API.
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

fn base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

async fn json_response(
    operation: &str,
    port: u16,
    response: reqwest::Response,
) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("{operation} port={port}: HTTP {status}: {body}"));
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("{operation} port={port}: decode: {e}"))
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
    let value = json_response("get_proxies", port, r).await?;
    if !value.get("proxies").is_some_and(Value::is_object) {
        return Err(format!("get_proxies port={port}: invalid payload"));
    }
    Ok(value)
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
    let v = json_response("traffic_total", port, r).await?;
    let up = v
        .get("uploadTotal")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| format!("traffic_total port={port}: uploadTotal missing"))?;
    let down = v
        .get("downloadTotal")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| format!("traffic_total port={port}: downloadTotal missing"))?;
    Ok(serde_json::json!({ "up": up, "down": down }))
}

// Живые соединения с привязкой к процессу и outbound'у — для монитора правил
// маршрутизации (что куда сейчас идёт: напрямую/через VPN/блок). Возвращаем
// компактный список [{ process, processPath, host, destinationIP, outbound }];
// outbound нормализован в "direct"|"proxy"|"block" по chains (block — если в
// цепочке reject/block). processPath заполняется, т.к. в конфиге есть
// форсирующее process-правило (buildRoute в singbox.js) — sing-box резолвит
// сокет→PID→exe у КАЖДОГО соединения (route.go: processSearcher!=nil ⇒ резолв на
// каждом коннекте). process (имя) выводим тут как basename пути: форк отдаёт лишь
// processPath. Если процесс не определился (системный сокет и т.п.) — process=null,
// путь пуст.
#[tauri::command]
pub async fn clash_get_connections(port: u16) -> Result<Value, String> {
    let c = client()?;
    let r = c
        .get(format!("{}/connections", base(port)))
        .bearer_auth(clash_secret())
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let v = json_response("get_connections", port, r).await?;
    if !v.get("connections").is_some_and(Value::is_array) {
        return Err(format!("get_connections port={port}: connections missing"));
    }
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
            // Имя процесса. Форк (hiddify-sing-box v1.13.0.h5) НЕ эмитит поле
            // metadata.process — в clashapi/trafficontrol/tracker.go::MarshalJSON
            // отдаётся ТОЛЬКО processPath (полный путь к exe). Поэтому имя выводим
            // как basename пути (как Throne/metacubexd): C:\...\AyuGram.exe →
            // "AyuGram.exe". На Windows processPath = чистый путь (ConnectionOwner
            // UserId=-1, без " (user)"-суффикса). Если форк когда-нибудь начнёт
            // слать process — берём его. rsplit по обоим разделителям — не зависит
            // от платформы сборки.
            let process_path = field("processPath");
            let process = {
                let direct = field("process");
                let name = if !direct.is_empty() {
                    direct
                } else {
                    process_path
                        .rsplit(['\\', '/'])
                        .next()
                        .unwrap_or("")
                        .to_string()
                };
                if name.is_empty() {
                    Value::Null
                } else {
                    Value::String(name)
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
                "processPath": process_path,
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
    let r = c
        .get(path)
        .bearer_auth(clash_secret())
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let value = json_response("test_node", port, r).await?;
    if !value.get("delay").is_some_and(Value::is_number) {
        return Err(format!("test_node port={port}: delay missing"));
    }
    Ok(value)
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
    let r = c
        .get(path)
        .bearer_auth(clash_secret())
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let value = json_response("test_group", port, r).await?;
    if !value.is_object() {
        return Err(format!("test_group port={port}: invalid payload"));
    }
    Ok(value)
}

// Переключение активной ноды Selector-группы.
// PUT /proxies/{group}  body: {"name": "<node-tag>"}
// В sing-box clash-API это работает только для Selector (не URLTest).
#[tauri::command]
pub async fn clash_select_proxy(port: u16, group: String, name: String) -> Result<(), String> {
    let c = client()?;
    let body = serde_json::json!({ "name": name });
    let path = format!("{}/proxies/{}", base(port), urlencoding::encode(&group));
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
        return Err(format!("select_proxy port={port}: HTTP {status}: {text}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_ipwho() {
        let v = serde_json::json!({
            "ip": "1.2.3.4", "success": true, "country": "Germany",
            "country_code": "DE", "connection": { "asn": 24940 }
        });
        let out = normalize_ip(&v).unwrap();
        assert_eq!(out["ip"], "1.2.3.4");
        assert_eq!(out["country_code"], "DE");
        assert_eq!(out["asn"], 24940);
        assert_eq!(out["connection"]["asn"], 24940);
    }

    #[test]
    fn normalize_ipapi_com() {
        // ip-api.com: query=ip, countryCode, as="AS13335 Cloudflare"
        let v = serde_json::json!({
            "status": "success", "query": "9.9.9.9", "country": "United States",
            "countryCode": "US", "as": "AS13335 Cloudflare, Inc."
        });
        let out = normalize_ip(&v).unwrap();
        assert_eq!(out["ip"], "9.9.9.9");
        assert_eq!(out["country_code"], "US");
        assert_eq!(out["asn"], 13335);
    }

    #[test]
    fn normalize_ipapi_co() {
        // ipapi.co: country=код, country_name=полное, asn="AS15169"
        let v = serde_json::json!({
            "ip": "8.8.8.8", "country": "US", "country_name": "United States",
            "asn": "AS15169"
        });
        let out = normalize_ip(&v).unwrap();
        assert_eq!(out["ip"], "8.8.8.8");
        assert_eq!(out["country"], "United States");
        assert_eq!(out["country_code"], "US");
        assert_eq!(out["asn"], 15169);
    }

    #[test]
    fn normalize_ip_sb() {
        // api.ip.sb/geoip: country_code + числовой asn на верхнем уровне.
        let v = serde_json::json!({
            "ip": "1.1.1.1", "country": "Australia",
            "country_code": "AU", "asn": 13335
        });
        let out = normalize_ip(&v).unwrap();
        assert_eq!(out["ip"], "1.1.1.1");
        assert_eq!(out["country_code"], "AU");
        assert_eq!(out["asn"], 13335);
        assert_eq!(out["connection"]["asn"], 13335);
    }

    #[test]
    fn normalize_rejects_failure() {
        assert!(normalize_ip(&serde_json::json!({ "success": false })).is_none());
        assert!(normalize_ip(&serde_json::json!({ "status": "fail" })).is_none());
        assert!(normalize_ip(&serde_json::json!({ "country": "X" })).is_none());
    }
}
