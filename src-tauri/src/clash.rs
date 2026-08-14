// Тонкий клиент к sing-box clash-API на 127.0.0.1.
// Через Rust, чтобы избежать CORS-ограничений WebView2.

use serde_json::Value;
use std::sync::OnceLock;

const MAX_IP_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_CLASH_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

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
                let response = c.get(url).send().await.ok()?;
                if !response.status().is_success() {
                    return None;
                }
                let body = crate::util::read_response_capped(
                    response,
                    MAX_IP_RESPONSE_BYTES,
                    "public IP provider",
                )
                .await
                .ok()?;
                let value = serde_json::from_slice::<Value>(&body).ok()?;
                normalize_ip(&value)
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

fn validate_clash_snapshot(snapshot: &Value, port: u16) -> Result<(), String> {
    if snapshot.get("running").and_then(Value::as_bool) != Some(true) {
        return Err("Clash API runtime is not running".into());
    }
    if snapshot.get("clashReady").and_then(Value::as_bool) != Some(true) {
        return Err("Clash API runtime is not ready".into());
    }
    let active = snapshot
        .get("clashPort")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .ok_or("Clash API port missing in live runtime")?;
    if active != port {
        return Err(format!(
            "Clash API port mismatch: active={active}, requested={port}"
        ));
    }
    Ok(())
}

fn validate_clash_port(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    port: u16,
) -> Result<(), String> {
    validate_clash_port_ref(&state, port)
}

/// Тот же гейт по ссылке — для вызывающих без `State` (фоновый WS-стрим).
///
/// 🔴 Состояние kill switch сюда НЕ передаётся намеренно. `validate_clash_snapshot`
/// читает только running/clashReady/clashPort, а `killswitch::is_active` при
/// холодном кэше делает синхронный RPC к службе BFE, держа мьютекс с WFP-хэндлами.
/// Этот путь зовут async-команды clash — при «обновить все пинги» фронт гонит их
/// пулом по 8 штук, и каждая блокировала worker-поток tokio на время RPC.
pub(crate) fn validate_clash_port_ref(
    state: &crate::vpn::SingboxState,
    port: u16,
) -> Result<(), String> {
    // Источник истины — RuntimeRecord в памяти vpn.rs, а не последний файл
    // singbox-current.json: файл может остаться после stop или исчезнуть при
    // живой сессии. Сериализация обходит приватные поля RuntimeSnapshot.
    let snapshot = serde_json::to_value(crate::vpn::runtime_snapshot_value(state, false))
        .map_err(|e| format!("Clash API runtime snapshot: {e}"))?;
    validate_clash_snapshot(&snapshot, port)
}

async fn json_response(
    operation: &str,
    port: u16,
    response: reqwest::Response,
) -> Result<Value, String> {
    let status = response.status();
    let body =
        crate::util::read_response_capped(response, MAX_CLASH_RESPONSE_BYTES, "Clash API").await?;
    if !status.is_success() {
        let text = String::from_utf8_lossy(&body);
        return Err(format!("{operation} port={port}: HTTP {status}: {text}"));
    }
    serde_json::from_slice::<Value>(&body)
        .map_err(|e| format!("{operation} port={port}: decode: {e}"))
}

fn process_name_value(process: &str, process_path: &str) -> Value {
    let name = if !process.is_empty() {
        process
    } else {
        process_path.rsplit(['\\', '/']).next().unwrap_or("")
    };
    if name.is_empty() {
        Value::Null
    } else {
        Value::String(name.to_string())
    }
}

// Куда соединение реально ушло, по его chains. Цепочка несёт теги всех
// пройденных outbound'ов, поэтому достаточно проверить наличие терминальных:
// всё, что не отвергнуто и не ушло напрямую, ушло через прокси.
fn connection_outbound(chains: Option<&Vec<Value>>) -> &'static str {
    let has = |tag: &str| {
        chains
            .map(|a| a.iter().any(|x| x.as_str() == Some(tag)))
            .unwrap_or(false)
    };
    if has("reject") || has("block") {
        "block"
    } else if has("direct") {
        "direct"
    } else {
        "proxy"
    }
}

pub(crate) async fn clash_get_proxies_unchecked(port: u16) -> Result<Value, String> {
    clash_get_proxies_unchecked_endpoint(&crate::vpn::ControlEndpoint {
        address: std::net::SocketAddr::from(([127, 0, 0, 1], port)),
    })
    .await
}

pub(crate) async fn clash_get_proxies_unchecked_endpoint(
    endpoint: &crate::vpn::ControlEndpoint,
) -> Result<Value, String> {
    let c = client()?;
    let r = c
        .get(format!("http://{}/proxies", endpoint.address))
        .bearer_auth(clash_secret())
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let value = json_response("get_proxies", endpoint.address.port(), r).await?;
    if !value.get("proxies").is_some_and(Value::is_object) {
        return Err(format!(
            "get_proxies port={}: invalid payload",
            endpoint.address.port()
        ));
    }
    Ok(value)
}

#[tauri::command]
pub async fn clash_get_proxies(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    port: u16,
) -> Result<Value, String> {
    validate_clash_port(state, port)?;
    clash_get_proxies_unchecked(port).await
}

