// Ninety · Diagnostics — trace to the server: how far the path gets and where it breaks.
//
// What we measure:
//   ICMP path — "do packets get through at all and via which hops" (IcmpSendEcho with
//               a substituted TTL: the hop where the TTL expired replies TTL_EXPIRED and
//               thereby identifies itself);
//   TCP to the port — one ordinary connection to the server's port;
//   control address — the same kind of connection to a known-live public
//               address, to tell "won't let us reach this server" apart from "TCP doesn't work
//               in this network at all".
//
// Why NOT a TTL-stepping SYN (as tcptraceroute does): verified on live
// Windows — the kernel doesn't hand ICMP "TTL expired" to the connecting socket, and EVERY
// intermediate TTL looks like the same timeout (measured: ttl=1..10 → timeout
// 1.2 s, ttl=11 → OPEN 44 ms). Naming the hop where the connection breaks from such
// a track is impossible — there is no data. On top of that, a burst of twenty
// simultaneous SYNs goes to one port: by itself it looks like a scan and falls
// under SYN limits.
//
// What this lets us conclude: the server answers ping, TCP to the port doesn't get through, but
// the control address opens — so it is exactly this connection being cut, not the whole
// network. None of the three measurements alone supports that conclusion.
//
// Windows only: ICMP goes through IcmpSendEcho (iphlpapi), raw sockets and
// administrator rights are not needed. On other OSes the command honestly returns an error so that
// a dev environment doesn't pretend a trace was taken.

// Errors go out as STABLE CODES (bad_target, dns_failed, ipv6_unsupported,
// no_ipv4, windows_only, no_targets, too_many_targets, internal), not ready-made
// text: the label is built by the i18n catalog in the UI language. A Russian string from
// the backend slipped into the UI past translation and looked foreign in any other language.
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

// Input bounds: the command is available to the frontend, so it is untrusted. Too
// long a trace means tens of seconds of waiting and hundreds of packets, too
// short a timeout means a false "silence" on a live route.
const MAX_HOPS_LIMIT: u8 = 30;
const DEFAULT_MAX_HOPS: u8 = 20;
const HOP_TIMEOUT_MS: u32 = 900;
// Second pass over silent hops: an echo reply gets lost for no particular reason too (a queue
// on a router, a traffic burst right after the reachability matrix), and a gap
// in the middle of the path looks like "doesn't get any further" and misleads.
// We couldn't reproduce the loss outside the app — so we treat it with a retry, not
// a guess about the cause.
const HOP_RETRY_TIMEOUT_MS: u32 = 1_500;
// Probes go in batches: two dozen simultaneous echo requests to one address
// is a burst that some networks cut as a flood.
const ICMP_CONCURRENCY: usize = 8;
const TCP_TIMEOUT: Duration = Duration::from_millis(1200);
const PROBE_PAYLOAD: &[u8] = b"ninety-diagnose";
// Control address: Cloudflare's public resolver. It is needed not for itself but as
// a reference point — if even it doesn't open, the problem is the whole network, not the server.
const CONTROL_ENDPOINT: &str = "1.1.1.1:443";

/// What the hop answered to an ICMP probe with the given TTL.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum IcmpStatus {
    /// Reached the target — this is the last hop.
    Reply,
    /// TTL expired at an intermediate hop: it identified itself.
    Expired,
    /// Hop unreachable (network/host/protocol).
    Unreachable,
    /// Silence until the timeout.
    Timeout,
    /// Error of the probe itself (not a property of the route).
    Error,
}

/// How a connection attempt to the port ended.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum TcpStatus {
    /// The connection was established.
    Open,
    /// Explicit refusal (RST, unreachable) — someone on the other side answered.
    Refused,
    /// Neither an answer nor a refusal before the timeout — the SYN was swallowed.
    Silent,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TraceHop {
    pub ttl: u8,
    /// Who answered at this hop (None — silence).
    pub address: Option<String>,
    pub rtt_ms: Option<u32>,
    pub icmp: IcmpStatus,
}

