// Движок качества связи — активная проба пропускной способности через туннель.
//
// Зачем: liveness-watchdog (vpn.rs/main.js) ловит только смерть ядра. ТСПУ же не
// блокирует, а ДЕГРАДИРУЕТ — режет отдачу до первых ~16 КБ на соединение
// (traffic-shaping, не обрыв). latency/generate_204 этот «занавес» не видит, т.к.
// сама проба меньше порога. Поэтому probe_quality обязан протащить >16 КБ и
// померить goodput + поймать stall (нет новых байт до 64 КБ = подпись троттла).
//
// Проба ВСЕГДА идёт через локальный inbound sing-box (http://127.0.0.1:{port}):
//   proxy/systemProxy — mixed-in; Rust системный прокси не чтит, задаём явно.
//   tun — отдельный probe-in (mixed на том же порту, см. buildInbound). Гнать
//     «напрямую» нельзя: собственный трафик Ninety.exe в TUN уходит в direct
//     bypass-правилом (защита от петли), и проба мерила бы голый канал, а не
//     туннель. Правило inbound=probe-in → proxy/warp в buildRoute стоит ВЫШЕ
//     bypass и гонит пробу сквозь аутбаунд.
// port=None/0 (direct-клиент) оставлен для совместимости/отладки.
// В обоих режимах меряется плечо аутбаунда юзер→exit, где сидит ТСПУ.

use serde::Serialize;
use std::time::{Duration, Instant};
use tokio::task::JoinSet;

use crate::runtime_ops::{DataplaneProbeKind, ProbeAcquireError};

// Пороги детекта stall (подпись ТСПУ-занавеса). Держим РЯДОМ с дефолтами
// quality-engine.js — если меняешь там, выровняй здесь.
const STALL_BYTES: u64 = 65_536; // 64 КиБ: до этого порога пауза = занавес
const STALL_GAP_MS: u64 = 800; // нет нового чанка дольше — это stall

// IPC-граничные значения: frontend-настройки считаются недоверенными. Без clamp
// произвольный invoke мог запросить гигабайтную выборку, много URL и минутный
// runtime, удерживая сеть/память процесса.
const MIN_SAMPLE_BYTES: u64 = 64 * 1024;
const MAX_SAMPLE_BYTES: u64 = 4 * 1024 * 1024;
const MIN_BUDGET_MS: u64 = 500;
const MAX_BUDGET_MS: u64 = 15_000;
const MAX_ENDPOINTS: usize = 8;
const MAX_REDIRECTS: usize = 3;
const ALLOWED_QUALITY_HOSTS: &[&str] = &["speed.cloudflare.com"];
const ALLOWED_HEALTH_HOSTS: &[&str] = &["speed.cloudflare.com", "www.gstatic.com"];
const HEALTH_ENDPOINTS: &[&str] = &[
    "https://speed.cloudflare.com/__down?bytes=16384",
    "https://www.gstatic.com/generate_204",
];
const HEALTH_ENDPOINT_TIMEOUT: Duration = Duration::from_secs(6);
const HEALTH_HEDGE_DELAY: Duration = Duration::from_millis(750);
const HEALTH_COORDINATOR_TIMEOUT: Duration = Duration::from_secs(7);

fn host_allowed(host: &str, allowlist: &[&str]) -> bool {
    allowlist
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed))
}

#[derive(Serialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub goodput_bps: u64, // бит/с по телу от TTFB до конца выборки
    pub ttfb_ms: u64,     // от старта запроса до первого байта тела
    pub bytes: u64,       // сколько реально протащили
    pub ms: u64,          // полная длительность пробы
    pub stalled: bool,    // пауза >STALL_GAP_MS до STALL_BYTES
    pub endpoint: String, // какой URL отработал (или последний пробованный)
    pub error: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub skipped: bool,
}

