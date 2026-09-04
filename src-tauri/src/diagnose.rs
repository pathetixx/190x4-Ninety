// Ninety · Диагностика — трасса до сервера: докуда доходит путь и где он рвётся.
//
// Две дорожки по одному и тому же маршруту:
//   ICMP — «доходят ли пакеты вообще и через какие узлы» (IcmpSendEcho с
//          подставленным TTL: узел, где TTL истёк, отвечает TTL_EXPIRED и тем
//          самым называет себя);
//   TCP  — «доходит ли SYN на нужный порт» (tokio-сокет с тем же TTL).
//
// Расхождение дорожек и есть подпись фильтра. На честном маршруте обе ведут себя
// одинаково: до предпоследнего хопа — TTL_EXPIRED/быстрая ошибка, на последнем —
// эхо-ответ и установленное соединение. Если же узлы продолжают отвечать на ICMP,
// а SYN с того же хопа перестал получать ХОТЬ КАКОЙ-ТО ответ (тишина до
// таймаута), значит соединение убивает промежуточный узел, а не сервер: сервер
// на ping отвечает.
//
// Почему не «просто traceroute»: обычная трасса показывает лишь путь и молчит о
// том, что с TCP. Пользователю же нужен ответ на вопрос «сервер умер или его
// блокируют», а он выводится только из сравнения двух дорожек.
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

/// Что случилось с SYN на тот же порт с тем же TTL.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum TcpStatus {
    /// Соединение установилось — путь до порта открыт целиком.
    Open,
    /// Пришёл ОТВЕТ (TTL истёк, отказ, недостижимость) — путь жив, просто TTL мал.
    Answered,
    /// Ни ответа, ни отказа до таймаута — здесь SYN проглотили.
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
    pub tcp: TcpStatus,
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
    /// TCP-соединение на порт установилось.
    pub tcp_open: bool,
    /// Первый хоп, начиная с которого SYN перестал получать любые ответы, хотя
    /// ICMP на этом хопе ещё отвечал. Совпал с последним хопом — молчит сам
    /// сервер (закрытый порт), иначе SYN убивают в пути. None — расхождения
    /// дорожек нет.
    pub filter_hop: Option<u8>,
    /// Сколько заняла вся трасса.
    pub elapsed_ms: u64,
}

/// Первый хоп, где TCP замолчал при живом ICMP, — и молчание держится до конца.
/// Разовая «дырка» в середине (узел не ответил на одну пробу) фильтром не
/// считается: маршрут обязан молчать ДАЛЬШЕ этого хопа тоже, иначе это шум.
pub fn detect_filter_hop(hops: &[TraceHop]) -> Option<u8> {
    if hops.iter().any(|h| h.tcp == TcpStatus::Open) {
        return None; // соединение состоялось — фильтровать нечего
    }
    let answered_before = |idx: usize| hops[..idx].iter().any(|h| h.tcp == TcpStatus::Answered);
    for (idx, hop) in hops.iter().enumerate() {
        if hop.tcp != TcpStatus::Silent {
            continue;
        }
        // Нужен и живой ICMP на этом хопе (узел отвечает — значит доехали),
        // и хотя бы один ответивший SYN раньше (иначе тишина была всегда, и
        // сказать, где она началась, нельзя).
        let icmp_alive = matches!(hop.icmp, IcmpStatus::Expired | IcmpStatus::Reply);
        if !icmp_alive || !answered_before(idx) {
            continue;
        }
        if hops[idx..].iter().all(|h| h.tcp == TcpStatus::Silent) {
            return Some(hop.ttl);
        }
    }
    None
}

/// Обрезаем хвост после хопа, на котором ICMP дошёл до цели: дальше идут
/// повторы того же ответа, и в ленте они выглядят как несуществующие узлы.
pub fn trim_after_destination(hops: Vec<TraceHop>) -> Vec<TraceHop> {
    match hops.iter().position(|h| h.icmp == IcmpStatus::Reply) {
        Some(idx) => hops.into_iter().take(idx + 1).collect(),
        None => hops,
    }
}

/// TCP-проба с заданным TTL. Ответ (пусть и отрицательный) отличаем от тишины
/// по факту ошибки до таймаута: истёкший TTL и явный отказ приходят как ошибка
/// соединения, а проглоченный SYN не приходит никак.
async fn tcp_probe(addr: SocketAddr, ttl: u32) -> TcpStatus {
    let socket = match addr {
        SocketAddr::V4(_) => tokio::net::TcpSocket::new_v4(),
        SocketAddr::V6(_) => tokio::net::TcpSocket::new_v6(),
    };
    let Ok(socket) = socket else {
        return TcpStatus::Silent;
    };
    if socket.set_ttl(ttl).is_err() {
        return TcpStatus::Silent;
    }
    match tokio::time::timeout(TCP_TIMEOUT, socket.connect(addr)).await {
        Ok(Ok(_stream)) => TcpStatus::Open,
        Ok(Err(_)) => TcpStatus::Answered,
        Err(_) => TcpStatus::Silent,
    }
}

