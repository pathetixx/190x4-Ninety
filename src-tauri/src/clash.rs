// Thin client for the sing-box clash API on 127.0.0.1.
// Goes through Rust to avoid WebView2 CORS restrictions.

use serde_json::Value;
use std::sync::OnceLock;

const MAX_IP_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_CLASH_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

// clash API secret: generated once per process lifetime, injected into
// the sing-box config (vpn::harden_config) and sent with every request as
// Bearer. Without it any local process could drive the core through 9090
// (switch node, read config, statistics). 127.0.0.1 + the secret close this off.
pub fn clash_secret() -> &'static str {
    static SECRET: OnceLock<String> = OnceLock::new();
    SECRET.get_or_init(|| {
        use rand_core::RngCore;
        let mut b = [0u8; 16];
        rand_core::OsRng.fill_bytes(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect()
    })
}

// ── Public IP info (through the proxy, if active) ────────────
// Returns a normalized {ip, country, country_code, asn, connection:{asn},
// success}. A single provider is a single point of failure (free-tier limits, reachability
// from a particular exit): we try several, each with its own response format,
// and reduce them to a common shape. The frontend (ip-info.js) and localAsn read exactly these fields.
// All endpoints are HTTPS: fetch_public_ip is also called directly (localAsn, bypassing
// the tunnel), and plaintext HTTP there would let the ISP/TSPU see and spoof the IP lookup.
// ip-api.com is deliberately NOT in the pool — it only has an http endpoint (https is
// paid), and plaintext is unacceptable here. Its format (query/as/countryCode) is still
// parsed in normalize_ip/extract_asn: it is a fallback in case it comes back and is
// covered by unit tests (normalize_ipapi_com) — the branch itself never fires in production.
const IP_PROVIDERS: &[&str] = &[
    "https://ipwho.is/",
    "https://api.ip.sb/geoip",
    "https://ipapi.co/json/",
];

// Extracts the ASN number from any provider format: ipwho.is — connection.asn
// (number); ipapi.co — "asn":"AS13335"; ip-api.com — "as":"AS13335 Cloudflare".
fn extract_asn(v: &Value) -> Value {
    if let Some(a) = v.get("connection").and_then(|c| c.get("asn")) {
        if a.is_number() || a.is_string() {
            return a.clone();
        }
    }
    for key in ["asn", "as"] {
        let Some(val) = v.get(key) else { continue };
        // Numeric ASN (api.ip.sb: "asn":13335) is taken as is; a string one
        // ("AS13335"/"AS13335 Cloudflare") has its digits pulled out.
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

// Reduces a specific provider's response to a common shape. None — the provider explicitly
// signals failure (ipwho success:false, ip-api status:"fail") or there is no IP →
// try the next one.
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
    // Full country name: ipapi.co puts it in country_name, the rest in country.
    let country = v
        .get("country_name")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("country").and_then(|x| x.as_str()))
        .unwrap_or("");
    // 2-letter code: ipwho — country_code, ip-api — countryCode, ipapi.co —
    // country (there, country is exactly the code).
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
    let mut b = crate::util::direct_client_builder()
        .user_agent("Ninety/0.1")
        // connect_timeout separate from the overall one: an unreachable provider drops off
        // after 3 s instead of eating the whole request budget.
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

    // Staggered race: the priority provider starts immediately, each next one
    // — after STAGGER_MS (it only gets a chance if the previous ones are silent). The first
    // response that normalizes wins; the remaining futures are dropped together with
    // the stream — their requests are cancelled. The old join_all hit ALL three endpoints
    // on every call (one GEO service every 5 minutes of a session — extra
    // metadata for third parties) and waited for the slowest one even when the first
    // answered instantly.
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
    Err(crate::util::i18n_error("backend.ip.allProvidersDown"))
}