impl ProbeResult {
    fn fail(endpoint: String, ms: u64, err: String) -> Self {
        ProbeResult {
            ok: false,
            goodput_bps: 0,
            ttfb_ms: 0,
            bytes: 0,
            ms,
            stalled: false,
            endpoint,
            error: Some(err),
            skipped: false,
        }
    }

    fn skipped(reason: &str) -> Self {
        Self {
            ok: false,
            goodput_bps: 0,
            ttfb_ms: 0,
            bytes: 0,
            ms: 0,
            stalled: false,
            endpoint: String::new(),
            error: Some(reason.into()),
            skipped: true,
        }
    }
}

fn normalize_limits(sample_bytes: Option<u64>, budget_ms: Option<u64>) -> (u64, Duration) {
    let sample = sample_bytes
        .unwrap_or(262_144)
        .clamp(MIN_SAMPLE_BYTES, MAX_SAMPLE_BYTES);
    let budget = budget_ms
        .unwrap_or(4_000)
        .clamp(MIN_BUDGET_MS, MAX_BUDGET_MS);
    (sample, Duration::from_millis(budget))
}

fn validate_endpoints(endpoints: Vec<String>) -> Result<Vec<String>, String> {
    validate_endpoints_with_allowlist(endpoints, ALLOWED_QUALITY_HOSTS, "quality")
}

fn validate_endpoints_with_allowlist(
    endpoints: Vec<String>,
    allowlist: &[&str],
    label: &str,
) -> Result<Vec<String>, String> {
    if endpoints.is_empty() {
        return Err(format!("no {label} endpoints"));
    }
    if endpoints.len() > MAX_ENDPOINTS {
        return Err(format!(
            "too many {label} endpoints: maximum {MAX_ENDPOINTS}"
        ));
    }

    endpoints
        .into_iter()
        .map(|endpoint| {
            let endpoint = endpoint.trim();
            if endpoint.is_empty() {
                return Err(format!("{label} endpoint is empty"));
            }
            let parsed = reqwest::Url::parse(endpoint)
                .map_err(|e| format!("invalid {label} endpoint: {e}"))?;
            if parsed.scheme() != "https" || parsed.host_str().is_none() {
                return Err(format!("{label} endpoint must be an absolute HTTPS URL"));
            }
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err(format!("{label} endpoint credentials are not allowed"));
            }
            let host = parsed
                .host_str()
                .ok_or_else(|| format!("{label} endpoint host is missing"))?;
            if !host_allowed(host, allowlist) {
                return Err(format!("{label} endpoint host is not allowed: {host}"));
            }
            Ok(endpoint.to_string())
        })
        .collect()
}

fn redirect_target_allowed(initial: &reqwest::Url, target: &reqwest::Url) -> bool {
    initial.scheme() == "https"
        && target.scheme() == "https"
        && initial.host_str() == target.host_str()
        && initial.port_or_known_default() == target.port_or_known_default()
        && target.username().is_empty()
        && target.password().is_none()
}

fn quality_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let Some(initial) = attempt.previous().first() else {
            return attempt.stop();
        };
        if attempt.previous().len() > MAX_REDIRECTS {
            return attempt.stop();
        }
        if redirect_target_allowed(initial, attempt.url()) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

// Клиент пробы. port=Some(p>0) → через mixed-inbound (proxy/systemProxy);
// иначе direct (tun — трафик и так в туннеле). БЕЗ общего .timeout(): тело
// стримим до budget_ms вручную, иначе reqwest оборвёт долгую (но живую) выборку
// как ошибку. connect_timeout отдельный — мёртвый аутбаунд не висит весь бюджет.
fn build_client(port: Option<u16>) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        // Проверка исходного endpoint бессмысленна, если reqwest затем молча
        // уйдёт по Location на HTTP или другой origin. Разрешаем только короткую
        // same-origin HTTPS-цепочку; запрещённый redirect останется 3xx и проба
        // корректно перейдёт к следующему endpoint.
        .redirect(quality_redirect_policy())
        .no_gzip(); // считаем сырые байты на проводе, не распакованные
    if let Some(p) = port {
        if p > 0 {
            let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{p}"))
                .map_err(|e| format!("proxy: {e}"))?;
            b = b.proxy(proxy);
        }
    }
    b.build().map_err(|e| format!("client: {e}"))
}

