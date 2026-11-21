use crate::util::{i18n_error, i18n_error_with};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use tokio::net::lookup_host;

// Response body cap: a server list is tens of kilobytes; a gigabyte response is
// either not a subscription or a malicious panel, and it must not be swallowed into memory.
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;

/// Device headers for panels with a device limit (the Happ standard,
/// used by Remnawave). Only `hwid` is mandatory, the rest is so that
/// the device is distinguishable in the panel's list.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HwidHeaders {
    pub hwid: String,
    pub device_os: Option<String>,
    pub ver_os: Option<String>,
    pub device_model: Option<String>,
    /// true — the subscription gets its own provider HWID derived from
    /// `hwid` and the subscription host (hwid::scoped_hwid), not the shared identifier.
    /// The host is taken from the address the backend validated, not from the frontend.
    #[serde(default)]
    pub scoped: bool,
}

/// Remnawave (panel v3+) checks the HWID with the regex `^[a-zA-Z0-9=-]{10,64}$` and
/// silently ignores a header that doesn't match it. We check on our
/// side so as not to send an obviously useless identifier.
fn hwid_is_valid(value: &str) -> bool {
    (10..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'=' || b == b'-')
}

/// Free-form device description: we strip control characters and limit the length
/// so that a value from the frontend state can't break the header.
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

fn hwid_header_value(headers: &HwidHeaders, origin_host: &str) -> Option<String> {
    if !hwid_is_valid(&headers.hwid) {
        return None;
    }
    Some(if headers.scoped {
        crate::hwid::scoped_hwid(&headers.hwid, origin_host)
    } else {
        headers.hwid.clone()
    })
}

