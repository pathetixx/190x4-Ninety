// CF WARP endpoint scanner.
//
// Two modes:
//   * "tcp" — TCP-connect ping over IP×port pairs. Fast, a fallback when there is no
//     WARP registration.
//   * "wg"  — a real WG handshake init packet via boringtun, we wait for the response
//     (msg_type=2). More accurate — filters out "port open but WARP doesn't answer".
//     Uses the keys from writable config dir/warp.json. The reserved bytes (CF
//     client_id routing) are substituted, MAC1 is recomputed via blake2.
//
// IP ranges and ports come from the publicly known CF endpoint pool
// (see bepass-org/warp-plus/warp/endpoint.go, MIT).

use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::net::{TcpStream, UdpSocket};

#[derive(Default)]
pub struct WarpScanState {
    generation: AtomicU64,
}

// CF WARP subnets with real WG endpoints. Each /24 contains several
// hundred live IPs. We take random samples from them.
// The regular pool (8) — the main subnets, the deep pool (≈22) — the full set from
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

// Standard Cloudflare WG ports (part of the known pool from warp-plus).
const CF_PORTS: &[u16] = &[
    2408, 500, 1701, 4500, 854, 859, 864, 878, 880, 890, 891, 894, 903, 908,
];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScanResult {
    pub ip: String,
    pub port: u16,
    pub latency_ms: u64,
    /// "tcp" or "wg" — how the latency was measured
    pub method: String,
}

fn pseudo_random_sample(per_subnet: usize, deep: bool) -> Vec<SocketAddr> {
    // We don't use external rand — a simple LCG on nanoseconds for the seed.
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15);
    pseudo_random_sample_with_seed(per_subnet, deep, seed)
}