fn client() -> Result<reqwest::Client, String> {
    // One client per process (inside an Arc, clone is cheap): we don't recreate
    // the TLS config and connection pool on every UI request to the clash API.
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = crate::util::direct_client_builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

// The latency test waits for the core as long as the caller asked, plus headroom for
// the response itself. The client's overall timeout (10 s) is shorter than a long group run:
// the request was cut off midway, and fresh latencies never reached the screen.
fn delay_request_timeout(timeout_ms: u32) -> std::time::Duration {
    std::time::Duration::from_millis(u64::from(timeout_ms) + 3_000)
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

/// The same link gate — for callers without `State` (the background WS stream).
///
/// 🔴 The kill switch state is deliberately NOT passed here. `validate_clash_snapshot`
/// reads only running/clashReady/clashPort, while `killswitch::is_active` with
/// a cold cache makes a synchronous RPC to the BFE service, holding the mutex with the WFP handles.
/// This path is called by async clash commands — on "refresh all pings" the frontend fires them
/// in a pool of 8, and each one blocked a tokio worker thread for the duration of the RPC.
pub(crate) fn validate_clash_port_ref(
    state: &crate::vpn::SingboxState,
    port: u16,
) -> Result<(), String> {
    // The source of truth is the in-memory RuntimeRecord in vpn.rs, not the last
    // singbox-current.json file: the file may stay behind after stop or vanish during
    // a live session. Serialization skips the private fields of RuntimeSnapshot.
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

// Where the connection actually went, judging by its chains. The chain carries the tags of all
// outbounds it passed through, so it is enough to check for the terminal ones:
// anything not rejected and not sent direct went through the proxy.
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

// Cumulative traffic since the core started: /connections returns uploadTotal/
// downloadTotal (bytes). Resets when sing-box restarts — accumulation across
// sessions is done by the frontend (traffic-meter.js, deltas in localStorage per source).
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

// Live connections bound to their process and outbound — for the routing rules
// monitor (what goes where right now: direct/through VPN/block). We return
// a compact list [{ process, processPath, host, destinationIP, outbound }];
// outbound is normalized to "direct"|"proxy"|"block" by chains (block — if the
// chain contains reject/block). processPath is filled because the config has
// a forcing process rule (buildRoute in singbox.js) — sing-box resolves
// socket→PID→exe for EVERY connection (route.go: processSearcher!=nil ⇒ resolve on
// every connect). process (the name) is derived here as the path's basename: the fork only returns
// processPath. If the process could not be determined (system socket, etc.) — process=null,
// the path is empty.
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
            // Process name. The core does NOT emit the
            // metadata.process field — clashapi/trafficontrol/tracker.go::MarshalJSON
            // returns ONLY processPath (the full path to the exe). So the name is derived
            // as the path's basename: C:\...\AyuGram.exe →
            // "AyuGram.exe". On Windows processPath is a clean path (ConnectionOwner
            // UserId=-1, no " (user)" suffix). If the core ever starts
            // sending process — we take it. rsplit on both separators — independent
            // of the build platform.
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
        .timeout(delay_request_timeout(t))
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
        .timeout(delay_request_timeout(t))
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let value = json_response("test_group", port, r).await?;
    if !value.is_object() {
        return Err(format!("test_group port={port}: invalid payload"));
    }
    Ok(value)
}

// Switches the active node of a Selector group.
// PUT /proxies/{group}  body: {"name": "<node-tag>"}
// In the sing-box clash API this only works for Selector (not URLTest).
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

// Tears down live proxy connections — the second half of a node switch.
//
// PUT /proxies/{group} only decides where NEW connections go. Tearing down
// the old ones was supposed to be interrupt_exist_connections on the selector, but in sing-box 1.13
// it does not fire for inbound traffic: Selector.NewConnectionEx hands
// the connection straight to the selected outbound, bypassing its own interrupt group, and
// that group stays empty. So the browser's keep-alive keeps flowing through the previous
// node, and the external IP doesn't change until the core reconnects.
//
// We close connections individually by id rather than with a single DELETE /connections: that one also tears down
// direct connections (in Ninety that is split tunneling, e.g. a Discord call) and
// additionally calls router.ResetNetwork(). Switching the exit node is no reason to touch
// what never went through it.
//
// Returns the number of closed connections. A connection that vanished between the snapshot and DELETE
// (closed on its own) is not an error — the goal is already achieved.
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
        // ipapi.co: country=code, country_name=full name, asn="AS15169"
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
        // api.ip.sb/geoip: country_code + numeric asn at the top level.
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