/// TCP-дорожка целиком: по пробе на каждый TTL, все одновременно.
async fn tcp_walk(addr: SocketAddr, hops: u8) -> Vec<TcpStatus> {
    let mut tasks = Vec::with_capacity(hops as usize);
    for ttl in 1..=hops {
        tasks.push(tokio::spawn(tcp_probe(addr, ttl as u32)));
    }
    let mut out = Vec::with_capacity(hops as usize);
    for task in tasks {
        out.push(task.await.unwrap_or(TcpStatus::Silent));
    }
    out
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

    // Обе дорожки идут параллельно, и внутри каждой параллельны сами хопы:
    // последовательный обход упирался бы в таймауты молчащих узлов и занимал
    // десятки секунд вместо секунды-двух.
    let (icmp, tcp) = tokio::join!(icmp_walk(ip, hops_limit), tcp_walk(addr, hops_limit));
    let icmp = icmp?;

    let hops: Vec<TraceHop> = icmp
        .into_iter()
        .enumerate()
        .map(|(idx, (status, address, rtt_ms))| TraceHop {
            ttl: (idx + 1) as u8,
            address,
            rtt_ms,
            icmp: status,
            tcp: tcp.get(idx).copied().unwrap_or(TcpStatus::Silent),
        })
        .collect();

    let hops = trim_after_destination(hops);
    Ok(TraceResult {
        target: host,
        port,
        resolved_ip: ip.to_string(),
        icmp_reached: hops.iter().any(|h| h.icmp == IcmpStatus::Reply),
        tcp_open: hops.iter().any(|h| h.tcp == TcpStatus::Open),
        filter_hop: detect_filter_hop(&hops),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(ttl: u8, icmp: IcmpStatus, tcp: TcpStatus) -> TraceHop {
        TraceHop {
            ttl,
            address: Some(format!("10.0.0.{ttl}")),
            rtt_ms: Some(ttl as u32),
            icmp,
            tcp,
        }
    }

    #[test]
    fn open_connection_means_no_filter() {
        let hops = vec![
            hop(1, IcmpStatus::Expired, TcpStatus::Answered),
            hop(2, IcmpStatus::Reply, TcpStatus::Open),
        ];
        assert_eq!(detect_filter_hop(&hops), None);
    }

    #[test]
    fn silence_after_answers_is_the_filter() {
        // Узлы отвечают на ICMP до самого сервера, но SYN замолчал на 3-м хопе.
        let hops = vec![
            hop(1, IcmpStatus::Expired, TcpStatus::Answered),
            hop(2, IcmpStatus::Expired, TcpStatus::Answered),
            hop(3, IcmpStatus::Expired, TcpStatus::Silent),
            hop(4, IcmpStatus::Expired, TcpStatus::Silent),
            hop(5, IcmpStatus::Reply, TcpStatus::Silent),
        ];
        assert_eq!(detect_filter_hop(&hops), Some(3));
    }

    #[test]
    fn gap_in_the_middle_is_ignored_and_final_silence_is_named() {
        let hops = vec![
            hop(1, IcmpStatus::Expired, TcpStatus::Answered),
            hop(2, IcmpStatus::Expired, TcpStatus::Silent),
            hop(3, IcmpStatus::Expired, TcpStatus::Answered),
            hop(4, IcmpStatus::Reply, TcpStatus::Silent),
        ];
        // Тишина на 2-м хопе не продолжилась — это шум, и хоп не назван.
        // Названным становится 4-й: там тишина держится до конца. Что он же
        // является адресом сервера, разбирает фронт: молчание на последнем хопе
        // означает закрытый порт, а не фильтр в пути.
        assert_eq!(detect_filter_hop(&hops), Some(4));
    }

    #[test]
    fn silence_from_the_first_hop_names_nothing() {
        // Ни один SYN не получил ответа: сказать, ГДЕ началась тишина, нельзя.
        let hops = vec![
            hop(1, IcmpStatus::Expired, TcpStatus::Silent),
            hop(2, IcmpStatus::Reply, TcpStatus::Silent),
        ];
        assert_eq!(detect_filter_hop(&hops), None);
    }

    #[test]
    fn dead_icmp_hop_is_not_blamed() {
        // Узел не ответил и на ICMP — он просто не отвечает на пробы, это не
        // повод объявлять его фильтром.
        let hops = vec![
            hop(1, IcmpStatus::Expired, TcpStatus::Answered),
            hop(2, IcmpStatus::Timeout, TcpStatus::Silent),
            hop(3, IcmpStatus::Expired, TcpStatus::Silent),
        ];
        assert_eq!(detect_filter_hop(&hops), Some(3));
    }

    #[test]
    fn hops_after_destination_are_dropped() {
        let hops = vec![
            hop(1, IcmpStatus::Expired, TcpStatus::Answered),
            hop(2, IcmpStatus::Reply, TcpStatus::Open),
            hop(3, IcmpStatus::Reply, TcpStatus::Open),
        ];
        assert_eq!(trim_after_destination(hops).len(), 2);
    }
}