fn apply_hwid_headers(
    request: reqwest::RequestBuilder,
    headers: &HwidHeaders,
    origin_host: &str,
) -> reqwest::RequestBuilder {
    let Some(hwid) = hwid_header_value(headers, origin_host) else {
        return request;
    };
    let mut request = request.header("x-hwid", hwid);
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
    /// The panel reported that the device limit is enabled.
    pub hwid_active: bool,
    /// The device limit is enabled, but the request went out without `x-hwid`.
    pub hwid_not_supported: bool,
    /// The device limit is exhausted — the panel won't accept new devices.
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
    addresses: Vec<SocketAddr>,
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

fn validate_resolved_addresses(addresses: &[SocketAddr]) -> Result<(), String> {
    if addresses.is_empty() {
        return Err(i18n_error("subs.err.noAddresses"));
    }
    if addresses
        .iter()
        .any(|address| is_forbidden_target_ip(address.ip()))
    {
        // Reject the whole answer, not only the first address. This prevents a
        // DNS rebinding answer from hiding a private A/AAAA record behind a
        // public one selected by the resolver.
        return Err(i18n_error("subs.err.privateNetwork"));
    }
    Ok(())
}

fn parse_subscription_url(raw: &str) -> Result<reqwest::Url, String> {
    if raw.trim() != raw || raw.is_empty() {
        return Err(i18n_error("subs.err.invalidUrl"));
    }
    let url = reqwest::Url::parse(raw).map_err(|_| i18n_error("subs.err.invalidUrl"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(i18n_error("subs.err.badScheme"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(i18n_error("subs.err.embeddedCredentials"));
    }
    Ok(url)
}

async fn resolve_public_target(url: &reqwest::Url) -> Result<ResolvedTarget, String> {
    let host = url
        .host_str()
        .ok_or_else(|| i18n_error("subs.err.noHost"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| i18n_error("subs.err.noPort"))?;

    if let Some(ip) = host_literal_ip(host) {
        if is_forbidden_target_ip(ip) {
            return Err(i18n_error("subs.err.privateNetwork"));
        }
        return Ok(ResolvedTarget {
            host: host.to_ascii_lowercase(),
            addresses: vec![SocketAddr::new(ip, port)],
            is_ip_literal: true,
        });
    }

    let addresses: Vec<SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|_| i18n_error("subs.err.dnsFailed"))?
        .collect();
    validate_resolved_addresses(&addresses)?;
    Ok(ResolvedTarget {
        host: host.to_ascii_lowercase(),
        addresses,
        is_ip_literal: false,
    })
}

/// Address check when the request goes through Ninety's local proxy. The name
/// is resolved by the tunnel itself, so we don't touch local DNS: otherwise the panel's
/// domain goes to the system resolver and the subscription update breaks exactly
/// where DNS is blocked — and that's precisely why it's updated "through the VPN".
/// An IP literal is still cut off: it doesn't resolve anywhere and is visible right away.
fn reject_forbidden_literal(url: &reqwest::Url) -> Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| i18n_error("subs.err.noHost"))?;
    if let Some(ip) = host_literal_ip(host) {
        if is_forbidden_target_ip(ip) {
            return Err(i18n_error("subs.err.privateNetwork"));
        }
    }
    Ok(())
}

// IP literal of the host. `host_str()` returns IPv6 in square brackets, and a direct
// `parse::<IpAddr>()` didn't recognize it: `http://[::1]/` through the tunnel passed
// the literal check as a regular name.
fn host_literal_ip(host: &str) -> Option<IpAddr> {
    host.strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host)
        .parse()
        .ok()
}

const PROXIED_REDIRECT_LOOKUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

// A redirect through the tunnel to ANOTHER host. sing-box resolves the name there, and
// a direct route (region, the "Direct" rule) led "x.example.ru →
// 192.168.1.1" to the router or a service on this PC, and the redirect host is chosen by
// the subscription server, not the user. Such a name is checked with local DNS. If
// it didn't resolve locally, the tunnel decides: the subscription is pulled through it
// precisely because of DNS blocking.
async fn reject_private_proxied_redirect(url: &reqwest::Url) -> Result<(), String> {
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return Ok(());
    };
    if host_literal_ip(host).is_some() {
        return Ok(()); // the literal has already been checked by reject_forbidden_literal
    }
    let answer = tokio::time::timeout(PROXIED_REDIRECT_LOOKUP_TIMEOUT, lookup_host((host, port)))
        .await
        .ok()
        .and_then(Result::ok)
        .map(|addresses| addresses.collect::<Vec<_>>());
    proxied_redirect_verdict(answer.as_deref())
}

fn proxied_redirect_verdict(answer: Option<&[SocketAddr]>) -> Result<(), String> {
    match answer {
        Some(addresses)
            if addresses
                .iter()
                .any(|address| is_forbidden_target_ip(address.ip())) =>
        {
            Err(i18n_error("subs.err.redirectPrivate"))
        }
        _ => Ok(()),
    }
}

/// User-Agent of the subscription request. Panels choose the response format based on it:
/// v2rayN gets a list of links, while xray JSON (whole Xray configs with fields
/// that links don't have, e.g. `finalmask`) is given only to clients
/// that understand this format. A recent version — because some panels
/// gate JSON by client version.
const LINKS_USER_AGENT: &str = "v2rayN/6.42";
const XRAY_JSON_USER_AGENT: &str = "Happ/9.9.9";

/// The format the frontend asks the panel for. An unknown value means a regular
/// link list: this way an old call without the parameter behaves as before.
fn user_agent_for(format: Option<&str>) -> &'static str {
    match format {
        Some("xray-json") => XRAY_JSON_USER_AGENT,
        _ => LINKS_USER_AGENT,
    }
}

