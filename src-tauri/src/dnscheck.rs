// Ninety · active direct-DNS probe (for the frontend DNS watchdog).
//
// Why: sing-box resolves the node's server name (e.g. de1.example.com) through
// dns-direct BEFORE the tunnel is up (otherwise it's a vicious circle). If direct DNS is dead
// (in Russia, Google/Cloudflare DoH went down this way today), NOT A SINGLE node comes up, and
// the error looks vague ("i/o timeout"). dns-guard.js periodically (and before
// connecting) calls this command to tell a live resolver from a dead one and
// switch to a fallback if needed. Returns: "ok" | "dead" | "skip".
//
// Supported direct-DNS formats: udp://host[:port] and a bare host (→ UDP:53),
// https://host/path (DoH, RFC 8484 wire format via GET ?dns=). tls/tcp/quic/
// local/system → "skip" (we can't probe them — we don't count them as dead so the watchdog doesn't
// switch needlessly). We check actual RESOLUTION (ANCOUNT>0), not mere reachability.

use rand_core::{OsRng, RngCore};
use std::time::Duration;
use tokio::net::UdpSocket;

const MAX_DOH_RESPONSE_BYTES: usize = 64 * 1024;

// Builds a DNS A-query wire packet for host. The transaction ID is random: a fixed
// ID let a stray/late UDP packet predictably pass the first check.
fn build_dns_query(host: &str) -> Result<Vec<u8>, String> {
    let host = host.trim().trim_end_matches('.');
    if host.is_empty() {
        return Err("DNS probe host is empty".into());
    }

    let labels: Vec<&str> = host.split('.').collect();
    let encoded_name_len = labels.iter().try_fold(1usize, |total, label| {
        if label.is_empty() {
            return Err("DNS probe host has an empty label".to_string());
        }
        let len = label.len();
        if len > 63 {
            return Err(format!("DNS label is longer than 63 bytes: {len}"));
        }
        total
            .checked_add(1 + len)
            .ok_or_else(|| "DNS probe host is too long".to_string())
    })?;
    if encoded_name_len > 255 {
        return Err("DNS probe host is longer than 255 wire bytes".into());
    }

    let mut p = Vec::with_capacity(12 + encoded_name_len + 4);
    let mut id = [0u8; 2];
    OsRng.fill_bytes(&mut id);
    p.extend_from_slice(&id);
    p.extend_from_slice(&0x0100u16.to_be_bytes()); // flags: RD
    p.extend_from_slice(&1u16.to_be_bytes()); // qdcount
    p.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // an/ns/ar count = 0
    for label in labels {
        let bytes = label.as_bytes();
        p.push(bytes.len() as u8);
        p.extend_from_slice(bytes);
    }
    p.push(0); // root label
    p.extend_from_slice(&1u16.to_be_bytes()); // qtype A
    p.extend_from_slice(&1u16.to_be_bytes()); // qclass IN
    Ok(p)
}

// ANCOUNT from the DNS response header (bytes 6..8). >0 = the resolver actually answered
// with records, not just "the socket opened".
fn answer_count(resp: &[u8]) -> u16 {
    if resp.len() < 8 {
        return 0;
    }
    u16::from_be_bytes([resp[6], resp[7]])
}

#[derive(Debug, PartialEq, Eq)]
struct DnsQuestion {
    labels: Vec<Vec<u8>>,
    qtype: u16,
    qclass: u16,
}

fn read_dns_name(message: &[u8], start: usize) -> Result<(Vec<Vec<u8>>, usize), String> {
    let mut labels = Vec::new();
    let mut cursor = start;
    let mut consumed_end = None;
    let mut visited = std::collections::HashSet::new();

    loop {
        if cursor >= message.len() || !visited.insert(cursor) {
            return Err("invalid or cyclic DNS name".into());
        }
        let len = message[cursor];
        if len & 0xc0 == 0xc0 {
            let next = *message
                .get(cursor + 1)
                .ok_or("truncated DNS compression pointer")?;
            let pointer = (usize::from(len & 0x3f) << 8) | usize::from(next);
            if pointer >= message.len() {
                return Err("DNS compression pointer outside the packet".into());
            }
            consumed_end.get_or_insert(cursor + 2);
            cursor = pointer;
            continue;
        }
        if len & 0xc0 != 0 {
            return Err("unsupported DNS label type".into());
        }
        cursor += 1;
        if len == 0 {
            return Ok((labels, consumed_end.unwrap_or(cursor)));
        }
        let label_len = usize::from(len);
        if label_len > 63 {
            return Err("DNS label is longer than 63 bytes".into());
        }
        let end = cursor.checked_add(label_len).ok_or("DNS label overflow")?;
        let label = message
            .get(cursor..end)
            .ok_or("truncated DNS label")?
            .iter()
            .map(|byte| byte.to_ascii_lowercase())
            .collect();
        labels.push(label);
        cursor = end;
    }
}

