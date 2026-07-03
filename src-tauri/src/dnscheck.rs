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

use std::time::Duration;
use tokio::net::UdpSocket;

// Собирает DNS A-query wire-packet для host. id фиксирован — проба не
// конкурентная, на один запрос один сокет/клиент.
fn build_dns_query(host: &str) -> Vec<u8> {
    let host = host.trim_end_matches('.');
    let mut p = Vec::with_capacity(host.len() + 18);
    p.extend_from_slice(&0x1234u16.to_be_bytes()); // id
    p.extend_from_slice(&0x0100u16.to_be_bytes()); // flags: RD
    p.extend_from_slice(&1u16.to_be_bytes()); // qdcount
    p.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // an/ns/ar count = 0
    for label in host.split('.') {
        // label >63 байт невалиден — обрезаем (защита от кривого host).
        let bytes = label.as_bytes();
        let len = bytes.len().min(63);
        p.push(len as u8);
        p.extend_from_slice(&bytes[..len]);
    }
    p.push(0); // корневой label
    p.extend_from_slice(&1u16.to_be_bytes()); // qtype A
    p.extend_from_slice(&1u16.to_be_bytes()); // qclass IN
    p
}

// ANCOUNT из заголовка DNS-ответа (байты 6..8). >0 = резолвер реально ответил
// записями, а не просто «сокет открылся».
fn answer_count(resp: &[u8]) -> u16 {
    if resp.len() < 8 {
        return 0;
    }
    u16::from_be_bytes([resp[6], resp[7]])
}

// host[:port] → host:port (добавляет default при отсутствии). IPv6 ожидаем в
// скобках ([::1] / [::1]:53); голый IPv6 без скобок не поддержан (редко для
// direct-DNS, обычно udp://[...]).
fn ensure_port(host: &str, default: u16) -> String {
    if host.starts_with('[') {
        if host.contains("]:") { host.to_string() } else { format!("{host}:{default}") }
    } else if host.contains(':') {
        host.to_string()
    } else {
        format!("{host}:{default}")
    }
}

enum Target {
    Udp(String),  // host:port для UDP DNS
    Doh(String),  // полный https URL
    Skip,         // формат, который не пробуем
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
    let sock = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("bind: {e}"))?;
    sock.connect(host_port)
        .await
        .map_err(|e| format!("connect {host_port}: {e}"))?;
    sock.send(query).await.map_err(|e| format!("send: {e}"))?;
    let mut buf = [0u8; 512];
    match tokio::time::timeout(timeout, sock.recv(&mut buf)).await {
        Ok(Ok(n)) => {
            let resp = &buf[..n];
            // Ответ обязан эхо-нуть наш transaction id и нести QR-бит (это
            // ответ, а не запрос) — иначе любой залётный UDP-пакет с ненулевым
            // ANCOUNT «оживлял» бы мёртвый резолвер.
            if n < 12 || resp[..2] != query[..2] || resp[2] & 0x80 == 0 {
                Err("невалидный DNS-ответ (id/QR не совпали)".into())
            } else if answer_count(resp) > 0 {
                Ok(())
            } else {
                Err("ответ без записей (ANCOUNT=0)".into())
            }
        }
        Ok(Err(e)) => Err(format!("recv: {e}")),
        Err(_) => Err("timeout".into()),
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
    let body = resp.bytes().await.map_err(|e| format!("body: {e}"))?;
    if answer_count(&body) > 0 {
        Ok(())
    } else {
        Err("ответ без записей (ANCOUNT=0)".into())
    }
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
    let query = build_dns_query(&host);
    let res = match parse_target(&dns) {
        Target::Skip => return Ok(DnsProbeResult { status: "skip", detail: None }),
        Target::Udp(hp) => probe_udp(&hp, &query, timeout).await,
        Target::Doh(url) => probe_doh(&url, &query, timeout).await,
    };
    Ok(match res {
        Ok(()) => DnsProbeResult { status: "ok", detail: None },
        Err(e) => DnsProbeResult { status: "dead", detail: Some(e) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_query_shape() {
        let q = build_dns_query("example.com");
        // header(12) + 7(example) + 3(com) + 1(root) + qtype(2) + qclass(2)
        assert_eq!(q.len(), 12 + (1 + 7) + (1 + 3) + 1 + 2 + 2);
        assert_eq!(&q[4..6], &1u16.to_be_bytes()); // qdcount=1
        assert_eq!(q[12], 7); // первый label "example"
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
        assert!(matches!(parse_target("udp://1.1.1.1:5353"), Target::Udp(hp) if hp == "1.1.1.1:5353"));
        assert!(matches!(parse_target("https://149.112.112.112/dns-query"), Target::Doh(_)));
        assert!(matches!(parse_target("tls://8.8.8.8"), Target::Skip));
        assert!(matches!(parse_target("local"), Target::Skip));
        assert!(matches!(parse_target(""), Target::Skip));
    }
}
