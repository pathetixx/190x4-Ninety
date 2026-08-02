use base64::Engine;
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use tokio::net::lookup_host;

// Кап тела ответа: список серверов — десятки килобайт; гигабайтный ответ — это
// либо не подписка, либо злонамеренная панель, и глотать его в память нельзя.
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;

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

#[derive(Debug, Clone)]
struct ResolvedTarget {
    host: String,
    address: SocketAddr,
    is_ip_literal: bool,
}

fn is_forbidden_target_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_multicast()
                // Shared carrier NAT, benchmarking, documentation and special
                // purpose ranges are not valid public subscription targets.
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
                || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
                || (octets[0] == 198 && octets[1] == 18)
                || (octets[0] == 198 && octets[1] == 19)
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                || octets[0] >= 240
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_multicast()
                || ip.is_unicast_link_local()
                // Unique-local IPv6 (fc00::/7).
                || (segments[0] & 0xfe00) == 0xfc00
                // Deprecated site-local IPv6 (fec0::/10).
                || (segments[0] & 0xffc0) == 0xfec0
                // Documentation and benchmarking ranges.
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] == 0x2001 && segments[1] == 0x0002)
                // IPv4-mapped IPv6 must inherit the IPv4 policy.
                || ip.to_ipv4().is_some_and(|mapped| is_forbidden_target_ip(IpAddr::V4(mapped)))
        }
    }
}

fn validate_resolved_addresses(addresses: &[SocketAddr]) -> Result<SocketAddr, String> {
    if addresses.is_empty() {
        return Err("адрес подписки не имеет IP-адресов".into());
    }
    if addresses
        .iter()
        .any(|address| is_forbidden_target_ip(address.ip()))
    {
        // Reject the whole answer, not only the first address. This prevents a
        // DNS rebinding answer from hiding a private A/AAAA record behind a
        // public one selected by the resolver.
        return Err("адрес подписки разрешился в локальную или специальную сеть".into());
    }
    Ok(addresses[0])
}

fn parse_subscription_url(raw: &str) -> Result<reqwest::Url, String> {
    if raw.trim() != raw || raw.is_empty() {
        return Err("адрес подписки недействителен".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "адрес подписки недействителен")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("подписка должна использовать http:// или https://".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("адрес подписки со встроенными учётными данными запрещён".into());
    }
    Ok(url)
}

async fn resolve_public_target(url: &reqwest::Url) -> Result<ResolvedTarget, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "у подписки отсутствует имя хоста".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "у подписки отсутствует порт".to_string())?;

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_forbidden_target_ip(ip) {
            return Err("адрес подписки указывает в локальную или специальную сеть".into());
        }
        return Ok(ResolvedTarget {
            host: host.to_ascii_lowercase(),
            address: SocketAddr::new(ip, port),
            is_ip_literal: true,
        });
    }

    let addresses: Vec<SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|_| "не удалось разрешить адрес подписки".to_string())?
        .collect();
    let address = validate_resolved_addresses(&addresses)?;
    Ok(ResolvedTarget {
        host: host.to_ascii_lowercase(),
        address,
        is_ip_literal: false,
    })
}

fn make_client(proxy: Option<&str>, target: &ResolvedTarget) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("v2rayN/6.42")
        .timeout(std::time::Duration::from_secs(20))
        // Redirects are followed manually so every Location is resolved and
        // checked before the next connection. Automatic reqwest redirects
        // cannot provide DNS-rebinding protection for each hop.
        .redirect(reqwest::redirect::Policy::none())
        .gzip(true);
    if !target.is_ip_literal {
        // Connect to the checked address while retaining the URL hostname for
        // TLS SNI and HTTP Host. This closes the resolve-then-connect race for
        // the target used by this request.
        builder = builder.resolve(&target.host, target.address);
    }
    if let Some(proxy) = proxy {
        let configured = reqwest::Proxy::all(proxy)
            .map_err(|_| "прокси подписки имеет недействительный адрес".to_string())?;
        builder = builder.proxy(configured);
    }
    builder
        .build()
        .map_err(|_| "не удалось создать HTTP-клиент для подписки".into())
}

fn checked_redirect(current: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
    let next = current
        .join(location)
        .map_err(|_| "перенаправление подписки имеет недействительный адрес".to_string())?;
    parse_subscription_url(next.as_str())?;
    if current.scheme() == "https" && next.scheme() == "http" {
        return Err("перенаправление подписки из https в http запрещено".into());
    }
    Ok(next)
}