/// One connection attempt: to the server or to the control address.
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
    /// ICMP reached the server itself.
    pub icmp_reached: bool,
    /// Connection to the server's port.
    pub tcp: TcpProbe,
    /// The same kind of connection to a known-live public address: separates
    /// "won't let us reach this server" from "TCP doesn't work in this network".
    pub control: TcpProbe,
    /// The TCP connection to the port was established (a shorthand for the frontend).
    pub tcp_open: bool,
    /// How long the whole trace took.
    pub elapsed_ms: u64,
}

/// Cut the tail after the hop where ICMP reached the target: what follows are
/// repeats of the same reply, and in the list they look like nonexistent hops.
pub fn trim_after_destination(hops: Vec<TraceHop>) -> Vec<TraceHop> {
    match hops.iter().position(|h| h.icmp == IcmpStatus::Reply) {
        Some(idx) => hops.into_iter().take(idx + 1).collect(),
        None => hops,
    }
}

/// One connection to the port. A refusal (RST/unreachable) is told apart from silence by
/// the kind of error: a swallowed SYN never comes back and produces a timeout.
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

/// Trace to host:port. Returns both tracks per hop and a conclusion about where
/// the path breaks.
#[tauri::command]
pub async fn diagnose_trace(
    target: String,
    port: Option<u16>,
    max_hops: Option<u8>,
) -> Result<TraceResult, String> {
    let host = target.trim().to_string();
    if host.is_empty() || host.len() > 255 {
        return Err("bad_target".into());
    }
    let port = port.unwrap_or(443);
    let hops_limit = max_hops
        .unwrap_or(DEFAULT_MAX_HOPS)
        .clamp(1, MAX_HOPS_LIMIT);

    let started = Instant::now();
    let addr = resolve_v4(&host, port).await?;
    let ip = match addr.ip() {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(_) => return Err("ipv6_unsupported".into()),
    };

    // ICMP hops run in parallel with each other (otherwise the trace is bound by the timeouts
    // of silent hops), while connections go one per target.
    let control_addr: SocketAddr = CONTROL_ENDPOINT
        .parse()
        .map_err(|_| "internal".to_string())?;
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

/// Resolve to IPv4. A separate function: diagnostics must name the address
/// it actually went to — with CDN names each user gets their own.
async fn resolve_v4(host: &str, port: u16) -> Result<SocketAddr, String> {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Ok(SocketAddr::from((ip, port)));
    }
    let mut addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "dns_failed".to_string())?;
    addrs
        .find(|a| a.is_ipv4())
        .ok_or_else(|| "no_ipv4".to_string())
}

#[cfg(target_os = "windows")]
type HopProbe = (IcmpStatus, Option<String>, Option<u32>);

/// One pass over the given TTLs in batches of ICMP_CONCURRENCY.
#[cfg(target_os = "windows")]
async fn icmp_pass(ip: Ipv4Addr, ttls: &[u8], timeout_ms: u32) -> Vec<HopProbe> {
    let mut out = Vec::with_capacity(ttls.len());
    for chunk in ttls.chunks(ICMP_CONCURRENCY) {
        let mut tasks = Vec::with_capacity(chunk.len());
        for &ttl in chunk {
            tasks.push(tauri::async_runtime::spawn_blocking(move || {
                win::echo_with_ttl(ip, ttl, timeout_ms)
            }));
        }
        for task in tasks {
            out.push(task.await.unwrap_or((IcmpStatus::Error, None, None)));
        }
    }
    out
}