/// Активная проба пропускной способности через туннель.
///
/// Перебирает endpoints до первого, отдавшего тело; стримит до sample_bytes или
/// budget_ms; по дороге ловит stall. Возвращает метрики первого успешного (или
/// последнюю ошибку, если все легли).
pub(crate) async fn probe_quality_inner(
    port: Option<u16>,
    endpoints: Vec<String>,
    sample_bytes: Option<u64>,
    budget_ms: Option<u64>,
) -> Result<ProbeResult, String> {
    let (sample_bytes, budget) = normalize_limits(sample_bytes, budget_ms);
    let endpoints = validate_endpoints(endpoints)?;
    let client = build_client(port)?;

    let mut last_err = ProbeResult::fail(String::new(), 0, "no endpoints".into());
    let overall = Instant::now();

    for ep in &endpoints {
        let Some(remaining) = budget.checked_sub(overall.elapsed()) else {
            break;
        };
        match probe_one(&client, ep, sample_bytes, remaining).await {
            Ok(r) => return Ok(r), // первый отдавший тело — берём его метрики
            Err(r) => last_err = r,
        }
    }
    Ok(last_err)
}

/// Conservative dataplane liveness probe with a bounded hedge.  The endpoints
/// have independent six-second timeouts and a seven-second coordinator budget:
/// the primary starts immediately, the secondary starts after 750ms only if
/// liveness is still unproven, and the losing request is aborted on success.
pub(crate) async fn probe_health_inner(port: Option<u16>) -> Result<ProbeResult, String> {
    let endpoints = validate_endpoints_with_allowlist(
        HEALTH_ENDPOINTS
            .iter()
            .map(|endpoint| (*endpoint).into())
            .collect(),
        ALLOWED_HEALTH_HOSTS,
        "health",
    )?;
    let client = build_client(port)?;
    let mut tasks = JoinSet::new();
    tasks.spawn(probe_health_endpoint(client.clone(), endpoints[0].clone()));
    let mut secondary_started = false;
    let mut last = ProbeResult::fail(String::new(), 0, "no health endpoints".into());
    let hedge = tokio::time::sleep(HEALTH_HEDGE_DELAY);
    let deadline = tokio::time::sleep(HEALTH_COORDINATOR_TIMEOUT);
    tokio::pin!(hedge);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => break,
            _ = &mut hedge, if !secondary_started => {
                secondary_started = true;
                tasks.spawn(probe_health_endpoint(client.clone(), endpoints[1].clone()));
            }
            joined = tasks.join_next(), if !tasks.is_empty() => {
                match joined {
                    Some(Ok(result)) if result.ok => {
                        tasks.abort_all();
                        return Ok(result);
                    }
                    Some(Ok(result)) => last = result,
                    Some(Err(_)) => last = ProbeResult::fail(String::new(), 0, "monitor task failed".into()),
                    None => {}
                }
                if secondary_started && tasks.is_empty() {
                    return Ok(last);
                }
            }
        }
    }
    tasks.abort_all();
    Ok(last)
}

fn is_false(value: &bool) -> bool {
    !*value
}