#[tauri::command]
pub async fn fetch_subscription(
    url: String,
    proxy: Option<String>,
) -> Result<SubscriptionInfo, String> {
    let mut current = parse_subscription_url(&url)?;
    let proxy = proxy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut redirects = 0usize;
    let resp = loop {
        let target = resolve_public_target(&current).await?;
        let client = make_client(proxy, &target)?;
        let response = client
            .get(current.clone())
            .header("Accept", "*/*")
            .send()
            .await
            .map_err(|_| "не удалось получить подписку".to_string())?;

        if response.status().is_redirection() {
            if MAX_REDIRECTS == 0 {
                return Err("слишком много перенаправлений подписки".into());
            }
            if redirects >= MAX_REDIRECTS {
                return Err("слишком много перенаправлений подписки".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "перенаправление подписки не содержит адреса".to_string())?;
            let next = checked_redirect(&current, location)?;
            // The redirect count is tracked locally rather than in reqwest's
            // automatic policy. A new client is intentionally built for every
            // hop so the checked DNS address cannot leak into the next URL.
            redirects += 1;
            current = next;
            continue;
        }
        break response;
    };

    // ВАЖНО: User-Agent определяет ответ сервера. Многие подписочные
    // панели (sub-store, marzban, xo.e0f.cx и т.п.) отдают:
    //   - известным клиентам (v2rayN, ClashMeta) — plain/base64 vless-список,
    //   - неизвестным — JSON или HTML страницу логина.
    // Поэтому шлём проверенный v2rayN UA.
    let status = resp.status().as_u16();

    let headers = resp.headers().clone();

    if let Some(len) = resp.content_length() {
        if len > MAX_BODY_BYTES as u64 {
            return Err(format!(
                "подписка больше {} МБ — это не список серверов",
                MAX_BODY_BYTES / 1024 / 1024
            ));
        }
    }
    // Стримим с капом (Content-Length может отсутствовать или врать).
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| "не удалось прочитать ответ подписки".to_string())?
    {
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(format!(
                "подписка больше {} МБ — это не список серверов",
                MAX_BODY_BYTES / 1024 / 1024
            ));
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
        assert_eq!(
            decode_profile_title("  Мой профиль "),
            Some("Мой профиль".into())
        );
        assert_eq!(decode_profile_title(""), None);
        assert_eq!(
            decode_profile_title("base64:TmluZXR5"),
            Some("Ninety".into())
        );
    }

    #[test]
    fn rejects_non_http_subscription_schemes() {
        for raw in [
            "file:///etc/passwd",
            "ftp://example.com/list",
            "example.com/list",
        ] {
            assert!(parse_subscription_url(raw).is_err(), "{raw}");
        }
        assert!(parse_subscription_url("https://example.com/list").is_ok());
    }

    #[test]
    fn rejects_private_local_and_special_ipv4_and_ipv6() {
        for raw in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "224.0.0.1",
            "192.88.99.1",
            "255.255.255.255",
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fec0::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
        ] {
            let ip = raw.parse::<IpAddr>().expect(raw);
            assert!(is_forbidden_target_ip(ip), "{raw}");
        }
        for raw in ["1.1.1.1", "2001:4860:4860::8888"] {
            let ip = raw.parse::<IpAddr>().expect(raw);
            assert!(!is_forbidden_target_ip(ip), "{raw}");
        }
    }

    #[test]
    fn rejects_a_mixed_public_and_private_dns_answer_as_rebinding() {
        let answer = [
            SocketAddr::from(([1, 1, 1, 1], 443)),
            SocketAddr::from(([127, 0, 0, 1], 443)),
        ];
        assert!(validate_resolved_addresses(&answer).is_err());
    }

    #[test]
    fn redirects_are_scheme_checked_before_the_next_request() {
        let https = reqwest::Url::parse("https://example.com/a").unwrap();
        assert_eq!(
            checked_redirect(&https, "/next").unwrap().as_str(),
            "https://example.com/next"
        );
        assert!(checked_redirect(&https, "http://example.com/next").is_err());
        assert!(checked_redirect(&https, "file:///etc/passwd").is_err());
    }
}