fn make_client(
    proxy: Option<&str>,
    target: Option<&ResolvedTarget>,
    jar: &Arc<reqwest::cookie::Jar>,
    user_agent: &str,
) -> Result<reqwest::Client, String> {
    let mut builder = crate::util::direct_client_builder()
        .user_agent(user_agent)
        .timeout(std::time::Duration::from_secs(20))
        // Redirects are followed manually so every Location is resolved and
        // checked before the next connection. Automatic reqwest redirects
        // cannot provide DNS-rebinding protection for each hop.
        .redirect(reqwest::redirect::Policy::none())
        // Each hop creates its own client (the address is pinned anew), so
        // the cookie store is shared and passed in from outside. Without it, a panel that
        // sets a session cookie on a 302 and sends to the same address drives the client
        // in circles until it hits MAX_REDIRECTS. Domain and path are limited by the jar itself:
        // on a redirect to a foreign host the original panel's cookie isn't sent.
        .cookie_provider(Arc::clone(jar))
        .gzip(true);
    if let Some(target) = target.filter(|target| !target.is_ip_literal) {
        // Connect to the checked addresses while retaining the URL hostname
        // for TLS SNI and HTTP Host. This closes the resolve-then-connect race
        // for the target used by this request. Every checked address is
        // pinned, not just the first one: a host whose first record is an
        // unroutable IPv6 address must still be reachable over IPv4.
        builder = builder.resolve_to_addrs(&target.host, &target.addresses);
    }
    if let Some(proxy) = proxy {
        let configured =
            reqwest::Proxy::all(proxy).map_err(|_| i18n_error("subs.err.invalidProxy"))?;
        builder = builder.proxy(configured);
    }
    builder
        .build()
        .map_err(|_| i18n_error("subs.err.clientFailed"))
}

/// Error for a chain that hit the limit: without the host, the code and the cookie sign,
/// "too many redirects" gives no clue to either the user or triage.
/// If the panel sets a cookie and the loop still doesn't break, it's no longer about
/// the session — that's how anti-bot protection with an in-browser check responds.
fn redirect_loop_error(url: &reqwest::Url, status: u16, sets_cookie: bool) -> String {
    let key = if sets_cookie {
        "subs.err.redirectLoopCookie"
    } else {
        "subs.err.redirectLoop"
    };
    i18n_error_with(
        key,
        &[
            ("steps", &MAX_REDIRECTS.to_string()),
            ("host", url.host_str().unwrap_or_default()),
            ("status", &status.to_string()),
        ],
    )
}

fn too_large_error() -> String {
    i18n_error_with(
        "subs.err.tooLarge",
        &[("mb", &(MAX_BODY_BYTES / 1024 / 1024).to_string())],
    )
}

fn checked_redirect(current: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
    let next = current
        .join(location)
        .map_err(|_| i18n_error("subs.err.redirectInvalid"))?;
    parse_subscription_url(next.as_str())?;
    if current.scheme() == "https" && next.scheme() == "http" {
        return Err(i18n_error("subs.err.redirectDowngrade"));
    }
    Ok(next)
}

/// The device identifier goes only to the host the user added
/// themselves. A redirect to a foreign host is a common way for subscription panels
/// to spread traffic across mirrors, but the HWID is none of its business.
fn same_host(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    match (a.host_str(), b.host_str()) {
        (Some(left), Some(right)) => left.eq_ignore_ascii_case(right),
        _ => false,
    }
}

// Subscription request failure in plain words. Previously any failure turned into
// "failed to get the subscription": a timeout, a refused connection and a certificate
// problem looked the same, and there was nothing to latch onto for either the
// user or triage. We don't expose the reqwest error text — it contains the subscription
// address with the token; we only look for signs along the chain of causes.
fn describe_fetch_error(error: &reqwest::Error, via_proxy: bool) -> String {
    let causes = error_causes(error);
    let key = if error.is_timeout() {
        "subs.err.fetchTimeout"
    } else if causes.contains("certificate")
        || causes.contains("tls")
        || causes.contains("handshake")
    {
        "subs.err.fetchTls"
    } else if error.is_connect() && via_proxy {
        "subs.err.fetchTunnel"
    } else if error.is_connect() {
        "subs.err.fetchRefused"
    } else {
        "subs.err.fetchInterrupted"
    };
    i18n_error(key)
}

