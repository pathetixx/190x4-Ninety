// Движок качества связи — активная проба пропускной способности через туннель.
//
// Зачем: liveness-watchdog (vpn.rs/main.js) ловит только смерть ядра. ТСПУ же не
// блокирует, а ДЕГРАДИРУЕТ — режет отдачу до первых ~16 КБ на соединение
// (traffic-shaping, не обрыв). latency/generate_204 этот «занавес» не видит, т.к.
// сама проба меньше порога. Поэтому probe_quality обязан протащить >16 КБ и
// померить goodput + поймать stall (нет новых байт до 64 КБ = подпись троттла).
//
// Как проба попадает в туннель зависит от режима:
//   proxy/systemProxy — через mixed-inbound (http://127.0.0.1:{port}); Rust сам
//     системный прокси не чтит, поэтому проксируем явно.
//   tun — mixed-inbound'а НЕТ (buildInbound отдаёт только tun-inbound), но при
//     auto_route весь трафик Ninety.exe и так уходит в TUN → пробуем НАПРЯМУ́Ю
//     (port=None/0), пакеты сами проходят туннель. (sing-box исключает из TUN
//     только свой процесс, не Ninety.exe.)
// В обоих случаях меряется плечо аутбаунда юзер→exit, где сидит ТСПУ.

use serde::Serialize;
use std::time::{Duration, Instant};

// Пороги детекта stall (подпись ТСПУ-занавеса). Держим РЯДОМ с дефолтами
// quality-engine.js — если меняешь там, выровняй здесь.
const STALL_BYTES: u64 = 65_536; // 64 КиБ: до этого порога пауза = занавес
const STALL_GAP_MS: u64 = 800; // нет нового чанка дольше — это stall

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
        }
    }
}

// Клиент пробы. port=Some(p>0) → через mixed-inbound (proxy/systemProxy);
// иначе direct (tun — трафик и так в туннеле). БЕЗ общего .timeout(): тело
// стримим до budget_ms вручную, иначе reqwest оборвёт долгую (но живую) выборку
// как ошибку. connect_timeout отдельный — мёртвый аутбаунд не висит весь бюджет.
fn build_client(port: Option<u16>) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
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
#[tauri::command]
pub async fn probe_quality(
    port: Option<u16>,
    endpoints: Vec<String>,
    sample_bytes: Option<u64>,
    budget_ms: Option<u64>,
) -> Result<ProbeResult, String> {
    let sample_bytes = sample_bytes.unwrap_or(262_144);
    let budget = Duration::from_millis(budget_ms.unwrap_or(4000));
    let client = build_client(port)?;

    if endpoints.is_empty() {
        return Ok(ProbeResult::fail(String::new(), 0, "no endpoints".into()));
    }

    let mut last_err = ProbeResult::fail(String::new(), 0, "no endpoints".into());

    for ep in &endpoints {
        match probe_one(&client, ep, sample_bytes, budget).await {
            Ok(r) => return Ok(r), // первый отдавший тело — берём его метрики
            Err(r) => last_err = r,
        }
    }
    Ok(last_err)
}

// Одна проба. Ok = тело пошло (метрики валидны, даже если потом stalled);
// Err = соединение/запрос не состоялись → пробуем следующий endpoint.
async fn probe_one(
    client: &reqwest::Client,
    endpoint: &str,
    sample_bytes: u64,
    budget: Duration,
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
        let chunk_gate = remaining.min(Duration::from_millis(STALL_GAP_MS));

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
                if bytes < STALL_BYTES {
                    stalled = true;
                }
                break;
            }
        }
    }

    let ms = started.elapsed().as_millis() as u64;

    // Тело так и не пошло — не успех, дайм шанс следующему endpoint.
    let Some(fb) = first_byte_at else {
        return Err(ProbeResult::fail(
            endpoint.into(),
            ms,
            "no body bytes".into(),
        ));
    };

    // goodput считаем от первого байта до конца выборки (без setup/TTFB) —
    // это честная скорость канала аутбаунда.
    let body_ms = fb.elapsed().as_millis() as u64;
    let goodput_bps = if body_ms > 0 {
        bytes.saturating_mul(8).saturating_mul(1000) / body_ms
    } else {
        0
    };

    Ok(ProbeResult {
        ok: !stalled,
        goodput_bps,
        ttfb_ms,
        bytes,
        ms,
        stalled,
        endpoint: endpoint.into(),
        error: None,
    })
}
