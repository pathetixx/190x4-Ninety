from pathlib import Path

p = Path("src-tauri/src/clash.rs")
s = p.read_text()
s = s.replace(
    "const MAX_IP_RESPONSE_BYTES: usize = 64 * 1024;\n",
    "const MAX_IP_RESPONSE_BYTES: usize = 64 * 1024;\nconst MAX_CLASH_RESPONSE_BYTES: usize = 4 * 1024 * 1024;\n",
    1,
)
old = '''fn base(port: u16) -> String {
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
'''
new = '''fn base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn clash_port_from_config(raw: &str) -> Option<u16> {
    serde_json::from_str::<Value>(raw)
        .ok()?
        .pointer("/experimental/clash_api/external_controller")?
        .as_str()?
        .rsplit(':')
        .next()?
        .parse()
        .ok()
}

fn configured_clash_port(app: &tauri::AppHandle) -> Result<u16, String> {
    let path = crate::app_paths::config_dir(app)?.join("singbox-current.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Clash API runtime config unavailable: {e}"))?;
    clash_port_from_config(&raw).ok_or_else(|| "Clash API port missing in runtime config".into())
}

fn validate_clash_port(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    let active = configured_clash_port(app)?;
    if active == port {
        Ok(())
    } else {
        Err(format!("Clash API port mismatch: active={active}, requested={port}"))
    }
}

async fn json_response(
    operation: &str,
    port: u16,
    response: reqwest::Response,
) -> Result<Value, String> {
    let status = response.status();
    let body = crate::util::read_response_capped(
        response,
        MAX_CLASH_RESPONSE_BYTES,
        "Clash API",
    )
    .await?;
    if !status.is_success() {
        let text = String::from_utf8_lossy(&body);
        return Err(format!("{operation} port={port}: HTTP {status}: {text}"));
    }
    serde_json::from_slice::<Value>(&body)
        .map_err(|e| format!("{operation} port={port}: decode: {e}"))
}
'''
assert old in s
s = s.replace(old, new, 1)
old = '''#[tauri::command]
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
'''
new = '''pub(crate) async fn clash_get_proxies_unchecked(port: u16) -> Result<Value, String> {
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

#[tauri::command]
pub async fn clash_get_proxies(app: tauri::AppHandle, port: u16) -> Result<Value, String> {
    validate_clash_port(&app, port)?;
    clash_get_proxies_unchecked(port).await
}
'''
assert old in s
s = s.replace(old, new, 1)
replacements = {
'''pub async fn clash_traffic_total(port: u16) -> Result<Value, String> {
    let c = client()?;''': '''pub async fn clash_traffic_total(
    app: tauri::AppHandle,
    port: u16,
) -> Result<Value, String> {
    validate_clash_port(&app, port)?;
    let c = client()?;''',
'''pub async fn clash_get_connections(port: u16) -> Result<Value, String> {
    let c = client()?;''': '''pub async fn clash_get_connections(
    app: tauri::AppHandle,
    port: u16,
) -> Result<Value, String> {
    validate_clash_port(&app, port)?;
    let c = client()?;''',
'''pub async fn clash_test_node(
    port: u16,
    name: String,''': '''pub async fn clash_test_node(
    app: tauri::AppHandle,
    port: u16,
    name: String,''',
'''pub async fn clash_test_group(
    port: u16,
    group: String,''': '''pub async fn clash_test_group(
    app: tauri::AppHandle,
    port: u16,
    group: String,''',
'''pub async fn clash_select_proxy(port: u16, group: String, name: String) -> Result<(), String> {
    let c = client()?;''': '''pub async fn clash_select_proxy(
    app: tauri::AppHandle,
    port: u16,
    group: String,
    name: String,
) -> Result<(), String> {
    validate_clash_port(&app, port)?;
    let c = client()?;''',
}
for old, new in replacements.items():
    assert old in s, old
    s = s.replace(old, new, 1)
needle = '''    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    let c = client()?;'''
replacement = '''    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    validate_clash_port(&app, port)?;
    let c = client()?;'''
assert s.count(needle) == 2
s = s.replace(needle, replacement, 2)
old = '''    let status = r.status();
    if !status.is_success() {
        let text = r.text().await.unwrap_or_default();
        return Err(format!("select_proxy port={port}: HTTP {status}: {text}"));
    }
'''
new = '''    let status = r.status();
    if !status.is_success() {
        let body = crate::util::read_response_capped(
            r,
            MAX_CLASH_RESPONSE_BYTES,
            "Clash API",
        )
        .await?;
        let text = String::from_utf8_lossy(&body);
        return Err(format!("select_proxy port={port}: HTTP {status}: {text}"));
    }
'''
assert old in s
s = s.replace(old, new, 1)
test_anchor = '''mod tests {
    use super::*;
'''
tests = '''

    #[test]
    fn runtime_config_port_is_parsed_from_loopback_controller() {
        let raw = r#"{"experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}}}"#;
        assert_eq!(clash_port_from_config(raw), Some(9191));
        assert_eq!(clash_port_from_config("{}"), None);
        assert_eq!(clash_port_from_config("not-json"), None);
    }
'''
assert test_anchor in s
s = s.replace(test_anchor, test_anchor + tests, 1)
p.write_text(s)

p = Path("src-tauri/src/vpn.rs")
s = p.read_text()
old = "        match crate::clash::clash_get_proxies(port).await {"
new = "        match crate::clash::clash_get_proxies_unchecked(port).await {"
assert old in s
p.write_text(s.replace(old, new, 1))