#[cfg(target_os = "windows")]
async fn icmp_walk(ip: Ipv4Addr, hops: u8) -> Result<Vec<HopProbe>, String> {
    let all: Vec<u8> = (1..=hops).collect();
    let mut out = icmp_pass(ip, &all, HOP_TIMEOUT_MS).await;

    // Retry only what was silent, and only within the actual path: past
    // the hop where the target answered there is nothing to retry.
    let limit = out
        .iter()
        .position(|(status, ..)| *status == IcmpStatus::Reply)
        .map(|idx| idx + 1)
        .unwrap_or(out.len());
    let silent: Vec<u8> = (1..=limit)
        .filter(|ttl| matches!(out[*ttl - 1].0, IcmpStatus::Timeout | IcmpStatus::Error))
        .map(|ttl| ttl as u8)
        .collect();

    if !silent.is_empty() {
        let retried = icmp_pass(ip, &silent, HOP_RETRY_TIMEOUT_MS).await;
        for (ttl, probe) in silent.iter().zip(retried) {
            if !matches!(probe.0, IcmpStatus::Timeout | IcmpStatus::Error) {
                out[*ttl as usize - 1] = probe;
            }
        }
    }
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
async fn icmp_walk(
    _ip: Ipv4Addr,
    _hops: u8,
) -> Result<Vec<(IcmpStatus, Option<String>, Option<u32>)>, String> {
    Err("windows_only".into())
}

#[cfg(target_os = "windows")]
mod win {
    use super::{IcmpStatus, PROBE_PAYLOAD};
    use std::net::Ipv4Addr;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::NetworkManagement::IpHelper::{
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY, IP_DEST_HOST_UNREACHABLE,
        IP_DEST_NET_UNREACHABLE, IP_DEST_PORT_UNREACHABLE, IP_DEST_PROT_UNREACHABLE,
        IP_OPTION_INFORMATION, IP_REQ_TIMED_OUT, IP_SUCCESS, IP_TTL_EXPIRED_TRANSIT,
    };

    /// An ICMP handle that closes itself: between creation and closing there is
    /// a blocking call, and an early return without Drop would leak a handle on
    /// every probe (and there are up to 30 of them per trace).
    struct IcmpHandle(HANDLE);

    impl Drop for IcmpHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = IcmpCloseHandle(self.0);
            }
        }
    }

    /// One echo probe with a substituted TTL. Returns (status, who answered, rtt).
    pub fn echo_with_ttl(
        ip: Ipv4Addr,
        ttl: u8,
        timeout_ms: u32,
    ) -> (IcmpStatus, Option<String>, Option<u32>) {
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

            // Reply buffer: the structure itself + the echoed payload + headroom for
            // service data the API appends after it (see the IcmpSendEcho
            // documentation: a buffer smaller than this size is guaranteed to produce
            // IP_BUF_TOO_SMALL).
            //
            // We keep it as Vec<u64>, not Vec<u8>: ICMP_ECHO_REPLY contains
            // a pointer, and reading the structure from an unaligned byte buffer is
            // UB. Vec<u64> has 8-byte alignment, which is enough for the structure.
            let reply_size = std::mem::size_of::<ICMP_ECHO_REPLY>() + PROBE_PAYLOAD.len() + 64;
            let mut reply: Vec<u64> = vec![0; reply_size.div_ceil(8)];

            // The address is needed in the form it has in in_addr — that is, in
            // network byte order; from_ne_bytes over the octets gives exactly that.
            let dest = u32::from_ne_bytes(ip.octets());

            let count = IcmpSendEcho(
                handle.0,
                dest,
                PROBE_PAYLOAD.as_ptr() as *const core::ffi::c_void,
                PROBE_PAYLOAD.len() as u16,
                Some(&options),
                reply.as_mut_ptr() as *mut core::ffi::c_void,
                reply_size as u32,
                timeout_ms,
            );

            if count == 0 {
                // Zero replies means both a timeout and an API failure. They can only be told apart
                // via GetLastError, but for a trace both mean the same thing:
                // nobody answered us at this hop.
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
// Reachability: one target, two directions
//
// The key to all diagnostics is comparison. The same address is probed directly and
// through the tunnel, and the conclusion comes from the pair of outcomes: "blocked by the ISP" is
// "direct no, through the tunnel yes", while "the service rejects our address" is exactly
// the opposite. Taken alone, neither of these measurements proves anything.
// ═══════════════════════════════════════════════════════════════════════════

use crate::runtime_ops::{DataplaneProbeKind, ProbeAcquireError};
use crate::vpn::{ProbeProxyEndpoint, SingboxState};
use serde::Deserialize;

const MAX_TARGETS: usize = 32;
const MAX_URL_LEN: usize = 300;
const REACH_TIMEOUT: Duration = Duration::from_secs(6);
const REACH_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
// How many targets we probe at once. Too many — and we ourselves create a burst
// of connections that looks like a scan on mobile TSPU and gets cut by SYN.
const REACH_CONCURRENCY: usize = 6;

#[derive(Deserialize)]
pub struct ReachTarget {
    pub id: String,
    pub url: String,
}

/// Outcome of a probe in one direction. state is the only thing the frontend reads for
/// display; the rest is shown as details.
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
        return Err("no_targets".into());
    }
    if targets.len() > MAX_TARGETS {
        return Err("too_many_targets".into());
    }
    for target in &targets {
        if target.url.len() > MAX_URL_LEN {
            return Err("bad_target".into());
        }
        let parsed = reqwest::Url::parse(&target.url).map_err(|_| "bad_target".to_string())?;
        // Schemes other than http(s) would lead reqwest into an unexpected transport, and file://
        // would even read a local file.
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("bad_target".into());
        }
    }
    Ok(targets)
}