fn describe_read_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        i18n_error("subs.err.readTimeout")
    } else {
        i18n_error("subs.err.readInterrupted")
    }
}

// The error's causes without its top level: reqwest::Error itself prints the request
// address, and the word "tls" in the path or domain would falsely indicate a TLS problem.
fn error_causes(error: &reqwest::Error) -> String {
    let mut text = String::new();
    let mut current = std::error::Error::source(error);
    while let Some(cause) = current {
        text.push_str(&cause.to_string().to_ascii_lowercase());
        text.push('\n');
        current = cause.source();
    }
    text
}

/// The HWID the subscription will receive. The subscription window shows it so that
/// the user can tell the provider exactly the value the panel sees.
#[tauri::command]
pub fn subscription_hwid(url: String, hwid: String, scoped: bool) -> Result<String, String> {
    let url = parse_subscription_url(&url)?;
    let headers = HwidHeaders {
        hwid,
        scoped,
        ..HwidHeaders::default()
    };
    hwid_header_value(&headers, url.host_str().unwrap_or_default())
        .ok_or_else(|| i18n_error("subs.err.invalidHwid"))
}

#[tauri::command]
pub async fn fetch_subscription(
    url: String,
    proxy: Option<String>,
    hwid: Option<HwidHeaders>,
    format: Option<String>,
) -> Result<SubscriptionInfo, String> {
    let user_agent = user_agent_for(format.as_deref());
    let mut current = parse_subscription_url(&url)?;
    let origin = current.clone();
    let proxy = proxy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    // The cookie store lives for exactly one call: it never reaches disk and isn't
    // reused between subscriptions — the panel session is needed only within this
    // redirect chain.
    let jar = Arc::new(reqwest::cookie::Jar::default());

    let mut redirects = 0usize;
    let resp = loop {
        // A direct request resolves and pins the address itself; a proxied one leaves
        // name resolution to the tunnel and doesn't touch local DNS at all.
        let target = match proxy {
            Some(_) => {
                reject_forbidden_literal(&current)?;
                if !same_host(&origin, &current) {
                    reject_private_proxied_redirect(&current).await?;
                }
                None
            }
            None => Some(resolve_public_target(&current).await?),
        };
        let client = make_client(proxy, target.as_ref(), &jar, user_agent)?;
        let mut request = client.get(current.clone()).header("Accept", "*/*");
        if let Some(headers) = hwid.as_ref().filter(|_| same_host(&origin, &current)) {
            request = apply_hwid_headers(request, headers, origin.host_str().unwrap_or_default());
        }
        let response = request
            .send()
            .await
            .map_err(|error| describe_fetch_error(&error, proxy.is_some()))?;

        if response.status().is_redirection() {
            if MAX_REDIRECTS == 0 || redirects >= MAX_REDIRECTS {
                return Err(redirect_loop_error(
                    &current,
                    response.status().as_u16(),
                    response.headers().contains_key(reqwest::header::SET_COOKIE),
                ));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| i18n_error("subs.err.redirectNoLocation"))?;
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

    // IMPORTANT: the User-Agent determines the server's response. Many subscription
    // panels (sub-store, marzban, xo.e0f.cx, etc.) return:
    //   - to known clients (v2rayN, ClashMeta) — a plain/base64 vless list,
    //   - to unknown ones — JSON or an HTML login page.
    // So by default we send the proven v2rayN UA (see user_agent_for).
    let status = resp.status().as_u16();

    let headers = resp.headers().clone();

    if let Some(len) = resp.content_length() {
        if len > MAX_BODY_BYTES as u64 {
            return Err(too_large_error());
        }
    }
    // Stream with a cap (Content-Length may be missing or lie). The limit itself
    // is computed by the shared `util::checked_body_len` — the same guard as in
    // read_response_capped: local arithmetic added lengths without
    // checked_add. The loop stays here only for the error texts: it matters to the user
    // that "this is not a server list", not an abstract "body too large".
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|error| describe_read_error(&error))?
    {
        if crate::util::checked_body_len(buf.len(), chunk.len(), MAX_BODY_BYTES).is_err() {
            return Err(too_large_error());
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

    // The panel (Remnawave ≥ 2.7.5) reports the device limit state
    // via headers — the frontend uses them to explain an empty subscription list instead of
    // showing the panel's placeholder node as a real server.
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
    fn user_agent_follows_requested_format() {
        assert_eq!(user_agent_for(None), LINKS_USER_AGENT);
        assert_eq!(user_agent_for(Some("links")), LINKS_USER_AGENT);
        assert_eq!(user_agent_for(Some("xray-json")), XRAY_JSON_USER_AGENT);
    }

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
        assert_eq!(up, None); // not a number — skipped
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

    // A proxied request goes into the tunnel: resolving the panel domain locally
    // would expose it to the system DNS and break updates where DNS is blocked.
    // An IP literal into the local network is cut off in this mode too.
    #[test]
    fn proxied_requests_still_reject_local_ip_literals() {
        let local = reqwest::Url::parse("http://127.0.0.1:8080/sub").unwrap();
        assert!(reject_forbidden_literal(&local).is_err());
        let private = reqwest::Url::parse("http://192.168.1.10/sub").unwrap();
        assert!(reject_forbidden_literal(&private).is_err());
        let public = reqwest::Url::parse("https://1.1.1.1/sub").unwrap();
        assert!(reject_forbidden_literal(&public).is_ok());
        // The name isn't resolved at all — that's the whole point of the mode.
        let host = reqwest::Url::parse("https://panel.example/sub").unwrap();
        assert!(reject_forbidden_literal(&host).is_ok());
    }

    // A new-scheme subscription gets its own provider HWID, not the shared one: two
    // providers won't match the device. Old-scheme subscriptions work as before,
    // otherwise the panel would count Ninety as a new device.
    #[test]
    fn scoped_hwid_is_derived_from_the_checked_subscription_host() {
        let base = "0123456789abcdef0123456789abcdef".to_string();
        let shown = subscription_hwid("https://Panel.Example/sub/token".into(), base.clone(), true)
            .unwrap();
        assert_eq!(shown, crate::hwid::scoped_hwid(&base, "panel.example"));
        assert_ne!(shown, base);
        let legacy = subscription_hwid("https://panel.example/sub".into(), base.clone(), false);
        assert_eq!(legacy.unwrap(), base);
        assert!(subscription_hwid("https://panel.example/sub".into(), "bad".into(), true).is_err());
        assert!(subscription_hwid("file:///etc/hosts".into(), base, true).is_err());
    }

    #[test]
    fn ipv6_literals_are_recognised_in_url_form() {
        let loopback = reqwest::Url::parse("http://[::1]:8080/sub").unwrap();
        assert!(reject_forbidden_literal(&loopback).is_err());
        let mapped = reqwest::Url::parse("http://[::ffff:192.168.1.1]/sub").unwrap();
        assert!(reject_forbidden_literal(&mapped).is_err());
        let public = reqwest::Url::parse("https://[2001:4860:4860::8888]/sub").unwrap();
        assert!(reject_forbidden_literal(&public).is_ok());
        assert_eq!(
            host_literal_ip("[::1]"),
            Some(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST))
        );
        assert_eq!(host_literal_ip("panel.example"), None);
    }

    // A redirect through the tunnel to a foreign host is checked with local DNS.
    // Not resolving locally is no reason to fail the update: that's the whole point of
    // loading through the tunnel.
    #[test]
    fn proxied_cross_host_redirect_into_a_private_network_is_refused() {
        let private = [SocketAddr::from(([192, 168, 1, 1], 80))];
        assert!(proxied_redirect_verdict(Some(private.as_slice())).is_err());
        let mixed = [
            SocketAddr::from(([1, 1, 1, 1], 443)),
            SocketAddr::from(([127, 0, 0, 1], 443)),
        ];
        assert!(proxied_redirect_verdict(Some(mixed.as_slice())).is_err());
        let public = [SocketAddr::from(([1, 1, 1, 1], 443))];
        assert!(proxied_redirect_verdict(Some(public.as_slice())).is_ok());
        assert!(proxied_redirect_verdict(None).is_ok());
    }

    #[test]
    fn hwid_matches_the_panel_validation_rule() {
        assert!(hwid_is_valid("a1b2c3d4e5f60718"));
        assert!(hwid_is_valid("UE42LJXu4DbiCaBv"));
        assert!(hwid_is_valid("A-B=C-D=E-F=G-H"));
        // Shorter than 10 characters, longer than 64 and foreign characters are ignored by the panel.
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

    // HWID is a device identifier: it goes only to the host the
    // user added, and doesn't follow a redirect to a foreign domain.
    #[test]
    fn hwid_travels_only_to_the_host_the_user_added() {
        let origin = reqwest::Url::parse("https://panel.example/sub/key").unwrap();
        let same = reqwest::Url::parse("https://PANEL.example/sub/key?v=2").unwrap();
        let other = reqwest::Url::parse("https://mirror.example/sub/key").unwrap();
        assert!(same_host(&origin, &same));
        assert!(!same_host(&origin, &other));
    }

    // The original panel's cookie must not travel to a mirror on a foreign domain —
    // exactly the same boundary as for the HWID above, only the jar itself enforces it.
    #[test]
    fn cookie_jar_is_scoped_to_the_host_that_set_it() {
        use reqwest::cookie::CookieStore;

        let origin = reqwest::Url::parse("https://panel.example/sub/key").unwrap();
        let mirror = reqwest::Url::parse("https://mirror.example/sub/key").unwrap();
        let jar = reqwest::cookie::Jar::default();
        jar.add_cookie_str("session=abc; Path=/", &origin);

        let sent = jar.cookies(&origin).expect("cookie for the origin host");
        assert_eq!(sent.to_str().unwrap(), "session=abc");
        assert!(jar.cookies(&mirror).is_none());
    }

    #[test]
    fn redirect_loop_error_names_the_host_status_and_cookie() {
        let url = reqwest::Url::parse("https://panel.example/sub/key").unwrap();
        let with_cookie = redirect_loop_error(&url, 302, true);
        assert!(
            with_cookie.starts_with("[[subs.err.redirectLoopCookie "),
            "{with_cookie}"
        );
        assert!(with_cookie.contains("panel.example"), "{with_cookie}");
        assert!(with_cookie.contains("\"302\""), "{with_cookie}");
        let plain = redirect_loop_error(&url, 307, false);
        assert!(plain.starts_with("[[subs.err.redirectLoop "), "{plain}");
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

    // A refused connection and a timeout are distinguished by the error key, and the subscription
    // address with the token doesn't get into it.
    #[tokio::test]
    async fn fetch_errors_name_the_failure_without_leaking_the_url() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let client = crate::util::direct_client_builder().build().unwrap();
        let refused = client
            .get(format!("http://127.0.0.1:{port}/sub/secret-token"))
            .send()
            .await
            .unwrap_err();
        let error = describe_fetch_error(&refused, false);
        assert_eq!(error, i18n_error("subs.err.fetchRefused"));
        assert!(!error.contains("secret-token"), "{error}");

        let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = silent.local_addr().unwrap();
        let hold = tokio::spawn(async move {
            let (_socket, _) = silent.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        });
        let slow = crate::util::direct_client_builder()
            .timeout(std::time::Duration::from_millis(200))
            .build()
            .unwrap();
        let timeout = slow
            .get(format!("http://{address}/sub"))
            .send()
            .await
            .unwrap_err();
        assert_eq!(
            describe_fetch_error(&timeout, false),
            i18n_error("subs.err.fetchTimeout")
        );
        hold.abort();
    }
}