fn parse_dns_question(message: &[u8], start: usize) -> Result<DnsQuestion, String> {
    let (labels, end) = read_dns_name(message, start)?;
    let fields = message
        .get(end..end + 4)
        .ok_or("truncated DNS QTYPE/QCLASS")?;
    Ok(DnsQuestion {
        labels,
        qtype: u16::from_be_bytes([fields[0], fields[1]]),
        qclass: u16::from_be_bytes([fields[2], fields[3]]),
    })
}

fn validate_dns_response(resp: &[u8], query: &[u8]) -> Result<(), String> {
    if resp.len() < 12 || query.len() < 17 {
        return Err("invalid DNS response (short packet)".into());
    }
    if resp[..2] != query[..2] || resp[2] & 0x80 == 0 {
        return Err("invalid DNS response (id/QR mismatch)".into());
    }
    let rcode = resp[3] & 0x0f;
    if rcode != 0 {
        return Err(format!("DNS response returned RCODE={rcode}"));
    }
    let qdcount = u16::from_be_bytes([resp[4], resp[5]]);
    if qdcount != 1 {
        return Err(format!("DNS response has QDCOUNT={qdcount}, expected 1"));
    }

    // QNAME is case-insensitive and may use wire compression.
    // We compare parsed labels + numeric QTYPE/QCLASS, keeping
    // protection against a response for another hostname without false dead on a valid echo.
    if parse_dns_question(resp, 12)? != parse_dns_question(query, 12)? {
        return Err("DNS response answers a different question".into());
    }

    if answer_count(resp) > 0 {
        return Ok(());
    }
    // TC=1 means "the answer didn't fit into UDP, retry over TCP". The resolver still
    // answered, so it is alive; declaring it dead and sending the watchdog to the fallback
    // because of the response size is wrong.
    if resp[2] & 0x02 != 0 {
        return Ok(());
    }
    Err("response has no records (ANCOUNT=0)".into())
}

// host[:port] → host:port (adds the default if missing). IPv6 is expected in
// brackets ([::1] / [::1]:53); bare IPv6 without brackets is not supported (rare for
// direct DNS, usually udp://[...]).
fn ensure_port(host: &str, default: u16) -> String {
    if host.starts_with('[') {
        if host.contains("]:") {
            host.to_string()
        } else {
            format!("{host}:{default}")
        }
    } else if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:{default}")
    }
}

enum Target {
    Udp(String), // host:port for UDP DNS
    Doh(String), // full https URL
    Skip,        // a format we don't probe
}

// The resolver address comes from the frontend, so the probe target must be restricted.
// BUT the policy here is deliberately softer than for subscriptions (subscription.rs): unlike
// a subscription URL, the DNS address is a setting the user enters themselves, and
// a local resolver is normal here (router 192.168.x.1, Pi-hole/AdGuard on the LAN or
// loopback, sing-box's own resolver). Blocking them would break
// a working configuration.
//
// We only reject what cannot be a resolver and is a classic
// SSRF target: link-local (including cloud metadata 169.254.169.254), unspecified,
// multicast and documentation/benchmark ranges.
fn is_impossible_resolver_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let octets = ip.octets();
            ip.is_unspecified()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
                || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                || octets[0] >= 240
        }
        std::net::IpAddr::V6(ip) => {
            let segments = ip.segments();
            ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unicast_link_local()
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || ip
                    .to_ipv4()
                    .is_some_and(|mapped| is_impossible_resolver_ip(std::net::IpAddr::V4(mapped)))
        }
    }
}

fn reject_forbidden_host(host: &str) -> Result<(), String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_impossible_resolver_ip(ip) {
            return Err(crate::util::i18n_error("backend.dns.notResolver"));
        }
    }
    Ok(())
}

fn host_of(host_port: &str) -> &str {
    if let Some(rest) = host_port.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    match host_port.rsplit_once(':') {
        Some((host, _)) => host,
        None => host_port,
    }
}

