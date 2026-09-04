// Ninety · Диагностика — трасса до сервера: докуда доходит путь и где он рвётся.
//
// Что меряем:
//   ICMP-путь — «доходят ли пакеты вообще и через какие узлы» (IcmpSendEcho с
//               подставленным TTL: узел, где TTL истёк, отвечает TTL_EXPIRED и
//               тем самым называет себя);
//   TCP до порта — одно обычное соединение на порт сервера;
//   контрольный адрес — такое же соединение до заведомо живого публичного
//               адреса, чтобы отличить «не пускает к этому серверу» от «в этой
//               сети не работает TCP вообще».
//
// Почему НЕ TTL-шагающий SYN (как делает tcptraceroute): проверено на живой
// Windows — ICMP «TTL истёк» ядро не отдаёт подключающемуся сокету, и КАЖДЫЙ
// промежуточный TTL выглядит одинаковым таймаутом (замер: ttl=1..10 → timeout
// 1.2 c, ttl=11 → OPEN 44 мс). Назвать по такой дорожке хоп, где рвётся
// соединение, невозможно — данных нет. Заодно уходит пачка из двадцати
// одновременных SYN на один порт: она сама по себе похожа на скан и попадает
// под SYN-лимиты.
//
// Что из этого выводится: сервер отвечает на ping, TCP до порта не проходит, а
// контрольный адрес открывается — значит рвут именно это соединение, а не сеть
// целиком. Ни один из трёх замеров поодиночке такого вывода не даёт.
//
// Только Windows: ICMP идёт через IcmpSendEcho (iphlpapi), raw-сокеты и права
// администратора не нужны. На прочих ОС команда честно возвращает ошибку, чтобы
// dev-окружение не притворялось, что трасса снята.

use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

// Границы входа: команда доступна фронту, а значит недоверенная. Слишком
// длинная трасса — это десятки секунд ожидания и сотни пакетов, слишком
// короткий таймаут — ложная «тишина» на живом маршруте.
const MAX_HOPS_LIMIT: u8 = 30;
const DEFAULT_MAX_HOPS: u8 = 20;
const HOP_TIMEOUT_MS: u32 = 900;
const TCP_TIMEOUT: Duration = Duration::from_millis(1200);
const PROBE_PAYLOAD: &[u8] = b"ninety-diagnose";
// Контрольный адрес: публичный резолвер Cloudflare. Нужен не сам по себе, а как
// точка отсчёта — если и он не открывается, дело в сети целиком, а не в сервере.
const CONTROL_ENDPOINT: &str = "1.1.1.1:443";

/// Что ответил узел на ICMP-пробу с данным TTL.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum IcmpStatus {
    /// Дошли до цели — это последний хоп.
    Reply,
    /// TTL истёк на промежуточном узле: он назвал себя.
    Expired,
    /// Узел недостижим (сеть/хост/протокол).
    Unreachable,
    /// Молчание до таймаута.
    Timeout,
    /// Ошибка самой пробы (не свойство маршрута).
    Error,
}

/// Чем кончилась попытка соединения на порт.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum TcpStatus {
    /// Соединение установилось.
    Open,
    /// Явный отказ (RST, недостижимость) — на той стороне кто-то ответил.
    Refused,
    /// Ни ответа, ни отказа до таймаута — SYN проглотили.
    Silent,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TraceHop {
    pub ttl: u8,
    /// Кто ответил на этом хопе (None — молчание).
    pub address: Option<String>,
    pub rtt_ms: Option<u32>,
    pub icmp: IcmpStatus,
}

/// Одна попытка соединения: до сервера или до контрольного адреса.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TcpProbe {
    pub state: TcpStatus,
    pub ms: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    pub target: String,
    pub port: u16,
    pub resolved_ip: String,
    pub hops: Vec<TraceHop>,
    /// ICMP дошёл до самого сервера.
    pub icmp_reached: bool,
    /// Соединение на порт сервера.
    pub tcp: TcpProbe,
    /// Такое же соединение до заведомо живого публичного адреса: отделяет
    /// «не пускает к этому серверу» от «TCP не работает в этой сети».
    pub control: TcpProbe,
    /// TCP-соединение на порт установилось (сокращение для фронта).
    pub tcp_open: bool,
    /// Сколько заняла вся трасса.
    pub elapsed_ms: u64,
}