fn build_probe_client(endpoint: Option<&ProbeProxyEndpoint>) -> Result<reqwest::Client, String> {
    let mut builder = crate::util::direct_client_builder()
        .connect_timeout(REACH_CONNECT_TIMEOUT)
        .timeout(REACH_TIMEOUT)
        // Redirects are not suppressed: for "is the service reachable", a 301 to www means reachable.
        .redirect(reqwest::redirect::Policy::limited(3))
        .no_gzip();
    if let Some(endpoint) = endpoint {
        let proxy = reqwest::Proxy::all(format!("http://{}", endpoint.address))
            .map_err(|_| "internal".to_string())?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|_| "internal".to_string())
}

/// reqwest error → a short kind of failure. We don't carry the error text into state: it
/// is unstable across versions, and the frontend needs exactly the kind to pick a label.
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
            // 4xx/5xx is a response from the service, not a broken channel: "403 for the
            // server's address" and "the connection didn't get through" must look different,
            // otherwise the verdict will lie.
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

/// Reachability matrix: each target is probed directly and through the tunnel.
///
/// include_direct=false comes from the frontend when the direct probe is forbidden
/// (kill switch, strict tunnel): then the "direct" column is marked
/// skipped rather than made up.
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
// Leaks and manual check of your own address
// ═══════════════════════════════════════════════════════════════════════════

const DOH_JSON_URL: &str = "https://cloudflare-dns.com/dns-query";
const TRACE_URL: &str = "https://cloudflare.com/cdn-cgi/trace";
// Both responses are short: JSON with four addresses and a dozen lines of trace. We read them
// with a cap, like other external responses (util::read_response_capped).
const MAX_LEAK_RESPONSE_BYTES: usize = 256 * 1024;
// Cloudflare's public IPv6 resolver: we check not it but the very fact that
// the machine has a working IPv6 exit bypassing the tunnel.
const IPV6_PROBE: &str = "[2606:4700:4700::1111]:443";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LeakCheck {
    /// ok — no leak; warn — something to look at; err — leaking; skipped — not checked.
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
    /// Whether the name resolves through the tunnel at all.
    pub dns_in_tunnel: LeakCheck,
    /// Whether the system resolver's answer matched the answer through the tunnel. A mismatch
    /// is either a CDN (normal) or ISP spoofing (not normal);
    /// the decision stays with a human, so the level is warn, not err.
    pub dns_answer_match: LeakCheck,
    /// External address as the internet sees it from the tunnel.
    pub external_ip: LeakCheck,
    /// Whether the machine has an IPv6 exit bypassing the tunnel.
    pub ipv6_open: LeakCheck,
}

