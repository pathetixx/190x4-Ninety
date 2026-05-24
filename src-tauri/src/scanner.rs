// CF WARP endpoint scanner.
//
// MVP — простой TCP-connect ping по известным CF endpoint IP×port парам.
// Сортировка по latency, возвращает top-N в UI.
//
// Полноценный WG-handshake (как в bepass-org/warp-plus) — отложен до alpha33:
// требует WG init-packet сборки + verify response, без этого можем выбрать IP
// где порт открыт, но WARP отвечает с задержкой/потерями.
//
// IP-диапазоны и порты взяты из публично известного CF endpoint pool
// (см. bepass-org/warp-plus/warp/endpoint.go, MIT). Полный сан /16 не делаем —
// выборка случайных IP из 6 подсетей × фиксированный набор портов = ~250 проб.

use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;

// CF WARP подсети с реальными WG-эндпоинтами. Каждая /24 содержит несколько
// сотен живых IP. Берём из них случайные семплы.
const CF_SUBNETS: &[(&str, u32, u32)] = &[
    ("162.159.192.", 1, 254),
    ("162.159.193.", 1, 254),
    ("162.159.195.", 1, 254),
    ("162.159.198.", 1, 254),
    ("188.114.96.", 1, 254),
    ("188.114.97.", 1, 254),
    ("188.114.98.", 1, 254),
    ("188.114.99.", 1, 254),
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
}

fn pseudo_random_sample(per_subnet: usize) -> Vec<SocketAddr> {
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

    let mut targets: Vec<SocketAddr> = Vec::with_capacity(CF_SUBNETS.len() * per_subnet * CF_PORTS.len());
    for (prefix, lo, hi) in CF_SUBNETS {
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

/// Сканирует CF WARP endpoints и возвращает top_n с лучшей latency.
///
/// per_subnet — сколько случайных IP взять из каждой /24 (по умолчанию 5).
/// concurrency — сколько TCP-коннектов параллельно (по умолчанию 50).
/// timeout_ms — таймаут на коннект (по умолчанию 1500).
#[tauri::command]
pub async fn warp_scan_endpoints(
    per_subnet: Option<usize>,
    concurrency: Option<usize>,
    timeout_ms: Option<u64>,
    top_n: Option<usize>,
) -> Result<Vec<ScanResult>, String> {
    let per_subnet = per_subnet.unwrap_or(5).clamp(1, 30);
    let concurrency = concurrency.unwrap_or(50).clamp(1, 200);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(1500).clamp(200, 10_000));
    let top_n = top_n.unwrap_or(10).clamp(1, 100);

    let targets = pseudo_random_sample(per_subnet);
    if targets.is_empty() {
        return Err("no targets".into());
    }

    // tokio::sync::Semaphore ограничивает concurrency без выделения отдельной
    // worker-пары на каждый IP.
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(concurrency));
    let mut handles = Vec::with_capacity(targets.len());
    for addr in targets {
        let sem = sem.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            let lat = tcp_ping(addr, timeout).await?;
            Some(ScanResult {
                ip: addr.ip().to_string(),
                port: addr.port(),
                latency_ms: lat,
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