fn parse_target(dns: &str) -> Result<Target, String> {
    let s = dns.trim();
    if s.is_empty() || s == "local" || s == "system" {
        return Ok(Target::Skip);
    }
    if s.starts_with("https://") {
        let url =
            reqwest::Url::parse(s).map_err(|_| crate::util::i18n_error("backend.dns.badDoh"))?;
        let host = url
            .host_str()
            .ok_or_else(|| crate::util::i18n_error("backend.dns.badDoh"))?
            .to_string();
        reject_forbidden_host(&host)?;
        return Ok(Target::Doh(url.to_string()));
    }
    if let Some(rest) = s.strip_prefix("udp://") {
        let host_port = ensure_port(rest, 53);
        reject_forbidden_host(host_of(&host_port))?;
        return Ok(Target::Udp(host_port));
    }
    // tls/tcp/quic — not probed (we don't implement a wire protocol probe for them).
    if s.contains("://") {
        return Ok(Target::Skip);
    }
    // Bare host/IP → UDP:53 (like parseDnsAddress in singbox.js).
    let host_port = ensure_port(s, 53);
    reject_forbidden_host(host_of(&host_port))?;
    Ok(Target::Udp(host_port))
}

// Ok = the resolver answered with records; Err = the cause of death (goes to the frontend in detail
// for console diagnostics — a bool lost it, and "why dead" could not be figured out).
async fn probe_udp(host_port: &str, query: &[u8], timeout: Duration) -> Result<(), String> {
    // One shared deadline covers the system resolve and all returned addresses.
    // Otherwise lookup_host was unbounded, and every IPv4/IPv6 address got another
    // full timeout — the declared 4 seconds turned into N×4 seconds.
    let deadline = tokio::time::Instant::now() + timeout;
    let addresses: Vec<_> = tokio::time::timeout_at(deadline, tokio::net::lookup_host(host_port))
        .await
        .map_err(|_| format!("resolve {host_port}: timeout"))?
        .map_err(|e| format!("resolve {host_port}: {e}"))?
        .collect();
    if addresses.is_empty() {
        return Err(format!("resolve {host_port}: no addresses"));
    }
    // The name could resolve into a range where a resolver cannot be (e.g. into
    // cloud metadata 169.254.169.254). We reject the whole answer, not just the first
    // address: otherwise mixing in a single such A record would be enough.
    if addresses
        .iter()
        .any(|address| is_impossible_resolver_ip(address.ip()))
    {
        return Err(crate::util::i18n_error("backend.dns.notResolver"));
    }
    let mut errors = Vec::new();
    for address in addresses {
        match tokio::time::timeout_at(deadline, probe_udp_addr(address, query)).await {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(e)) => errors.push(format!("{address}: {e}")),
            Err(_) => {
                errors.push(format!("{address}: timeout"));
                break;
            }
        }
    }
    Err(errors.join("; "))
}

fn udp_bind_addr(address: std::net::SocketAddr) -> &'static str {
    if address.is_ipv6() {
        "[::]:0"
    } else {
        "0.0.0.0:0"
    }
}

async fn probe_udp_addr(address: std::net::SocketAddr, query: &[u8]) -> Result<(), String> {
    let sock = UdpSocket::bind(udp_bind_addr(address))
        .await
        .map_err(|e| format!("bind: {e}"))?;
    sock.connect(address)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    sock.send(query).await.map_err(|e| format!("send: {e}"))?;
    // 512 is the response ceiling for a query WITHOUT EDNS0 (our case), but there are
    // resolvers that don't respect it. On Windows a datagram larger than the buffer
    // isn't silently truncated as on unix, but fails `recv` with WSAEMSGSIZE — so
    // a live but verbose resolver got the "dead" verdict. We take it with headroom.
    let mut buf = [0u8; 4096];
    match sock.recv(&mut buf).await {
        Ok(n) => {
            let resp = &buf[..n];
            // The response must echo the transaction id and the original question, carry
            // the QR bit and a successful RCODE — otherwise a stray/erroneous packet must not
            // "revive" a dead resolver.
            validate_dns_response(resp, query)
        }
        Err(e) => Err(format!("recv: {e}")),
    }
}