/// Обрезаем хвост после хопа, на котором ICMP дошёл до цели: дальше идут
/// повторы того же ответа, и в ленте они выглядят как несуществующие узлы.
pub fn trim_after_destination(hops: Vec<TraceHop>) -> Vec<TraceHop> {
    match hops.iter().position(|h| h.icmp == IcmpStatus::Reply) {
        Some(idx) => hops.into_iter().take(idx + 1).collect(),
        None => hops,
    }
}

/// Одно соединение на порт. Отказ (RST/недостижимость) отличаем от тишины по
/// виду ошибки: проглоченный SYN не приходит никак и даёт таймаут.
async fn tcp_probe(addr: SocketAddr) -> TcpProbe {
    let started = Instant::now();
    let state = match tokio::time::timeout(TCP_TIMEOUT, tokio::net::TcpStream::connect(addr)).await
    {
        Ok(Ok(_stream)) => TcpStatus::Open,
        Ok(Err(_)) => TcpStatus::Refused,
        Err(_) => TcpStatus::Silent,
    };
    TcpProbe {
        state,
        ms: started.elapsed().as_millis() as u64,
    }
}

/// Трасса до host:port. Возвращает обе дорожки по хопам и вывод о том, где
/// рвётся путь.
#[tauri::command]
pub async fn diagnose_trace(
    target: String,
    port: Option<u16>,
    max_hops: Option<u8>,
) -> Result<TraceResult, String> {
    let host = target.trim().to_string();
    if host.is_empty() || host.len() > 255 {
        return Err("пустой или слишком длинный адрес".into());
    }
    let port = port.unwrap_or(443);
    let hops_limit = max_hops
        .unwrap_or(DEFAULT_MAX_HOPS)
        .clamp(1, MAX_HOPS_LIMIT);

    let started = Instant::now();
    let addr = resolve_v4(&host, port).await?;
    let ip = match addr.ip() {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(_) => return Err("IPv6-трасса пока не поддержана".into()),
    };

    // ICMP-хопы идут параллельно между собой (иначе трасса упирается в таймауты
    // молчащих узлов), а соединения — по одному на цель.
    let control_addr: SocketAddr = CONTROL_ENDPOINT
        .parse()
        .map_err(|_| "неверный контрольный адрес".to_string())?;
    let (icmp, tcp, control) = tokio::join!(
        icmp_walk(ip, hops_limit),
        tcp_probe(addr),
        tcp_probe(control_addr)
    );
    let icmp = icmp?;

    let hops: Vec<TraceHop> = icmp
        .into_iter()
        .enumerate()
        .map(|(idx, (status, address, rtt_ms))| TraceHop {
            ttl: (idx + 1) as u8,
            address,
            rtt_ms,
            icmp: status,
        })
        .collect();

    let hops = trim_after_destination(hops);
    Ok(TraceResult {
        target: host,
        port,
        resolved_ip: ip.to_string(),
        icmp_reached: hops.iter().any(|h| h.icmp == IcmpStatus::Reply),
        tcp_open: tcp.state == TcpStatus::Open,
        tcp,
        control,
        hops,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Резолв в IPv4. Отдельная функция: диагностике важно назвать адрес, к которому
/// она реально ходила, — на CDN-именах он у каждого свой.
async fn resolve_v4(host: &str, port: u16) -> Result<SocketAddr, String> {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Ok(SocketAddr::from((ip, port)));
    }
    let mut addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("имя не резолвится: {e}"))?;
    addrs
        .find(|a| a.is_ipv4())
        .ok_or_else(|| "у имени нет IPv4-адреса".to_string())
}

#[cfg(target_os = "windows")]
async fn icmp_walk(
    ip: Ipv4Addr,
    hops: u8,
) -> Result<Vec<(IcmpStatus, Option<String>, Option<u32>)>, String> {
    let mut tasks = Vec::with_capacity(hops as usize);
    for ttl in 1..=hops {
        tasks.push(tauri::async_runtime::spawn_blocking(move || {
            win::echo_with_ttl(ip, ttl)
        }));
    }
    let mut out = Vec::with_capacity(hops as usize);
    for task in tasks {
        out.push(task.await.unwrap_or((IcmpStatus::Error, None, None)));
    }
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
async fn icmp_walk(
    _ip: Ipv4Addr,
    _hops: u8,
) -> Result<Vec<(IcmpStatus, Option<String>, Option<u32>)>, String> {
    Err("трасса доступна только на Windows".into())
}

#[cfg(target_os = "windows")]
mod win {
    use super::{IcmpStatus, HOP_TIMEOUT_MS, PROBE_PAYLOAD};
    use std::net::Ipv4Addr;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::NetworkManagement::IpHelper::{
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY, IP_DEST_HOST_UNREACHABLE,
        IP_DEST_NET_UNREACHABLE, IP_DEST_PORT_UNREACHABLE, IP_DEST_PROT_UNREACHABLE,
        IP_OPTION_INFORMATION, IP_REQ_TIMED_OUT, IP_SUCCESS, IP_TTL_EXPIRED_TRANSIT,
    };

    /// Хендл ICMP, закрывающийся сам: между созданием и закрытием стоит
    /// блокирующий вызов, и ранний return без Drop оставлял бы утечку хендла на
    /// каждую пробу (а их до 30 на одну трассу).
    struct IcmpHandle(HANDLE);

    impl Drop for IcmpHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = IcmpCloseHandle(self.0);
            }
        }
    }

    /// Одна эхо-проба с подставленным TTL. Возвращает (статус, кто ответил, rtt).
    pub fn echo_with_ttl(ip: Ipv4Addr, ttl: u8) -> (IcmpStatus, Option<String>, Option<u32>) {
        unsafe {
            let handle = match IcmpCreateFile() {
                Ok(h) => IcmpHandle(h),
                Err(_) => return (IcmpStatus::Error, None, None),
            };

            let options = IP_OPTION_INFORMATION {
                Ttl: ttl,
                Tos: 0,
                Flags: 0,
                OptionsSize: 0,
                OptionsData: std::ptr::null_mut(),
            };

            // Буфер ответа: сама структура + эхо полезной нагрузки + запас на
            // служебные данные, которые API дописывает следом (см. документацию
            // IcmpSendEcho: буфер меньше этого размера гарантированно даёт
            // IP_BUF_TOO_SMALL).
            //
            // Держим его как Vec<u64>, а не Vec<u8>: внутри ICMP_ECHO_REPLY есть
            // указатель, и читать структуру из невыровненного байтового буфера —
            // UB. У Vec<u64> выравнивание 8, чего структуре достаточно.
            let reply_size = std::mem::size_of::<ICMP_ECHO_REPLY>() + PROBE_PAYLOAD.len() + 64;
            let mut reply: Vec<u64> = vec![0; reply_size.div_ceil(8)];

            // Адрес нужен в том виде, в каком он лежит в in_addr — то есть в
            // сетевом порядке байт; from_ne_bytes над октетами даёт ровно это.
            let dest = u32::from_ne_bytes(ip.octets());

            let count = IcmpSendEcho(
                handle.0,
                dest,
                PROBE_PAYLOAD.as_ptr() as *const core::ffi::c_void,
                PROBE_PAYLOAD.len() as u16,
                Some(&options),
                reply.as_mut_ptr() as *mut core::ffi::c_void,
                reply_size as u32,
                HOP_TIMEOUT_MS,
            );

            if count == 0 {
                // Ноль ответов — это и таймаут, и отказ API. Различить их можно
                // только по GetLastError, но для трассы оба означают одно:
                // на этом хопе нам не ответили.
                return (IcmpStatus::Timeout, None, None);
            }

            let echo = std::ptr::read_unaligned(reply.as_ptr() as *const ICMP_ECHO_REPLY);
            let addr = Ipv4Addr::from(echo.Address.to_ne_bytes()).to_string();
            let rtt = Some(echo.RoundTripTime);

            let status = match echo.Status {
                IP_SUCCESS => IcmpStatus::Reply,
                IP_TTL_EXPIRED_TRANSIT => IcmpStatus::Expired,
                IP_DEST_HOST_UNREACHABLE
                | IP_DEST_NET_UNREACHABLE
                | IP_DEST_PORT_UNREACHABLE
                | IP_DEST_PROT_UNREACHABLE => IcmpStatus::Unreachable,
                IP_REQ_TIMED_OUT => return (IcmpStatus::Timeout, None, None),
                _ => IcmpStatus::Error,
            };

            match status {
                IcmpStatus::Reply | IcmpStatus::Expired | IcmpStatus::Unreachable => {
                    (status, Some(addr), rtt)
                }
                _ => (status, None, None),
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Доступность: одна цель, два направления
//
// Ключ всей диагностики — сравнение. Один и тот же адрес пробуется напрямую и
// через туннель, и вывод делается из пары исходов: «блокирует провайдер» — это
// «напрямую нет, через туннель да», а «сервис не пускает наш адрес» — ровно
// наоборот. Поодиночке ни один из этих замеров ничего не доказывает.
// ═══════════════════════════════════════════════════════════════════════════

use crate::runtime_ops::{DataplaneProbeKind, ProbeAcquireError};
use crate::vpn::{ProbeProxyEndpoint, SingboxState};
use serde::Deserialize;

const MAX_TARGETS: usize = 32;
const MAX_URL_LEN: usize = 300;
const REACH_TIMEOUT: Duration = Duration::from_secs(6);
const REACH_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
// Сколько целей щупаем одновременно. Слишком много — и мы сами создаём всплеск
// соединений, который на мобильном ТСПУ выглядит как скан и рубится по SYN.
const REACH_CONCURRENCY: usize = 6;

#[derive(Deserialize)]
pub struct ReachTarget {
    pub id: String,
    pub url: String,
}

/// Исход пробы в одном направлении. state — единственное, что читает фронт для
/// вывода; остальное показывается как подробности.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DirectionOutcome {
    pub state: String,
    pub http_status: Option<u16>,
    pub ms: Option<u64>,
    pub error: Option<String>,
}

impl DirectionOutcome {
    fn skipped(reason: &str) -> Self {
        Self {
            state: "skipped".into(),
            error: Some(reason.to_string()),
            ..Default::default()
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReachRow {
    pub id: String,
    pub url: String,
    pub direct: DirectionOutcome,
    pub tunnel: DirectionOutcome,
}

fn validate_targets(targets: Vec<ReachTarget>) -> Result<Vec<ReachTarget>, String> {
    if targets.is_empty() {
        return Err("список целей пуст".into());
    }
    if targets.len() > MAX_TARGETS {
        return Err(format!("слишком много целей (максимум {MAX_TARGETS})"));
    }
    for target in &targets {
        if target.url.len() > MAX_URL_LEN {
            return Err("слишком длинный адрес цели".into());
        }
        let parsed = reqwest::Url::parse(&target.url).map_err(|e| format!("адрес цели: {e}"))?;
        // Схемы кроме http(s) увели бы reqwest в неожиданный транспорт, а file://
        // вообще прочитал бы локальный файл.
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("допустимы только http и https".into());
        }
    }
    Ok(targets)
}

fn build_probe_client(endpoint: Option<&ProbeProxyEndpoint>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(REACH_CONNECT_TIMEOUT)
        .timeout(REACH_TIMEOUT)
        // Редиректы не гасим: для «доступен ли сервис» 301 на www — это доступен.
        .redirect(reqwest::redirect::Policy::limited(3))
        .no_gzip();
    if let Some(endpoint) = endpoint {
        let proxy = reqwest::Proxy::all(format!("http://{}", endpoint.address))
            .map_err(|e| format!("proxy: {e}"))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| format!("client: {e}"))
}

/// Ошибка reqwest → короткий вид отказа. Текст ошибки в state не тащим: он
/// нестабилен между версиями, а фронту нужен именно вид, чтобы выбрать подпись.
fn classify_error(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        return "timeout";
    }
    let text = err.to_string().to_ascii_lowercase();
    if text.contains("dns") || text.contains("resolve") || text.contains("name or service") {
        return "dns";
    }
    if text.contains("certificate") || text.contains("tls") || text.contains("handshake") {
        return "tls";
    }
    if err.is_connect() {
        return "refused";
    }
    "error"
}

async fn probe_once(client: &reqwest::Client, url: &str) -> DirectionOutcome {
    let started = Instant::now();
    match client.get(url).send().await {
        Ok(response) => {
            let status = response.status();
            // 4xx/5xx — это ответ сервиса, а не поломка канала: «403 для адреса
            // сервера» и «соединение не дошло» обязаны выглядеть по-разному,
            // иначе вердикт будет врать.
            let reachable = status.is_success() || status.is_redirection();
            let state = if reachable { "ok" } else { "http" };
            DirectionOutcome {
                state: state.into(),
                http_status: Some(status.as_u16()),
                ms: Some(started.elapsed().as_millis() as u64),
                error: None,
            }
        }
        Err(err) => DirectionOutcome {
            state: classify_error(&err).into(),
            http_status: err.status().map(|s| s.as_u16()),
            ms: Some(started.elapsed().as_millis() as u64),
            error: Some(err.to_string().chars().take(200).collect()),
        },
    }
}

/// Матрица доступности: каждая цель пробуется напрямую и через туннель.
///
/// include_direct=false приходит от фронта, когда прямая проба запрещена
/// (kill switch, строгий туннель): тогда колонка «напрямую» помечается
/// skipped, а не выдумывается.
#[tauri::command]
pub async fn diagnose_reach(
    state: tauri::State<'_, SingboxState>,
    expected_generation: Option<u64>,
    targets: Vec<ReachTarget>,
    include_direct: Option<bool>,
) -> Result<Vec<ReachRow>, String> {
    let targets = validate_targets(targets)?;
    let include_direct = include_direct.unwrap_or(true);

    let tunnel_endpoint = crate::vpn::probe_endpoint_for_generation(&state, expected_generation);
    let permit = match &tunnel_endpoint {
        Ok((generation, _)) => match state
            .dataplane_probe
            .acquire(DataplaneProbeKind::Diagnostics, *generation, None)
            .await
        {
            Ok(permit) => Some(permit),
            Err(ProbeAcquireError::Busy) => return Err("probe_busy".into()),
            Err(ProbeAcquireError::StaleGeneration) => return Err("stale_generation".into()),
        },
        Err(_) => None,
    };

    let direct_client = if include_direct {
        Some(build_probe_client(None)?)
    } else {
        None
    };
    let tunnel_client = match &tunnel_endpoint {
        Ok((_, endpoint)) => Some(build_probe_client(Some(endpoint))?),
        Err(_) => None,
    };
    let tunnel_skip_reason = tunnel_endpoint
        .as_ref()
        .err()
        .copied()
        .unwrap_or("endpoint_unavailable");

    let mut rows: Vec<ReachRow> = Vec::with_capacity(targets.len());
    for chunk in targets.chunks(REACH_CONCURRENCY) {
        let mut batch = Vec::with_capacity(chunk.len());
        for target in chunk {
            let direct = direct_client.clone();
            let tunnel = tunnel_client.clone();
            let url = target.url.clone();
            let id = target.id.clone();
            batch.push(async move {
                let direct_outcome = match &direct {
                    Some(client) => probe_once(client, &url).await,
                    None => DirectionOutcome::skipped("direct_disabled"),
                };
                let tunnel_outcome = match &tunnel {
                    Some(client) => probe_once(client, &url).await,
                    None => DirectionOutcome::skipped(tunnel_skip_reason),
                };
                ReachRow {
                    id,
                    url,
                    direct: direct_outcome,
                    tunnel: tunnel_outcome,
                }
            });
        }
        rows.extend(futures_util::future::join_all(batch).await);
    }

    if let (Some(permit), Ok((_, _))) = (&permit, &tunnel_endpoint) {
        if !state.dataplane_probe.is_current(permit) {
            return Err("stale_generation".into());
        }
    }
    Ok(rows)
}

// ═══════════════════════════════════════════════════════════════════════════
// Утечки и ручная проверка своего адреса
// ═══════════════════════════════════════════════════════════════════════════

const DOH_JSON_URL: &str = "https://cloudflare-dns.com/dns-query";
const TRACE_URL: &str = "https://cloudflare.com/cdn-cgi/trace";
// Публичный IPv6-резолвер Cloudflare: проверяем не его, а сам факт, что у
// машины есть рабочий выход в IPv6 мимо туннеля.
const IPV6_PROBE: &str = "[2606:4700:4700::1111]:443";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LeakCheck {
    /// ok — утечки нет; warn — есть на что посмотреть; err — течёт; skipped — не проверяли.
    pub state: String,
    pub detail: Option<String>,
}

impl LeakCheck {
    fn new(state: &str, detail: Option<String>) -> Self {
        Self {
            state: state.to_string(),
            detail,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LeakReport {
    /// Резолвится ли имя через туннель вообще.
    pub dns_in_tunnel: LeakCheck,
    /// Совпал ли ответ системного резолвера с ответом через туннель. Расхождение
    /// — это либо CDN (нормально), либо подмена провайдером (не нормально);
    /// решение остаётся за человеком, поэтому уровень warn, а не err.
    pub dns_answer_match: LeakCheck,
    /// Внешний адрес, каким его видит интернет из туннеля.
    pub external_ip: LeakCheck,
    /// Есть ли у машины выход в IPv6 мимо туннеля.
    pub ipv6_open: LeakCheck,
}

/// Резолв системным резолвером — то есть ровно тем, что выдал провайдер.
async fn resolve_system(host: &str) -> Result<Vec<String>, String> {
    let lookup = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|e| e.to_string())?;
    let mut out: Vec<String> = lookup.map(|addr| addr.ip().to_string()).collect();
    out.sort();
    out.dedup();
    Ok(out)
}

/// Резолв через туннель. DoH в JSON-виде, а не в wire-формате: разбирать
/// бинарный ответ ради четырёх адресов незачем, а JSON-эндпоинт отдаёт то же
/// самое и идёт через тот же прокси.
async fn resolve_via_tunnel(client: &reqwest::Client, host: &str) -> Result<Vec<String>, String> {
    let url = format!("{DOH_JSON_URL}?name={}&type=A", urlencoding::encode(host));
    let response = client
        .get(url)
        .header("accept", "application/dns-json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let mut out: Vec<String> = json["Answer"]
        .as_array()
        .map(|answers| {
            answers
                .iter()
                .filter(|a| a["type"].as_u64() == Some(1))
                .filter_map(|a| a["data"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.dedup();
    Ok(out)
}

/// Внешний адрес глазами интернета (через переданный клиент).
async fn external_ip(client: &reqwest::Client) -> Result<String, String> {
    let body = client
        .get(TRACE_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    body.lines()
        .find_map(|line| line.strip_prefix("ip=").map(str::to_string))
        .ok_or_else(|| "в ответе нет адреса".to_string())
}

/// Утечки: что уходит мимо туннеля, пока он поднят.
///
/// Контрольное имя приходит от фронта (по умолчанию — домен проверки соединения
/// из настроек): захардкоженный домен в бэкенде пришлось бы менять релизом.
#[tauri::command]
pub async fn diagnose_leaks(
    state: tauri::State<'_, SingboxState>,
    expected_generation: Option<u64>,
    control_host: Option<String>,
) -> Result<LeakReport, String> {
    let host = control_host.unwrap_or_else(|| "cloudflare.com".to_string());
    if host.len() > 255 || host.contains('/') {
        return Err("некорректное контрольное имя".into());
    }

    let (_, endpoint) = crate::vpn::probe_endpoint_for_generation(&state, expected_generation)
        .map_err(|reason| reason.to_string())?;
    let tunnel = build_probe_client(Some(&endpoint))?;

    let tunnel_answers = resolve_via_tunnel(&tunnel, &host).await;
    let dns_in_tunnel = match &tunnel_answers {
        Ok(list) if !list.is_empty() => LeakCheck::new("ok", Some(list.join(", "))),
        Ok(_) => LeakCheck::new("warn", Some("пустой ответ".into())),
        Err(err) => LeakCheck::new("err", Some(err.clone())),
    };

    let system_answers = resolve_system(&host).await;
    let dns_answer_match = match (&system_answers, &tunnel_answers) {
        (Ok(system), Ok(tunneled)) if !system.is_empty() && !tunneled.is_empty() => {
            // Пересечение, а не равенство: у крупных сайтов адреса разные в
            // каждом регионе, и требовать полного совпадения значило бы кричать
            // «подмена» на любом CDN.
            if system.iter().any(|ip| tunneled.contains(ip)) {
                LeakCheck::new("ok", Some(system.join(", ")))
            } else {
                LeakCheck::new(
                    "warn",
                    Some(format!(
                        "провайдер: {} · туннель: {}",
                        system.join(", "),
                        tunneled.join(", ")
                    )),
                )
            }
        }
        (Err(err), _) => LeakCheck::new("warn", Some(err.clone())),
        _ => LeakCheck::new("skipped", None),
    };

    let external_ip = match external_ip(&tunnel).await {
        Ok(ip) => LeakCheck::new("ok", Some(ip)),
        Err(err) => LeakCheck::new("err", Some(err)),
    };

    let ipv6_open = match IPV6_PROBE.parse::<SocketAddr>() {
        Ok(addr) => {
            let reachable =
                tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(addr))
                    .await
                    .map(|r| r.is_ok())
                    .unwrap_or(false);
            if reachable {
                LeakCheck::new("warn", Some("IPv6 доступен".into()))
            } else {
                LeakCheck::new("ok", Some("IPv6 закрыт".into()))
            }
        }
        Err(_) => LeakCheck::new("skipped", None),
    };

    Ok(LeakReport {
        dns_in_tunnel,
        dns_answer_match,
        external_ip,
        ipv6_open,
    })
}

/// Пошаговый разбор одного адреса. Ступени идут в том же порядке, в каком их
/// проходит настоящее соединение: имя → порт → рукопожатие → ответ.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProbeStages {
    pub dns: Vec<String>,
    pub dns_error: Option<String>,
    pub tcp_ms: Option<u64>,
    pub tcp_error: Option<String>,
    pub http_status: Option<u16>,
    pub http_ms: Option<u64>,
    pub http_state: Option<String>,
    pub http_error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub host: String,
    pub port: u16,
    pub url: String,
    pub direct: ProbeStages,
    pub tunnel: ProbeStages,
}

/// Разбирает пользовательский ввод: домен, домен:порт, IP, IP:порт или URL.
/// Возвращает (host, port, url) — последний нужен, чтобы бить в тот же адрес
/// HTTP-запросом.
pub fn parse_probe_target(raw: &str) -> Result<(String, u16, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_URL_LEN {
        return Err("пустой или слишком длинный адрес".into());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let url = reqwest::Url::parse(trimmed).map_err(|e| format!("адрес: {e}"))?;
        let host = url
            .host_str()
            .ok_or("в адресе нет имени хоста")?
            .to_string();
        let port = url
            .port_or_known_default()
            .ok_or("не удалось определить порт")?;
        return Ok((host, port, url.to_string()));
    }

    // Голый IPv6 в скобках или домен с портом.
    let (host, port) = match trimmed.rsplit_once(':') {
        Some((head, tail)) if !head.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => {
            let port: u16 = tail.parse().map_err(|_| "некорректный порт".to_string())?;
            (head.trim_matches(['[', ']']).to_string(), port)
        }
        _ => (trimmed.trim_matches(['[', ']']).to_string(), 443u16),
    };
    if host.is_empty() || host.contains('/') || host.contains(' ') {
        return Err("некорректный адрес".into());
    }
    let scheme = if port == 80 { "http" } else { "https" };
    let authority = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    let url = if port == 80 || port == 443 {
        format!("{scheme}://{authority}/")
    } else {
        format!("{scheme}://{authority}:{port}/")
    };
    Ok((host, port, url))
}

async fn direct_stages(client: &reqwest::Client, host: &str, port: u16, url: &str) -> ProbeStages {
    let mut stages = ProbeStages::default();

    match resolve_system(host).await {
        Ok(list) => stages.dns = list,
        Err(err) => stages.dns_error = Some(err),
    }

    if let Some(first) = stages.dns.first() {
        let addr: Option<SocketAddr> = format!("{first}:{port}").parse().ok();
        if let Some(addr) = addr {
            let started = Instant::now();
            match tokio::time::timeout(REACH_CONNECT_TIMEOUT, tokio::net::TcpStream::connect(addr))
                .await
            {
                Ok(Ok(_)) => stages.tcp_ms = Some(started.elapsed().as_millis() as u64),
                Ok(Err(err)) => stages.tcp_error = Some(err.to_string()),
                Err(_) => stages.tcp_error = Some("таймаут".into()),
            }
        }
    }

    let outcome = probe_once(client, url).await;
    stages.http_state = Some(outcome.state);
    stages.http_status = outcome.http_status;
    stages.http_ms = outcome.ms;
    stages.http_error = outcome.error;
    stages
}

async fn tunnel_stages(client: &reqwest::Client, host: &str, url: &str) -> ProbeStages {
    let mut stages = ProbeStages::default();
    match resolve_via_tunnel(client, host).await {
        Ok(list) => stages.dns = list,
        Err(err) => stages.dns_error = Some(err),
    }
    // Отдельной TCP-ступени через туннель нет: соединение устанавливает ядро,
    // и «время до порта» здесь измерялось бы до локального прокси, а не до
    // сервера. Фронт показывает в этой клетке прочерк.
    let outcome = probe_once(client, url).await;
    stages.http_state = Some(outcome.state);
    stages.http_status = outcome.http_status;
    stages.http_ms = outcome.ms;
    stages.http_error = outcome.error;
    stages
}

/// Ручная проверка одного адреса в обе стороны.
#[tauri::command]
pub async fn diagnose_probe(
    state: tauri::State<'_, SingboxState>,
    expected_generation: Option<u64>,
    target: String,
    include_direct: Option<bool>,
) -> Result<ProbeReport, String> {
    let (host, port, url) = parse_probe_target(&target)?;
    let include_direct = include_direct.unwrap_or(true);

    let direct = if include_direct {
        let client = build_probe_client(None)?;
        direct_stages(&client, &host, port, &url).await
    } else {
        ProbeStages::default()
    };

    let tunnel = match crate::vpn::probe_endpoint_for_generation(&state, expected_generation) {
        Ok((_, endpoint)) => {
            let client = build_probe_client(Some(&endpoint))?;
            tunnel_stages(&client, &host, &url).await
        }
        Err(_) => ProbeStages::default(),
    };

    Ok(ProbeReport {
        host,
        port,
        url,
        direct,
        tunnel,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(ttl: u8, icmp: IcmpStatus) -> TraceHop {
        TraceHop {
            ttl,
            address: Some(format!("10.0.0.{ttl}")),
            rtt_ms: Some(ttl as u32),
            icmp,
        }
    }

    #[test]
    fn hops_after_destination_are_dropped() {
        // Хопы за целью — это повторы её же ответа: параллельный обход шлёт
        // пробы на все TTL сразу, и после достижения сервера отвечает он же.
        let hops = vec![
            hop(1, IcmpStatus::Expired),
            hop(2, IcmpStatus::Reply),
            hop(3, IcmpStatus::Reply),
        ];
        assert_eq!(trim_after_destination(hops).len(), 2);
    }

    #[test]
    fn trace_without_destination_keeps_every_hop() {
        let hops = vec![hop(1, IcmpStatus::Expired), hop(2, IcmpStatus::Timeout)];
        assert_eq!(trim_after_destination(hops).len(), 2);
    }

    #[test]
    fn probe_target_accepts_host_port_ip_and_url() {
        assert_eq!(
            parse_probe_target("example.com").unwrap(),
            ("example.com".into(), 443, "https://example.com/".into())
        );
        assert_eq!(
            parse_probe_target("example.com:8443").unwrap(),
            (
                "example.com".into(),
                8443,
                "https://example.com:8443/".into()
            )
        );
        // Порт 80 — это http, иначе проба ушла бы в TLS на нешифрованный порт.
        assert_eq!(
            parse_probe_target("1.2.3.4:80").unwrap(),
            ("1.2.3.4".into(), 80, "http://1.2.3.4/".into())
        );
        let (host, port, _) = parse_probe_target("https://docs.example/path").unwrap();
        assert_eq!((host.as_str(), port), ("docs.example", 443));
    }

    #[test]
    fn probe_target_rejects_junk() {
        assert!(parse_probe_target("").is_err());
        assert!(parse_probe_target("   ").is_err());
        assert!(parse_probe_target("example.com/path").is_err());
        assert!(parse_probe_target("example.com:99999").is_err());
    }
}
