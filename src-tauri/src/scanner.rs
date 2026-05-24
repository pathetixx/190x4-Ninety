// CF WARP endpoint scanner.
//
// Два режима:
//   * "tcp" — TCP-connect ping по IP×port парам. Быстрый, fallback когда нет
//     WARP-регистрации.
//   * "wg"  — реальный WG handshake init packet через boringtun, ждём response
//     (msg_type=2). Точнее — отсеивает "порт открыт, но WARP не отвечает".
//     Использует ключи из app_config_dir/warp.json. Reserved-байты (CF
//     client_id routing) подменяются, MAC1 пересчитывается через blake2.
//
// IP-диапазоны и порты — из публично известного CF endpoint pool
// (см. bepass-org/warp-plus/warp/endpoint.go, MIT).

use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use tokio::net::{TcpStream, UdpSocket};
use tauri::AppHandle;

// CF WARP подсети с реальными WG-эндпоинтами. Каждая /24 содержит несколько
// сотен живых IP. Берём из них случайные семплы.
// Обычный пул (8) — основные подсети, deep-пул (≈22) — полный набор из
// bepass-org/warp-plus warp/endpoint.go (MIT).
const CF_SUBNETS_BASE: &[(&str, u32, u32)] = &[
    ("162.159.192.", 1, 254),
    ("162.159.193.", 1, 254),
    ("162.159.195.", 1, 254),
    ("162.159.198.", 1, 254),
    ("188.114.96.", 1, 254),
    ("188.114.97.", 1, 254),
    ("188.114.98.", 1, 254),
    ("188.114.99.", 1, 254),
];

const CF_SUBNETS_DEEP: &[(&str, u32, u32)] = &[
    ("162.159.192.", 1, 254),
    ("162.159.193.", 1, 254),
    ("162.159.194.", 1, 254),
    ("162.159.195.", 1, 254),
    ("162.159.196.", 1, 254),
    ("162.159.197.", 1, 254),
    ("162.159.198.", 1, 254),
    ("162.159.199.", 1, 254),
    ("162.159.200.", 1, 254),
    ("162.159.204.", 1, 254),
    ("188.114.96.", 1, 254),
    ("188.114.97.", 1, 254),
    ("188.114.98.", 1, 254),
    ("188.114.99.", 1, 254),
    ("188.114.100.", 1, 254),
    ("188.114.101.", 1, 254),
    ("8.6.112.", 1, 254),
    ("8.6.113.", 1, 254),
    ("8.6.144.", 1, 254),
    ("8.6.145.", 1, 254),
    ("8.6.146.", 1, 254),
    ("8.39.204.", 1, 254),
];

// Стандартные WG-порты Cloudflare (часть известного pool из warp-plus).
const CF_PORTS: &[u16] = &[
    2408, 500, 1701, 4500, 854, 859, 864, 878, 880, 890, 891, 894, 903, 908,
];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScanResult {
    pub ip: String,
    pub port: u16,
    pub latency_ms: u64,
    /// "tcp" или "wg" — каким способом замерили latency
    pub method: String,
}

fn pseudo_random_sample(per_subnet: usize, deep: bool) -> Vec<SocketAddr> {
    // Не используем external rand — простой LCG на nanoseconds для seed.
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15);
    let mut state = seed;
    let next = |s: &mut u64| -> u32 {
        *s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (*s >> 33) as u32
    };

    let subnets: &[(&str, u32, u32)] = if deep { CF_SUBNETS_DEEP } else { CF_SUBNETS_BASE };
    let mut targets: Vec<SocketAddr> = Vec::with_capacity(subnets.len() * per_subnet * CF_PORTS.len());
    for (prefix, lo, hi) in subnets {
        let range = hi - lo + 1;
        for _ in 0..per_subnet {
            let last = lo + (next(&mut state) % range);
            let ip_str = format!("{prefix}{last}");
            for &port in CF_PORTS {
                let full = format!("{ip_str}:{port}");
                if let Ok(addr) = full.parse::<SocketAddr>() {
                    targets.push(addr);
                }
            }
        }
    }
    targets
}

async fn tcp_ping(addr: SocketAddr, timeout: Duration) -> Option<u64> {
    let start = Instant::now();
    let fut = TcpStream::connect(addr);
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(_stream)) => Some(start.elapsed().as_millis() as u64),
        _ => None,
    }
}

