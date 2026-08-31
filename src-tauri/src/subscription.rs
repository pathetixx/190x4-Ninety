use base64::Engine;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use tokio::net::lookup_host;

// Кап тела ответа: список серверов — десятки килобайт; гигабайтный ответ — это
// либо не подписка, либо злонамеренная панель, и глотать его в память нельзя.
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;

/// Заголовки устройства для панелей с лимитом устройств (стандарт Happ,
/// используется Remnawave). Обязателен только `hwid`, остальное — чтобы
/// устройство было различимо в списке панели.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HwidHeaders {
    pub hwid: String,
    pub device_os: Option<String>,
    pub ver_os: Option<String>,
    pub device_model: Option<String>,
}

/// Remnawave (панель v3+) проверяет HWID регуляркой `^[a-zA-Z0-9=-]{10,64}$` и
/// молча игнорирует заголовок, который под неё не подходит. Проверяем на своей
/// стороне, чтобы не отправлять заведомо бесполезный идентификатор.
fn hwid_is_valid(value: &str) -> bool {
    (10..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'=' || b == b'-')
}

/// Описание устройства свободной формы: режем управляющие символы и длину,
/// чтобы значение из состояния фронтенда не могло разорвать заголовок.
fn sanitize_device_field(value: Option<&String>) -> Option<String> {
    let cleaned: String = value?
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn apply_hwid_headers(
    request: reqwest::RequestBuilder,
    headers: &HwidHeaders,
) -> reqwest::RequestBuilder {
    if !hwid_is_valid(&headers.hwid) {
        return request;
    }
    let mut request = request.header("x-hwid", headers.hwid.as_str());
    if let Some(value) = sanitize_device_field(headers.device_os.as_ref()) {
        request = request.header("x-device-os", value);
    }
    if let Some(value) = sanitize_device_field(headers.ver_os.as_ref()) {
        request = request.header("x-ver-os", value);
    }
    if let Some(value) = sanitize_device_field(headers.device_model.as_ref()) {
        request = request.header("x-device-model", value);
    }
    request
}

fn header_is_true(headers: &reqwest::header::HeaderMap, name: &str) -> bool {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
}

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
    /// Панель сообщила, что лимит устройств включён.
    pub hwid_active: bool,
    /// Лимит устройств включён, а запрос ушёл без `x-hwid`.
    pub hwid_not_supported: bool,
    /// Лимит устройств исчерпан — новые устройства панель не примет.
    pub hwid_limit_reached: bool,
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
                // "This network" (0.0.0.0/8, RFC 1122). Only 0.0.0.0 itself is
                // covered by is_unspecified, and the rest of the block is not a
                // routable subscription host either.
                || octets[0] == 0
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

/// Проверка адреса, когда запрос уходит через локальный прокси Ninety. Имя
/// резолвит уже сам туннель, поэтому локальный DNS не трогаем: иначе домен
/// панели уезжает системному резолверу и обновление подписки ломается ровно
/// там, где DNS и блокируют, — а именно ради этого её и обновляют «через VPN».
/// IP-литерал всё равно отсекаем: он никуда не резолвится и виден сразу.
fn reject_forbidden_literal(url: &reqwest::Url) -> Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "у подписки отсутствует имя хоста".to_string())?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_forbidden_target_ip(ip) {
            return Err("адрес подписки указывает в локальную или специальную сеть".into());
        }
    }
    Ok(())
}