// ⚠️ DoH servers (Quad9, Yandex) REQUIRE HTTP/2: on HTTP/1.1 Quad9 returns 505,
// Yandex drops the connection. That's why reqwest in Cargo.toml is built with the "http2" feature —
// without it this probe buried ANY live DoH (the watchdog spammed the fallback). If
// you trim reqwest features — leave http2 alone.
async fn probe_doh(url: &str, query: &[u8], timeout: Duration) -> Result<(), String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let b64 = URL_SAFE_NO_PAD.encode(query);
    let full = if url.contains('?') {
        format!("{url}&dns={b64}")
    } else {
        format!("{url}?dns={b64}")
    };
    let client = crate::util::direct_client_builder()
        // connect is no longer than the overall budget (previously connect 3 s > timeout 2.5 s).
        .connect_timeout(timeout.min(Duration::from_secs(3)))
        .timeout(timeout)
        // A DoH resolver has nothing to redirect. Automatic reqwest redirects
        // would bypass the address check: the next hop is validated by nobody and
        // can lead the probe into the internal network.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let resp = client
        .get(full)
        .header("accept", "application/dns-message")
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let body = crate::util::read_response_capped(resp, MAX_DOH_RESPONSE_BYTES, "DoH").await?;
    validate_dns_response(&body, query)
}

#[derive(serde::Serialize)]
pub struct DnsProbeResult {
    pub status: &'static str, // "ok" | "dead" | "skip"
    /// The reason for "dead" — the frontend writes it to the console for diagnostics.
    pub detail: Option<String>,
}

