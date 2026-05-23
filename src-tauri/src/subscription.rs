use base64::Engine;
use serde::Serialize;

#[derive(Serialize)]
pub struct SubscriptionInfo {
    pub body: String,
    pub upload: Option<u64>,
    pub download: Option<u64>,
    pub total: Option<u64>,
    pub expire: Option<u64>,
    pub profile_title: Option<String>,
    pub profile_update_interval_hours: Option<u32>,
    pub status: u16,
}

fn parse_userinfo(header: &str) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    let mut up = None;
    let mut down = None;
    let mut total = None;
    let mut expire = None;
    for part in header.split(';') {
        let p = part.trim();
        let Some(eq) = p.find('=') else { continue };
        let k = p[..eq].trim().to_ascii_lowercase();
        let v = p[eq + 1..].trim();
        let Ok(n) = v.parse::<u64>() else { continue };
        match k.as_str() {
            "upload" => up = Some(n),
            "download" => down = Some(n),
            "total" => total = Some(n),
            "expire" => expire = Some(n),
            _ => {}
        }
    }
    (up, down, total, expire)
}

fn decode_profile_title(raw: &str) -> Option<String> {
    let v = raw.trim();
    if v.is_empty() {
        return None;
    }
    if let Some(rest) = v.strip_prefix("base64:") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(rest.trim())
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(rest.trim()))
            .ok()?;
        return String::from_utf8(bytes).ok();
    }
    Some(v.to_string())
}

#[tauri::command]
pub async fn fetch_subscription(url: String) -> Result<SubscriptionInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("Ninety/0.1 (sing-box subscription)")
        .timeout(std::time::Duration::from_secs(20))
        .gzip(true)
        .build()
        .map_err(|e| format!("client: {e}"))?;

    let resp = client
        .get(&url)
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status().as_u16();

    let headers = resp.headers().clone();

    let body = resp
        .text()
        .await
        .map_err(|e| format!("body decode: {e}"))?;

    let (upload, download, total, expire) = headers
        .get("subscription-userinfo")
        .and_then(|v| v.to_str().ok())
        .map(parse_userinfo)
        .unwrap_or((None, None, None, None));

    let profile_title = headers
        .get("profile-title")
        .and_then(|v| v.to_str().ok())
        .and_then(decode_profile_title);

    let profile_update_interval_hours = headers
        .get("profile-update-interval")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u32>().ok());

    Ok(SubscriptionInfo {
        body,
        upload,
        download,
        total,
        expire,
        profile_title,
        profile_update_interval_hours,
        status,
    })
}
