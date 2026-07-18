// Ninety · активная проба direct-DNS (для DNS-watchdog фронта).
//
// Зачем: имя сервера ноды (напр. de1.example.com) sing-box резолвит через
// dns-direct ДО поднятия туннеля (иначе замкнутый круг). Если direct-DNS мёртв
// (в РФ так сегодня легли Google/Cloudflare DoH), НИ ОДНА нода не поднимается, а
// ошибка выглядит невнятно («i/o timeout»). dns-guard.js периодически (и перед
// коннектом) зовёт эту команду, чтобы отличить живой резолвер от мёртвого и при
// нужде переключиться на резерв. Возврат: "ok" | "dead" | "skip".
//
// Поддержаны форматы direct-DNS: udp://host[:port] и голый host (→ UDP:53),
// https://host/path (DoH, RFC 8484 wireformat через GET ?dns=). tls/tcp/quic/
// local/system → "skip" (пробу не умеем — не считаем мёртвым, чтобы watchdog не
// переключал зря). Проверяем именно РЕЗОЛЮЦИЮ (ANCOUNT>0), не просто доступность.

use rand_core::{OsRng, RngCore};
use std::time::Duration;
use tokio::net::UdpSocket;

const MAX_DOH_RESPONSE_BYTES: usize = 64 * 1024;

// Собирает DNS A-query wire-packet для host. Transaction ID случайный: фиксированный
// ID позволял постороннему/запоздалому UDP-пакету предсказуемо пройти первую проверку.
fn build_dns_query(host: &str) -> Result<Vec<u8>, String> {
    let host = host.trim().trim_end_matches('.');
    if host.is_empty() {
        return Err("DNS probe host пуст".into());
    }

    let labels: Vec<&str> = host.split('.').collect();
    let encoded_name_len = labels.iter().try_fold(1usize, |total, label| {
        if label.is_empty() {
            return Err("DNS probe host содержит пустой label".to_string());
        }
        let len = label.len();
        if len > 63 {
            return Err(format!("DNS label длиннее 63 байт: {len}"));
        }
        total
            .checked_add(1 + len)
            .ok_or_else(|| "DNS probe host слишком длинный".to_string())
    })?;
    if encoded_name_len > 255 {
        return Err("DNS probe host длиннее 255 байт в wire-формате".into());
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
    p.push(0); // корневой label
    p.extend_from_slice(&1u16.to_be_bytes()); // qtype A
    p.extend_from_slice(&1u16.to_be_bytes()); // qclass IN
    Ok(p)
}

// ANCOUNT из заголовка DNS-ответа (байты 6..8). >0 = резолвер реально ответил
// записями, а не просто «сокет открылся».
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
            return Err("невалидное или циклическое DNS-имя".into());
        }
        let len = message[cursor];
        if len & 0xc0 == 0xc0 {
            let next = *message
                .get(cursor + 1)
                .ok_or("обрезанный DNS compression pointer")?;
            let pointer = (usize::from(len & 0x3f) << 8) | usize::from(next);
            if pointer >= message.len() {
                return Err("DNS compression pointer вне пакета".into());
            }
            consumed_end.get_or_insert(cursor + 2);
            cursor = pointer;
            continue;
        }
        if len & 0xc0 != 0 {
            return Err("неподдерживаемый DNS label type".into());
        }
        cursor += 1;
        if len == 0 {
            return Ok((labels, consumed_end.unwrap_or(cursor)));
        }
        let label_len = usize::from(len);
        if label_len > 63 {
            return Err("DNS label длиннее 63 байт".into());
        }
        let end = cursor.checked_add(label_len).ok_or("DNS label overflow")?;
        let label = message
            .get(cursor..end)
            .ok_or("обрезанный DNS label")?
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
        .ok_or("обрезанные DNS QTYPE/QCLASS")?;
    Ok(DnsQuestion {
        labels,
        qtype: u16::from_be_bytes([fields[0], fields[1]]),
        qclass: u16::from_be_bytes([fields[2], fields[3]]),
    })
}

fn validate_dns_response(resp: &[u8], query: &[u8]) -> Result<(), String> {
    if resp.len() < 12 || query.len() < 17 {
        return Err("невалидный DNS-ответ (короткий пакет)".into());
    }
    if resp[..2] != query[..2] || resp[2] & 0x80 == 0 {
        return Err("невалидный DNS-ответ (id/QR не совпали)".into());
    }
    let rcode = resp[3] & 0x0f;
    if rcode != 0 {
        return Err(format!("DNS-ответ вернул RCODE={rcode}"));
    }
    let qdcount = u16::from_be_bytes([resp[4], resp[5]]);
    if qdcount != 1 {
        return Err(format!("DNS-ответ содержит QDCOUNT={qdcount}, ожидался 1"));
    }

    // QNAME регистронезависим и может использовать wire compression.
    // Сравниваем разобранные labels + числовые QTYPE/QCLASS, сохраняя
    // защиту от ответа на другой hostname без ложных dead на валидное эхо.
    if parse_dns_question(resp, 12)? != parse_dns_question(query, 12)? {
        return Err("DNS-ответ относится к другому question".into());
    }

    if answer_count(resp) > 0 {
        Ok(())
    } else {
        Err("ответ без записей (ANCOUNT=0)".into())
    }
}