/// Tries to resolve `host` through the resolver `dns`. status:
///   "ok"   — the resolver answered with records (alive);
///   "dead" — didn't answer in time / error (detail = reason);
///   "skip" — the resolver format isn't covered by the probe (tls/tcp/quic/local) — left alone.
#[tauri::command]
pub async fn dns_probe(
    dns: String,
    host: String,
    timeout_ms: Option<u64>,
) -> Result<DnsProbeResult, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(4000).clamp(300, 10_000));
    let query = build_dns_query(&host)?;
    let res = match parse_target(&dns)? {
        Target::Skip => {
            return Ok(DnsProbeResult {
                status: "skip",
                detail: None,
            })
        }
        Target::Udp(hp) => probe_udp(&hp, &query, timeout).await,
        Target::Doh(url) => probe_doh(&url, &query, timeout).await,
    };
    Ok(match res {
        Ok(()) => DnsProbeResult {
            status: "ok",
            detail: None,
        },
        Err(e) => DnsProbeResult {
            status: "dead",
            detail: Some(e),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_response(query: &[u8]) -> Vec<u8> {
        let mut response = vec![0u8; 12];
        response[..2].copy_from_slice(&query[..2]);
        response[2] = 0x80; // QR
        response[4..6].copy_from_slice(&1u16.to_be_bytes()); // QDCOUNT
        response[6..8].copy_from_slice(&1u16.to_be_bytes()); // ANCOUNT
        response.extend_from_slice(&query[12..]);
        response
    }

    #[test]
    fn dns_query_shape() {
        let q = build_dns_query("example.com").unwrap();
        // header(12) + 7(example) + 3(com) + 1(root) + qtype(2) + qclass(2)
        assert_eq!(q.len(), 12 + (1 + 7) + (1 + 3) + 1 + 2 + 2);
        assert_eq!(&q[4..6], &1u16.to_be_bytes()); // qdcount=1
        assert_eq!(q[12], 7); // first label "example"
    }

    #[test]
    fn invalid_dns_names_are_rejected_instead_of_truncated() {
        assert!(build_dns_query("").is_err());
        assert!(build_dns_query("a..example").is_err());
        assert!(build_dns_query(&format!("{}.example", "a".repeat(64))).is_err());
    }

    // TC=1 means "didn't fit into UDP, retry over TCP": the resolver answered, so
    // it is alive. Previously such a response went to "dead" and sent the watchdog to the fallback.
    #[test]
    fn a_truncated_answer_still_proves_the_resolver_is_alive() {
        let query = build_dns_query("example.com").unwrap();
        let mut truncated = valid_response(&query);
        truncated[2] |= 0x02; // TC
        truncated[6..8].copy_from_slice(&0u16.to_be_bytes()); // ANCOUNT=0
        assert!(validate_dns_response(&truncated, &query).is_ok());

        // Without TC an empty answer is still not a confirmation.
        let mut empty = valid_response(&query);
        empty[6..8].copy_from_slice(&0u16.to_be_bytes());
        assert!(validate_dns_response(&empty, &query).is_err());
    }

    #[test]
    fn answer_count_reads_header() {
        let mut resp = vec![0u8; 12];
        resp[6] = 0;
        resp[7] = 3;
        assert_eq!(answer_count(&resp), 3);
        assert_eq!(answer_count(&[0, 0]), 0); // short answer
    }

    #[test]
    fn parse_target_variants() {
        assert!(
            matches!(parse_target("udp://77.88.8.8"), Ok(Target::Udp(hp)) if hp == "77.88.8.8:53")
        );
        assert!(matches!(parse_target("77.88.8.8"), Ok(Target::Udp(hp)) if hp == "77.88.8.8:53"));
        assert!(
            matches!(parse_target("udp://1.1.1.1:5353"), Ok(Target::Udp(hp)) if hp == "1.1.1.1:5353")
        );
        assert!(matches!(
            parse_target("https://149.112.112.112/dns-query"),
            Ok(Target::Doh(_))
        ));
        assert!(matches!(parse_target("tls://8.8.8.8"), Ok(Target::Skip)));
        assert!(matches!(parse_target("local"), Ok(Target::Skip)));
        assert!(matches!(parse_target(""), Ok(Target::Skip)));
    }

    // The target gate must cut classic SSRF addresses but NOT touch local
    // resolvers: a router and Pi-hole/AdGuard on the LAN are a legitimate user
    // setting, not an attack.
    #[test]
    fn probe_target_refuses_only_impossible_resolvers() {
        for dns in [
            "169.254.169.254",
            "udp://169.254.169.254:53",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "203.0.113.5",
            "https://169.254.169.254/dns-query",
            "https://[fe80::1]/dns-query",
        ] {
            assert!(
                parse_target(dns).is_err(),
                "{dns} не может быть резолвером и обязан отвергаться"
            );
        }
        // Both public and local resolvers keep working.
        for dns in [
            "1.1.1.1",
            "udp://77.88.8.8:53",
            "127.0.0.1",
            "udp://127.0.0.1:5353",
            "192.168.1.1",
            "udp://10.0.0.1",
            "https://dns.quad9.net/dns-query",
            "https://[2606:4700:4700::1111]/dns-query",
            "https://192.168.0.1/dns-query",
        ] {
            assert!(parse_target(dns).is_ok(), "{dns} обязан оставаться рабочим");
        }
    }

    #[test]
    fn host_of_handles_bare_ipv6_and_ports() {
        assert_eq!(host_of("1.1.1.1:53"), "1.1.1.1");
        assert_eq!(host_of("[2606:4700:4700::1111]:53"), "2606:4700:4700::1111");
        assert_eq!(host_of("dns.example"), "dns.example");
    }

    #[test]
    fn udp_bind_matches_target_address_family() {
        assert_eq!(udp_bind_addr("1.1.1.1:53".parse().unwrap()), "0.0.0.0:0");
        assert_eq!(
            udp_bind_addr("[2606:4700:4700::1111]:53".parse().unwrap()),
            "[::]:0"
        );
    }

    #[test]
    fn dns_response_requires_matching_id_qr_and_question() {
        let query = build_dns_query("example.com").unwrap();
        let mut response = valid_response(&query);
        assert!(validate_dns_response(&response, &query).is_ok());

        response[0] ^= 1;
        assert!(validate_dns_response(&response, &query).is_err());
        response = valid_response(&query);
        response[12] ^= 1;
        assert!(validate_dns_response(&response, &query).is_err());
    }

    #[test]
    fn dns_question_comparison_is_case_insensitive() {
        let query = build_dns_query("example.com").unwrap();
        let mut response = valid_response(&query);
        response[13..20].make_ascii_uppercase();
        assert!(validate_dns_response(&response, &query).is_ok());
    }

    #[test]
    fn dns_name_parser_supports_compression_pointers() {
        let mut message = build_dns_query("example.com").unwrap();
        let pointer_offset = message.len();
        message.extend_from_slice(&[0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01]);
        assert_eq!(
            parse_dns_question(&message, pointer_offset).unwrap(),
            parse_dns_question(&message, 12).unwrap()
        );
    }

    #[test]
    fn dns_name_parser_rejects_pointer_loops() {
        let mut message = vec![0u8; 18];
        message[12] = 0xc0;
        message[13] = 0x0c;
        assert!(parse_dns_question(&message, 12).is_err());
    }

    #[test]
    fn dns_response_rejects_error_rcode_and_wrong_qdcount() {
        let query = build_dns_query("example.com").unwrap();
        let mut response = valid_response(&query);
        response[3] = 3; // NXDOMAIN
        assert!(validate_dns_response(&response, &query).is_err());

        response = valid_response(&query);
        response[4..6].copy_from_slice(&0u16.to_be_bytes());
        assert!(validate_dns_response(&response, &query).is_err());
    }
}