async fn probe_health_endpoint(client: reqwest::Client, endpoint: String) -> ProbeResult {
    let started = Instant::now();
    match tokio::time::timeout(HEALTH_ENDPOINT_TIMEOUT, client.get(&endpoint).send()).await {
        Ok(Ok(response)) => ProbeResult {
            ok: true,
            goodput_bps: 0,
            ttfb_ms: started.elapsed().as_millis() as u64,
            bytes: 0,
            ms: started.elapsed().as_millis() as u64,
            stalled: false,
            endpoint,
            error: (!response.status().is_success()).then_some("probe_endpoint_rejected".into()),
            skipped: false,
        },
        Ok(Err(error)) => ProbeResult::fail(
            endpoint,
            started.elapsed().as_millis() as u64,
            format!("transport: {error}"),
        ),
        Err(_) => ProbeResult::fail(
            endpoint,
            started.elapsed().as_millis() as u64,
            "timeout".into(),
        ),
    }
}

#[tauri::command]
pub async fn probe_health(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    port: Option<u16>,
) -> Result<ProbeResult, String> {
    let Some(generation) = crate::vpn::runtime_generation_for_probe(&state, port) else {
        return probe_health_inner(port).await;
    };
    let permit = match state
        .dataplane_probe
        .acquire(DataplaneProbeKind::HealthProbe, generation, None)
        .await
    {
        Ok(permit) => permit,
        Err(ProbeAcquireError::Busy) => return Ok(ProbeResult::skipped("probe_busy")),
        Err(ProbeAcquireError::StaleGeneration) => {
            return Ok(ProbeResult::skipped("stale_generation"))
        }
    };
    let result = probe_health_inner(port).await?;
    if !state.dataplane_probe.is_current(&permit) {
        return Ok(ProbeResult::skipped("stale_generation"));
    }
    Ok(result)
}

#[tauri::command]
pub async fn probe_quality(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    port: Option<u16>,
    endpoints: Vec<String>,
    sample_bytes: Option<u64>,
    budget_ms: Option<u64>,
) -> Result<ProbeResult, String> {
    let Some(generation) = crate::vpn::runtime_generation_for_probe(&state, port) else {
        return probe_quality_inner(port, endpoints, sample_bytes, budget_ms).await;
    };
    let permit = match state
        .dataplane_probe
        .acquire(DataplaneProbeKind::QualityProbe, generation, None)
        .await
    {
        Ok(permit) => permit,
        Err(ProbeAcquireError::Busy) => return Ok(ProbeResult::skipped("probe_busy")),
        Err(ProbeAcquireError::StaleGeneration) => {
            return Ok(ProbeResult::skipped("stale_generation"))
        }
    };
    let result = probe_quality_inner(port, endpoints, sample_bytes, budget_ms).await?;
    if !state.dataplane_probe.is_current(&permit) {
        return Ok(ProbeResult::skipped("stale_generation"));
    }
    Ok(result)
}

// Одна проба. Ok = тело пошло (метрики валидны, даже если потом stalled);
// Err = соединение/запрос не состоялись → пробуем следующий endpoint.
async fn probe_one(
    client: &reqwest::Client,
    endpoint: &str,
    sample_bytes: u64,
    budget: Duration,
) -> Result<ProbeResult, ProbeResult> {
    probe_one_with_policy(
        client,
        endpoint,
        sample_bytes,
        budget,
        ProbePolicy {
            stall_before_bytes: STALL_BYTES,
            chunk_gap: Duration::from_millis(STALL_GAP_MS),
            allow_empty_body: false,
        },
    )
    .await
}

#[derive(Clone, Copy)]
struct ProbePolicy {
    stall_before_bytes: u64,
    chunk_gap: Duration,
    allow_empty_body: bool,
}

