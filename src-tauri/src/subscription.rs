use base64::Engine;
use serde::Serialize;

// Кап тела ответа: список серверов — десятки килобайт; гигабайтный ответ — это
// либо не подписка, либо злонамеренная панель, и глотать его в память нельзя.
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

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
    // ВАЖНО: User-Agent определяет ответ сервера. Многие подписочные
    // панели (sub-store, marzban, xo.e0f.cx и т.п.) отдают:
    //   - известным клиентам (v2rayN, ClashMeta) — plain/base64 vless-список,
    //   - неизвестным — JSON или HTML страницу логина.
    // Поэтому шлём проверенный v2rayN UA.
    let client = reqwest::Client::builder()
        .user_agent("v2rayN/6.42")
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

    if let Some(len) = resp.content_length() {
        if len > MAX_BODY_BYTES as u64 {
            return Err(format!("подписка больше {} МБ — это не список серверов", MAX_BODY_BYTES / 1024 / 1024));
        }
    }
    // Стримим с капом (Content-Length может отсутствовать или врать).
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("body read: {e}"))? {
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(format!("подписка больше {} МБ — это не список серверов", MAX_BODY_BYTES / 1024 / 1024));
        }
        buf.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&buf).to_string();

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_userinfo_full() {
        let (up, down, total, expire) =
            parse_userinfo("upload=123; download=456; total=789; expire=1700000000");
        assert_eq!(up, Some(123));
        assert_eq!(down, Some(456));
        assert_eq!(total, Some(789));
        assert_eq!(expire, Some(1_700_000_000));
    }

    #[test]
    fn parse_userinfo_partial_and_garbage() {
        let (up, down, total, expire) = parse_userinfo("download=42; junk; foo=bar; upload=abc");
        assert_eq!(up, None); // не число — пропущен
        assert_eq!(down, Some(42));
        assert_eq!(total, None);
        assert_eq!(expire, None);
    }

    #[test]
    fn decode_profile_title_plain_and_base64() {
        assert_eq!(decode_profile_title("  Мой профиль "), Some("Мой профиль".into()));
        assert_eq!(decode_profile_title(""), None);
        assert_eq!(decode_profile_title("base64:TmluZXR5"), Some("Ninety".into()));
    }
}