fn make_client(
    proxy: Option<&str>,
    target: Option<&ResolvedTarget>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("v2rayN/6.42")
        .timeout(std::time::Duration::from_secs(20))
        // Redirects are followed manually so every Location is resolved and
        // checked before the next connection. Automatic reqwest redirects
        // cannot provide DNS-rebinding protection for each hop.
        .redirect(reqwest::redirect::Policy::none())
        .gzip(true);
    if let Some(target) = target.filter(|target| !target.is_ip_literal) {
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

/// Идентификатор устройства уходит только на тот хост, который пользователь
/// добавил сам. Редирект на чужой хост — обычный способ подписочных панелей
/// раздать трафик по зеркалам, но HWID это уже не его дело.
fn same_host(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    match (a.host_str(), b.host_str()) {
        (Some(left), Some(right)) => left.eq_ignore_ascii_case(right),
        _ => false,
    }
}

#[tauri::command]
pub async fn fetch_subscription(
    url: String,
    proxy: Option<String>,
    hwid: Option<HwidHeaders>,
) -> Result<SubscriptionInfo, String> {
    let mut current = parse_subscription_url(&url)?;
    let origin = current.clone();
    let proxy = proxy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut redirects = 0usize;
    let resp = loop {
        // Прямой запрос сам резолвит и пиннит адрес; проксированный отдаёт
        // разрешение имени туннелю и локальный DNS не трогает вовсе.
        let target = match proxy {
            Some(_) => {
                reject_forbidden_literal(&current)?;
                None
            }
            None => Some(resolve_public_target(&current).await?),
        };
        let client = make_client(proxy, target.as_ref())?;
        let mut request = client.get(current.clone()).header("Accept", "*/*");
        if let Some(headers) = hwid.as_ref().filter(|_| same_host(&origin, &current)) {
            request = apply_hwid_headers(request, headers);
        }
        let response = request
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

    // Панель (Remnawave ≥ 2.7.5) сообщает состояние лимита устройств
    // заголовками — по ним фронтенд объясняет пустой список подписки вместо
    // того, чтобы показывать ноду-заглушку панели как настоящий сервер.
    let hwid_active = header_is_true(&headers, "x-hwid-active");
    let hwid_not_supported = header_is_true(&headers, "x-hwid-not-supported");
    let hwid_limit_reached = header_is_true(&headers, "x-hwid-max-devices-reached")
        || header_is_true(&headers, "x-hwid-limit");

    Ok(SubscriptionInfo {
        body,
        upload,
        download,
        total,
        expire,
        profile_title,
        profile_update_interval_hours,
        status,
        hwid_active,
        hwid_not_supported,
        hwid_limit_reached,
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
            "0.1.2.3",
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

    // Проксированный запрос уходит в туннель: локальный резолв домена панели
    // раскрыл бы его системному DNS и ломал обновление там, где DNS блокируют.
    // IP-литерал в локальную сеть отсекается и в этом режиме.
    #[test]
    fn proxied_requests_still_reject_local_ip_literals() {
        let local = reqwest::Url::parse("http://127.0.0.1:8080/sub").unwrap();
        assert!(reject_forbidden_literal(&local).is_err());
        let private = reqwest::Url::parse("http://192.168.1.10/sub").unwrap();
        assert!(reject_forbidden_literal(&private).is_err());
        let public = reqwest::Url::parse("https://1.1.1.1/sub").unwrap();
        assert!(reject_forbidden_literal(&public).is_ok());
        // Имя не резолвим вовсе — это и есть смысл режима.
        let host = reqwest::Url::parse("https://panel.example/sub").unwrap();
        assert!(reject_forbidden_literal(&host).is_ok());
    }

    #[test]
    fn hwid_matches_the_panel_validation_rule() {
        assert!(hwid_is_valid("a1b2c3d4e5f60718"));
        assert!(hwid_is_valid("UE42LJXu4DbiCaBv"));
        assert!(hwid_is_valid("A-B=C-D=E-F=G-H"));
        // Короче 10 символов, длиннее 64 и посторонние символы панель игнорирует.
        assert!(!hwid_is_valid("short1234"));
        assert!(!hwid_is_valid(&"a".repeat(65)));
        assert!(!hwid_is_valid("{6b9e0f3a-1c2d-4e5f}"));
        assert!(!hwid_is_valid("base64_url_style_id"));
    }

    #[test]
    fn device_fields_are_trimmed_and_stripped_of_control_characters() {
        assert_eq!(
            sanitize_device_field(Some(&"  Windows\r\n".to_string())),
            Some("Windows".to_string())
        );
        assert_eq!(sanitize_device_field(Some(&"   ".to_string())), None);
        assert_eq!(sanitize_device_field(None), None);
        let long = sanitize_device_field(Some(&"m".repeat(100))).unwrap();
        assert_eq!(long.len(), 64);
    }

    // HWID — идентификатор устройства: он уходит только тому хосту, который
    // пользователь добавил, и не следует за редиректом на чужой домен.
    #[test]
    fn hwid_travels_only_to_the_host_the_user_added() {
        let origin = reqwest::Url::parse("https://panel.example/sub/key").unwrap();
        let same = reqwest::Url::parse("https://PANEL.example/sub/key?v=2").unwrap();
        let other = reqwest::Url::parse("https://mirror.example/sub/key").unwrap();
        assert!(same_host(&origin, &same));
        assert!(!same_host(&origin, &other));
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