// ── WG handshake-ping ─────────────────────────────────────────
// Собираем настоящий WG init packet через boringtun, заменяем reserved-байты
// header'а на CF client_id (первые 3 байта) и пересчитываем MAC1 — иначе CF
// не примет пакет.
//
// reserved-bytes: для оригинального WG там [0,0,0] (часть LE-кодирования
// message_type=1). CF использует их как routing key для multi-tenant. См.
// hiddify/wireguard-go field Reserved [3]byte.

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};

struct WgKeys {
    private: StaticSecret,
    peer_public: PublicKey,
    reserved: [u8; 3],
}

fn parse_wg_keys(info: &crate::warp::WarpInfo) -> Option<WgKeys> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let priv_raw = B64.decode(info.private_key.as_bytes()).ok()?;
    let pub_raw = B64.decode(info.peer_public_key.as_bytes()).ok()?;
    if priv_raw.len() != 32 || pub_raw.len() != 32 {
        return None;
    }
    let mut p_arr = [0u8; 32];
    p_arr.copy_from_slice(&priv_raw);
    let mut pub_arr = [0u8; 32];
    pub_arr.copy_from_slice(&pub_raw);

    // client_id — base64 от 3 байт reserved
    let cid = B64.decode(info.client_id.as_bytes()).unwrap_or_default();
    let mut reserved = [0u8; 3];
    for i in 0..3.min(cid.len()) {
        reserved[i] = cid[i];
    }
    Some(WgKeys {
        private: StaticSecret::from(p_arr),
        peer_public: PublicKey::from(pub_arr),
        reserved,
    })
}

// Пересчитывает MAC1 в already-собранном WG handshake init packet.
// Layout init packet: [0..1] type, [1..4] reserved, [4..8] sender, [8..40]
// ephemeral, [40..88] enc_static, [88..116] enc_timestamp, [116..132] MAC1,
// [132..148] MAC2. Всего 148 байт.
//
// MAC1 = BLAKE2s-128(key=BLAKE2s-256("mac1----" || peer_static_pub), data=msg[..116])
fn recompute_mac1(packet: &mut [u8], peer_pub: &[u8; 32]) {
    use blake2::digest::{KeyInit, Mac, Update};
    use blake2::{digest::consts::U16, Blake2s256, Blake2sMac, Digest};

    let mut h = Blake2s256::new();
    Digest::update(&mut h, b"mac1----");
    Digest::update(&mut h, peer_pub.as_ref());
    let key = h.finalize();

    let mut mac = Blake2sMac::<U16>::new_from_slice(&key)
        .expect("blake2s 32-byte key");
    Mac::update(&mut mac, &packet[..116]);
    let tag = mac.finalize().into_bytes();
    packet[116..132].copy_from_slice(&tag);
}

async fn wg_ping(
    addr: SocketAddr,
    keys: &WgKeys,
    timeout: Duration,
) -> Option<u64> {
    // Tunn::new берёт private/peer by value — клонируем (StaticSecret поддерживает
    // Clone в x25519-dalek 2 с feature static_secrets).
    let mut tunn = Tunn::new(
        keys.private.clone(),
        keys.peer_public,
        None,
        None,
        0,
        None,
    ).ok()?;

    let mut buf = [0u8; 256];
    let init_len = match tunn.format_handshake_initiation(&mut buf, true) {
        TunnResult::WriteToNetwork(p) => p.len(),
        _ => return None,
    };
    if init_len != 148 {
        // Должно быть ровно 148 байт — WG init message size фиксирован.
        return None;
    }

    // Подменяем reserved (bytes 1..4) и пересчитываем MAC1.
    buf[1..4].copy_from_slice(&keys.reserved);
    let peer_pub_bytes = *keys.peer_public.as_bytes();
    recompute_mac1(&mut buf[..init_len], &peer_pub_bytes);

    let socket = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    socket.connect(addr).await.ok()?;

    let start = Instant::now();
    socket.send(&buf[..init_len]).await.ok()?;

    let mut rx = [0u8; 256];
    let recv = socket.recv(&mut rx);
    match tokio::time::timeout(timeout, recv).await {
        // WG handshake response: type=2 (LE), длина 92 байта.
        Ok(Ok(n)) if n == 92 && rx[0] == 2 => Some(start.elapsed().as_millis() as u64),
        _ => None,
    }
}