// host[:port] → host:port (добавляет default при отсутствии). IPv6 ожидаем в
// скобках ([::1] / [::1]:53); голый IPv6 без скобок не поддержан (редко для
// direct-DNS, обычно udp://[...]).
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
    Udp(String), // host:port для UDP DNS
    Doh(String), // полный https URL
    Skip,        // формат, который не пробуем
}

fn parse_target(dns: &str) -> Target {
    let s = dns.trim();
    if s.is_empty() || s == "local" || s == "system" {
        return Target::Skip;
    }
    if s.starts_with("https://") {
        return Target::Doh(s.to_string());
    }
    if let Some(rest) = s.strip_prefix("udp://") {
        return Target::Udp(ensure_port(rest, 53));
    }
    // tls/tcp/quic — не пробуем (пробу wire-протокола для них не делаем).
    if s.contains("://") {
        return Target::Skip;
    }
    // Голый host/IP → UDP:53 (как parseDnsAddress в singbox.js).
    Target::Udp(ensure_port(s, 53))
}

// Ok = резолвер ответил записями; Err = причина смерти (уходит фронту в detail
// для console-диагностики — bool терял её, и «почему dead» было не выяснить).
async fn probe_udp(host_port: &str, query: &[u8], timeout: Duration) -> Result<(), String> {
    // Один общий deadline включает системный resolve и все полученные адреса.
    // Иначе lookup_host был безлимитным, а каждый IPv4/IPv6 адрес получал ещё
    // полный timeout — заявленные 4 секунды превращались в N×4 секунд.
    let deadline = tokio::time::Instant::now() + timeout;
    let addresses: Vec<_> = tokio::time::timeout_at(deadline, tokio::net::lookup_host(host_port))
        .await
        .map_err(|_| format!("resolve {host_port}: timeout"))?
        .map_err(|e| format!("resolve {host_port}: {e}"))?
        .collect();
    if addresses.is_empty() {
        return Err(format!("resolve {host_port}: no addresses"));
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
    let mut buf = [0u8; 512];
    match sock.recv(&mut buf).await {
        Ok(n) => {
            let resp = &buf[..n];
            // Ответ обязан эхо-нуть transaction id и исходный question, нести
            // QR-бит и успешный RCODE — иначе залётный/ошибочный пакет не должен
            // «оживлять» мёртвый резолвер.
            validate_dns_response(resp, query)
        }
        Err(e) => Err(format!("recv: {e}")),
    }
}

// ⚠️ DoH-серверы (Quad9, Yandex) ТРЕБУЮТ HTTP/2: на HTTP/1.1 Quad9 отдаёт 505,
// Yandex рвёт соединение. Поэтому reqwest в Cargo.toml собран с фичей "http2" —
// без неё эта проба хоронила ЛЮБОЙ живой DoH (watchdog спамил фолбэком). Если
// урезаешь фичи reqwest — http2 не трогать.
async fn probe_doh(url: &str, query: &[u8], timeout: Duration) -> Result<(), String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let b64 = URL_SAFE_NO_PAD.encode(query);
    let full = if url.contains('?') {
        format!("{url}&dns={b64}")
    } else {
        format!("{url}?dns={b64}")
    };
    let client = reqwest::Client::builder()
        // connect не длиннее общего бюджета (раньше connect 3с > timeout 2.5с).
        .connect_timeout(timeout.min(Duration::from_secs(3)))
        .timeout(timeout)
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
    /// Причина при "dead" — фронт пишет её в console для диагностики.
    pub detail: Option<String>,
}

/// Пробует зарезолвить `host` через резолвер `dns`. status:
///   "ok"   — резолвер ответил записями (жив);
///   "dead" — не ответил в срок / ошибка (detail = причина);
///   "skip" — формат резолвера пробой не покрыт (tls/tcp/quic/local) — не трогаем.
#[tauri::command]
pub async fn dns_probe(
    dns: String,
    host: String,
    timeout_ms: Option<u64>,
) -> Result<DnsProbeResult, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(4000).clamp(300, 10_000));
    let query = build_dns_query(&host)?;
    let res = match parse_target(&dns) {
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
        assert_eq!(q[12], 7); // первый label "example"
    }

    #[test]
    fn invalid_dns_names_are_rejected_instead_of_truncated() {
        assert!(build_dns_query("").is_err());
        assert!(build_dns_query("a..example").is_err());
        assert!(build_dns_query(&format!("{}.example", "a".repeat(64))).is_err());
    }

    #[test]
    fn answer_count_reads_header() {
        let mut resp = vec![0u8; 12];
        resp[6] = 0;
        resp[7] = 3;
        assert_eq!(answer_count(&resp), 3);
        assert_eq!(answer_count(&[0, 0]), 0); // короткий ответ
    }

    #[test]
    fn parse_target_variants() {
        assert!(matches!(parse_target("udp://77.88.8.8"), Target::Udp(hp) if hp == "77.88.8.8:53"));
        assert!(matches!(parse_target("77.88.8.8"), Target::Udp(hp) if hp == "77.88.8.8:53"));
        assert!(
            matches!(parse_target("udp://1.1.1.1:5353"), Target::Udp(hp) if hp == "1.1.1.1:5353")
        );
        assert!(matches!(
            parse_target("https://149.112.112.112/dns-query"),
            Target::Doh(_)
        ));
        assert!(matches!(parse_target("tls://8.8.8.8"), Target::Skip));
        assert!(matches!(parse_target("local"), Target::Skip));
        assert!(matches!(parse_target(""), Target::Skip));
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