/// Resolve with the system resolver — that is, exactly what the ISP returned.
async fn resolve_system(host: &str) -> Result<Vec<String>, String> {
    let lookup = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|e| e.to_string())?;
    let mut out: Vec<String> = lookup.map(|addr| addr.ip().to_string()).collect();
    out.sort();
    out.dedup();
    Ok(out)
}

/// Resolve through the tunnel. DoH in JSON form, not wire format: parsing
/// a binary response for four addresses is pointless, and the JSON endpoint returns the same
/// thing and goes through the same proxy.
async fn resolve_via_tunnel(client: &reqwest::Client, host: &str) -> Result<Vec<String>, String> {
    let url = format!("{DOH_JSON_URL}?name={}&type=A", urlencoding::encode(host));
    let response = client
        .get(url)
        .header("accept", "application/dns-json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body = crate::util::read_response_capped(response, MAX_LEAK_RESPONSE_BYTES, "DoH").await?;
    let json: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
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

/// External address as the internet sees it (through the passed client).
async fn external_ip(client: &reqwest::Client) -> Result<String, String> {
    let response = client
        .get(TRACE_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body =
        crate::util::read_response_text_capped(response, MAX_LEAK_RESPONSE_BYTES, "trace").await?;
    body.lines()
        .find_map(|line| line.strip_prefix("ip=").map(str::to_string))
        .ok_or_else(|| "no address in the response".to_string())
}

/// Leaks: what bypasses the tunnel while it is up.
///
/// The control name comes from the frontend (by default — the connection check domain
/// from settings): a domain hardcoded in the backend would need a release to change.
#[tauri::command]
pub async fn diagnose_leaks(
    state: tauri::State<'_, SingboxState>,
    expected_generation: Option<u64>,
    control_host: Option<String>,
) -> Result<LeakReport, String> {
    let host = control_host.unwrap_or_else(|| "cloudflare.com".to_string());
    if host.len() > 255 || host.contains('/') {
        return Err("bad_target".into());
    }

    let (_, endpoint) = crate::vpn::probe_endpoint_for_generation(&state, expected_generation)
        .map_err(|reason| reason.to_string())?;
    let tunnel = build_probe_client(Some(&endpoint))?;

    let tunnel_answers = resolve_via_tunnel(&tunnel, &host).await;
    let dns_in_tunnel = match &tunnel_answers {
        Ok(list) if !list.is_empty() => LeakCheck::new("ok", Some(list.join(", "))),
        Ok(_) => LeakCheck::new(
            "warn",
            Some(crate::util::i18n_error("backend.diag.emptyAnswer")),
        ),
        Err(err) => LeakCheck::new("err", Some(err.clone())),
    };

    let system_answers = resolve_system(&host).await;
    let dns_answer_match = match (&system_answers, &tunnel_answers) {
        (Ok(system), Ok(tunneled)) if !system.is_empty() && !tunneled.is_empty() => {
            // Intersection, not equality: big sites have different addresses in
            // each region, and requiring a full match would mean shouting
            // "spoofing" on any CDN.
            if system.iter().any(|ip| tunneled.contains(ip)) {
                LeakCheck::new("ok", Some(system.join(", ")))
            } else {
                LeakCheck::new(
                    "warn",
                    Some(crate::util::i18n_error_with(
                        "backend.diag.dnsMismatch",
                        &[
                            ("system", &system.join(", ")),
                            ("tunnel", &tunneled.join(", ")),
                        ],
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
                LeakCheck::new(
                    "warn",
                    Some(crate::util::i18n_error("backend.diag.ipv6Open")),
                )
            } else {
                LeakCheck::new(
                    "ok",
                    Some(crate::util::i18n_error("backend.diag.ipv6Closed")),
                )
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

/// Step-by-step breakdown of one address. The steps go in the same order in which
/// a real connection passes them: name → port → handshake → response.
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

/// Parses user input: domain, domain:port, IP, IP:port or URL.
/// Returns (host, port, url) — the last one is needed to hit the same address
/// with an HTTP request.
pub fn parse_probe_target(raw: &str) -> Result<(String, u16, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_URL_LEN {
        return Err("bad_target".into());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let url = reqwest::Url::parse(trimmed).map_err(|e| {
            crate::util::i18n_error_with("backend.diag.badAddress", &[("error", &e.to_string())])
        })?;
        let host = url
            .host_str()
            .ok_or_else(|| crate::util::i18n_error("backend.diag.noHost"))?
            .to_string();
        let port = url
            .port_or_known_default()
            .ok_or_else(|| crate::util::i18n_error("backend.diag.noPort"))?;
        return Ok((host, port, url.to_string()));
    }

    // Bare IPv6 in brackets or a domain with a port.
    let (host, port) = match trimmed.rsplit_once(':') {
        Some((head, tail)) if !head.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => {
            let port: u16 = tail
                .parse()
                .map_err(|_| crate::util::i18n_error("backend.diag.noPort"))?;
            (head.trim_matches(['[', ']']).to_string(), port)
        }
        _ => (trimmed.trim_matches(['[', ']']).to_string(), 443u16),
    };
    if host.is_empty() || host.contains('/') || host.contains(' ') {
        return Err("bad_target".into());
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
                Err(_) => stages.tcp_error = Some(crate::util::i18n_error("backend.diag.timeout")),
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
    // There is no separate TCP step through the tunnel: the core establishes the connection,
    // and "time to port" here would be measured to the local proxy, not to
    // the server. The frontend shows a dash in this cell.
    let outcome = probe_once(client, url).await;
    stages.http_state = Some(outcome.state);
    stages.http_status = outcome.http_status;
    stages.http_ms = outcome.ms;
    stages.http_error = outcome.error;
    stages
}

/// Manual check of one address in both directions.
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
        // Hops past the target are repeats of its own reply: the parallel walk sends
        // probes to all TTLs at once, and once the server is reached it is the one answering.
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
        // Port 80 means http, otherwise the probe would go into TLS on an unencrypted port.
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

    // Manual experiment on a live network (not run in CI):
    //   set NINETY_TRACE_IP=185.223.171.1
    //   cargo test manual_icmp_walk -- --ignored --nocapture
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn manual_icmp_walk() {
        let ip: Ipv4Addr = std::env::var("NINETY_TRACE_IP")
            .unwrap_or_else(|_| "1.1.1.1".to_string())
            .parse()
            .expect("NINETY_TRACE_IP");

        println!("--- sequential ---");
        for ttl in 1..=14u8 {
            let (status, addr, rtt) = win::echo_with_ttl(ip, ttl, HOP_TIMEOUT_MS);
            println!("ttl={ttl} {status:?} {addr:?} {rtt:?}");
        }

        let hops: u8 = std::env::var("NINETY_TRACE_HOPS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(20);
        println!("--- concurrent x{hops} (threads, as spawn_blocking does) ---");
        let handles: Vec<_> = (1..=hops)
            .map(|ttl| {
                std::thread::spawn(move || (ttl, win::echo_with_ttl(ip, ttl, HOP_TIMEOUT_MS)))
            })
            .collect();
        for h in handles {
            let (ttl, (status, addr, rtt)) = h.join().unwrap();
            println!("ttl={ttl} {status:?} {addr:?} {rtt:?}");
        }
    }
}