/// Сканирует CF WARP endpoints и возвращает top_n с лучшей latency.
///
/// per_subnet — сколько случайных IP взять из каждой /24 (по умолчанию 5).
/// concurrency — сколько TCP-коннектов параллельно (по умолчанию 50).
/// timeout_ms — таймаут на коннект (по умолчанию 1500).
/// Сканирует CF WARP endpoints и возвращает top_n с лучшей latency.
///
/// Аргументы:
///   per_subnet  — сколько случайных IP взять из каждой /24
///                 (deep ? default 15 : 5; clamp 1..30)
///   concurrency — сколько проб параллельно (default 50, clamp 1..200; для WG
///                 автоматически режется до 32, иначе UDP-всплеск ловит RST)
///   timeout_ms  — таймаут одной пробы (default tcp:1500, wg:2200; clamp 200..10000)
///   top_n       — сколько лучших вернуть (default 10, clamp 1..100)
///   deep        — bool, расширенный пул подсетей (~22 vs 8)
///   mode        — "auto" (default — WG если есть warp.json, иначе TCP) | "tcp" | "wg"
#[tauri::command]
pub async fn warp_scan_endpoints(
    app: AppHandle,
    per_subnet: Option<usize>,
    concurrency: Option<usize>,
    timeout_ms: Option<u64>,
    top_n: Option<usize>,
    deep: Option<bool>,
    mode: Option<String>,
) -> Result<Vec<ScanResult>, String> {
    let deep = deep.unwrap_or(false);
    let default_per = if deep { 15 } else { 5 };
    let per_subnet = per_subnet.unwrap_or(default_per).clamp(1, 30);
    let top_n = top_n.unwrap_or(10).clamp(1, 100);
    let mode_req = mode.unwrap_or_else(|| "auto".into());

    // Решаем какой метод реально пускать. Для WG нужны ключи из warp.json —
    // если их нет, любой "wg" / "auto" падает на TCP.
    let warp_info = crate::warp::warp_status(app).ok().flatten();
    let use_wg = match mode_req.as_str() {
        "wg" => warp_info.is_some(),
        "tcp" => false,
        _ => warp_info.is_some(), // auto
    };
    let method_label: &'static str = if use_wg { "wg" } else { "tcp" };

    // UDP-всплеск 200 параллельно ловит RST/потери, ограничиваем для WG до 32.
    let default_conc = if use_wg { 32 } else { 50 };
    let max_conc = if use_wg { 64 } else { 200 };
    let concurrency = concurrency.unwrap_or(default_conc).clamp(1, max_conc);

    // WG handshake чуть медленнее — увеличиваем дефолтный таймаут.
    let default_to = if use_wg { 2200 } else { 1500 };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(default_to).clamp(200, 10_000));

    // Парсим ключи один раз для shared между задачами.
    let keys = if use_wg {
        let info = warp_info.as_ref()
            .ok_or_else(|| "WG-режим требует warp.json — зарегистрируйте WARP".to_string())?;
        Some(std::sync::Arc::new(parse_wg_keys(info)
            .ok_or_else(|| "warp.json: невалидные private/peer ключи".to_string())?))
    } else {
        None
    };

    let targets = pseudo_random_sample(per_subnet, deep);
    if targets.is_empty() {
        return Err("no targets".into());
    }

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(concurrency));
    let mut handles = Vec::with_capacity(targets.len());
    for addr in targets {
        let sem = sem.clone();
        let keys = keys.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            let lat = if let Some(k) = keys.as_deref() {
                wg_ping(addr, k, timeout).await?
            } else {
                tcp_ping(addr, timeout).await?
            };
            Some(ScanResult {
                ip: addr.ip().to_string(),
                port: addr.port(),
                latency_ms: lat,
                method: method_label.into(),
            })
        }));
    }

    let mut results: Vec<ScanResult> = Vec::with_capacity(handles.len() / 4);
    for h in handles {
        if let Ok(Some(r)) = h.await {
            results.push(r);
        }
    }
    results.sort_by_key(|r| r.latency_ms);
    results.truncate(top_n);
    Ok(results)
}