// Кумулятивный трафик с момента старта ядра: /connections отдаёт uploadTotal/
// downloadTotal (байты). Сбрасывается при перезапуске sing-box — накопление между
// сессиями ведёт фронт (traffic-meter.js, дельты в localStorage per-source).
#[tauri::command]
pub async fn clash_traffic_total(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    port: u16,
) -> Result<Value, String> {
    validate_clash_port(state, port)?;
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
pub async fn clash_get_connections(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    port: u16,
) -> Result<Value, String> {
    validate_clash_port(state, port)?;
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
                    .map(|x| {
                        x.as_str()
                            .map(ToOwned::to_owned)
                            .or_else(|| x.as_u64().map(|value| value.to_string()))
                            .unwrap_or_default()
                    })
                    .unwrap_or_default()
            };
            // Имя процесса. Ядро НЕ эмитит поле
            // metadata.process — в clashapi/trafficontrol/tracker.go::MarshalJSON
            // отдаётся ТОЛЬКО processPath (полный путь к exe). Поэтому имя выводим
            // как basename пути: C:\...\AyuGram.exe →
            // "AyuGram.exe". На Windows processPath = чистый путь (ConnectionOwner
            // UserId=-1, без " (user)"-суффикса). Если ядро когда-нибудь начнёт
            // слать process — берём его. rsplit по обоим разделителям — не зависит
            // от платформы сборки.
            let process_path = field("processPath");
            let process = process_name_value(&field("process"), &process_path);
            let outbound = connection_outbound(conn.get("chains").and_then(|x| x.as_array()));
            out.push(serde_json::json!({
                "process": process,
                "processPath": process_path,
                "host": field("host"),
                "sourceIP": field("sourceIP"),
                "sourcePort": field("sourcePort"),
                "destinationIP": field("destinationIP"),
                "destinationPort": field("destinationPort"),
                "outbound": outbound,
            }));
        }
    }
    Ok(Value::Array(out))
}

#[tauri::command]
pub async fn clash_test_node(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    port: u16,
    name: String,
    url: Option<String>,
    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    validate_clash_port(state, port)?;
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
    state: tauri::State<'_, crate::vpn::SingboxState>,
    port: u16,
    group: String,
    url: Option<String>,
    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    validate_clash_port(state, port)?;
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
pub async fn clash_select_proxy(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    port: u16,
    group: String,
    name: String,
) -> Result<(), String> {
    validate_clash_port(state, port)?;
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
        let body =
            crate::util::read_response_capped(r, MAX_CLASH_RESPONSE_BYTES, "Clash API").await?;
        let text = String::from_utf8_lossy(&body);
        return Err(format!("select_proxy port={port}: HTTP {status}: {text}"));
    }
    Ok(())
}

// Разрыв живых прокси-соединений — вторая половина смены ноды.
//
// PUT /proxies/{group} решает только то, куда пойдут НОВЫЕ соединения. Рвать
// старые должен был interrupt_exist_connections на селекторе, но в sing-box 1.13
// для трафика из inbound он не срабатывает: Selector.NewConnectionEx отдаёт
// соединение сразу в выбранный outbound, минуя собственную interrupt-группу, и
// та остаётся пустой. Поэтому keep-alive браузера продолжает течь через прежнюю
// ноду, и внешний IP не меняется до реконнекта ядра.
//
// Закрываем адресно по id, а не одним DELETE /connections: тот рвёт заодно
// direct-соединения (у Ninety это split-tunnel, например звонок в Discord) и
// дополнительно делает router.ResetNetwork(). Смена exit-ноды не повод трогать
// то, что через неё и не шло.
//
// Возвращает число закрытых соединений. Пропавшее между снапшотом и DELETE
// соединение (закрылось само) ошибкой не считается — цель уже достигнута.
#[tauri::command]
pub async fn clash_close_proxy_connections(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    port: u16,
) -> Result<usize, String> {
    validate_clash_port(state, port)?;
    let c = client()?;
    let r = c
        .get(format!("{}/connections", base(port)))
        .bearer_auth(clash_secret())
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let v = json_response("close_proxy_connections", port, r).await?;
    let Some(conns) = v.get("connections").and_then(|x| x.as_array()) else {
        return Err(format!(
            "close_proxy_connections port={port}: connections missing"
        ));
    };
    let ids: Vec<String> = conns
        .iter()
        .filter(|conn| {
            connection_outbound(conn.get("chains").and_then(|x| x.as_array())) == "proxy"
        })
        .filter_map(|conn| {
            conn.get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect();
    let mut closed = 0usize;
    for id in ids {
        let path = format!("{}/connections/{}", base(port), urlencoding::encode(&id));
        let sent = c.delete(path).bearer_auth(clash_secret()).send().await;
        if sent.is_ok_and(|resp| resp.status().is_success()) {
            closed += 1;
        }
    }
    Ok(closed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_name_uses_process_path_basename_and_preserves_unknown() {
        assert_eq!(
            process_name_value("", r"C:\Apps\ChatGPT\ChatGPT.exe"),
            serde_json::json!("ChatGPT.exe")
        );
        assert_eq!(
            process_name_value("", "/opt/codex/codex.exe"),
            serde_json::json!("codex.exe")
        );
        assert_eq!(process_name_value("", ""), Value::Null);
        assert_eq!(
            process_name_value("explicit.exe", r"C:\ignored.exe"),
            serde_json::json!("explicit.exe")
        );
    }

    #[test]
    fn live_runtime_snapshot_controls_clash_port_access() {
        let ready = serde_json::json!({
            "running": true,
            "clashReady": true,
            "clashPort": 9191
        });
        assert!(validate_clash_snapshot(&ready, 9191).is_ok());
        assert!(validate_clash_snapshot(&ready, 9090).is_err());
        assert!(validate_clash_snapshot(
            &serde_json::json!({ "running": false, "clashReady": true, "clashPort": 9191 }),
            9191
        )
        .is_err());
        assert!(validate_clash_snapshot(
            &serde_json::json!({ "running": true, "clashReady": false, "clashPort": 9191 }),
            9191
        )
        .is_err());
    }

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