async fn probe_one_with_policy(
    client: &reqwest::Client,
    endpoint: &str,
    sample_bytes: u64,
    budget: Duration,
    policy: ProbePolicy,
) -> Result<ProbeResult, ProbeResult> {
    let started = Instant::now();

    // Запрос + заголовки ответа в рамках бюджета.
    let resp = match tokio::time::timeout(budget, client.get(endpoint).send()).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            return Err(ProbeResult::fail(
                endpoint.into(),
                started.elapsed().as_millis() as u64,
                format!("request: {e}"),
            ))
        }
        Err(_) => {
            return Err(ProbeResult::fail(
                endpoint.into(),
                started.elapsed().as_millis() as u64,
                "timeout: no response headers".into(),
            ))
        }
    };

    if !resp.status().is_success() {
        return Err(ProbeResult::fail(
            endpoint.into(),
            started.elapsed().as_millis() as u64,
            format!("HTTP {}", resp.status()),
        ));
    }

    // Стримим тело по чанкам. Каждый chunk() гейтим на STALL_GAP_MS — этот гейт
    // и есть детектор занавеса: до STALL_BYTES долгая пауза = троттл.
    let status = resp.status();
    let mut resp = resp;
    let mut bytes: u64 = 0;
    let mut ttfb_ms: u64 = 0;
    let mut first_byte_at: Option<Instant> = None;
    let mut stalled = false;

    loop {
        // Не вышли ли за общий бюджет.
        let elapsed = started.elapsed();
        if elapsed >= budget {
            break;
        }
        let remaining = budget - elapsed;
        // Гейт чанка = min(остаток бюджета, окно stall).
        let chunk_gate = remaining.min(policy.chunk_gap);

        match tokio::time::timeout(chunk_gate, resp.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                if first_byte_at.is_none() {
                    first_byte_at = Some(Instant::now());
                    ttfb_ms = started.elapsed().as_millis() as u64;
                }
                bytes += chunk.len() as u64;
                if bytes >= sample_bytes {
                    break; // набрали выборку
                }
            }
            Ok(Ok(None)) => break, // тело кончилось раньше sample_bytes
            Ok(Err(e)) => {
                // Обрыв посреди тела. Если ещё ничего не пришло — это провал
                // запроса (пробуем следующий endpoint); иначе метрики валидны.
                if first_byte_at.is_none() {
                    return Err(ProbeResult::fail(
                        endpoint.into(),
                        started.elapsed().as_millis() as u64,
                        format!("body: {e}"),
                    ));
                }
                break;
            }
            Err(_) => {
                // Гейт сработал — пауза в потоке. До 64 КБ это подпись занавеса.
                if bytes < policy.stall_before_bytes {
                    stalled = true;
                }
                break;
            }
        }
    }

    let ms = started.elapsed().as_millis() as u64;

    // Тело так и не пошло — не успех, дайм шанс следующему endpoint.
    let Some(fb) = first_byte_at else {
        if policy.allow_empty_body && status == reqwest::StatusCode::NO_CONTENT {
            return Ok(ProbeResult {
                ok: true,
                goodput_bps: 0,
                ttfb_ms: started.elapsed().as_millis() as u64,
                bytes: 0,
                ms,
                stalled: false,
                endpoint: endpoint.into(),
                error: None,
                skipped: false,
            });
        }
        return Err(ProbeResult::fail(
            endpoint.into(),
            ms,
            "no body bytes".into(),
        ));
    };

    // goodput считаем от первого байта до конца выборки (без setup/TTFB) —
    // это честная скорость канала аутбаунда.
    let goodput_bps = calculate_goodput_bps(bytes, fb.elapsed().as_millis() as u64);

    let complete = bytes >= sample_bytes;
    Ok(ProbeResult {
        ok: !stalled && complete,
        goodput_bps,
        ttfb_ms,
        bytes,
        ms,
        stalled,
        endpoint: endpoint.into(),
        error: if !stalled && !complete {
            Some(format!("incomplete sample: {bytes}/{sample_bytes} bytes"))
        } else {
            None
        },
        skipped: false,
    })
}