fn pseudo_random_sample_with_seed(per_subnet: usize, deep: bool, seed: u64) -> Vec<SocketAddr> {
    let mut state = seed;
    let next = |s: &mut u64| -> u32 {
        *s = s
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (*s >> 33) as u32
    };

    let subnets: &[(&str, u32, u32)] = if deep {
        CF_SUBNETS_DEEP
    } else {
        CF_SUBNETS_BASE
    };
    let mut targets: Vec<SocketAddr> =
        Vec::with_capacity(subnets.len() * per_subnet * CF_PORTS.len());
    for (prefix, lo, hi) in subnets {
        // Fisher–Yates: IPs within a /24 don't repeat in one scan.
        let mut hosts: Vec<u32> = (*lo..=*hi).collect();
        for i in (1..hosts.len()).rev() {
            let j = (next(&mut state) as usize) % (i + 1);
            hosts.swap(i, j);
        }
        for last in hosts.into_iter().take(per_subnet) {
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
// We build a real WG init packet via boringtun, replace the header's reserved bytes
// with the CF client_id (the first 3 bytes) and recompute MAC1 — otherwise CF
// won't accept the packet.
//
// reserved bytes: in original WG they are [0,0,0] (part of the LE encoding of
// message_type=1). CF uses them as a routing key for multi-tenancy. See
// the Reserved [3]byte field in wireguard-go.

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

    // client_id — base64 of the 3 reserved bytes
    let cid = B64.decode(info.client_id.as_bytes()).unwrap_or_default();
    let mut reserved = [0u8; 3];
    let n = 3.min(cid.len());
    reserved[..n].copy_from_slice(&cid[..n]);
    Some(WgKeys {
        private: StaticSecret::from(p_arr),
        peer_public: PublicKey::from(pub_arr),
        reserved,
    })
}

// Recomputes MAC1 in an already built WG handshake init packet.
// Layout init packet: [0..1] type, [1..4] reserved, [4..8] sender, [8..40]
// ephemeral, [40..88] enc_static, [88..116] enc_timestamp, [116..132] MAC1,
// [132..148] MAC2. 148 bytes in total.
//
// MAC1 = BLAKE2s-128(key=BLAKE2s-256("mac1----" || peer_static_pub), data=msg[..116])
fn recompute_mac1(packet: &mut [u8], peer_pub: &[u8; 32]) {
    use blake2::digest::{KeyInit, Mac};
    use blake2::{digest::consts::U16, Blake2s256, Blake2sMac, Digest};

    let mut h = Blake2s256::new();
    Digest::update(&mut h, b"mac1----");
    Digest::update(&mut h, peer_pub.as_ref());
    let key = h.finalize();

    // KeyInit and Mac both define new_from_slice — disambiguation is needed
    type Mac16 = Blake2sMac<U16>;
    let mut mac = <Mac16 as KeyInit>::new_from_slice(&key).expect("blake2s 32-byte key");
    Mac::update(&mut mac, &packet[..116]);
    let tag = mac.finalize().into_bytes();
    packet[116..132].copy_from_slice(&tag);
}

async fn wg_ping(addr: SocketAddr, keys: &WgKeys, timeout: Duration) -> Option<u64> {
    // Tunn::new takes private/peer by value — we clone (StaticSecret supports
    // Clone in x25519-dalek 2 with the static_secrets feature). In boringtun 0.7+ it returns
    // Self directly, without a Result.
    let mut tunn = Tunn::new(keys.private.clone(), keys.peer_public, None, None, 0, None);

    let mut buf = [0u8; 256];
    let init_len = match tunn.format_handshake_initiation(&mut buf, true) {
        TunnResult::WriteToNetwork(p) => p.len(),
        _ => return None,
    };
    if init_len != 148 {
        // Must be exactly 148 bytes — the WG init message size is fixed.
        return None;
    }

    // Substitute reserved (bytes 1..4) and recompute MAC1.
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
        // WG handshake response: type=2 (LE), length 92 bytes.
        Ok(Ok(n)) if n == 92 && rx[0] == 2 => Some(start.elapsed().as_millis() as u64),
        _ => None,
    }
}

/// Scans CF WARP endpoints and returns top_n with the best latency.
///
/// per_subnet — how many random IPs to take from each /24 (default 5).
/// concurrency — how many TCP connects in parallel (default 50).
/// timeout_ms — per-connect timeout (default 1500).
/// Scans CF WARP endpoints and returns top_n with the best latency.
///
/// Arguments:
///   per_subnet  — how many random IPs to take from each /24
///                 (deep ? default 15 : 5; clamp 1..30)
///   concurrency — how many probes in parallel (default 50, clamp 1..200; for WG
///                 automatically cut to 32, otherwise a UDP burst catches RST)
///   timeout_ms  — timeout of one probe (default tcp:1500, wg:2200; clamp 200..10000)
///   top_n       — how many of the best to return (default 10, clamp 1..100)
///   deep        — bool, extended subnet pool (~22 vs 8)
///   mode        — "auto" (default — WG if warp.json exists, otherwise TCP) | "tcp" | "wg"
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri IPC keeps compatible top-level args.
pub async fn warp_scan_endpoints(
    app: AppHandle,
    state: State<'_, WarpScanState>,
    per_subnet: Option<usize>,
    concurrency: Option<usize>,
    timeout_ms: Option<u64>,
    top_n: Option<usize>,
    deep: Option<bool>,
    mode: Option<String>,
) -> Result<Vec<ScanResult>, String> {
    let generation = state
        .generation
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    let deep = deep.unwrap_or(false);
    let default_per = if deep { 15 } else { 5 };
    let per_subnet = per_subnet.unwrap_or(default_per).clamp(1, 30);
    let top_n = top_n.unwrap_or(10).clamp(1, 100);
    let mode_req = mode.unwrap_or_else(|| "auto".into());

    // Decide which method to actually run. WG needs keys from warp.json —
    // if they aren't there, any "wg" / "auto" falls back to TCP.
    let warp_info = crate::warp::warp_status(app.clone()).ok().flatten();
    let parsed_keys = warp_info.as_ref().and_then(parse_wg_keys);
    let use_wg = match mode_req.as_str() {
        "wg" => {
            if parsed_keys.is_none() {
                return Err(crate::util::i18n_error("backend.warp.needRegistration"));
            }
            true
        }
        "tcp" => false,
        _ => parsed_keys.is_some(), // auto: broken/legacy keys → TCP fallback
    };
    let method_label: &'static str = if use_wg { "wg" } else { "tcp" };

    // A UDP burst of 200 in parallel catches RST/losses, we limit WG to 32.
    let default_conc = if use_wg { 32 } else { 50 };
    let max_conc = if use_wg { 64 } else { 200 };
    let concurrency = concurrency.unwrap_or(default_conc).clamp(1, max_conc);

    // The WG handshake is a bit slower — increase the default timeout.
    let default_to = if use_wg { 2200 } else { 1500 };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(default_to).clamp(200, 10_000));

    // Parse the keys once to share them between tasks.
    let keys = if use_wg {
        Some(std::sync::Arc::new(parsed_keys.ok_or_else(|| {
            "warp.json: invalid private/peer keys".to_string()
        })?))
    } else {
        None
    };

    let targets = pseudo_random_sample(per_subnet, deep);
    if targets.is_empty() {
        return Err("no targets".into());
    }

    let total = targets.len();
    let probes = stream::iter(targets.into_iter().map(|addr| {
        let keys = keys.clone();
        async move {
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
        }
    }))
    .buffer_unordered(concurrency);
    tokio::pin!(probes);

    let mut results: Vec<ScanResult> = Vec::with_capacity(total / 4);
    let mut completed = 0usize;
    let deadline = tokio::time::sleep(Duration::from_secs(if deep { 30 } else { 15 }));
    let mut cancel_tick = tokio::time::interval(Duration::from_millis(100));
    cancel_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tokio::pin!(deadline);
    loop {
        if state.generation.load(Ordering::SeqCst) != generation {
            return Err(crate::util::i18n_error("backend.warp.scanCancelled"));
        }
        tokio::select! {
            _ = &mut deadline => break,
            _ = cancel_tick.tick() => {
                if state.generation.load(Ordering::SeqCst) != generation {
                    return Err(crate::util::i18n_error("backend.warp.scanCancelled"));
                }
            }
            item = probes.next() => match item {
                Some(result) => {
                    completed += 1;
                    if let Some(r) = result { results.push(r); }
                    if completed == total || completed.is_multiple_of(50) {
                        let _ = app.emit("warp:scan-progress", serde_json::json!({
                            "completed": completed,
                            "total": total,
                            "found": results.len(),
                        }));
                    }
                }
                None => break,
            }
        }
    }
    results.sort_by_key(|r| r.latency_ms);
    results.truncate(top_n);
    Ok(results)
}

#[tauri::command]
pub fn warp_scan_cancel(state: State<'_, WarpScanState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn endpoint_sample_has_no_duplicate_socket_addresses() {
        let targets = pseudo_random_sample_with_seed(30, true, 42);
        let unique: HashSet<_> = targets.iter().copied().collect();
        assert_eq!(unique.len(), targets.len());
        assert_eq!(targets.len(), CF_SUBNETS_DEEP.len() * 30 * CF_PORTS.len());
    }
}