fn calculate_goodput_bps(bytes: u64, elapsed_ms: u64) -> u64 {
    bytes.saturating_mul(8).saturating_mul(1000) / elapsed_ms.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sub_millisecond_goodput_uses_one_millisecond_floor() {
        assert_eq!(calculate_goodput_bps(1024, 0), 8_192_000);
    }

    #[test]
    fn ipc_limits_are_clamped() {
        let (small_sample, short_budget) = normalize_limits(Some(1), Some(1));
        assert_eq!(small_sample, MIN_SAMPLE_BYTES);
        assert_eq!(short_budget, Duration::from_millis(MIN_BUDGET_MS));

        let (large_sample, long_budget) = normalize_limits(Some(u64::MAX), Some(u64::MAX));
        assert_eq!(large_sample, MAX_SAMPLE_BYTES);
        assert_eq!(long_budget, Duration::from_millis(MAX_BUDGET_MS));
    }

    #[test]
    fn endpoints_require_bounded_absolute_https_urls() {
        assert!(validate_endpoints(vec![
            "https://speed.cloudflare.com/__down?bytes=262144".into()
        ])
        .is_ok());
        assert!(validate_endpoints(vec!["http://example.com/file".into()]).is_err());
        assert!(validate_endpoints(vec!["file:///etc/passwd".into()]).is_err());
        assert!(validate_endpoints(vec!["https://user:pass@example.com/file".into()]).is_err());
        assert!(validate_endpoints(vec!["https://127.0.0.1/probe".into()]).is_err());
        assert!(validate_endpoints(vec!["https://localhost/probe".into()]).is_err());
        assert!(validate_endpoints(vec!["https://192.168.1.1/probe".into()]).is_err());
        assert!(validate_endpoints(vec!["https://example.com/file".into()]).is_err());
        assert!(validate_endpoints(vec![
            "https://speed.cloudflare.com".into();
            MAX_ENDPOINTS + 1
        ])
        .is_err());
    }

    #[test]
    fn quality_host_allowlist_is_exact_and_case_insensitive() {
        assert!(host_allowed("speed.cloudflare.com", ALLOWED_QUALITY_HOSTS));
        assert!(host_allowed("SPEED.CLOUDFLARE.COM", ALLOWED_QUALITY_HOSTS));
        assert!(!host_allowed("localhost", ALLOWED_QUALITY_HOSTS));
        assert!(!host_allowed(
            "speed.cloudflare.com.evil.example",
            ALLOWED_QUALITY_HOSTS
        ));
    }

    #[test]
    fn health_probe_has_independent_allowlist_and_liveness_thresholds() {
        assert_eq!(HEALTH_ENDPOINT_TIMEOUT, Duration::from_secs(6));
        assert_eq!(HEALTH_HEDGE_DELAY, Duration::from_millis(750));
        assert_eq!(HEALTH_COORDINATOR_TIMEOUT, Duration::from_secs(7));
        assert!(validate_endpoints_with_allowlist(
            HEALTH_ENDPOINTS
                .iter()
                .map(|endpoint| (*endpoint).into())
                .collect(),
            ALLOWED_HEALTH_HOSTS,
            "health",
        )
        .is_ok());
        assert!(validate_endpoints_with_allowlist(
            vec!["https://example.com/health".into()],
            ALLOWED_HEALTH_HOSTS,
            "health",
        )
        .is_err());
    }

    #[test]
    fn redirects_stay_on_the_same_https_origin() {
        let initial = reqwest::Url::parse("https://example.com/probe").unwrap();
        assert!(redirect_target_allowed(
            &initial,
            &reqwest::Url::parse("https://example.com/next").unwrap()
        ));
        assert!(!redirect_target_allowed(
            &initial,
            &reqwest::Url::parse("http://example.com/next").unwrap()
        ));
        assert!(!redirect_target_allowed(
            &initial,
            &reqwest::Url::parse("https://other.example/next").unwrap()
        ));
        assert!(!redirect_target_allowed(
            &initial,
            &reqwest::Url::parse("https://example.com:444/next").unwrap()
        ));
        assert!(!redirect_target_allowed(
            &initial,
            &reqwest::Url::parse("https://user@example.com/next").unwrap()
        ));
    }
}
