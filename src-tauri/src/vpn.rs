use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

use crate::runtime_ops::{
    DataplaneProbeCoordinator, DataplaneProbeKind, ProbeAcquireError, RuntimeOperationCoordinator,
    RuntimeOperationKind, RuntimeOperationToken,
};
use crate::util::MutexExt;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[cfg(not(target_os = "windows"))]
use crate::proxy_stub as proxy;
#[cfg(target_os = "windows")]
use crate::proxy_win as proxy;

/// Strips ANSI escapes (SGR colors and other CSI) from an engine log line.
/// sing-box/xray color stderr even into a pipe — without this, control codes end up in the .log
/// (\x1b[36mINFO\x1b[0m). We clean at the source: the file, the in-memory buffers
/// and the death message all come out without garbage. The frontend has a duplicate strip.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            // CSI: ESC '[' … <terminator letter>. Other ESC sequences —
            // we just drop the ESC itself (there are practically none in engine logs).
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

// Engine monitor task spec (see spawn_log_monitor). The three engines
// (sing-box / xray / naive|TT) are read the same way — writer + ring of recent
// lines + death flag; they differ only in the banner, the crash label and whether
// stdout goes into the ring. Previously this block was copied three times.
struct MonitorSpec {
    start_banner: String,
    death_label: String,
    death_suffix: &'static str,
    prefix_stderr: bool, // sing-box tags stderr with the "STDERR: " prefix
    ring_stdout: bool,   // whether to put stdout into the diagnostic ring (sing-box — no)
}

impl MonitorSpec {
    // xray/naive/TT bridges: both stdout and stderr are crash diagnostics, no prefix.
    // Death lines/markers are in English: they go into log files (which get sent to
    // issues/support regardless of the UI language), the user toast is localized by the frontend.
    fn bridge(banner: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            start_banner: banner.into(),
            death_label: label.into(),
            death_suffix: "Last lines:",
            prefix_stderr: false,
            ring_stdout: true,
        }
    }
    // sing-box: stdout is the regular log, the ring accumulates only stderr (errors).
    fn core(banner: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            start_banner: banner.into(),
            death_label: label.into(),
            death_suffix: "Last errors:",
            prefix_stderr: true,
            ring_stdout: false,
        }
    }
}

struct MonitorGeneration {
    current: Arc<AtomicU64>,
    expected_exit: Arc<AtomicU64>,
    value: u64,
}

fn monitor_exit_expected(
    current_generation: u64,
    expected_exit_generation: u64,
    monitor_generation: u64,
) -> bool {
    expected_exit_generation == monitor_generation || current_generation != monitor_generation
}

// Size cap of a single engine log file. sing-box/xray logs at info level with
// active traffic (especially during a DNS retry storm: every failed resolution is
// a line) grew to hundreds of MB (we saw a 518 MB singbox.log). The cap keeps
// the file bounded: on overflow we truncate and continue with a marker. Fresh
// lines for crash diagnostics still live in the in-memory ring (died_flag).
const LOG_CAP_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_LOG_TAIL_BYTES: u64 = 128 * 1024;
const MAX_LOG_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SIDECAR_LOG_FILES: usize = 16;

// Level of the app's own line in the engine log. The engines write to the same
// file in the same format, so lifecycle diagnostics must have a level:
// without it the "Logs" screen won't show them in either the "Errors" or the "Info" filter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DiagnosticLevel {
    Info,
    Warn,
    Error,
}

impl DiagnosticLevel {
    fn tag(self) -> &'static str {
        match self {
            DiagnosticLevel::Info => "INFO",
            DiagnosticLevel::Warn => "WARN",
            DiagnosticLevel::Error => "ERROR",
        }
    }
}

// Results of frontend events that mean a failure rather than progress. Everything
// else (none/available/completed/cancelled) is ordinary chronicle.
const DIAGNOSTIC_FAILURE_RESULTS: &[&str] = &[
    "failed",
    "error",
    "degraded",
    "refused",
    "timeout",
    "unreachable",
    "unverified",
];

pub(crate) fn diagnostic_level_for_result(result: &str) -> DiagnosticLevel {
    if DIAGNOSTIC_FAILURE_RESULTS
        .iter()
        .any(|marker| result.eq_ignore_ascii_case(marker))
    {
        DiagnosticLevel::Warn
    } else {
        DiagnosticLevel::Info
    }
}

// The app's own lines go into the engine file, and the "Logs" screen parses
// them with the same parser. A bare line without a timestamp and level stuck to
// the previous engine record as its continuation: no time of its own, the level filter
// misses it, search finds it inside someone else's record. The format is exactly sing-box's with
// log.timestamp=true — `-0700 2006-01-02 15:04:05 LEVEL message`.
fn stamped_diagnostic(now: &time::OffsetDateTime, level: DiagnosticLevel, body: &str) -> String {
    let stamp = now
        .format(time::macros::format_description!(
            "[offset_hour sign:mandatory][offset_minute] [year]-[month]-[day] [hour]:[minute]:[second]"
        ))
        .unwrap_or_default();
    format!("{stamp} {} {body}", level.tag())
}

fn diagnostic_line(level: DiagnosticLevel, body: &str) -> String {
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    stamped_diagnostic(&now, level, body)
}

fn truncation_marker() -> String {
    diagnostic_line(
        DiagnosticLevel::Warn,
        &format!("[log truncated at {} MB cap]", LOG_CAP_BYTES / 1024 / 1024),
    )
}

// The engine log is written by TWO independent sources: the process monitor (keeps the file
// open for the whole session) and append_runtime_diagnostic_at (opens the file for every
// line). Both check the cap and both truncate the file. Without a shared lock they
// truncate the file under each other: the monitor's local counter diverges from
// the real size, the cap stops holding the boundary, and records get interleaved.
static LOG_WRITE_LOCK: Mutex<()> = Mutex::new(());

// How many engine lines accumulate in memory before being written to disk and how long the monitor
// waits for a lull before flushing the batch. The engine event channel of
// tauri-plugin-shell has a capacity of one event: while the monitor writes a line, the reader
// thread stands still, and behind it the engine's own pipe. A system call for every
// line slowed the core down exactly when it writes the most logs.
const LOG_BUFFER_BYTES: usize = 64 * 1024;
const LOG_FLUSH_IDLE: std::time::Duration = std::time::Duration::from_millis(100);

// Engine log file: size cap and write buffer.
struct CappedLog {
    path: PathBuf,
    file: std::io::BufWriter<std::fs::File>,
    written: u64,
}

impl CappedLog {
    fn open(path: PathBuf) -> Option<Self> {
        // A file bloated from the previous session is started over — otherwise the cap would start
        // already overflowed and write the very first line after a truncation.
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOG_CAP_BYTES {
            let _ = crate::util::truncate_log_file(&path);
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Some(Self {
            path,
            file: std::io::BufWriter::with_capacity(LOG_BUFFER_BYTES, file),
            written,
        })
    }

    fn write_line(&mut self, line: &str) {
        let _guard = LOG_WRITE_LOCK.lock_recover();
        if self.written > LOG_CAP_BYTES {
            // We check against the disk only on suspicion of overflow: the local
            // counter may have fallen behind (append_runtime_diagnostic_at writes to the same file),
            // and a stat on every line would be an extra syscall in the engine's hot path.
            let _ = self.file.flush();
            let size = self
                .file
                .get_ref()
                .metadata()
                .map(|m| m.len())
                .unwrap_or(self.written);
            if size <= LOG_CAP_BYTES {
                self.written = size;
            } else if crate::util::truncate_log_file(&self.path) {
                // The append handle writes at the current end of the file, i.e. from zero.
                let marker = format!("{}\n", truncation_marker());
                let _ = self.file.write_all(marker.as_bytes());
                self.written = marker.len() as u64;
            } else {
                // Truncation wasn't allowed (another process holds the file). The next
                // attempt is after one more cap, not on every line.
                self.written = 0;
            }
        }
        if writeln!(self.file, "{line}").is_ok() {
            self.written += line.len() as u64 + 1;
        }
    }

    fn has_pending(&self) -> bool {
        !self.file.buffer().is_empty()
    }

    fn flush(&mut self) {
        let _guard = LOG_WRITE_LOCK.lock_recover();
        let _ = self.file.flush();
    }
}

// The next engine event. While the log buffer has lines, we wait no longer than
// LOG_FLUSH_IDLE: a lull is the moment to flush the batch to disk so the "Logs" screen
// sees fresh lines without delay.
async fn next_engine_event(
    rx: &mut tauri::async_runtime::Receiver<CommandEvent>,
    log: &mut Option<CappedLog>,
) -> Option<CommandEvent> {
    loop {
        match log.as_mut() {
            Some(pending) if pending.has_pending() => {
                match tokio::time::timeout(LOG_FLUSH_IDLE, rx.recv()).await {
                    Ok(event) => return event,
                    Err(_) => pending.flush(),
                }
            }
            _ => return rx.recv().await,
        }
    }
}

// Engine process monitor: pours stdout/stderr into the file (if set), keeps
// the last lines in a ring of 40 and on Terminated sets died_flag with
// the reason. One helper for all three engines.
// Engine lifetime counters: how many monitors are still waiting for Terminated and how many
// ended without it. They travel together because they describe one state.
struct MonitorCounters {
    live: Arc<AtomicU64>,
    unconfirmed: Arc<AtomicU64>,
    exit_notify: Arc<Notify>,
}

fn spawn_log_monitor(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    log_file: Option<PathBuf>,
    died_flag: Arc<Mutex<Option<String>>>,
    counters: MonitorCounters,
    generation: MonitorGeneration,
    spec: MonitorSpec,
) {
    let MonitorCounters {
        live: live_processes,
        unconfirmed: unconfirmed_exits,
        exit_notify: process_exit_notify,
    } = counters;
    live_processes.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let mut writer = log_file.and_then(CappedLog::open);
        if let Some(w) = writer.as_mut() {
            let banner = diagnostic_line(DiagnosticLevel::Info, &spec.start_banner);
            w.write_line(&format!("\n{banner}"));
            w.flush();
        }
        // Ring of recent lines for death diagnostics. VecDeque, not Vec:
        // on overflow we cut the head in O(1) (pop_front) — Vec::remove(0)
        // would shift the whole buffer on every line over the cap.
        let mut last: VecDeque<String> = VecDeque::with_capacity(40);
        let push = |last: &mut VecDeque<String>, text: String| {
            if last.len() == 40 {
                last.pop_front();
            }
            last.push_back(text);
        };
        while let Some(event) = next_engine_event(&mut rx, &mut writer).await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                    if let Some(w) = writer.as_mut() {
                        w.write_line(&text);
                    }
                    if spec.ring_stdout {
                        push(&mut last, text);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                    if let Some(w) = writer.as_mut() {
                        if spec.prefix_stderr {
                            w.write_line(&format!("STDERR: {text}"));
                        } else {
                            w.write_line(&text);
                        }
                    }
                    push(&mut last, text);
                }
                CommandEvent::Terminated(payload) => {
                    let current_generation = generation.current.load(Ordering::SeqCst);
                    let expected = monitor_exit_expected(
                        current_generation,
                        generation.expected_exit.load(Ordering::SeqCst),
                        generation.value,
                    );
                    let msg = if expected {
                        format!(
                            "{} stopped (code {:?}, generation {}).",
                            spec.death_label, payload.code, generation.value
                        )
                    } else {
                        format!(
                            "{} died (code {:?}, generation {}). {}\n{}",
                            spec.death_label,
                            payload.code,
                            generation.value,
                            spec.death_suffix,
                            last.make_contiguous().join("\n")
                        )
                    };
                    if let Some(w) = writer.as_mut() {
                        // Into the log — with a timestamp and level, into the frontend (died_flag) —
                        // as is: there it's an error text, not a log line.
                        let level = if expected {
                            DiagnosticLevel::Info
                        } else {
                            DiagnosticLevel::Error
                        };
                        w.write_line(&diagnostic_line(level, &msg));
                        // Before the exit notification: the stop writes its outcome to
                        // the same log and must end up after the engine lines.
                        w.flush();
                    }
                    // The old set's Terminated may arrive after
                    // a quick stop and the start of a new one. We don't let a late
                    // event mark the new core as dead.
                    if !expected && current_generation == generation.value {
                        *died_flag.lock_recover() = Some(msg);
                    }
                    live_processes.fetch_sub(1, Ordering::SeqCst);
                    process_exit_notify.notify_waiters();
                    return;
                }
                _ => {}
            }
        }
        if let Some(w) = writer.as_mut() {
            w.flush();
        }
        // The event stream ended without Terminated: there is no formal confirmation
        // that the process exited (e.g. wait() returned an error). We remove
        // the process from the "live" counter but move it into a separate
        // unconfirmed one: otherwise pending_exit_events would stay non-zero until
        // the end of the session and look like a hanging process in the log. Neither
        // counter declares the child stopped — on Windows this is
        // decided by real PIDs, and on other platforms both must be zero.
        if live_processes
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_sub(1)
            })
            .is_ok()
        {
            unconfirmed_exits.fetch_add(1, Ordering::SeqCst);
        }
        process_exit_notify.notify_waiters();
    });
}

pub struct SingboxState {
    // sing-box child (sidecar) for ALL modes, including TUN. In TUN mode
    // Ninety runs elevated (Throne-style), so the sing-box child inherits
    // admin rights and brings up the TUN inbound itself — there is no separate service anymore.
    child: Mutex<Option<CommandChild>>,
    // xray-core sidecar (two-core): serves xhttp nodes. Listens on 127.0.0.1;
    // sing-box reaches it through a loopback socks bridge.
    xray_child: Mutex<Option<CommandChild>>,
    died: Arc<Mutex<Option<String>>>,
    // Cause of death of the xray sidecar (two-core). Set by the xray monitor task on
    // Terminated, reset in start_singbox. Needed so the frontend can tell
    // "the xhttp bridge crashed" (auto-reconnect) from "sing-box crashed" (tunnel closed).
    xray_died: Arc<Mutex<Option<String>>>,
    // naive / trusttunnel_client sidecar clients (one process per node):
    // each brings up a local SOCKS5, sing-box reaches them through a loopback bridge.
    // A list, because one source may contain several of these protocols.
    sidecars: Mutex<Vec<CommandChild>>,
    // Cause of death of any sidecar client (naive/TT) — like xray_died, for
    // auto-reconnect by the frontend (goes into health_snapshot).
    sidecar_died: Arc<Mutex<Option<String>>>,
    // "Start in progress" sentinel: the child guard only catches an already assigned handle,
    // while between the check and the assignment start_singbox has seconds of awaits (bridge settle
    // pauses) — two concurrent calls would spawn two sets of cores
    // fighting over ports.
    starting: AtomicBool,
    stopping: AtomicBool,
    lifecycle_gate: Mutex<()>,
    // Stop calls are serialized: a second click must not simultaneously take
    // already removed child handles and declare the runtime stopped.
    stop_lock: tokio::sync::Mutex<()>,
    process_generation: Arc<AtomicU64>,
    // stop increments the generation before kill: an already running start must not, after
    // its next await, bring up a new child on top of a disconnect.
    start_epoch: AtomicU64,
    runtime: Mutex<Option<RuntimeRecord>>,
    runtime_ports: Mutex<Vec<u16>>,
    // After an unconfirmed stop we keep the process identity and ports.
    // The next stop repeats the cleanup, and start must not overwrite the runtime.
    pending_cleanup: Mutex<Option<PendingCleanup>>,
    live_processes: Arc<AtomicU64>,
    // Monitors whose event stream ended without Terminated: the process is not
    // confirmed as exited, but it can't be considered "alive" either. A separate
    // counter keeps the stop log honest.
    unconfirmed_exits: Arc<AtomicU64>,
    process_exit_notify: Arc<Notify>,
    expected_exit_generation: Arc<AtomicU64>,
    pub(crate) dataplane_probe: Arc<DataplaneProbeCoordinator>,
}

/// Runtime generation counter for background tasks. A task bound to
/// a generation must exit on its own when the core changes: otherwise it outlives
/// stop and keeps working against a port that is no longer ours.
pub(crate) fn process_generation_handle(state: &SingboxState) -> Arc<AtomicU64> {
    state.process_generation.clone()
}

pub(crate) fn active_runtime_generation(state: &SingboxState) -> Result<u64, String> {
    let child_running = state.child.lock_recover().is_some();
    let generation = state
        .runtime
        .lock_recover()
        .as_ref()
        .map(|runtime| runtime.process_generation)
        .unwrap_or(0);
    if child_running && generation == 0 {
        return Err("running runtime has no published generation".into());
    }
    Ok(if child_running { generation } else { 0 })
}

#[derive(Clone)]
struct RuntimeRecord {
    process_generation: u64,
    source_fingerprint: Option<String>,
    config_hash: Option<String>,
    mode: String,
    strict_privacy: bool,
    pinned_node_tag: Option<String>,
    logs_disabled: bool,
    endpoints: RuntimeEndpoints,
    listener_ready: bool,
    clash_port: u16,
    clash_ready: bool,
    /// The address this runtime published as the Windows system proxy. Using
    /// it, the watchdog checks that the setting wasn't overridden by another program: in
    /// "System proxy" mode it's the only thing that routes browsers into the tunnel.
    system_proxy_endpoint: Option<String>,
}

/// Control and dataplane addresses are intentionally different types.  A
/// caller that has a ControlEndpoint cannot accidentally pass it to the HTTP
/// proxy builder, and vice versa.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlEndpoint {
    pub(crate) address: std::net::SocketAddr,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeProxyEndpoint {
    pub(crate) address: std::net::SocketAddr,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeEndpoints {
    pub(crate) control: ControlEndpoint,
    pub(crate) probe_proxy: Option<ProbeProxyEndpoint>,
}

#[derive(Clone)]
struct RuntimeLaunchSpec {
    config_json: String,
    mode: String,
    xray_json: Option<String>,
    sidecars_json: Option<String>,
    logs_disabled: bool,
    source_fingerprint: Option<String>,
    config_hash: Option<String>,
    strict_privacy: bool,
    pinned_node_tag: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct PendingCleanup {
    processes: Vec<TrackedProcess>,
    ports: Vec<u16>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TrackedProcess {
    pid: u32,
    // Windows may reuse a PID after a process exits. Creation
    // time distinguishes the original process object from a new process with the same PID.
    creation_time: Option<u64>,
}

fn cleanup_targets(
    runtime_ports: &[u16],
    pending: PendingCleanup,
) -> (Vec<u16>, Vec<TrackedProcess>) {
    let mut ports = runtime_ports.to_vec();
    ports.extend(pending.ports);
    ports.sort_unstable();
    ports.dedup();
    let mut processes = pending.processes;
    processes.sort_unstable_by_key(|process| process.pid);
    processes.dedup_by_key(|process| process.pid);
    (ports, processes)
}

impl Default for SingboxState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            xray_child: Mutex::new(None),
            died: Arc::new(Mutex::new(None)),
            xray_died: Arc::new(Mutex::new(None)),
            sidecars: Mutex::new(Vec::new()),
            sidecar_died: Arc::new(Mutex::new(None)),
            starting: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            lifecycle_gate: Mutex::new(()),
            stop_lock: tokio::sync::Mutex::new(()),
            process_generation: Arc::new(AtomicU64::new(0)),
            start_epoch: AtomicU64::new(0),
            runtime: Mutex::new(None),
            runtime_ports: Mutex::new(Vec::new()),
            pending_cleanup: Mutex::new(None),
            live_processes: Arc::new(AtomicU64::new(0)),
            unconfirmed_exits: Arc::new(AtomicU64::new(0)),
            process_exit_notify: Arc::new(Notify::new()),
            expected_exit_generation: Arc::new(AtomicU64::new(0)),
            dataplane_probe: Arc::new(DataplaneProbeCoordinator::default()),
        }
    }
}

// RAII reset of the starting sentinel: covers all early returns of start_singbox.
struct StartingGuard<'a>(&'a AtomicBool);
impl Drop for StartingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct StoppingGuard<'a>(&'a AtomicBool);
impl Drop for StoppingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

// Sidecar client spec, comes from the frontend (buildConfig.sidecars).
#[derive(serde::Deserialize)]
struct SidecarSpec {
    kind: String, // "naive" | "trusttunnel"
    port: u16,
    config: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SidecarLogKind {
    Naive,
    TrustTunnel,
}

impl SidecarLogKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "naive" => Some(Self::Naive),
            "trusttunnel" => Some(Self::TrustTunnel),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Naive => "naive",
            Self::TrustTunnel => "trusttunnel",
        }
    }
}

fn sidecar_log_name(kind: SidecarLogKind, port: u16) -> String {
    format!("{}-{port}.log", kind.as_str())
}

fn sidecar_log_port(name: &str, kind: SidecarLogKind) -> Option<u16> {
    let port = name
        .strip_prefix(&format!("{}-", kind.as_str()))?
        .strip_suffix(".log")?;
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}

fn is_sidecar_log_name(name: &str, kind: SidecarLogKind) -> bool {
    name == format!("{}.log", kind.as_str()) || sidecar_log_port(name, kind).is_some()
}

fn sidecar_log_entries(dir: &std::path::Path, kind: SidecarLogKind) -> Vec<std::fs::DirEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            entry.file_type().map(|t| t.is_file()).unwrap_or(false)
                && is_sidecar_log_name(&entry.file_name().to_string_lossy(), kind)
        })
        .collect()
}

fn prune_sidecar_logs(dir: &std::path::Path, kind: SidecarLogKind, protected: &HashSet<String>) {
    let mut entries = sidecar_log_entries(dir, kind);
    let is_protected = |entry: &std::fs::DirEntry| {
        protected.contains(&entry.file_name().to_string_lossy().into_owned())
    };
    // We reserve space for the future runtime's logs in advance. Adding up the lengths of
    // entries and protected is not allowed: files with the same ports may already be on
    // disk and would then be counted twice — the total came out inflated.
    let keep_existing = MAX_SIDECAR_LOG_FILES.saturating_sub(protected.len());
    let removable = entries
        .iter()
        .filter(|entry| !is_protected(entry))
        .count()
        .saturating_sub(keep_existing);
    if removable == 0 {
        return;
    }
    entries.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    for entry in entries
        .into_iter()
        .filter(|entry| !is_protected(entry))
        .take(removable)
    {
        let _ = std::fs::remove_file(entry.path());
    }
}

// Final config processing before launching sing-box (in any mode):
//  - inject the clash API secret (see clash::clash_secret) so that 9090 isn't
//    accessible to any local process without authorization;
//  - force external_controller onto 127.0.0.1 (even if the frontend
//    for some reason set 0.0.0.0) — core control must not be exposed to the network.
// On invalid JSON we return it as is: let sing-box complain itself.
fn harden_config(raw: &str, cache_path: Option<&Path>) -> String {
    let mut v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return raw.to_string(),
    };
    if let Some(api) = v
        .get_mut("experimental")
        .and_then(|e| e.get_mut("clash_api"))
        .and_then(|a| a.as_object_mut())
    {
        api.insert(
            "secret".into(),
            serde_json::Value::String(crate::clash::clash_secret().to_string()),
        );
        // The port must be a number: `rsplit(':')` on a value without a port
        // ("0.0.0.0") returned the address itself, and garbage like
        // "127.0.0.1:0.0.0.0" went into the config — the start failed later with an unclear reason.
        let port: u16 = api
            .get("external_controller")
            .and_then(|c| c.as_str())
            .and_then(|s| s.rsplit(':').next())
            .and_then(|s| s.parse().ok())
            .filter(|port| *port != 0)
            .unwrap_or(9090);
        api.insert(
            "external_controller".into(),
            serde_json::Value::String(format!("127.0.0.1:{port}")),
        );
    }
    if let Some(cache_path) = cache_path {
        if let Some(root) = v.as_object_mut() {
            let experimental = root
                .entry("experimental")
                .or_insert_with(|| serde_json::json!({}));
            if !experimental.is_object() {
                *experimental = serde_json::json!({});
            }
            let experimental = experimental
                .as_object_mut()
                .expect("experimental object was just initialized");
            let cache_file = experimental
                .entry("cache_file")
                .or_insert_with(|| serde_json::json!({}));
            if !cache_file.is_object() {
                *cache_file = serde_json::json!({});
            }
            cache_file
                .as_object_mut()
                .expect("cache_file object was just initialized")
                .insert(
                    "path".into(),
                    serde_json::Value::String(cache_path.to_string_lossy().into_owned()),
                );
        }
    }
    serde_json::to_string(&v).unwrap_or_else(|_| raw.to_string())
}

fn singbox_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::data_dir(app)?.join("singbox");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir singbox data: {e}"))?;
    Ok(dir.join("cache.db"))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("singbox-current.json"))
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::app_paths::log_dir(app).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("singbox.log"))
}

// Short safe lifecycle records from the health controller must get into
// the same log the user sees in the UI. There are no URLs, IPs, configs
// or node names here — only the generation, the state and a fixed reason code.
pub(crate) fn append_runtime_diagnostic(app: &AppHandle, line: &str) {
    append_runtime_diagnostic_at(app, DiagnosticLevel::Info, line);
}

pub(crate) fn append_runtime_diagnostic_at(app: &AppHandle, level: DiagnosticLevel, line: &str) {
    let Some(path) = log_path(app) else {
        return;
    };
    let bounded: String = line
        .chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .take(512)
        .collect();
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        // The same cap and the same lock as the engine monitor (see LOG_WRITE_LOCK):
        // there must be one rotation per file, otherwise two writers truncate it
        // under each other. With the runtime off there is no monitor at all, and
        // diagnostics stay the only writer: without the check here
        // the log would grow without bound.
        let _guard = LOG_WRITE_LOCK.lock_recover();
        if file.metadata().map(|m| m.len()).unwrap_or(0) > LOG_CAP_BYTES
            && crate::util::truncate_log_file(&path)
        {
            let _ = writeln!(file, "{}", truncation_marker());
        }
        let _ = writeln!(file, "{}", diagnostic_line(level, &bounded));
    }
}

fn xray_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("xray-current.json"))
}

fn xray_log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::app_paths::log_dir(app).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("xray.log"))
}

// Under high load Windows doesn't guarantee that the userspace datapath will
// get CPU in time (video rendering, compilation, a game — the core starves, TUN
// queues aren't drained, handshakes expire, and the user sees "VPN crashed" although
// the process is alive). We raise only the critical network children to ABOVE_NORMAL:
// HIGH/REALTIME are deliberately not used, so as not to turn Ninety into a source of
// starvation for the whole system. Failure isn't fatal — the dataplane simply stays
// at NORMAL, so we only log the error. winws is also dataplane: WinDivert
// hands it packets before the ipset-exclude check, including traffic to the node itself.
pub(crate) fn prioritize_datapath_process(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
        };

        unsafe {
            match OpenProcess(PROCESS_SET_INFORMATION, false, pid) {
                Ok(handle) => {
                    if let Err(error) = SetPriorityClass(handle, ABOVE_NORMAL_PRIORITY_CLASS) {
                        eprintln!("datapath priority failed for pid {pid}: {error}");
                    }
                    let _ = CloseHandle(handle);
                }
                Err(error) => eprintln!("datapath priority open failed for pid {pid}: {error}"),
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = pid;
}

// A Task Scheduler task starts the process with BELOW_NORMAL by default (Priority 7),
// and this class is inherited by all children we don't raise explicitly. Under load
// the controller and winws starve — the VPN "crashes" although the node is alive. We raise ourselves
// to NORMAL; if the user set it higher themselves, we leave it alone.
pub(crate) fn normalize_own_priority() {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Threading::{
            GetCurrentProcess, GetPriorityClass, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS,
            IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
        };

        unsafe {
            let process = GetCurrentProcess();
            let class = GetPriorityClass(process);
            let starved = class == BELOW_NORMAL_PRIORITY_CLASS.0 || class == IDLE_PRIORITY_CLASS.0;
            if !starved {
                return;
            }
            if let Err(error) = SetPriorityClass(process, NORMAL_PRIORITY_CLASS) {
                eprintln!("own priority normalize failed: {error}");
            }
        }
    }
}

// xray config fields through which the engine reads or writes files itself: the TLS key
// log and certificates from disk. An outbound from an Xray-JSON subscription goes into
// xray almost as is, and in TUN the bridge inherits administrator rights: without cleaning,
// the subscription owner could create or append to a file anywhere on the system.
// The bridge doesn't need local paths — certificates are given by content.
// Case doesn't matter: Go's JSON decoder accepts field names case-insensitively.
fn is_xray_file_field(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key == "masterkeylog" || key.ends_with("file")
}

fn strip_xray_file_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.retain(|key, _| !is_xray_file_field(key));
            // A certificate that had only a file path is empty after cleaning,
            // and xray rejects such an element when building TLS — and brings down the whole bridge.
            for (key, child) in map.iter_mut() {
                if key.eq_ignore_ascii_case("certificates") {
                    if let serde_json::Value::Array(items) = child {
                        items.retain(|item| {
                            item.as_object().is_some_and(|cert| {
                                cert.keys().any(|k| k.eq_ignore_ascii_case("certificate"))
                            })
                        });
                    }
                }
            }
            map.retain(|key, child| {
                !(key.eq_ignore_ascii_case("certificates")
                    && child.as_array().is_some_and(|items| items.is_empty()))
            });
            for child in map.values_mut() {
                strip_xray_file_fields(child);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                strip_xray_file_fields(child);
            }
        }
        _ => {}
    }
}

fn harden_xray_config(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    strip_xray_file_fields(&mut value);
    serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string())
}

// Brings up the xray-core sidecar for xhttp nodes (two-core). Always user-level,
// listens on 127.0.0.1; sing-box (our child or a service under LocalSystem) reaches
// it through loopback socks bridges from the config. Spawned before sing-box.
async fn spawn_xray(
    app: &AppHandle,
    state: &SingboxState,
    xray_json: &str,
    logs_disabled: bool,
    start_epoch: u64,
    process_generation: u64,
) -> Result<(), String> {
    let path = xray_config_path(app)?;
    std::fs::write(&path, harden_xray_config(xray_json))
        .map_err(|e| format!("write xray config: {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("xray")
        .map_err(|e| format!("xray sidecar lookup: {e}"))?;
    let (rx, child) = sidecar
        .args(["run", "-c", &path_str])
        .env("NO_COLOR", "1")
        .spawn()
        .map_err(|e| format!("spawn xray: {e}"))?;
    prioritize_datapath_process(child.pid());
    crate::job_guard::bind_pid(child.pid());
    *state.xray_child.lock_recover() = Some(child);

    let died_flag = state.xray_died.clone();
    // logs_disabled (the "Disable logs completely" setting) → we don't write a log file;
    // the in-memory last lines for crash diagnostics (died_flag) are kept.
    let log_file = if logs_disabled {
        None
    } else {
        xray_log_path(app)
    };
    spawn_log_monitor(
        rx,
        log_file,
        died_flag,
        MonitorCounters {
            live: state.live_processes.clone(),
            unconfirmed: state.unconfirmed_exits.clone(),
            exit_notify: state.process_exit_notify.clone(),
        },
        MonitorGeneration {
            current: state.process_generation.clone(),
            expected_exit: state.expected_exit_generation.clone(),
            value: process_generation,
        },
        MonitorSpec::bridge(
            format!("=== xray start · generation {process_generation} ==="),
            "xray",
        ),
    );

    // Let xray come up and bind the socks inbounds before sing-box starts,
    // otherwise the first urltests of xhttp nodes will hit connection refused.
    wait_start_delay(state, start_epoch, std::time::Duration::from_millis(400)).await?;

    // Fail-fast: it died during the settle pause (broken config, busy port) → fail the start
    // with the reason. Previously the start "succeeded", and the health watchdog found
    // the corpse 5 s later and went into a reconnect — in a loop, because the port stayed busy.
    if let Some(err) = state.xray_died.lock_recover().take() {
        return Err(err);
    }
    Ok(())
}

// Brings up the naive / trusttunnel_client sidecar clients (one per node).
// Each listens on a local SOCKS5 (port from the spec), sing-box reaches them through a bridge.
// User-level (TT's SOCKS mode doesn't need admin rights/TUN). Spawned before sing-box.
async fn spawn_sidecars(
    app: &AppHandle,
    state: &SingboxState,
    specs: &[SidecarSpec],
    logs_disabled: bool,
    start_epoch: u64,
    process_generation: u64,
) -> Result<(), String> {
    let cfg_dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("mkdir: {e}"))?;
    let log_dir = crate::app_paths::log_dir(app).ok();

    let mut planned_logs: HashSet<String> = HashSet::new();
    for spec in specs {
        let kind = SidecarLogKind::parse(&spec.kind)
            .ok_or_else(|| format!("unknown sidecar: {}", spec.kind))?;
        let name = sidecar_log_name(kind, spec.port);
        if !planned_logs.insert(name) {
            return Err(format!(
                "duplicate {} sidecar on port {}",
                spec.kind, spec.port
            ));
        }
    }
    for kind in [SidecarLogKind::Naive, SidecarLogKind::TrustTunnel] {
        let protected: HashSet<String> = planned_logs
            .iter()
            .filter(|name| sidecar_log_port(name, kind).is_some())
            .cloned()
            .collect();
        if protected.len() > MAX_SIDECAR_LOG_FILES {
            return Err(format!(
                "too many {} sidecars: the maximum is {MAX_SIDECAR_LOG_FILES}",
                kind.as_str()
            ));
        }
        if let Some(dir) = log_dir.as_ref() {
            prune_sidecar_logs(dir, kind, &protected);
        }
    }

    for spec in specs {
        // Binary name (externalBin) + arguments + config extension by type.
        let (bin, ext, file_arg) = match spec.kind.as_str() {
            "naive" => ("naive", "json", false), // naive.exe <config.json>
            "trusttunnel" => ("trusttunnel_client", "toml", true), // --config <toml>
            other => return Err(format!("unknown sidecar: {other}")),
        };
        let cfg_path = cfg_dir.join(format!("{}-{}.{}", spec.kind, spec.port, ext));
        std::fs::write(&cfg_path, &spec.config)
            .map_err(|e| format!("write {} config: {e}", spec.kind))?;
        let cfg_str = cfg_path.to_string_lossy().to_string();

        let sidecar = app
            .shell()
            .sidecar(bin)
            .map_err(|e| format!("{bin} sidecar lookup: {e}"))?;
        let cmd = if file_arg {
            sidecar.args(["--config", &cfg_str])
        } else {
            sidecar.args([cfg_str.as_str()])
        };
        let (rx, child) = cmd
            .env("NO_COLOR", "1")
            .spawn()
            .map_err(|e| format!("spawn {bin}: {e}"))?;
        prioritize_datapath_process(child.pid());
        crate::job_guard::bind_pid(child.pid());
        state.sidecars.lock_recover().push(child);

        let died_flag = state.sidecar_died.clone();
        let log_file = if logs_disabled {
            None
        } else {
            let kind = SidecarLogKind::parse(&spec.kind)
                .ok_or_else(|| format!("unknown sidecar: {}", spec.kind))?;
            log_dir
                .as_ref()
                .map(|d| d.join(sidecar_log_name(kind, spec.port)))
        };
        let label = format!("{} :{}", spec.kind, spec.port);
        spawn_log_monitor(
            rx,
            log_file,
            died_flag,
            MonitorCounters {
                live: state.live_processes.clone(),
                unconfirmed: state.unconfirmed_exits.clone(),
                exit_notify: state.process_exit_notify.clone(),
            },
            MonitorGeneration {
                current: state.process_generation.clone(),
                expected_exit: state.expected_exit_generation.clone(),
                value: process_generation,
            },
            MonitorSpec::bridge(
                format!("=== {label} start · generation {process_generation} ==="),
                label.clone(),
            ),
        );
    }

    if !specs.is_empty() {
        // Let the clients bind SOCKS before sing-box starts (TrustTunnel's handshake to the endpoint
        // is slow), otherwise the first urltests will hit refused.
        wait_start_delay(state, start_epoch, std::time::Duration::from_millis(1200)).await?;

        // Fail-fast: a client died during the settle pause → fail the start with the reason
        // (see spawn_xray — otherwise the health watchdog would loop on reconnects).
        if let Some(err) = state.sidecar_died.lock_recover().take() {
            return Err(err);
        }
    }
    Ok(())
}

// Path to the sing-box log. In all modes the log is written by Tauri itself into the writable log dir
// (sing-box is our child, its stdout/stderr is poured into the file by the monitor task).
fn resolved_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    log_path(app).ok_or_else(|| "log_dir is unavailable".to_string())
}

#[tauri::command]
pub async fn singbox_log_path(app: AppHandle) -> Result<String, String> {
    let p = resolved_log_path(&app)?;
    Ok(p.to_string_lossy().to_string())
}

// Reads the tail of a file (the last tail_bytes), cutting off the first partial line.
// pub(crate): dpi.rs reuses it for dpi.log instead of reading the whole file.
fn normalized_log_tail_bytes(tail_bytes: Option<u64>) -> u64 {
    tail_bytes
        .unwrap_or(DEFAULT_LOG_TAIL_BYTES)
        .min(MAX_LOG_TAIL_BYTES)
}

pub(crate) fn read_tail(path: &std::path::Path, tail_bytes: Option<u64>) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let size = std::fs::metadata(path)
        .map_err(|e| format!("stat: {e}"))?
        .len();
    read_tail_within(path, tail_bytes, size)
}

// Tail of the first `size` bytes of the file. The caller sets the size: the engine appends to
// the log between stat and the read, and reading "to the end of the file" returned lines past
// the position that the "Logs" screen then read again — they got duplicated.
fn read_tail_within(
    path: &std::path::Path,
    tail_bytes: Option<u64>,
    size: u64,
) -> Result<String, String> {
    let limit = normalized_log_tail_bytes(tail_bytes);
    if limit == 0 {
        return Ok(String::new());
    }
    if size <= limit {
        use std::io::Read;
        let f = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
        let mut bytes = Vec::with_capacity(size as usize);
        f.take(size)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read_to_end: {e}"))?;
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    let start = size - limit;
    f.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek: {e}"))?;
    let mut buf = Vec::with_capacity(limit as usize);
    f.take(limit)
        .read_to_end(&mut buf)
        .map_err(|e| format!("read_to_end: {e}"))?;
    let utf8_skip = buf
        .iter()
        .take(3)
        .take_while(|b| (**b & 0b1100_0000) == 0b1000_0000)
        .count();
    let buf = &buf[utf8_skip..];
    let text = String::from_utf8_lossy(buf).to_string();
    let cut = text.find('\n').map(|i| i + 1).unwrap_or(0);
    Ok(format!(
        "…[{} bytes truncated above]…\n{}",
        start + utf8_skip as u64 + cut as u64,
        &text[cut..]
    ))
}

// Reading from a position: whole lines only. The writing process may have stopped in
// the middle of a line (and thus in the middle of a UTF-8 character), so everything after
// the last line break stays in the file until the next call, and the offset
// is returned exactly at a line boundary.
fn read_from_offset(path: &std::path::Path, from: u64, size: u64) -> Result<(String, u64), String> {
    use std::io::{Read, Seek, SeekFrom};
    if from >= size {
        return Ok((String::new(), from));
    }
    let mut f = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    f.seek(SeekFrom::Start(from))
        .map_err(|e| format!("seek: {e}"))?;
    let len = size - from;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len)
        .read_to_end(&mut buf)
        .map_err(|e| format!("read_to_end: {e}"))?;
    let Some(last_nl) = buf.iter().rposition(|b| *b == b'\n') else {
        // No whole line yet — don't move the position, read it next time.
        return Ok((String::new(), from));
    };
    let cut = last_nl + 1;
    let text = String::from_utf8_lossy(&buf[..cut]).into_owned();
    Ok((text, from + cut as u64))
}

// Log tail read from a position. The log screen polls the file every two
// seconds, and previously each poll sent the whole tail through IPC so the frontend
// would parse it again from start to finish. Now after the first read only
// the appended part travels, and `reset` tells the frontend when the accumulated buffer must be
// replaced entirely (first read, log cleared, rotation, too large a
// gap). Composite sources (naive/trusttunnel — a file per process)
// are glued together from several files and have no single monotonic position:
// for them incremental=false and the behavior is as before.
#[derive(serde::Serialize)]
pub struct LogChunk {
    pub text: String,
    pub offset: u64,
    pub size: u64,
    pub reset: bool,
    pub incremental: bool,
}

// Log files by source key. For naive/TrustTunnel it returns a convenient
// aggregated list of individual processes plus the legacy file of old versions.
fn component_log_files(dir: &std::path::Path, source: &str) -> Result<Vec<PathBuf>, String> {
    let single = match source {
        "singbox" => Some("singbox.log"),
        "xray" => Some("xray.log"),
        "dpi" => Some("dpi.log"),
        "naive" | "trusttunnel" => None,
        _ => return Err(format!("unknown log source: {source}")),
    };
    if let Some(name) = single {
        return Ok(vec![dir.join(name)]);
    }
    let kind =
        SidecarLogKind::parse(source).ok_or_else(|| format!("unknown log source: {source}"))?;
    let mut entries = sidecar_log_entries(dir, kind);
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries.into_iter().map(|entry| entry.path()).collect())
}

fn read_log_files(paths: &[PathBuf], tail_bytes: Option<u64>) -> Result<String, String> {
    let limit = normalized_log_tail_bytes(tail_bytes);
    if limit == 0 || paths.is_empty() {
        return Ok(String::new());
    }
    let visible = paths.len().min(MAX_SIDECAR_LOG_FILES);
    let per_file = (limit / visible as u64).max(1);
    let mut chunks = Vec::new();
    for path in paths.iter().take(visible) {
        let text = read_tail(path, Some(per_file))?;
        if text.is_empty() {
            continue;
        }
        let label = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("sidecar.log");
        chunks.push(format!("=== {label} ===\n{text}"));
    }
    Ok(chunks.join("\n"))
}

fn clear_log_files(paths: &[PathBuf]) -> Result<(), String> {
    for path in paths {
        if path.exists() {
            std::fs::write(path, b"").map_err(|e| format!("truncate {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

// The same read, but continuing from the previous position (see LogChunk).
#[tauri::command]
pub async fn read_log_chunk(
    app: AppHandle,
    source: String,
    tail_bytes: Option<u64>,
    from_offset: Option<u64>,
) -> Result<LogChunk, String> {
    let dir = crate::app_paths::log_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let paths = component_log_files(&dir, &source)?;
    if paths.len() != 1 {
        return Ok(LogChunk {
            text: read_log_files(&paths, tail_bytes)?,
            offset: 0,
            size: 0,
            reset: true,
            incremental: false,
        });
    }
    let path = &paths[0];
    if !path.exists() {
        return Ok(LogChunk {
            text: String::new(),
            offset: 0,
            size: 0,
            reset: true,
            incremental: true,
        });
    }
    let size = std::fs::metadata(path)
        .map_err(|e| format!("stat: {e}"))?
        .len();
    let limit = normalized_log_tail_bytes(tail_bytes);
    // We continue reading only if the position is still inside the file and the gap is no larger than
    // the tail the screen shows anyway. Otherwise it's cheaper and more honest to
    // return the whole tail: from > size means the log was cleared or rotated.
    if let Some(from) = from_offset {
        if from <= size && size - from <= limit {
            let (text, offset) = read_from_offset(path, from, size)?;
            return Ok(LogChunk {
                text,
                offset,
                size,
                reset: false,
                incremental: true,
            });
        }
    }
    Ok(LogChunk {
        text: read_tail_within(path, tail_bytes, size)?,
        offset: size,
        size,
        reset: true,
        incremental: true,
    })
}

// Clearing the log of any component.
#[tauri::command]
pub async fn clear_log(app: AppHandle, source: String) -> Result<(), String> {
    let dir = crate::app_paths::log_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let paths = component_log_files(&dir, &source)?;
    clear_log_files(&paths)
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = crate::app_paths::log_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    #[cfg(target_os = "windows")]
    {
        // Absolute path: explorer.exe lives in the Windows directory (not in System32).
        // We rely neither on PATH nor on %SystemRoot% — opening logs may happen
        // from an elevated process, and the environment variable is written by HKCU\Environment,
        // i.e. a regular user. GetWindowsDirectoryW doesn't read the environment.
        let explorer = crate::util::windows_directory().join("explorer.exe");
        std::process::Command::new(explorer)
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("open: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    running: bool,
    starting: bool,
    process_generation: u64,
    source_fingerprint: Option<String>,
    config_hash: Option<String>,
    mode: Option<String>,
    strict_privacy: bool,
    pinned_node_tag: Option<String>,
    control_endpoint: Option<ControlEndpoint>,
    probe_proxy_endpoint: Option<ProbeProxyEndpoint>,
    listener_ready: bool,
    clash_port: u16,
    clash_ready: bool,
    proxy_enable: bool,
    proxy_server: Option<String>,
    notification_generation: u64,
    notification_applied_generation: u64,
    runtime_diagnostic: RuntimeDiagnostic,
    sidecars: serde_json::Value,
    system_proxy_ownership: &'static str,
    kill_switch_active: bool,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostic {
    pub mode: Option<String>,
    pub generation: u64,
    pub configured_endpoint: Option<String>,
    pub published_endpoint: Option<String>,
    pub listener_ready: bool,
    pub proxy_enable: bool,
    pub proxy_server: Option<String>,
    pub notification_generation: u64,
    pub notification_applied_generation: u64,
}

#[derive(Clone, Default)]
pub(crate) struct NativeRuntimeStatus {
    pub running: bool,
    pub xray_alive: bool,
    pub sidecars_alive: bool,
    pub clash_ready: bool,
    pub control_endpoint: Option<ControlEndpoint>,
    pub probe_proxy_endpoint: Option<ProbeProxyEndpoint>,
}

fn parse_endpoint_address(
    raw: &str,
    configured_port: Option<u16>,
    label: &str,
) -> Result<std::net::SocketAddr, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(format!("{label} address is empty"));
    }
    let address = if let Ok(address) = raw.parse::<std::net::SocketAddr>() {
        if let Some(port) = configured_port {
            if port == 0 || address.port() != port {
                return Err(format!("{label} address/port mismatch"));
            }
        }
        address
    } else {
        let ip = raw
            .parse::<std::net::IpAddr>()
            .map_err(|_| format!("{label} address is not a numeric IP address"))?;
        let port = configured_port.ok_or_else(|| format!("{label} port is missing"))?;
        if port == 0 {
            return Err(format!("{label} port must be non-zero"));
        }
        std::net::SocketAddr::new(ip, port)
    };
    if address.port() == 0 {
        return Err(format!("{label} port must be non-zero"));
    }
    Ok(address)
}

fn runtime_endpoints_from_value(value: &serde_json::Value) -> Result<RuntimeEndpoints, String> {
    let control_raw = value
        .pointer("/experimental/clash_api/external_controller")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Clash control endpoint is not configured".to_string())?;
    let control = parse_endpoint_address(control_raw, None, "Clash control endpoint")?;
    if !control.ip().is_loopback() {
        return Err("Clash control endpoint must be loopback".into());
    }

    let selected = value
        .get("inbounds")
        .and_then(|v| v.as_array())
        .and_then(|inbounds| {
            inbounds
                .iter()
                .find(|inbound| inbound.get("tag").and_then(|v| v.as_str()) == Some("probe-in"))
                .or_else(|| {
                    inbounds.iter().find(|inbound| {
                        inbound.get("tag").and_then(|v| v.as_str()) == Some("mixed-in")
                    })
                })
        });
    let probe_proxy = if let Some(inbound) = selected {
        if !matches!(
            inbound.get("type").and_then(|v| v.as_str()),
            Some("mixed") | Some("http")
        ) {
            return Err("probe inbound must use the mixed or http protocol".into());
        }
        let listen = inbound
            .get("listen")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "probe inbound listen address is missing".to_string())?;
        let listen_port = inbound
            .get("listen_port")
            .and_then(|v| v.as_u64())
            .and_then(|port| u16::try_from(port).ok())
            .ok_or_else(|| "probe inbound listen port is invalid".to_string())?;
        let address = parse_endpoint_address(listen, Some(listen_port), "probe endpoint")?;
        if !(address.ip().is_loopback() || address.ip().is_unspecified()) {
            return Err("probe endpoint must be loopback or unspecified".into());
        }
        let address = if address.ip().is_unspecified() {
            match address {
                std::net::SocketAddr::V4(_) => std::net::SocketAddr::new(
                    std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                    address.port(),
                ),
                std::net::SocketAddr::V6(_) => std::net::SocketAddr::new(
                    std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
                    address.port(),
                ),
            }
        } else {
            address
        };
        Some(ProbeProxyEndpoint { address })
    } else {
        None
    };

    Ok(RuntimeEndpoints {
        control: ControlEndpoint { address: control },
        probe_proxy,
    })
}

// The plan_bridge_ports range. Other ports on 127.0.0.1 belong to the user's own
// local proxy: we must not wait for them to be freed after a stop,
// otherwise disconnecting gets stuck in pending_cleanup forever.
const BRIDGE_PORTS: std::ops::RangeInclusive<u16> = 31_100..=34_000;

fn runtime_ports_from_value(
    value: &serde_json::Value,
    endpoints: &RuntimeEndpoints,
) -> Result<(u16, Vec<u16>), String> {
    let clash = endpoints.control.address.port();
    let mut ports = vec![clash];
    if let Some(inbounds) = value.get("inbounds").and_then(|v| v.as_array()) {
        for inbound in inbounds {
            if let Some(port) = inbound
                .get("listen_port")
                .and_then(|v| v.as_u64())
                .and_then(|p| u16::try_from(p).ok())
            {
                ports.push(port);
            }
        }
    }
    if let Some(outbounds) = value.get("outbounds").and_then(|v| v.as_array()) {
        for outbound in outbounds {
            if outbound.get("server").and_then(|v| v.as_str()) == Some("127.0.0.1") {
                if let Some(port) = outbound
                    .get("server_port")
                    .and_then(|v| v.as_u64())
                    .and_then(|p| u16::try_from(p).ok())
                    .filter(|p| BRIDGE_PORTS.contains(p))
                {
                    ports.push(port);
                }
            }
        }
    }
    ports.sort_unstable();
    ports.dedup();
    Ok((clash, ports))
}

fn runtime_config_metadata_from_config(
    raw: &str,
) -> Result<(RuntimeEndpoints, u16, Vec<u16>), String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("config json: {e}"))?;
    let endpoints = runtime_endpoints_from_value(&value)?;
    let (clash_port, runtime_ports) = runtime_ports_from_value(&value, &endpoints)?;
    Ok((endpoints, clash_port, runtime_ports))
}

// The core or a bridge died after the 800 ms window, while we were waiting for readiness. Their
// real cause (e.g. `initialize outbound[N]`, by which the frontend
// quarantines the node) matters more than the generic "not ready" after 8 s, which on top of that
// was wiped by the cleanup on abort.
fn take_startup_death(state: &SingboxState) -> Option<String> {
    let core = state.died.lock_recover().take();
    core.or_else(|| state.xray_died.lock_recover().take())
        .or_else(|| state.sidecar_died.lock_recover().take())
}

async fn wait_clash_ready(
    control: &ControlEndpoint,
    state: &SingboxState,
    start_epoch: u64,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        ensure_start_current(state, start_epoch).await?;
        if let Some(err) = take_startup_death(state) {
            return Err(err);
        }
        match crate::clash::clash_get_proxies_unchecked_endpoint(control).await {
            Ok(_) => return Ok(()),
            Err(e) if tokio::time::Instant::now() >= deadline => {
                return Err(format!(
                    "Clash control endpoint port={} is not ready: {e}",
                    control.address.port()
                ))
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(150)).await,
        }
    }
}

async fn local_probe_listener_ready(endpoint: &ProbeProxyEndpoint) -> bool {
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::net::TcpStream::connect(endpoint.address),
        )
        .await,
        Ok(Ok(_))
    )
}

async fn wait_probe_listener_ready(
    endpoint: Option<&ProbeProxyEndpoint>,
    state: &SingboxState,
    start_epoch: u64,
) -> Result<(), String> {
    let Some(endpoint) = endpoint else {
        return Ok(());
    };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        ensure_start_current(state, start_epoch).await?;
        if let Some(err) = take_startup_death(state) {
            return Err(err);
        }
        if local_probe_listener_ready(endpoint).await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "runtime probe endpoint {} has no live listener",
                endpoint.address
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

// After kill we confirm both conditions with ONE short barrier. Previously two
// independent 5-second waits ran sequentially, and when a start was cancelled
// in flight stop was called twice — the protective deadlines added up to almost 30 s.
#[cfg(target_os = "windows")]
fn process_creation_time(handle: windows::Win32::Foundation::HANDLE) -> Option<u64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetProcessTimes;

    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user).ok()?;
    }
    Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
}

#[cfg(target_os = "windows")]
fn track_process(pid: u32) -> TrackedProcess {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    let creation_time = unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
        .ok();
        handle.and_then(|handle| {
            let creation_time = process_creation_time(handle);
            let _ = CloseHandle(handle);
            creation_time
        })
    };
    TrackedProcess { pid, creation_time }
}

#[cfg(not(target_os = "windows"))]
fn track_process(pid: u32) -> TrackedProcess {
    TrackedProcess {
        pid,
        creation_time: None,
    }
}

#[cfg(target_os = "windows")]
fn process_has_exited(process: &TrackedProcess) -> bool {
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    unsafe {
        let access = if process.creation_time.is_some() {
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
        } else {
            PROCESS_SYNCHRONIZE
        };
        // ERROR_INVALID_PARAMETER means the original PID is already gone. Any other
        // error (e.g. ACCESS_DENIED) must not be passed off as a confirmed exit.
        let Ok(handle) = OpenProcess(access, false, process.pid) else {
            return GetLastError() == ERROR_INVALID_PARAMETER;
        };
        // A new process object with the same PID is not our runtime: the original
        // process has already exited, and the new one must neither be waited on nor, even less, killed.
        if let Some(expected) = process.creation_time {
            match process_creation_time(handle) {
                Some(actual) if actual != expected => {
                    let _ = CloseHandle(handle);
                    return true;
                }
                None => {
                    let _ = CloseHandle(handle);
                    return false;
                }
                Some(_) => {}
            }
        }
        let exited = WaitForSingleObject(handle, 0) == WAIT_OBJECT_0;
        let _ = CloseHandle(handle);
        exited
    }
}

#[cfg(target_os = "windows")]
fn terminate_tracked_process(process: &TrackedProcess) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE,
    };

    let Some(expected) = process.creation_time else {
        // Without a stable identity, terminating a bare PID again is unsafe.
        return;
    };
    unsafe {
        if let Ok(handle) = OpenProcess(
            PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            process.pid,
        ) {
            // We check the identity on the same handle we pass to
            // TerminateProcess: the PID can no longer move between the check and the kill.
            if process_creation_time(handle) == Some(expected) {
                let _ = TerminateProcess(handle, 1);
            }
            let _ = CloseHandle(handle);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate_tracked_process(_process: &TrackedProcess) {}

#[cfg(not(target_os = "windows"))]
fn killed_processes_exited(state: &SingboxState, _processes: &[TrackedProcess]) -> bool {
    // A monitor without Terminated went into unconfirmed: it doesn't count as
    // confirmation of the exit, so both zeros are needed here.
    state.live_processes.load(Ordering::SeqCst) == 0
        && state.unconfirmed_exits.load(Ordering::SeqCst) == 0
}

#[cfg(target_os = "windows")]
fn killed_processes_exited(_state: &SingboxState, processes: &[TrackedProcess]) -> bool {
    processes.iter().all(process_has_exited)
}

#[cfg(target_os = "windows")]
fn unresolved_processes(processes: &[TrackedProcess]) -> Vec<TrackedProcess> {
    processes
        .iter()
        .filter(|process| process.creation_time.is_some() && !process_has_exited(process))
        .cloned()
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn unresolved_processes(processes: &[TrackedProcess]) -> Vec<TrackedProcess> {
    processes.to_vec()
}

async fn wait_runtime_released(
    state: &SingboxState,
    ports: &[u16],
    killed_processes: &[TrackedProcess],
) -> (bool, Vec<u16>) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        // live_processes is a counter of CommandEvent::Terminated deliveries to
        // the log monitor, not an OS state. The event comes after stdout/stderr and
        // may be late after a successful kill. On Windows we wait for real PIDs.
        let processes_exited = killed_processes_exited(state, killed_processes);
        // We check exactly the possibility of the next bind, not connect. On
        // Windows a connect to an already closed but WFP/WinDivert-filtered port
        // may wait for TCP retransmit for 15–30 seconds and thereby blow through the outer
        // two-second deadline. bind answers synchronously and instantly.
        let remaining_ports: Vec<u16> = ports
            .iter()
            .copied()
            .filter(|port| {
                std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, *port)).is_err()
            })
            .collect();
        if processes_exited && remaining_ports.is_empty() {
            return (true, Vec::new());
        }
        if tokio::time::Instant::now() >= deadline {
            return (processes_exited, remaining_ports);
        }
        let notified = state.process_exit_notify.notified();
        tokio::select! {
            _ = notified => {}
            _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => {}
        }
    }
}

pub(crate) fn runtime_snapshot_value(
    state: &SingboxState,
    kill_switch_active: bool,
) -> RuntimeSnapshot {
    let running = compute_singbox_running(state);
    let record = state.runtime.lock_recover().clone();
    let proxy_state = proxy::system_proxy_state();
    let (notification_generation, notification_applied_generation) =
        proxy::proxy_notification_generations();
    let generation = record.as_ref().map(|r| r.process_generation).unwrap_or(0);
    let mode = record.as_ref().map(|r| r.mode.clone());
    let configured_endpoint = record.as_ref().and_then(|r| {
        r.endpoints
            .probe_proxy
            .as_ref()
            .map(|endpoint| endpoint.address.to_string())
    });
    let listener_ready = running && record.as_ref().is_some_and(|r| r.listener_ready);
    let runtime_diagnostic = RuntimeDiagnostic {
        mode: mode.clone(),
        generation,
        configured_endpoint,
        published_endpoint: proxy_state.proxy_server.clone(),
        listener_ready,
        proxy_enable: proxy_state.proxy_enable,
        proxy_server: proxy_state.proxy_server.clone(),
        notification_generation,
        notification_applied_generation,
    };
    RuntimeSnapshot {
        running,
        starting: state.starting.load(Ordering::SeqCst),
        process_generation: generation,
        source_fingerprint: record.as_ref().and_then(|r| r.source_fingerprint.clone()),
        config_hash: record.as_ref().and_then(|r| r.config_hash.clone()),
        mode,
        strict_privacy: record.as_ref().is_some_and(|r| r.strict_privacy),
        pinned_node_tag: record.as_ref().and_then(|r| r.pinned_node_tag.clone()),
        control_endpoint: record.as_ref().map(|r| r.endpoints.control.clone()),
        probe_proxy_endpoint: record
            .as_ref()
            .and_then(|r| r.endpoints.probe_proxy.clone()),
        listener_ready,
        clash_port: record.as_ref().map(|r| r.clash_port).unwrap_or(0),
        clash_ready: running && record.as_ref().is_some_and(|r| r.clash_ready),
        proxy_enable: proxy_state.proxy_enable,
        proxy_server: proxy_state.proxy_server,
        notification_generation,
        notification_applied_generation,
        runtime_diagnostic,
        sidecars: serde_json::json!({ "xray": compute_xray_status(state), "clients": compute_sidecar_status(state) }),
        system_proxy_ownership: if proxy_state.owned {
            "owned"
        } else {
            "not_owned"
        },
        kill_switch_active,
    }
}

pub(crate) fn native_runtime_status(
    app: &AppHandle,
    expected_generation: u64,
) -> NativeRuntimeStatus {
    let Some(state) = app.try_state::<SingboxState>() else {
        return NativeRuntimeStatus::default();
    };
    let record = state.runtime.lock_recover().clone();
    let process_generation = record
        .as_ref()
        .map(|runtime| runtime.process_generation)
        .unwrap_or(0);
    let generation_matches = expected_generation == 0 || process_generation == expected_generation;
    NativeRuntimeStatus {
        running: generation_matches && compute_singbox_running(&state),
        xray_alive: if state.xray_child.lock_recover().is_none() {
            true
        } else {
            state.xray_died.lock_recover().is_none()
        },
        sidecars_alive: if state.sidecars.lock_recover().is_empty() {
            true
        } else {
            state.sidecar_died.lock_recover().is_none()
        },
        clash_ready: generation_matches
            && record.as_ref().is_some_and(|runtime| runtime.clash_ready),
        control_endpoint: if generation_matches {
            record
                .as_ref()
                .map(|runtime| runtime.endpoints.control.clone())
        } else {
            None
        },
        probe_proxy_endpoint: if generation_matches {
            record
                .as_ref()
                .and_then(|runtime| runtime.endpoints.probe_proxy.clone())
        } else {
            None
        },
    }
}

pub(crate) fn probe_endpoint_for_generation(
    state: &SingboxState,
    expected_generation: Option<u64>,
) -> Result<(u64, ProbeProxyEndpoint), &'static str> {
    let runtime = state.runtime.lock_recover();
    let runtime = runtime.as_ref().ok_or("runtime_unavailable")?;
    if let Some(expected_generation) = expected_generation.filter(|generation| *generation != 0) {
        if runtime.process_generation != expected_generation {
            return Err("stale_generation");
        }
    }
    let endpoint = runtime
        .endpoints
        .probe_proxy
        .clone()
        .ok_or("endpoint_unavailable")?;
    Ok((runtime.process_generation, endpoint))
}

async fn local_clash_listener_ready(control: &ControlEndpoint) -> bool {
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::net::TcpStream::connect(control.address),
        )
        .await,
        Ok(Ok(_))
    )
}

async fn validate_runtime_probe_endpoint(
    state: &SingboxState,
    expected_generation: Option<u64>,
    expected_endpoint: Option<&str>,
) -> Result<(u64, ProbeProxyEndpoint), String> {
    let (generation, endpoint) = probe_endpoint_for_generation(state, expected_generation)
        .map_err(|reason| format!("runtime probe endpoint is {reason}"))?;
    if let Some(expected_endpoint) = expected_endpoint {
        let expected = parse_endpoint_address(expected_endpoint, None, "published proxy endpoint")?;
        if expected != endpoint.address {
            return Err(format!(
                "stale proxy endpoint: expected {}, current generation {} owns {}",
                expected, generation, endpoint.address
            ));
        }
    }
    if !compute_singbox_running(state) {
        return Err(format!(
            "runtime generation {generation} is not running for {}",
            endpoint.address
        ));
    }
    if !state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| runtime.listener_ready)
    {
        return Err(format!(
            "runtime generation {generation} has not published listener readiness for {}",
            endpoint.address
        ));
    }
    if !local_probe_listener_ready(&endpoint).await {
        return Err(format!(
            "runtime generation {generation} has no live listener at {}",
            endpoint.address
        ));
    }
    Ok((generation, endpoint))
}

async fn enable_system_proxy_for_runtime(
    state: &SingboxState,
    host_port: &str,
    bypass_lan: Option<bool>,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    let (generation, endpoint) =
        validate_runtime_probe_endpoint(state, expected_generation, Some(host_port)).await?;
    let canonical_endpoint = endpoint.address.to_string();
    proxy::set_system_proxy(true, Some(&canonical_endpoint), bypass_lan)?;
    let proxy_state = proxy::system_proxy_state();
    if !proxy::system_proxy_matches(&canonical_endpoint)
        || !proxy_state.proxy_enable
        || !proxy_state.owned
        || proxy_state.proxy_server.as_deref() != Some(canonical_endpoint.as_str())
    {
        let _ = proxy::set_system_proxy(false, None, None);
        return Err(format!(
            "system proxy readback mismatch: enable={} server={:?}, expected {}",
            proxy_state.proxy_enable, proxy_state.proxy_server, canonical_endpoint
        ));
    }
    if !local_probe_listener_ready(&endpoint).await {
        let _ = proxy::set_system_proxy(false, None, None);
        return Err(format!(
            "probe listener disappeared after system proxy enable at {}",
            canonical_endpoint
        ));
    }
    // We record it only for our own generation: the runtime may have changed during IPC.
    if let Some(runtime) = state
        .runtime
        .lock_recover()
        .as_mut()
        .filter(|runtime| runtime.process_generation == generation)
    {
        runtime.system_proxy_endpoint = Some(canonical_endpoint);
    }
    Ok(())
}

fn forget_system_proxy_endpoint(state: &SingboxState) {
    if let Some(runtime) = state.runtime.lock_recover().as_mut() {
        runtime.system_proxy_endpoint = None;
    }
}

/// The system proxy published by the live runtime is no longer ours: another program
/// removed or overrode it. Browser traffic then bypasses the tunnel, although
/// the core is alive and the interface shows "connected". We don't check during
/// a stop: stop removes the proxy itself before forgetting the runtime.
fn system_proxy_lost(state: &SingboxState) -> bool {
    if state.stopping.load(Ordering::SeqCst) {
        return false;
    }
    let expected = state
        .runtime
        .lock_recover()
        .as_ref()
        .and_then(|runtime| runtime.system_proxy_endpoint.clone());
    expected.is_some_and(|endpoint| !proxy::system_proxy_matches(&endpoint))
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RuntimeDataplaneVerification {
    Ready,
    HardFailed { reason: String },
    Unverified { reason: String },
    Cancelled,
    Stale,
}

fn operation_is_current(app: &AppHandle, token: &RuntimeOperationToken) -> bool {
    app.try_state::<RuntimeOperationCoordinator>()
        .is_some_and(|coordinator| coordinator.authorize(token))
}

fn lifecycle_operation(
    app: &AppHandle,
    supplied: Option<RuntimeOperationToken>,
    fallback_kind: RuntimeOperationKind,
    generation: u64,
    source_fingerprint: Option<&str>,
) -> Result<(RuntimeOperationToken, bool), String> {
    let coordinator = app
        .try_state::<RuntimeOperationCoordinator>()
        .ok_or("runtime operation coordinator unavailable")?;
    match supplied {
        Some(token) if coordinator.authorize(&token) => Ok((token, false)),
        Some(_) => Err("stale or cancelled runtime operation token".into()),
        None => coordinator
            .begin(fallback_kind, generation, source_fingerprint)
            .map(|token| (token, true)),
    }
}

fn finish_implicit_operation(app: &AppHandle, token: &RuntimeOperationToken, implicit: bool) {
    if implicit {
        if let Some(coordinator) = app.try_state::<RuntimeOperationCoordinator>() {
            let _ = coordinator.complete(token);
        }
    }
}

fn runtime_identity_matches(
    state: &SingboxState,
    generation: u64,
    source_fingerprint: Option<&str>,
) -> bool {
    state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| {
            runtime.process_generation == generation
                && source_fingerprint
                    .is_none_or(|expected| runtime.source_fingerprint.as_deref() == Some(expected))
        })
}

fn verified_runtime_ready(app: &AppHandle) -> RuntimeDataplaneVerification {
    match release_transition_barrier(app) {
        Ok(()) => RuntimeDataplaneVerification::Ready,
        Err(_) => RuntimeDataplaneVerification::Unverified {
            reason: "transition_barrier_preserved".into(),
        },
    }
}

/// One-shot source-switch verifier.  It intentionally does not consult the
/// background watchdog state: a transaction proves *this* runtime generation or
/// returns a structured non-destructive verdict.
#[tauri::command]
pub async fn verify_runtime_dataplane(
    app: AppHandle,
    state: State<'_, SingboxState>,
    operation_token: RuntimeOperationToken,
    expected_generation: u64,
) -> Result<RuntimeDataplaneVerification, String> {
    Ok(verify_runtime_dataplane_inner(&app, &state, operation_token, expected_generation).await)
}

async fn verify_runtime_dataplane_inner(
    app: &AppHandle,
    state: &SingboxState,
    operation_token: RuntimeOperationToken,
    expected_generation: u64,
) -> RuntimeDataplaneVerification {
    let operation_id = operation_token.id;
    let operation_kind = operation_token.kind;
    let started = std::time::Instant::now();
    let verdict =
        verify_runtime_dataplane_unlogged(app, state, operation_token, expected_generation).await;
    log_runtime_verification(
        app,
        state,
        operation_id,
        operation_kind,
        expected_generation,
        &verdict,
        started.elapsed().as_millis() as u64,
    );
    verdict
}

fn runtime_logs_disabled(state: &SingboxState) -> bool {
    state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| runtime.logs_disabled)
}

// What exactly confirmed reachability. The liveness probe counts ANY
// valid HTTP response as success (behind it there is a successful TLS with an allowed host), so
// the log must show what kind of response it was: "ready" without this line can't
// be told apart from a 204 and from a 500 from the remote side.
fn log_verification_evidence(app: &AppHandle, state: &SingboxState, evidence: Option<&str>) {
    if runtime_logs_disabled(state) {
        return;
    }
    let evidence: String = evidence
        .unwrap_or("none")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.'))
        .take(64)
        .collect();
    append_runtime_diagnostic(
        app,
        &format!("source_verification_evidence probe=health result={evidence}"),
    );
}

fn log_runtime_verification(
    app: &AppHandle,
    state: &SingboxState,
    operation_id: u64,
    operation_kind: RuntimeOperationKind,
    expected_generation: u64,
    verdict: &RuntimeDataplaneVerification,
    duration_ms: u64,
) {
    if runtime_logs_disabled(state) {
        return;
    }
    let (control_port, probe_port) = state
        .runtime
        .lock_recover()
        .as_ref()
        .map(|runtime| {
            (
                runtime.endpoints.control.address.port(),
                runtime
                    .endpoints
                    .probe_proxy
                    .as_ref()
                    .map(|endpoint| endpoint.address.port()),
            )
        })
        .unwrap_or((0, None));
    let (verdict_name, reason) = match verdict {
        RuntimeDataplaneVerification::Ready => ("ready", None),
        RuntimeDataplaneVerification::HardFailed { reason } => {
            ("hard_failed", Some(reason.as_str()))
        }
        RuntimeDataplaneVerification::Unverified { reason } => {
            ("unverified", Some(reason.as_str()))
        }
        RuntimeDataplaneVerification::Cancelled => ("cancelled", None),
        RuntimeDataplaneVerification::Stale => ("stale", None),
    };
    // Cancelled and outdated checks are a normal part of switching sources, but
    // a dataplane failure must be shown to the user as an error.
    let level = match verdict {
        RuntimeDataplaneVerification::HardFailed { .. } => DiagnosticLevel::Error,
        RuntimeDataplaneVerification::Unverified { .. } => DiagnosticLevel::Warn,
        _ => DiagnosticLevel::Info,
    };
    append_runtime_diagnostic_at(
        app,
        level,
        &format!(
            "source_verification operation_id={} kind={operation_kind:?} expected_generation={} control_role=clash_api control_port={} probe_role=dataplane_proxy probe_port={} verdict={} reason={} duration_ms={duration_ms}",
            operation_id,
            expected_generation,
            control_port,
            probe_port.map_or_else(|| "none".to_string(), |port| port.to_string()),
            verdict_name,
            reason.unwrap_or("none"),
        ),
    );
}

async fn verify_runtime_dataplane_unlogged(
    app: &AppHandle,
    state: &SingboxState,
    operation_token: RuntimeOperationToken,
    expected_generation: u64,
) -> RuntimeDataplaneVerification {
    let expected_source_fingerprint = operation_token.expected_source_fingerprint.as_deref();
    if !operation_is_current(app, &operation_token) {
        return RuntimeDataplaneVerification::Cancelled;
    }
    if !matches!(
        operation_token.kind,
        RuntimeOperationKind::SourceSwitch
            | RuntimeOperationKind::FrontendRecovery
            | RuntimeOperationKind::QualityRemediation
    ) {
        return RuntimeDataplaneVerification::Cancelled;
    }
    if operation_token.kind == RuntimeOperationKind::SourceSwitch
        && expected_source_fingerprint.is_none()
    {
        return RuntimeDataplaneVerification::Unverified {
            reason: "source_identity_unavailable".into(),
        };
    }
    if !runtime_identity_matches(state, expected_generation, expected_source_fingerprint) {
        return RuntimeDataplaneVerification::Stale;
    }

    let status = native_runtime_status(app, expected_generation);
    if !status.running {
        return RuntimeDataplaneVerification::HardFailed {
            reason: "process_dead".into(),
        };
    }
    if !status.xray_alive || !status.sidecars_alive {
        return RuntimeDataplaneVerification::HardFailed {
            reason: "required_sidecar_dead".into(),
        };
    }
    let local_ready = if status.clash_ready {
        match status.control_endpoint.as_ref() {
            Some(control) => local_clash_listener_ready(control).await,
            None => false,
        }
    } else {
        false
    };
    // The listener check is an await boundary.  Never classify a stale
    // generation as a hard failure after it completes.
    if !operation_is_current(app, &operation_token) {
        return RuntimeDataplaneVerification::Cancelled;
    }
    if !runtime_identity_matches(state, expected_generation, expected_source_fingerprint) {
        return RuntimeDataplaneVerification::Stale;
    }
    if !status.clash_ready || !local_ready {
        return RuntimeDataplaneVerification::HardFailed {
            reason: "local_control_unavailable".into(),
        };
    }
    if !operation_is_current(app, &operation_token) {
        return RuntimeDataplaneVerification::Cancelled;
    }
    if !runtime_identity_matches(state, expected_generation, expected_source_fingerprint) {
        return RuntimeDataplaneVerification::Stale;
    }

    let strict_privacy = state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| runtime.strict_privacy);
    if strict_privacy {
        // `is_active` is also true when only the transitional barrier is alive.
        // It may be removed only on top of an assembled user policy —
        // the same condition as in release_runtime_transition_barrier.
        let wfp_ready = app
            .try_state::<crate::killswitch::KillSwitchState>()
            .is_some_and(|kill_switch| {
                crate::killswitch::policy_lease_active(&kill_switch)
                    && crate::killswitch::is_active(&kill_switch)
            });
        return if wfp_ready {
            verified_runtime_ready(app)
        } else {
            RuntimeDataplaneVerification::Unverified {
                reason: "wfp_policy_unconfirmed".into(),
            }
        };
    }

    let permit = match state
        .dataplane_probe
        .acquire(
            DataplaneProbeKind::SourceVerification,
            expected_generation,
            Some(std::time::Duration::from_secs(1)),
        )
        .await
    {
        Ok(permit) => permit,
        Err(ProbeAcquireError::Busy) => {
            return RuntimeDataplaneVerification::Unverified {
                reason: "probe_busy".into(),
            }
        }
        Err(ProbeAcquireError::StaleGeneration) => return RuntimeDataplaneVerification::Stale,
    };

    for round in 0..2 {
        if !operation_is_current(app, &operation_token) {
            return RuntimeDataplaneVerification::Cancelled;
        }
        if !state.dataplane_probe.is_current(&permit)
            || !runtime_identity_matches(state, expected_generation, expected_source_fingerprint)
        {
            return RuntimeDataplaneVerification::Stale;
        }
        let Some(probe_endpoint) = status.probe_proxy_endpoint.as_ref() else {
            return RuntimeDataplaneVerification::Unverified {
                reason: "endpoint_unavailable".into(),
            };
        };
        let result = crate::quality::probe_health_inner(Some(probe_endpoint)).await;
        // A probe may finish after a superseding source switch, generation
        // replacement, or pressure transition.  Its result is not allowed to
        // release a transition barrier for the newer runtime.
        if !operation_is_current(app, &operation_token) {
            return RuntimeDataplaneVerification::Cancelled;
        }
        if !state.dataplane_probe.is_current(&permit)
            || !runtime_identity_matches(state, expected_generation, expected_source_fingerprint)
        {
            return RuntimeDataplaneVerification::Stale;
        }
        match result {
            Ok(result) if result.ok => {
                log_verification_evidence(app, state, result.error.as_deref());
                return verified_runtime_ready(app);
            }
            Ok(_) if round == 0 => {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if !operation_is_current(app, &operation_token) {
                    return RuntimeDataplaneVerification::Cancelled;
                }
                if !state.dataplane_probe.is_current(&permit)
                    || !runtime_identity_matches(
                        state,
                        expected_generation,
                        expected_source_fingerprint,
                    )
                {
                    return RuntimeDataplaneVerification::Stale;
                }
            }
            Ok(_) => {
                return RuntimeDataplaneVerification::HardFailed {
                    reason: "external_route_failure".into(),
                }
            }
            Err(_) => {
                return RuntimeDataplaneVerification::Unverified {
                    reason: "monitor_error".into(),
                }
            }
        }
    }
    RuntimeDataplaneVerification::Unverified {
        reason: "verification_incomplete".into(),
    }
}

async fn start_singbox_inner(
    app: AppHandle,
    state: &SingboxState,
    spec: RuntimeLaunchSpec,
    operation_token: &RuntimeOperationToken,
) -> Result<RuntimeSnapshot, String> {
    let RuntimeLaunchSpec {
        config_json: raw_config_json,
        mode,
        xray_json,
        sidecars_json,
        logs_disabled,
        source_fingerprint,
        config_hash,
        strict_privacy,
        pinned_node_tag,
    } = spec;
    if !operation_is_current(&app, operation_token) {
        return Err("stale or cancelled runtime operation token".into());
    }
    let (start_epoch, process_generation) = {
        // A short synchronous gate makes start/stop linear at the generation switch
        // point; the long launch itself doesn't run under it.
        let _gate = state.lifecycle_gate.lock_recover();
        if state.stopping.load(Ordering::SeqCst) {
            return Err(crate::util::i18n_error("backend.vpn.stopping"));
        }
        // The sentinel comes BEFORE the child check: a second concurrent call is cut off
        // while the first is still in an await before publishing the child.
        if state.starting.swap(true, Ordering::SeqCst) {
            return Err(crate::util::i18n_error("backend.vpn.starting"));
        }
        if state.pending_cleanup.lock_recover().is_some() {
            state.starting.store(false, Ordering::SeqCst);
            return Err(crate::util::i18n_error("backend.vpn.notCleaned"));
        }
        let child = state.child.lock_recover();
        if child.is_some() || state.xray_child.lock_recover().is_some() {
            state.starting.store(false, Ordering::SeqCst);
            return Err(crate::util::i18n_error("backend.vpn.running"));
        }
        let start_epoch = state.start_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        // First change the generation, then clear the death flags. Otherwise a late
        // Terminated of the old runtime could land in the window and poison the new session.
        let process_generation = state.process_generation.fetch_add(1, Ordering::SeqCst) + 1;
        // `expected_exit_generation` applies only to an already stopped
        // runtime. After a new start it must not match the new generation:
        // otherwise the first real crash after a cancelled disconnect would be
        // misclassified as a regular stop.
        state.expected_exit_generation.store(0, Ordering::SeqCst);
        *state.died.lock_recover() = None;
        *state.xray_died.lock_recover() = None;
        *state.sidecar_died.lock_recover() = None;
        (start_epoch, process_generation)
    };
    let _starting = StartingGuard(&state.starting);
    // Harden the config (clash API secret + loopback) before writing/sending.
    let cache_path = singbox_cache_path(&app)?;
    let config_json = harden_config(&raw_config_json, Some(&cache_path));
    // The frontend doesn't see the password for network neighbors and doesn't put it into the config: it is
    // substituted by the backend from the encrypted storage (lan_auth.rs).
    let config_json = crate::lan_auth::apply_to_config(&app, &config_json);
    let (endpoints, clash_port, runtime_ports) = runtime_config_metadata_from_config(&config_json)?;
    if operation_token.kind == RuntimeOperationKind::SourceSwitch
        && (operation_token.expected_source_fingerprint.is_none()
            || operation_token.expected_source_fingerprint.as_deref()
                != source_fingerprint.as_deref())
    {
        return Err("source identity changed during source switch".into());
    }
    let probe_endpoint = endpoints.probe_proxy.clone();
    // Parsing the bridge spec comes before publishing the ports: with broken JSON nothing
    // was launched, but the port list would already have gone into state and the next stop
    // would check the release of ports of a runtime that never existed.
    let sidecar_specs: Option<Vec<SidecarSpec>> = sidecars_json
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .map(|sj| serde_json::from_str(sj).map_err(|e| format!("sidecars json: {e}")))
        .transpose()?;
    *state.runtime_ports.lock_recover() = runtime_ports;

    // Two-core: if the config has xhttp nodes, bring up xray BEFORE sing-box
    // (in any mode). On a spawn error we don't start the VPN at all.
    if let Some(xj) = xray_json.as_ref().filter(|s| !s.trim().is_empty()) {
        if let Err(e) = spawn_xray(
            &app,
            state,
            xj,
            logs_disabled,
            start_epoch,
            process_generation,
        )
        .await
        {
            abort_started_runtime_scoped(state, PortDebt::Unproven).await;
            return Err(e);
        }
        ensure_start_current(state, start_epoch).await?;
        ensure_operation_current(&app, state, operation_token).await?;
    }

    // naive / trusttunnel sidecar clients (if there are such nodes) — also BEFORE sing-box.
    if let Some(specs) = sidecar_specs.as_ref() {
        if let Err(e) = spawn_sidecars(
            &app,
            state,
            specs,
            logs_disabled,
            start_epoch,
            process_generation,
        )
        .await
        {
            abort_started_runtime_scoped(state, PortDebt::Unproven).await;
            return Err(e);
        }
        ensure_start_current(state, start_epoch).await?;
        ensure_operation_current(&app, state, operation_token).await?;
    }

    // The mode (proxy/systemProxy/tun) no longer affects the core launch in Rust:
    // the TUN inbound is already baked into config_json (buildInbound in singbox.js), and
    // the system proxy is set by the frontend with a separate command. In TUN Ninety must
    // be elevated — JS guarantees this (is_elevated/relaunch) before the call.
    let _ = &mode;

    // Everything after the bridges come up goes through one shared cleanup: an early `?` here
    // would leave xray/naive/TT orphaned if writing the config or spawning
    // sing-box failed (credentials in their configs on disk, busy ports, and the
    // xray_child.is_some() guard would block the next start until an explicit stop).
    if let Err(e) = spawn_singbox_core(
        &app,
        state,
        &config_json,
        logs_disabled,
        start_epoch,
        process_generation,
    )
    .await
    {
        abort_started_runtime_scoped(state, PortDebt::Unproven).await;
        return Err(e);
    }
    ensure_start_current(state, start_epoch).await?;
    ensure_operation_current(&app, state, operation_token).await?;

    if let Err(e) = wait_clash_ready(&endpoints.control, state, start_epoch).await {
        abort_started_runtime_scoped(state, PortDebt::Unproven).await;
        return Err(e);
    }
    // Clash control readiness is not sufficient for System Proxy/TUN. The
    // endpoint published to Windows and to the dataplane probe must be the
    // listener owned by this freshly spawned sing-box generation.
    if let Err(e) = wait_probe_listener_ready(probe_endpoint.as_ref(), state, start_epoch).await {
        abort_started_runtime_scoped(state, PortDebt::Unproven).await;
        return Err(e);
    }
    ensure_operation_current(&app, state, operation_token).await?;
    *state.runtime.lock_recover() = Some(RuntimeRecord {
        process_generation,
        source_fingerprint: source_fingerprint.clone(),
        config_hash: config_hash.clone(),
        mode: mode.clone(),
        strict_privacy,
        pinned_node_tag: pinned_node_tag.clone(),
        logs_disabled,
        endpoints: endpoints.clone(),
        listener_ready: true,
        clash_port,
        clash_ready: true,
        system_proxy_endpoint: None,
    });
    state.dataplane_probe.reset_generation(process_generation);
    spawn_core_death_watcher(app.clone(), state, process_generation);
    // Previously there was a literal `false` here, i.e. the field went to the frontend
    // obviously false: in strict mode the kill switch is already armed at preflight.
    // Right now nobody substitutes the start snapshot into `runtimeSnapshotMatchesExpected`
    // (that one works with a fresh `runtime_snapshot`), but the check there is strict
    // (`killSwitchExpected ? === true : !== true`), and the very first call that
    // trusted the start response would silently break the connection. We return the actual
    // state; a cold `is_active` is a synchronous RPC to BFE, so it goes
    // to the blocking pool, as in `runtime_snapshot`.
    let kill_switch_active = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let kill_switch = app.try_state::<crate::killswitch::KillSwitchState>();
            kill_switch.is_some_and(|ks| crate::killswitch::is_active(&ks))
        })
        .await
        .map_err(|e| format!("could not read the kill switch state: {e}"))?
    };
    Ok(runtime_snapshot_value(state, kill_switch_active))
}

// Name of the core death event. The payload is only the generation and the cause
// text from the engine log: no addresses, no config.
pub const CORE_DIED_EVENT: &str = "vpn:core-died";

#[derive(Clone, serde::Serialize)]
pub struct CoreDiedEvent {
    pub generation: u64,
    pub reason: Option<String>,
}

// Rust learns about core death instantly: the process monitor catches Terminated and
// calls `process_exit_notify`. Before this watchdog nobody consumed the event —
// the frontend discovered the corpse only on the next 5-second tick, i.e. detection
// depended on the WebView timer. In the tray Chromium throttles timers of a hidden page, and
// under full CPU load the renderer is scheduled last — exactly in the
// cases where fault tolerance is needed. The watchdog stops and brings up NOTHING:
// the policy (stop, recover, what to show) is still decided by
// the frontend, here we only deliver the fact without delay.
fn spawn_core_death_watcher(app: AppHandle, state: &SingboxState, generation: u64) {
    let died = state.died.clone();
    let current_generation = state.process_generation.clone();
    let notify = state.process_exit_notify.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            // Register the wait BEFORE checking the condition: otherwise a death that landed
            // in the window between the check and the await would lose the wakeup, and the watchdog
            // would hang until someone else's exit.
            let notified = notify.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            if current_generation.load(Ordering::SeqCst) != generation {
                return; // the generation changed — this runtime is no longer ours
            }
            let reason = died.lock_recover().clone();
            if reason.is_some() {
                let _ = app.emit(CORE_DIED_EVENT, CoreDiedEvent { generation, reason });
                return;
            }
            notified.await;
        }
    });
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri IPC: named fields keep a compatible wire contract.
pub async fn start_singbox(
    app: AppHandle,
    state: State<'_, SingboxState>,
    config_json: String,
    mode: String,
    xray_json: Option<String>,
    sidecars_json: Option<String>,
    logs_disabled: Option<bool>,
    source_fingerprint: Option<String>,
    config_hash: Option<String>,
    strict_privacy: Option<bool>,
    pinned_node_tag: Option<String>,
    operation_token: Option<RuntimeOperationToken>,
) -> Result<RuntimeSnapshot, String> {
    let (operation_token, implicit) = lifecycle_operation(
        &app,
        operation_token,
        RuntimeOperationKind::UserConnect,
        0,
        source_fingerprint.as_deref(),
    )?;
    let logs_disabled = logs_disabled.unwrap_or(false);
    let result = start_singbox_inner(
        app.clone(),
        &state,
        RuntimeLaunchSpec {
            config_json,
            mode,
            xray_json,
            sidecars_json,
            logs_disabled,
            source_fingerprint,
            config_hash,
            strict_privacy: strict_privacy.unwrap_or(false),
            pinned_node_tag,
        },
        &operation_token,
    )
    .await;
    if let Err(error) = &result {
        let generation = state.process_generation.load(Ordering::SeqCst);
        log_start_failure(&app, logs_disabled, generation, error);
    }
    finish_implicit_operation(&app, &operation_token, implicit);
    result
}

// The start failure text used to go only to the frontend: the log kept only the
// `runtime_start_error` stage code, while the toast sent the user to look at the log,
// where the cause wasn't. A cancelled start is a normal outcome, not a warning.
fn log_start_failure(app: &AppHandle, logs_disabled: bool, generation: u64, error: &str) {
    let level = if is_start_cancellation(error) {
        DiagnosticLevel::Info
    } else {
        DiagnosticLevel::Warn
    };
    log_stop_diagnostic(
        app,
        logs_disabled,
        level,
        &start_failure_line(generation, error),
    );
}

fn is_start_cancellation(error: &str) -> bool {
    error.contains("backend.vpn.startCancelled")
}

fn start_failure_line(generation: u64, error: &str) -> String {
    let reason = error
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
    format!("runtime_start generation={generation} result=failed reason={reason}")
}

// Writing the config + spawning sing-box + the fail-fast window. Moved out of start_singbox
// so that any Err from here goes through the shared core and bridge cleanup at the caller —
// the function itself cleans up nothing.
async fn spawn_singbox_core(
    app: &AppHandle,
    state: &SingboxState,
    config_json: &str,
    logs_disabled: bool,
    start_epoch: u64,
    process_generation: u64,
) -> Result<(), String> {
    let path = config_path(app)?;
    std::fs::write(&path, config_json).map_err(|e| format!("write config: {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("sing-box")
        .map_err(|e| format!("sidecar lookup: {e}"))?;
    let (rx, child) = sidecar
        .args(["run", "-c", &path_str])
        .env("NO_COLOR", "1")
        .spawn()
        .map_err(|e| format!("spawn sing-box: {e}"))?;

    prioritize_datapath_process(child.pid());
    crate::job_guard::bind_pid(child.pid());
    *state.child.lock_recover() = Some(child);

    let died_flag = state.died.clone();
    // sing-box is silent anyway with logs_disabled (log.disabled in the config), but we also
    // turn off the file writer — consistently with the other engines.
    let log_file = if logs_disabled { None } else { log_path(app) };
    spawn_log_monitor(
        rx,
        log_file,
        died_flag,
        MonitorCounters {
            live: state.live_processes.clone(),
            unconfirmed: state.unconfirmed_exits.clone(),
            exit_notify: state.process_exit_notify.clone(),
        },
        MonitorGeneration {
            current: state.process_generation.clone(),
            expected_exit: state.expected_exit_generation.clone(),
            value: process_generation,
        },
        MonitorSpec::core(
            format!("=== sing-box start · generation {process_generation} ==="),
            "sing-box",
        ),
    );

    // give sing-box 800 ms to fail with a parse / bind error
    wait_start_delay(state, start_epoch, std::time::Duration::from_millis(800)).await?;
    if let Some(err) = state.died.lock_recover().take() {
        return Err(err);
    }
    // A bridge may also have died within these 800 ms (after its settle pause) — fail-fast too,
    // otherwise the health watchdog finds the corpse 5 s later and goes into a reconnect loop.
    let bridge_err = state
        .xray_died
        .lock_recover()
        .take()
        .or_else(|| state.sidecar_died.lock_recover().take());
    if let Some(err) = bridge_err {
        return Err(err);
    }
    Ok(())
}

fn kill_xray(state: &SingboxState) -> bool {
    if let Some(child) = state.xray_child.lock_recover().take() {
        child.kill().is_ok()
    } else {
        true
    }
}

fn kill_sidecars(state: &SingboxState) -> bool {
    let mut ok = true;
    for child in state.sidecars.lock_recover().drain(..) {
        ok &= child.kill().is_ok();
    }
    ok
}

// Cleanup of an unfinished launch. Cancellation by epoch and cancellation by operation
// ownership are the same outcome: the brought-up set no longer belongs
// to anyone. It must not be left alive: the `child.is_some()` guard would block
// the next start, and compute_singbox_running would keep returning
// running=true with an empty RuntimeRecord.
//
// 🔴 Cancellation must give the same guarantees as stop_singbox_inner. Previously there
// was a bare `let _ = child.kill()` here without a tracked PID, without checking port
// release and without pending_cleanup: if kill didn't go through (the process hung in
// TUN initialization, access denied), the state was reset, the next start passed
// the `child.is_some()` guard and brought up a SECOND set on the same ports — two
// sing-box instances fought over the clash API and mixed-in, while the orphan held the TUN adapter.
async fn abort_started_runtime(state: &SingboxState) {
    abort_started_runtime_scoped(state, PortDebt::Ours).await;
}

/// Who owns the ports of an unfinished launch.
///
/// Cancellation (new epoch, revoked token) removes the already brought-up set: a port
/// that stays busy is almost certainly held by our own process, and the debt is mandatory.
/// A spawn failure is a different case: the port may have been taken by a FOREIGN process, which is exactly
/// why the launch didn't happen. A permanent debt on such a port locks both
/// doors — start answers "repeat the disconnect", and stop can't confirm
/// the release of a foreign port and leaves the debt again.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PortDebt {
    Ours,
    Unproven,
}

async fn abort_started_runtime_scoped(state: &SingboxState, port_debt: PortDebt) {
    // Re-entry on an already cleaned-up state. The internal start steps
    // (wait_start_delay → ensure_start_current, wait_clash_ready) call
    // the cancellation themselves, and the outer handler of their error calls it again. The second
    // pass has nothing to confirm: it sees empty targets, would declare the cleanup
    // successful and erase the debt recorded by the first one — the orphaned engine and busy
    // ports would be left without a single recovery attempt.
    let nothing_to_abort = state.child.lock_recover().is_none()
        && state.xray_child.lock_recover().is_none()
        && state.sidecars.lock_recover().is_empty()
        && state.runtime_ports.lock_recover().is_empty()
        && state.runtime.lock_recover().is_none();
    if nothing_to_abort {
        return;
    }
    // Cancellation is a planned termination of THIS generation. Without the mark the monitor
    // classifies our own kill as a crash and writes an ERROR to the log,
    // "sing-box died" with a dump of lines — the user sees a core failure where
    // their own cancellation fired.
    state.expected_exit_generation.store(
        state.process_generation.load(Ordering::SeqCst),
        Ordering::SeqCst,
    );
    // The identity is taken BEFORE kill: Windows reuses a bare PID, and a repeated
    // cleanup needs proof that it's finishing off exactly our process object.
    let mut killed = Vec::new();
    if let Some(child) = state.child.lock_recover().take() {
        killed.push(track_process(child.pid()));
        let _ = child.kill();
    }
    if let Some(child) = state.xray_child.lock_recover().take() {
        killed.push(track_process(child.pid()));
        let _ = child.kill();
    }
    for child in state.sidecars.lock_recover().drain(..) {
        killed.push(track_process(child.pid()));
        let _ = child.kill();
    }
    killed.sort_unstable_by_key(|process| process.pid);
    killed.dedup_by_key(|process| process.pid);
    let ports = {
        let mut guard = state.runtime_ports.lock_recover();
        std::mem::take(&mut *guard)
    };
    // The runtime is forgotten before the proxy is removed: otherwise the watchdog could
    // see "our proxy is gone" on a still published runtime.
    *state.runtime.lock_recover() = None;
    let _ = proxy::set_system_proxy(false, None, None);

    // The same short confirmation barrier as in stop_singbox_inner.
    let (processes_exited, remaining_ports) = wait_runtime_released(state, &ports, &killed).await;
    let ports_confirmed = remaining_ports.is_empty() || port_debt == PortDebt::Unproven;
    if processes_exited && ports_confirmed {
        clear_death_flags(state);
        // A previously registered debt is NOT removed: unlike
        // stop_singbox_inner, cancellation doesn't mix pending_cleanup into its
        // targets, i.e. nobody checked these processes and ports. Only a stop that actually
        // finishes them off has the right to write off the debt.
    } else {
        // Cleanup not confirmed — record the debt. The next start will refuse with
        // "repeat the disconnect", and the next stop will physically finish off the rest.
        let incoming = PendingCleanup {
            processes: unresolved_processes(&killed),
            ports: match port_debt {
                PortDebt::Ours => ports,
                PortDebt::Unproven => Vec::new(),
            },
        };
        let mut guard = state.pending_cleanup.lock_recover();
        *guard = merge_pending_cleanup(guard.clone(), incoming);
    }
}

/// Merging cleanup debts. A new unfinished set doesn't replace the previous one:
/// each record is a process object not yet finished off or a port not yet released,
/// and losing any of them means an orphan without a subsequent attempt.
fn merge_pending_cleanup(
    existing: Option<PendingCleanup>,
    incoming: PendingCleanup,
) -> Option<PendingCleanup> {
    let existing = existing.unwrap_or_default();
    let mut processes = existing.processes;
    processes.extend(incoming.processes);
    processes.sort_unstable_by_key(|process| process.pid);
    processes.dedup_by_key(|process| process.pid);
    let mut ports = existing.ports;
    ports.extend(incoming.ports);
    ports.sort_unstable();
    ports.dedup();
    if processes.is_empty() && ports.is_empty() {
        return None;
    }
    Some(PendingCleanup { processes, ports })
}

async fn ensure_start_current(state: &SingboxState, epoch: u64) -> Result<(), String> {
    if state.start_epoch.load(Ordering::SeqCst) == epoch {
        return Ok(());
    }
    abort_started_runtime(state).await;
    Err(crate::util::i18n_error("backend.vpn.startCancelled"))
}

// Revoked/outdated token at any start step. Unlike the epoch check,
// the coordinator may have changed the owner without a new start_epoch (a latest-wins source
// switch), so this branch is the one that must clean up: stop_singbox with the same
// token no longer has ownership and will return refused without touching the processes.
async fn ensure_operation_current(
    app: &AppHandle,
    state: &SingboxState,
    token: &RuntimeOperationToken,
) -> Result<(), String> {
    if operation_is_current(app, token) {
        return Ok(());
    }
    abort_started_runtime(state).await;
    Err("stale or cancelled runtime operation token".into())
}

async fn wait_start_delay(
    state: &SingboxState,
    epoch: u64,
    duration: std::time::Duration,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + duration;
    loop {
        ensure_start_current(state, epoch).await?;
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(());
        }
        tokio::time::sleep(std::cmp::min(
            deadline - now,
            std::time::Duration::from_millis(25),
        ))
        .await;
    }
}

// Erases bridge configs (naive-*.json, trusttunnel-*.toml) from the writable config dir.
// They hold node credentials (user:pass) — we don't keep them on disk longer than the session.
// singbox-current.json/xray-current.json are NOT touched: that's normal for clients, and
// they are overwritten on the next start.
fn purge_bridge_configs(app: &AppHandle) {
    let Ok(dir) = crate::app_paths::config_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if is_bridge_config_name(&name) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn is_bridge_config_name(name: &str) -> bool {
    (name.starts_with("naive-") && name.ends_with(".json"))
        || (name.starts_with("trusttunnel-") && name.ends_with(".toml"))
}

fn is_runtime_config_name(name: &str) -> bool {
    matches!(name, "singbox-current.json" | "xray-current.json") || is_bridge_config_name(name)
}

pub fn purge_stale_runtime_configs(app: &AppHandle) {
    let Ok(dir) = crate::app_paths::config_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if is_runtime_config_name(&name) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// Erases singbox-current.json / xray-current.json from the writable config dir. They hold
// node UUIDs/passwords and (with WARP active) the private WG key — there is no reason to keep them on disk
// longer than the session: the next start will overwrite the files anyway.
fn purge_current_configs(app: &AppHandle) {
    let Ok(dir) = crate::app_paths::config_dir(app) else {
        return;
    };
    for name in ["singbox-current.json", "xray-current.json"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

// Resets the engine death flags. Without this the cause of the last death would live until
// the next start_singbox (health_snapshot would return stale data).
fn clear_death_flags(state: &SingboxState) {
    *state.died.lock_recover() = None;
    *state.xray_died.lock_recover() = None;
    *state.sidecar_died.lock_recover() = None;
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResult {
    singbox: &'static str,
    xray: &'static str,
    sidecars: &'static str,
    ports_released: bool,
    remaining_ports: Vec<u16>,
    processes_exited: bool,
    pending_exit_events: u64,
    // Monitors that ended without Terminated. A non-zero value explains
    // why the stop isn't confirmed by events, and doesn't pass itself off as a live
    // process.
    unconfirmed_monitor_exits: u64,
    system_proxy: &'static str,
    timings: StopTimings,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StopTimings {
    kill_ms: u64,
    proxy_ms: u64,
    confirm_ms: u64,
    total_ms: u64,
}

/// Whether the runtime ports are released from the cleanup's point of view.
///
/// On Windows the engines' exit is confirmed by their process object, and a listening
/// socket doesn't outlive its process. A port that is busy after all our
/// processes have confirmedly exited is held by a foreign program: it managed to
/// take it, for example, after the core crashed. Such a port must not be counted as our own debt —
/// stop would never be confirmed, and start would answer "repeat the
/// disconnect" until the app is restarted. The ports themselves stay in the stop
/// report and are visible in the log.
fn ports_confirmed_released(processes_exited: bool, remaining_ports: &[u16]) -> bool {
    remaining_ports.is_empty() || (cfg!(target_os = "windows") && processes_exited)
}

async fn stop_singbox_inner(app: &AppHandle, state: &SingboxState) -> Result<StopResult, String> {
    let _stop = state.stop_lock.lock().await;
    state.dataplane_probe.invalidate();
    {
        let _gate = state.lifecycle_gate.lock_recover();
        state.stopping.store(true, Ordering::SeqCst);
        // Invalidate start BEFORE removing the child handles. If an IPC start is
        // in an await, it will see the new generation and finish without leftovers.
        state.start_epoch.fetch_add(1, Ordering::SeqCst);
    }
    let _stopping = StoppingGuard(&state.stopping);
    forget_system_proxy_endpoint(state);
    state.expected_exit_generation.store(
        state.process_generation.load(Ordering::SeqCst),
        Ordering::SeqCst,
    );
    let started_at = std::time::Instant::now();
    let pending = state
        .pending_cleanup
        .lock_recover()
        .clone()
        .unwrap_or_default();
    let runtime_ports = state.runtime_ports.lock_recover().clone();
    let (ports, mut killed_processes) = cleanup_targets(&runtime_ports, pending);
    // The CommandChild was already consumed by the previous attempt. A repeated stop must still
    // physically finish off the remaining process object, but only if its
    // creation time still matches — Windows may have reused the bare PID.
    for process in &killed_processes {
        terminate_tracked_process(process);
    }
    // We record processes per component: without this the stop log gave
    // all three lines the same shared verdict, and "failed" didn't say
    // which engine exactly didn't exit.
    let mut singbox_processes: Vec<TrackedProcess> = Vec::new();
    let mut xray_processes: Vec<TrackedProcess> = Vec::new();
    let mut sidecar_processes: Vec<TrackedProcess> = Vec::new();
    let taken = state.child.lock_recover().take();
    let had_singbox = taken.is_some();
    if let Some(child) = taken {
        // child.kill() kills sing-box; the wintun adapter (non-persistent) is removed
        // by the system together with the death of the process that held it — a separate cleanup
        // of the TUN interface is not needed.
        let tracked = track_process(child.pid());
        singbox_processes.push(tracked.clone());
        killed_processes.push(tracked);
        let _ = child.kill();
    }
    let xray_child = state.xray_child.lock_recover().take();
    let had_xray = xray_child.is_some();
    if let Some(child) = xray_child {
        let tracked = track_process(child.pid());
        xray_processes.push(tracked.clone());
        killed_processes.push(tracked);
        let _ = child.kill();
    }
    let sidecar_children: Vec<_> = state.sidecars.lock_recover().drain(..).collect();
    let had_sidecars = !sidecar_children.is_empty();
    for child in sidecar_children {
        let tracked = track_process(child.pid());
        sidecar_processes.push(tracked.clone());
        killed_processes.push(tracked);
        let _ = child.kill();
    }
    killed_processes.sort_unstable_by_key(|process| process.pid);
    killed_processes.dedup_by_key(|process| process.pid);
    let killed_at = std::time::Instant::now();
    let proxy_was_owned = proxy::system_proxy_owned();
    let proxy_ok = proxy::set_system_proxy(false, None, None).is_ok();
    let proxy_done_at = std::time::Instant::now();
    let (processes_exited, remaining_ports) =
        wait_runtime_released(state, &ports, &killed_processes).await;
    // The verdict per component is computed from its own PIDs.
    let singbox_exited = killed_processes_exited(state, &singbox_processes);
    let xray_exited = killed_processes_exited(state, &xray_processes);
    let sidecars_exited = killed_processes_exited(state, &sidecar_processes);
    let ports_released = ports_confirmed_released(processes_exited, &remaining_ports);
    let confirmed_at = std::time::Instant::now();
    let proxy_confirmed = !proxy_was_owned || proxy_ok;
    let cleanup_confirmed = processes_exited && ports_released && proxy_confirmed;
    if cleanup_confirmed {
        purge_bridge_configs(app);
        purge_current_configs(app);
        clear_death_flags(state);
        state.unconfirmed_exits.store(0, Ordering::SeqCst);
        *state.runtime.lock_recover() = None;
        *state.runtime_ports.lock_recover() = Vec::new();
        *state.pending_cleanup.lock_recover() = None;
    } else {
        *state.pending_cleanup.lock_recover() = Some(PendingCleanup {
            processes: unresolved_processes(&killed_processes),
            // We keep the whole set, not just the busy ports: a repeated check
            // must confirm the release of the full runtime contract.
            ports: ports.clone(),
        });
    }
    Ok(StopResult {
        singbox: if !had_singbox {
            "already_stopped"
        } else if singbox_exited {
            "stopped"
        } else {
            "failed"
        },
        xray: if !had_xray {
            "already_stopped"
        } else if xray_exited {
            "stopped"
        } else {
            "failed"
        },
        sidecars: if !had_sidecars {
            "already_stopped"
        } else if sidecars_exited {
            "stopped"
        } else {
            "failed"
        },
        ports_released,
        remaining_ports,
        processes_exited,
        pending_exit_events: state.live_processes.load(Ordering::SeqCst),
        unconfirmed_monitor_exits: state.unconfirmed_exits.load(Ordering::SeqCst),
        system_proxy: if !proxy_was_owned {
            "not_owned"
        } else if proxy_ok {
            "restored"
        } else {
            "failed"
        },
        timings: StopTimings {
            kill_ms: killed_at.duration_since(started_at).as_millis() as u64,
            proxy_ms: proxy_done_at.duration_since(killed_at).as_millis() as u64,
            confirm_ms: confirmed_at.duration_since(proxy_done_at).as_millis() as u64,
            total_ms: started_at.elapsed().as_millis() as u64,
        },
    })
}

#[tauri::command]
pub async fn stop_singbox(
    app: AppHandle,
    state: State<'_, SingboxState>,
    operation_token: Option<RuntimeOperationToken>,
) -> Result<StopResult, String> {
    // Manual disconnect owns the lifecycle token and performs one verified stop.
    let generation = state.process_generation.load(Ordering::SeqCst);
    // logs_disabled lives in RuntimeRecord, and a confirmed stop resets it.
    // We read the setting before stopping, otherwise the final record would go into the file even
    // with logs fully disabled.
    let logs_disabled = state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| runtime.logs_disabled);
    // An ownership refusal is also a stop outcome, and in the UI it looks exactly like the same
    // "cleanup not confirmed" as an unfinished process. Without these records
    // there was a hole in the log: a failed stop left no trace at all, and
    // there was no way to tell a revoked token from a real cleanup problem.
    let requested_kind = operation_token.as_ref().map(|token| token.kind);
    let (operation_token, implicit) = match lifecycle_operation(
        &app,
        operation_token,
        RuntimeOperationKind::UserDisconnect,
        generation,
        None,
    ) {
        Ok(value) => value,
        Err(error) => {
            log_stop_refusal(&app, logs_disabled, requested_kind, generation, &error);
            return Err(error);
        }
    };
    if !operation_is_current(&app, &operation_token) {
        let error = "stale or cancelled runtime operation token".to_string();
        log_stop_refusal(
            &app,
            logs_disabled,
            Some(operation_token.kind),
            generation,
            &error,
        );
        return Err(error);
    }
    if operation_token.kind.needs_transition_barrier() {
        match native_transition_barrier(&app) {
            Ok(barrier) => log_stop_diagnostic(
                &app,
                logs_disabled,
                DiagnosticLevel::Info,
                &format!(
                    "runtime_stop_barrier kind={:?} generation={generation} state={}",
                    operation_token.kind,
                    if barrier { "armed" } else { "not_required" },
                ),
            ),
            Err(error) => {
                log_stop_diagnostic(
                    &app,
                    logs_disabled,
                    DiagnosticLevel::Warn,
                    &format!(
                        "runtime_stop_barrier kind={:?} generation={generation} state=failed reason={error}",
                        operation_token.kind,
                    ),
                );
                return Err(error);
            }
        }
    }
    // Manual intent invalidates any start still crossing an await boundary.
    state.start_epoch.fetch_add(1, Ordering::SeqCst);
    if !operation_is_current(&app, &operation_token) {
        let error = "stale or cancelled runtime operation token".to_string();
        log_stop_refusal(
            &app,
            logs_disabled,
            Some(operation_token.kind),
            generation,
            &error,
        );
        return Err(error);
    }
    let result = stop_singbox_inner(&app, &state).await;
    log_stop_result(
        &app,
        logs_disabled,
        operation_token.kind,
        generation,
        &result,
    );
    finish_implicit_operation(&app, &operation_token, implicit);
    result
}

// The stop outcome went only to the WebView console.error, which is inaccessible to the user:
// from the "cleanup not confirmed" message one couldn't tell an unfinished
// process from a busy port or from a system proxy that wasn't removed. We write the breakdown to
// the same singbox.log that opens in the "Logs" tab. There are no URLs, IPs,
// node names or configs here — only component statuses, runtime port numbers and
// stage timings.
fn log_stop_diagnostic(app: &AppHandle, logs_disabled: bool, level: DiagnosticLevel, line: &str) {
    if logs_disabled {
        return;
    }
    append_runtime_diagnostic_at(app, level, line);
}

// A stop rejected by the operation coordinator: this covers a revoked/outdated
// token and a busy lifecycle. The format matches the regular runtime_stop so that in
// the log both branches can be read with one grep.
fn log_stop_refusal(
    app: &AppHandle,
    logs_disabled: bool,
    kind: Option<RuntimeOperationKind>,
    generation: u64,
    reason: &str,
) {
    let kind = match kind {
        Some(kind) => format!("{kind:?}"),
        None => "none".to_string(),
    };
    log_stop_diagnostic(
        app,
        logs_disabled,
        DiagnosticLevel::Warn,
        &format!("runtime_stop kind={kind} generation={generation} result=refused reason={reason}"),
    );
}

fn log_stop_result(
    app: &AppHandle,
    logs_disabled: bool,
    kind: RuntimeOperationKind,
    generation: u64,
    result: &Result<StopResult, String>,
) {
    if logs_disabled {
        return;
    }
    // An unconfirmed cleanup is not chronicle but a reason to investigate: processes or
    // ports are still ours. In the log it must fall into the warnings
    // filter rather than get lost among regular stop lines.
    let level = match result {
        Ok(stop) if stop.processes_exited && stop.ports_released => DiagnosticLevel::Info,
        _ => DiagnosticLevel::Warn,
    };
    let line = match result {
        Ok(stop) => format!(
            "runtime_stop kind={kind:?} generation={generation} singbox={} xray={} sidecars={} \
             processes_exited={} ports_released={} remaining_ports={:?} pending_exit_events={} \
             unconfirmed_monitor_exits={} system_proxy={} kill_ms={} proxy_ms={} confirm_ms={} total_ms={}",
            stop.singbox,
            stop.xray,
            stop.sidecars,
            stop.processes_exited,
            stop.ports_released,
            stop.remaining_ports,
            stop.pending_exit_events,
            stop.unconfirmed_monitor_exits,
            stop.system_proxy,
            stop.timings.kill_ms,
            stop.timings.proxy_ms,
            stop.timings.confirm_ms,
            stop.timings.total_ms,
        ),
        Err(error) => {
            format!(
                "runtime_stop kind={kind:?} generation={generation} result=error reason={error}"
            )
        }
    };
    append_runtime_diagnostic_at(app, level, &line);
}

// The transitional barrier makes sense ONLY on top of an already active fail-closed
// policy: strict privacy or an armed kill switch. For a user with
// the Kill Switch off it gives nothing, yet on every mode switch and on
// every watchdog recovery it cuts all new app connections
// (block-all allows only loopback, DHCP and engine exes) — against an explicitly
// disabled setting. The barrier is removed only by successful verification of the new
// runtime, which doesn't happen at all on the mode switch path.
fn transition_barrier_required(strict_tunnel: bool, kill_switch_active: bool) -> bool {
    strict_tunnel || kill_switch_active
}

/// Returns true if the barrier is armed, false if the policy doesn't require it.
fn native_transition_barrier(app: &AppHandle) -> Result<bool, String> {
    let kill_switch = app
        .try_state::<crate::killswitch::KillSwitchState>()
        .ok_or("kill switch state unavailable for transition barrier")?;
    let strict_tunnel = app
        .try_state::<SingboxState>()
        .and_then(|state| {
            state
                .runtime
                .lock_recover()
                .as_ref()
                .map(|runtime| runtime.strict_privacy)
        })
        .unwrap_or(false);
    if !transition_barrier_required(strict_tunnel, crate::killswitch::is_active(&kill_switch)) {
        return Ok(false);
    }
    crate::killswitch::transition_arm(&kill_switch, strict_tunnel)?;
    if !crate::killswitch::transition_active(&kill_switch) {
        return Err("transition barrier was not confirmed active".into());
    }
    Ok(true)
}

pub(crate) fn release_transition_barrier(app: &AppHandle) -> Result<(), String> {
    let kill_switch = app
        .try_state::<crate::killswitch::KillSwitchState>()
        .ok_or("kill switch state unavailable for transition barrier")?;
    crate::killswitch::transition_release(&kill_switch)
}

/// Facts that decide the fate of the transitional barrier.
#[derive(Clone, Copy, Debug)]
struct TransitionReleaseFacts {
    running: bool,
    runtime_ready: bool,
    generation_matches: bool,
    strict_privacy: bool,
    policy_lease_active: bool,
}

/// The barrier is released only on top of a confirmed new runtime: it is alive,
/// has published the listener and the clash controller, and it is EXACTLY the generation
/// the caller was waiting for. In a strict session an assembled user policy
/// is additionally required — otherwise removing it would open exactly the window
/// the barrier was installed to close.
fn transition_release_allowed(facts: TransitionReleaseFacts) -> bool {
    facts.running
        && facts.runtime_ready
        && facts.generation_matches
        && (!facts.strict_privacy || facts.policy_lease_active)
}

/// Remove the transitional barrier after a confirmed connection.
///
/// The barrier is installed by `stop_singbox` for runtime switch operations, but it was removed
/// only by dataplane verification (`verify_runtime_dataplane`). Verification
/// is done only by source switching and quality healing: auto-reconnect on a
/// settings/mode change and recovery by the watchdog (core death, bridge death) never
/// reach it, and the extra block-all lived until the VPN was disconnected — on top of the already assembled
/// user policy, but without LAN exceptions and without a permit for Ninety itself.
/// The frontend calls this command at the end of a successful connect; the barrier itself is released
/// only if the new runtime is actually confirmed.
///
/// Returns: true — the barrier was removed, false — there was none.
#[tauri::command]
pub async fn release_runtime_transition_barrier(
    app: AppHandle,
    expected_generation: u64,
) -> Result<bool, String> {
    // Closing a WFP session is a synchronous RPC to BFE, it has no place on the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let kill_switch = app.state::<crate::killswitch::KillSwitchState>();
        if !crate::killswitch::transition_active(&kill_switch) {
            return Ok(false);
        }
        let state = app.state::<SingboxState>();
        let record = state.runtime.lock_recover().clone();
        let facts = TransitionReleaseFacts {
            running: compute_singbox_running(&state),
            runtime_ready: record
                .as_ref()
                .is_some_and(|runtime| runtime.listener_ready && runtime.clash_ready),
            generation_matches: expected_generation != 0
                && record
                    .as_ref()
                    .is_some_and(|runtime| runtime.process_generation == expected_generation),
            strict_privacy: record
                .as_ref()
                .is_some_and(|runtime| runtime.strict_privacy),
            policy_lease_active: crate::killswitch::policy_lease_active(&kill_switch),
        };
        if !transition_release_allowed(facts) {
            return Err("transition barrier release requires a confirmed runtime".into());
        }
        release_transition_barrier(&app)?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("could not remove the transition barrier: {e}"))?
}

// Internal status computations — reused by single commands and
// by the health_snapshot aggregate (one IPC round trip for the watchdog instead of four).
fn compute_singbox_running(state: &SingboxState) -> bool {
    if state.child.lock_recover().is_some() {
        // The child handle isn't cleared when the process dies — the monitor task only
        // sets died. Without this check singbox_running would return true
        // forever after a core crash (the UI keeps showing "Protected", the proxy points to
        // a dead port, traffic goes into a black hole). A corpse isn't counted as alive.
        return state.died.lock_recover().is_none();
    }
    false
}

// xray sidecar (two-core) status for the frontend health watchdog:
//   "none"  — xray wasn't spawned (no xhttp nodes in the active config);
//   "alive" — up and hasn't crashed;
//   "died"  — was up, but the process exited (the xhttp bridge is dead).
// The child handle isn't cleared on death, so we distinguish by the xray_died flag.
fn compute_xray_status(state: &SingboxState) -> &'static str {
    if state.xray_child.lock_recover().is_none() {
        return "none";
    }
    if state.xray_died.lock_recover().is_some() {
        "died"
    } else {
        "alive"
    }
}

// naive/TT sidecar client status (analogous to compute_xray_status):
//   "none"  — no sidecars were brought up (no such nodes in the config);
//   "alive" — up and haven't crashed;
//   "died"  — at least one client exited (the bridge is dead → reconnect).
fn compute_sidecar_status(state: &SingboxState) -> &'static str {
    if state.sidecars.lock_recover().is_empty() {
        return "none";
    }
    if state.sidecar_died.lock_recover().is_some() {
        "died"
    } else {
        "alive"
    }
}

// The last cause of core death (sing-box takes priority over xray/sidecar) — for the toast.
fn compute_last_error(state: &SingboxState) -> Option<String> {
    if let Some(e) = state.died.lock_recover().clone() {
        return Some(e);
    }
    if let Some(e) = state.xray_died.lock_recover().clone() {
        return Some(e);
    }
    state.sidecar_died.lock_recover().clone()
}

#[tauri::command]
pub fn singbox_running(state: State<'_, SingboxState>) -> bool {
    compute_singbox_running(&state)
}

pub(crate) fn protected_browser_tun_ready(state: &SingboxState) -> bool {
    if !compute_singbox_running(state) || state.starting.load(Ordering::SeqCst) {
        return false;
    }
    state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| runtime.mode == "tun" && runtime.clash_ready)
}

// State snapshots read the registry and (with a cold cache) poll BFE — that is,
// a synchronous RPC to the service. The frontend calls them on every redraw and on every
// watchdog tick, so on the main thread they regularly froze the window.
// spawn_blocking moves the work to the blocking pool, the wire contract doesn't change.
#[tauri::command]
pub async fn runtime_snapshot(app: AppHandle) -> Result<RuntimeSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SingboxState>();
        let kill_switch = app.state::<crate::killswitch::KillSwitchState>();
        runtime_snapshot_value(&state, crate::killswitch::is_active(&kill_switch))
    })
    .await
    .map_err(|e| format!("could not get the runtime snapshot: {e}"))
}

// Aggregate of core statuses in one call — the frontend watchdog used to query the status of
// sing-box, xray, the sidecars and the last error with four separate commands
// on every tick (every 5 s for the whole session); those commands are gone. last_error is read
// always: the frontend uses it only when singbox_running=false, but an extra
// clone is cheaper than a second round trip.
#[derive(serde::Serialize)]
pub struct HealthSnapshot {
    pub singbox_running: bool,
    pub xray: &'static str,
    pub sidecar: &'static str,
    pub last_error: Option<String>,
    pub kill_switch_active: bool,
    // This runtime's system proxy was removed or overridden by another program.
    pub system_proxy_lost: bool,
    pub runtime_operation: Option<crate::runtime_ops::RuntimeOperationSnapshot>,
    // Whether the host is to blame, not the network. It travels in the same snapshot so that the quality engine
    // learns about a CPU/memory shortage without a separate round trip.
    pub host_pressure: crate::host_pressure::HostPressureSnapshot,
    // TCP sockets of the sing-box process. Thousands and growing is a sign of a routing loop
    // (#168); the conclusion itself is made by the watchdog on the frontend. None — the core isn't running or
    // the snapshot failed.
    pub core_sockets: Option<u32>,
}

fn compute_core_sockets(state: &SingboxState) -> Option<u32> {
    if !compute_singbox_running(state) {
        return None;
    }
    let pid = state
        .child
        .lock_recover()
        .as_ref()
        .map(|child| child.pid())?;
    crate::netproc::tcp_socket_count(pid)
}

#[tauri::command]
pub async fn health_snapshot(app: AppHandle) -> Result<HealthSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SingboxState>();
        let kill_switch = app.state::<crate::killswitch::KillSwitchState>();
        let coordinator = app.state::<RuntimeOperationCoordinator>();
        let pressure = app.state::<crate::host_pressure::HostPressureState>();
        HealthSnapshot {
            singbox_running: compute_singbox_running(&state),
            xray: compute_xray_status(&state),
            sidecar: compute_sidecar_status(&state),
            last_error: compute_last_error(&state),
            kill_switch_active: crate::killswitch::is_active(&kill_switch),
            system_proxy_lost: system_proxy_lost(&state),
            runtime_operation: coordinator.snapshot(),
            host_pressure: pressure.snapshot(),
            core_sockets: compute_core_sockets(&state),
        }
    })
    .await
    .map_err(|e| format!("could not get the health snapshot: {e}"))
}

fn validate_system_proxy_enable_request(
    host_port: &str,
    expected_generation: u64,
) -> Result<(), String> {
    if host_port.trim().is_empty() {
        return Err("system proxy enable requires the current probe endpoint".into());
    }
    if expected_generation == 0 {
        return Err("system proxy enable requires the current process generation".into());
    }
    Ok(())
}

// Stopping the runtime under an operation token: we authorize the caller's own token,
// without it we take an implicit FrontendRecovery. A lifecycle occupied by a higher-priority
// operation must not be stopped — it's not our runtime.
async fn stop_owned_runtime(
    app: &AppHandle,
    state: &SingboxState,
    operation_token: Option<RuntimeOperationToken>,
    generation: u64,
) -> Result<StopResult, String> {
    let (token, implicit) = lifecycle_operation(
        app,
        operation_token,
        RuntimeOperationKind::FrontendRecovery,
        generation,
        None,
    )?;
    let result = if operation_is_current(app, &token) {
        stop_singbox_inner(app, state).await
    } else {
        Err("stale or cancelled runtime operation token".to_string())
    };
    finish_implicit_operation(app, &token, implicit);
    result
}

#[tauri::command]
pub async fn enable_system_proxy(
    app: AppHandle,
    state: State<'_, SingboxState>,
    host_port: String,
    bypass_lan: Option<bool>,
    expected_generation: u64,
    operation_token: Option<RuntimeOperationToken>,
) -> Result<(), String> {
    validate_system_proxy_enable_request(&host_port, expected_generation)?;
    if let Err(error) = enable_system_proxy_for_runtime(
        &state,
        host_port.trim(),
        bypass_lan,
        Some(expected_generation),
    )
    .await
    {
        // An emergency stop after a proxy readiness failure is the same
        // lifecycle operation as a manual "Disconnect". Without ownership it
        // killed the runtime blindly: during IPC a newer connect could have taken it over,
        // and that one got a suddenly killed core.
        let cleanup = stop_owned_runtime(&app, &state, operation_token, expected_generation).await;
        return Err(match cleanup {
            Ok(_) => format!("{error}; runtime stopped after proxy readiness failure"),
            Err(cleanup_error) => format!(
                "{error}; runtime stop after proxy readiness failure failed: {cleanup_error}"
            ),
        });
    }
    Ok(())
}

#[tauri::command]
pub fn disable_system_proxy(state: State<'_, SingboxState>) -> Result<(), String> {
    // The proxy is removed deliberately (mode switch, rollback after a failure): the watchdog must not
    // take this for interference by another program.
    forget_system_proxy_endpoint(&state);
    proxy::set_system_proxy(false, None, None)
}

#[cfg(test)]
mod system_proxy_command_tests {
    use super::validate_system_proxy_enable_request;

    #[test]
    fn enable_contract_requires_endpoint_and_generation() {
        assert!(validate_system_proxy_enable_request("", 1).is_err());
        assert!(validate_system_proxy_enable_request("127.0.0.1:7890", 0).is_err());
        assert!(validate_system_proxy_enable_request("127.0.0.1:7890", 1).is_ok());
    }

    #[test]
    fn transition_barrier_is_released_only_by_a_confirmed_runtime() {
        use super::{transition_release_allowed, TransitionReleaseFacts};

        let confirmed = TransitionReleaseFacts {
            running: true,
            runtime_ready: true,
            generation_matches: true,
            strict_privacy: false,
            policy_lease_active: false,
        };
        assert!(transition_release_allowed(confirmed));

        // A dead core, an unready listener/clash and a foreign generation must
        // keep the barrier: removing it here is exactly the fail-open window.
        assert!(!transition_release_allowed(TransitionReleaseFacts {
            running: false,
            ..confirmed
        }));
        assert!(!transition_release_allowed(TransitionReleaseFacts {
            runtime_ready: false,
            ..confirmed
        }));
        assert!(!transition_release_allowed(TransitionReleaseFacts {
            generation_matches: false,
            ..confirmed
        }));

        // A strict session releases the barrier only on top of an assembled policy.
        assert!(!transition_release_allowed(TransitionReleaseFacts {
            strict_privacy: true,
            ..confirmed
        }));
        assert!(transition_release_allowed(TransitionReleaseFacts {
            strict_privacy: true,
            policy_lease_active: true,
            ..confirmed
        }));
    }

    #[test]
    fn transition_barrier_follows_the_active_fail_closed_policy() {
        use super::transition_barrier_required;

        // Neither strict privacy nor an armed kill switch: blocking the network
        // during the runtime replacement is not allowed — the user didn't ask for fail-closed.
        assert!(!transition_barrier_required(false, false));
        assert!(transition_barrier_required(false, true));
        assert!(transition_barrier_required(true, false));
        assert!(transition_barrier_required(true, true));
    }
}

#[tauri::command]
pub async fn verify_runtime_endpoint(
    state: State<'_, SingboxState>,
    kill_switch: State<'_, crate::killswitch::KillSwitchState>,
    expected_generation: Option<u64>,
    expected_endpoint: Option<String>,
) -> Result<RuntimeSnapshot, String> {
    validate_runtime_probe_endpoint(&state, expected_generation, expected_endpoint.as_deref())
        .await?;
    Ok(runtime_snapshot_value(
        &state,
        crate::killswitch::is_active(&kill_switch),
    ))
}

pub fn recover_stale_system_proxy() -> Result<(), String> {
    proxy::recover_stale_system_proxy()
}

pub fn force_cleanup(app: &AppHandle, state: &SingboxState) {
    state.expected_exit_generation.store(
        state.process_generation.load(Ordering::SeqCst),
        Ordering::SeqCst,
    );
    if let Some(child) = state.child.lock_recover().take() {
        let _ = child.kill();
    }
    kill_xray(state);
    kill_sidecars(state);
    purge_bridge_configs(app);
    purge_current_configs(app);
    clear_death_flags(state);
    // The last line of defense before exit. The error must not be swallowed here: if
    // the proxy wasn't removed, after closing Ninety the user has no internet in
    // everything that reads WinINet, and not a single hint remains in the log —
    // a "broken proxy mode" looks like a Windows failure out of nowhere.
    #[cfg(target_os = "windows")]
    if let Err(error) = proxy::set_system_proxy(false, None, None) {
        append_runtime_diagnostic_at(
            app,
            DiagnosticLevel::Error,
            &format!("exit_cleanup system_proxy=failed reason={error}"),
        );
        eprintln!("exit cleanup: system proxy not restored: {error}");
    }
}

// ── Loopback bridge port planning ─────────────────────
// The static bases (31100/31200/31300 in singbox.js) may be taken by a foreign process —
// then the bridge would die on bind. Before buildConfig the frontend sends how many
// ports each family needs; we pick the first range where all ports
// are free (a bind probe on 127.0.0.1). The family ranges don't overlap.
// The TOCTOU window (the port gets taken between the probe and spawn) is closed by fail-fast in
// start_singbox — but the probe removes deterministic conflicts.

#[derive(serde::Deserialize)]
pub struct BridgeNeeds {
    #[serde(default)]
    xray: u16,
    #[serde(default)]
    naive: u16,
    #[serde(default)]
    trusttunnel: u16,
}

#[derive(serde::Serialize)]
pub struct BridgePorts {
    xray: u16,
    naive: u16,
    trusttunnel: u16,
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

// The first base >= start that gives `count` consecutive free ports outside the busy
// ranges. With count=0 no ports are needed — return the default without reserving.
fn find_free_base(start: u16, count: u16, taken: &mut Vec<(u16, u16)>) -> Result<u16, String> {
    if count == 0 {
        return Ok(start);
    }
    let mut base = start;
    // Upper search bound with headroom; only a handful of ports are needed, we won't hit it.
    while u32::from(base) + u32::from(count) <= 65535 && base < start.saturating_add(2000) {
        let end = base + count;
        let overlaps = taken.iter().any(|&(s, e)| base < e && s < end);
        if !overlaps && (base..end).all(port_free) {
            taken.push((base, end));
            return Ok(base);
        }
        base += 1;
    }
    Err(format!(
        "no free ports for the bridges (searched from {start})"
    ))
}

#[tauri::command]
pub async fn plan_bridge_ports(needs: BridgeNeeds) -> Result<BridgePorts, String> {
    let mut taken: Vec<(u16, u16)> = Vec::new();
    let xray = find_free_base(31100, needs.xray, &mut taken)?;
    let naive = find_free_base(31200, needs.naive, &mut taken)?;
    let trusttunnel = find_free_base(31300, needs.trusttunnel, &mut taken)?;
    Ok(BridgePorts {
        xray,
        naive,
        trusttunnel,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("ninety-vpn-{label}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // The log is read on from the previous position, and it may only be moved by whole
    // lines: sing-box writes to the file as it works, and a poll easily lands in
    // the middle of a line — and with a multibyte character, in the middle of the character too.
    #[test]
    fn a_half_written_line_does_not_move_the_read_position() {
        let dir = test_dir("log-offset");
        let path = dir.join("singbox.log");
        std::fs::write(&path, b"first line\nsecond a").unwrap();
        let size = std::fs::metadata(&path).unwrap().len();

        let (text, offset) = read_from_offset(&path, 0, size).unwrap();
        assert_eq!(text, "first line\n");
        assert_eq!(offset, 11, "позиция обязана встать за переводом строки");

        // The rest of the line was appended — now it can be returned whole.
        std::fs::write(&path, b"first line\nsecond and third\n").unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        let (text, offset) = read_from_offset(&path, offset, size).unwrap();
        assert_eq!(text, "second and third\n");
        assert_eq!(offset, size);

        // Nothing was appended — neither text nor position movement.
        let (text, same) = read_from_offset(&path, offset, size).unwrap();
        assert!(text.is_empty());
        assert_eq!(same, offset);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_line_without_a_newline_yet_is_held_back_whole() {
        let dir = test_dir("log-offset-partial");
        let path = dir.join("singbox.log");
        std::fs::write(&path, "чанк без перевода строки").unwrap();
        let size = std::fs::metadata(&path).unwrap().len();

        let (text, offset) = read_from_offset(&path, 0, size).unwrap();
        assert!(text.is_empty(), "строка без \\n не должна уезжать на фронт");
        assert_eq!(offset, 0);

        std::fs::remove_dir_all(&dir).ok();
    }

    // The "Logs" screen parser recognizes a record by `[offset] [date] time LEVEL` —
    // without this prefix an app line would become a continuation of someone else's record.
    #[test]
    fn xray_config_drops_file_path_fields_from_imported_outbounds() {
        let raw = serde_json::json!({
            "log": { "loglevel": "warning" },
            "outbounds": [{
                "tag": "node-a",
                "protocol": "vless",
                "streamSettings": {
                    "security": "tls",
                    "tlsSettings": {
                        "serverName": "srv.example",
                        "masterKeyLog": "C:\\x.cmd",
                        "certificates": [
                            { "certificateFile": "C:\\a.crt", "keyFile": "C:\\a.key", "certificate": ["inline"], "usage": "verify" },
                            { "CertificateFile": "C:\\b.crt", "KEYFILE": "C:\\b.key" }
                        ]
                    },
                    "xhttpSettings": {
                        "path": "/p",
                        "downloadSettings": { "tlsSettings": { "MasterKeyLog": "C:\\y.cmd", "certificates": [{ "certificateFile": "C:\\c.crt" }] } }
                    }
                }
            }]
        })
        .to_string();
        let hardened: serde_json::Value =
            serde_json::from_str(&harden_xray_config(&raw)).expect("valid json");
        let text = hardened.to_string();
        let lower = text.to_ascii_lowercase();
        assert!(!lower.contains("masterkeylog"));
        assert!(!lower.contains("certificatefile"));
        assert!(!lower.contains("keyfile"));
        let tls = &hardened["outbounds"][0]["streamSettings"]["tlsSettings"];
        assert_eq!(tls["serverName"], "srv.example");
        assert_eq!(tls["certificates"].as_array().map(Vec::len), Some(1));
        assert_eq!(tls["certificates"][0]["certificate"][0], "inline");
        let download = &hardened["outbounds"][0]["streamSettings"]["xhttpSettings"]
            ["downloadSettings"]["tlsSettings"];
        assert!(download.get("certificates").is_none());
        assert_eq!(
            hardened["outbounds"][0]["streamSettings"]["xhttpSettings"]["path"],
            "/p"
        );
        assert_eq!(harden_xray_config("not json"), "not json");
    }

    #[test]
    fn diagnostics_carry_a_singbox_shaped_timestamp_and_level() {
        let stamped = stamped_diagnostic(
            &time::macros::datetime!(2026-08-04 19:55:27 +03:00),
            DiagnosticLevel::Warn,
            "runtime_stop kind=Disconnect generation=7 result=refused",
        );
        let (offset, rest) = stamped.split_once(' ').expect("offset segment");
        assert!(
            offset.len() == 5
                && matches!(offset.as_bytes()[0], b'+' | b'-')
                && offset[1..].bytes().all(|b| b.is_ascii_digit()),
            "unexpected offset segment: {stamped}"
        );
        assert_eq!(
            rest,
            "2026-08-04 19:55:27 WARN runtime_stop kind=Disconnect generation=7 result=refused"
        );
    }

    #[test]
    fn start_failure_reason_reaches_the_log_on_one_line() {
        assert_eq!(
            start_failure_line(
                3,
                "Clash control endpoint port=9090 is not ready: request: timeout"
            ),
            "runtime_start generation=3 result=failed \
             reason=Clash control endpoint port=9090 is not ready: request: timeout"
        );
        assert_eq!(
            start_failure_line(4, "sing-box died\n  FATAL bind: in use\n\n"),
            "runtime_start generation=4 result=failed reason=sing-box died | FATAL bind: in use"
        );
        let cancelled = crate::util::i18n_error("backend.vpn.startCancelled");
        assert!(is_start_cancellation(&cancelled));
        let no_listener = "runtime probe endpoint 127.0.0.1:7890 has no live listener";
        assert!(!is_start_cancellation(no_listener));
    }

    #[test]
    fn only_failing_results_are_raised_above_info() {
        for result in ["failed", "error", "degraded", "unreachable", "UNVERIFIED"] {
            assert_eq!(
                diagnostic_level_for_result(result),
                DiagnosticLevel::Warn,
                "{result} should read as a failure"
            );
        }
        for result in ["none", "completed", "cancelled", "available", "update"] {
            assert_eq!(
                diagnostic_level_for_result(result),
                DiagnosticLevel::Info,
                "{result} is ordinary lifecycle chatter"
            );
        }
    }

    #[test]
    fn strip_ansi_removes_sgr() {
        assert_eq!(strip_ansi("\x1b[36mINFO\x1b[0m text"), "INFO text");
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi(""), "");
        // ESC without CSI simply drops out
        assert_eq!(strip_ansi("a\x1bZb"), "aZb");
    }

    #[test]
    fn monitor_exit_classifies_planned_stale_and_unexpected_generations() {
        assert!(monitor_exit_expected(7, 7, 7));
        assert!(monitor_exit_expected(8, 0, 7));
        assert!(!monitor_exit_expected(7, 0, 7));
        assert!(!monitor_exit_expected(8, 7, 8));
    }

    #[test]
    fn harden_config_injects_secret_and_loopback() {
        let raw = r#"{"experimental":{"clash_api":{"external_controller":"0.0.0.0:9090"}}}"#;
        let out = harden_config(raw, None);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let api = &v["experimental"]["clash_api"];
        assert_eq!(api["external_controller"], "127.0.0.1:9090");
        let secret = api["secret"].as_str().unwrap();
        assert_eq!(secret.len(), 32); // 16 bytes of hex
    }

    #[test]
    fn harden_config_pins_cache_path_outside_the_working_directory() {
        let raw = r#"{"experimental":{"cache_file":{"enabled":true,"store_rdrc":true}}}"#;
        let cache_path = Path::new(r"C:\Users\test\AppData\Local\Ninety\data\singbox\cache.db");
        let out = harden_config(raw, Some(cache_path));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["experimental"]["cache_file"]["path"],
            cache_path.to_string_lossy().as_ref()
        );
    }

    #[test]
    fn harden_config_passes_invalid_json_through() {
        assert_eq!(harden_config("not json", None), "not json");
    }

    #[test]
    fn runtime_endpoints_prioritize_probe_in_and_keep_dynamic_roles_separate() {
        let control = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap();
        let probe = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap();
        let raw = format!(
            r#"{{
                "experimental":{{"clash_api":{{"external_controller":"{control}"}}}},
                "inbounds":[
                    {{"type":"tun","tag":"tun-in"}},
                    {{"type":"mixed","tag":"mixed-in","listen":"127.0.0.1","listen_port":{}}},
                    {{"type":"mixed","tag":"probe-in","listen":"127.0.0.1","listen_port":{}}}
                ]
            }}"#,
            control.port(),
            probe.port()
        );
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let endpoints = runtime_endpoints_from_value(&value).unwrap();
        assert_eq!(endpoints.control.address, control);
        assert_eq!(
            endpoints.probe_proxy.unwrap().address,
            std::net::SocketAddr::new(
                std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                probe.port()
            )
        );
        assert_ne!(endpoints.control.address, probe);
    }

    #[test]
    fn runtime_endpoints_fallback_to_structurally_valid_mixed_in() {
        let raw = r#"{
            "experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}},
            "inbounds":[{"type":"mixed","tag":"mixed-in","listen":"127.0.0.1","listen_port":9898}]
        }"#;
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let endpoints = runtime_endpoints_from_value(&value).unwrap();
        assert_eq!(endpoints.control.address.port(), 9191);
        assert_eq!(endpoints.probe_proxy.unwrap().address.port(), 9898);
    }

    #[test]
    fn runtime_endpoints_do_not_fallback_to_control_or_unrelated_inbounds() {
        let raw = r#"{
            "experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}},
            "inbounds":[{"type":"mixed","tag":"other","listen":"127.0.0.1","listen_port":7777}]
        }"#;
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let endpoints = runtime_endpoints_from_value(&value).unwrap();
        assert_eq!(endpoints.control.address.port(), 9191);
        assert!(endpoints.probe_proxy.is_none());
    }

    #[test]
    fn runtime_endpoints_reject_non_local_or_wrong_probe_protocol() {
        let non_local = r#"{
            "experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}},
            "inbounds":[{"type":"mixed","tag":"probe-in","listen":"192.0.2.1","listen_port":9898}]
        }"#;
        let non_local_value: serde_json::Value = serde_json::from_str(non_local).unwrap();
        assert!(runtime_endpoints_from_value(&non_local_value).is_err());

        let wrong_protocol = r#"{
            "experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}},
            "inbounds":[{"type":"socks","tag":"probe-in","listen":"127.0.0.1","listen_port":9898}]
        }"#;
        let wrong_protocol_value: serde_json::Value = serde_json::from_str(wrong_protocol).unwrap();
        assert!(runtime_endpoints_from_value(&wrong_protocol_value).is_err());
    }

    #[tokio::test]
    async fn probe_listener_readiness_tracks_the_exact_runtime_endpoint() {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let endpoint = ProbeProxyEndpoint {
            address: listener.local_addr().unwrap(),
        };
        assert!(local_probe_listener_ready(&endpoint).await);
        drop(listener);
        assert!(!local_probe_listener_ready(&endpoint).await);
    }

    #[test]
    fn probe_endpoint_generation_rejects_stale_snapshots() {
        let state = SingboxState::default();
        let endpoint = ProbeProxyEndpoint {
            address: "127.0.0.1:2080".parse().unwrap(),
        };
        *state.runtime.lock_recover() = Some(RuntimeRecord {
            process_generation: 42,
            source_fingerprint: None,
            config_hash: None,
            mode: "systemProxy".into(),
            strict_privacy: false,
            pinned_node_tag: None,
            logs_disabled: false,
            endpoints: RuntimeEndpoints {
                control: ControlEndpoint {
                    address: "127.0.0.1:9090".parse().unwrap(),
                },
                probe_proxy: Some(endpoint),
            },
            listener_ready: true,
            clash_port: 9090,
            clash_ready: true,
            system_proxy_endpoint: None,
        });
        assert_eq!(
            probe_endpoint_for_generation(&state, Some(42)).unwrap().0,
            42
        );
        assert_eq!(
            probe_endpoint_for_generation(&state, Some(41)).unwrap_err(),
            "stale_generation"
        );
    }

    #[test]
    fn log_tail_caps_untrusted_requests() {
        assert_eq!(normalized_log_tail_bytes(None), DEFAULT_LOG_TAIL_BYTES);
        assert_eq!(normalized_log_tail_bytes(Some(0)), 0);
        assert_eq!(
            normalized_log_tail_bytes(Some(u64::MAX)),
            MAX_LOG_TAIL_BYTES
        );
    }

    #[test]
    fn log_tail_handles_small_large_empty_and_missing_files() {
        let dir = test_dir("tail");
        let small = dir.join("small.log");
        std::fs::write(&small, b"alpha\nbeta\n").unwrap();
        assert_eq!(read_tail(&small, Some(128)).unwrap(), "alpha\nbeta\n");

        let large = dir.join("large.log");
        std::fs::write(&large, b"old line\nnew line one\nnew line two\n").unwrap();
        let tail = read_tail(&large, Some(20)).unwrap();
        assert!(tail.contains("bytes truncated above"));
        assert!(tail.ends_with("new line two\n"));

        let empty = dir.join("empty.log");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(read_tail(&empty, None).unwrap(), "");
        assert_eq!(read_tail(&dir.join("missing.log"), None).unwrap(), "");
        assert_eq!(read_tail(&small, Some(0)).unwrap(), "");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn log_tail_handles_no_newline_and_utf8_boundary() {
        let dir = test_dir("utf8");
        let plain = dir.join("plain.log");
        std::fs::write(&plain, b"abcdefghijklmnop").unwrap();
        let tail = read_tail(&plain, Some(5)).unwrap();
        assert!(tail.ends_with("lmnop"));

        let unicode = dir.join("unicode.log");
        std::fs::write(&unicode, "aaaa€tail".as_bytes()).unwrap();
        let tail = read_tail(&unicode, Some(6)).unwrap();
        assert!(tail.ends_with("tail"));
        assert!(!tail.contains('\u{fffd}'));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sidecar_log_names_are_unique_and_strict() {
        assert_eq!(
            sidecar_log_name(SidecarLogKind::Naive, 31201),
            "naive-31201.log"
        );
        assert_ne!(
            sidecar_log_name(SidecarLogKind::Naive, 31201),
            sidecar_log_name(SidecarLogKind::Naive, 31202)
        );
        assert_ne!(
            sidecar_log_name(SidecarLogKind::Naive, 31201),
            sidecar_log_name(SidecarLogKind::TrustTunnel, 31201)
        );
        assert_eq!(SidecarLogKind::parse("../naive"), None);
        assert_eq!(
            sidecar_log_port("naive-31201.log", SidecarLogKind::Naive),
            Some(31201)
        );
        assert_eq!(
            sidecar_log_port("naive-70000.log", SidecarLogKind::Naive),
            None
        );
        assert_eq!(
            sidecar_log_port("naive-../../secret.log", SidecarLogKind::Naive),
            None
        );
    }

    #[test]
    fn sidecar_log_listing_and_clear_are_component_scoped() {
        let dir = test_dir("sidecars");
        for name in [
            "naive.log",
            "naive-31201.log",
            "naive-31202.log",
            "trusttunnel-31301.log",
            "naive-invalid.log",
        ] {
            std::fs::write(dir.join(name), name.as_bytes()).unwrap();
        }
        let paths = component_log_files(&dir, "naive").unwrap();
        assert_eq!(paths.len(), 3);
        assert!(component_log_files(&dir, "../naive").is_err());
        clear_log_files(&paths).unwrap();
        assert!(paths
            .iter()
            .all(|path| std::fs::metadata(path).unwrap().len() == 0));
        assert!(
            std::fs::metadata(dir.join("trusttunnel-31301.log"))
                .unwrap()
                .len()
                > 0
        );
        assert!(
            std::fs::metadata(dir.join("naive-invalid.log"))
                .unwrap()
                .len()
                > 0
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stale_sidecar_log_count_is_bounded() {
        let dir = test_dir("prune");
        for port in 31000..31020 {
            std::fs::write(
                dir.join(sidecar_log_name(SidecarLogKind::Naive, port)),
                b"log",
            )
            .unwrap();
        }
        prune_sidecar_logs(&dir, SidecarLogKind::Naive, &HashSet::new());
        assert!(sidecar_log_entries(&dir, SidecarLogKind::Naive).len() <= MAX_SIDECAR_LOG_FILES);
        std::fs::remove_dir_all(dir).unwrap();
    }

    // Logs of the future runtime may already be on disk: if they are counted both in
    // entries and in protected, the limit looks exhausted too early.
    #[test]
    fn prune_reserves_space_without_double_counting_reused_ports() {
        let dir = test_dir("prune-reuse");
        for port in 31000..31000 + MAX_SIDECAR_LOG_FILES as u16 {
            std::fs::write(
                dir.join(sidecar_log_name(SidecarLogKind::Naive, port)),
                b"log",
            )
            .unwrap();
        }
        // The same ports as already on disk: nothing to clean up, exactly the limit of files.
        let reused: HashSet<String> = (31000..31002)
            .map(|port| sidecar_log_name(SidecarLogKind::Naive, port))
            .collect();
        prune_sidecar_logs(&dir, SidecarLogKind::Naive, &reused);
        assert_eq!(
            sidecar_log_entries(&dir, SidecarLogKind::Naive).len(),
            MAX_SIDECAR_LOG_FILES
        );

        // New ports — space for them is freed at the expense of the oldest ones.
        let fresh: HashSet<String> = (32000..32002)
            .map(|port| sidecar_log_name(SidecarLogKind::Naive, port))
            .collect();
        prune_sidecar_logs(&dir, SidecarLogKind::Naive, &fresh);
        assert_eq!(
            sidecar_log_entries(&dir, SidecarLogKind::Naive).len(),
            MAX_SIDECAR_LOG_FILES - fresh.len()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn runtime_config_matcher_only_targets_ephemeral_files() {
        for name in [
            "singbox-current.json",
            "xray-current.json",
            "naive-31110.json",
            "trusttunnel-31120.toml",
        ] {
            assert!(is_runtime_config_name(name), "{name} должен чиститься");
        }
        for name in [
            "config.json",
            "warp.json",
            "singbox-current.json.bak",
            "naive-profile.txt",
            "trusttunnel-backup.toml.bak",
        ] {
            assert!(!is_runtime_config_name(name), "{name} нельзя чистить");
        }
    }

    #[test]
    fn find_free_base_skips_taken_ranges() {
        let mut taken = vec![(41100u16, 41102u16)];
        let base = find_free_base(41100, 2, &mut taken).unwrap();
        assert!(base >= 41102, "диапазон не должен пересечь занятый: {base}");
        // count=0 → default without reserving
        let before = taken.len();
        assert_eq!(find_free_base(41200, 0, &mut taken).unwrap(), 41200);
        assert_eq!(taken.len(), before);
    }

    #[test]
    fn find_free_base_skips_bound_port() {
        // Actually take a port (the first free one in a quiet range) and make sure
        // the base moved past it.
        let mut held = None;
        for p in 42000u16..43000 {
            if let Ok(l) = std::net::TcpListener::bind(("127.0.0.1", p)) {
                held = Some((p, l));
                break;
            }
        }
        let (busy, _l) = held.expect("нет свободного порта в 42000..43000");
        let mut taken = Vec::new();
        let base = find_free_base(busy, 1, &mut taken).unwrap();
        assert!(base > busy, "base={base} должен быть за занятым {busy}");
    }

    #[test]
    fn runtime_ports_include_custom_clash_inbound_and_local_bridges() {
        let raw = r#"{
          "experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}},
          "inbounds":[{"listen_port":7899}],
          "outbounds":[
            {"server":"127.0.0.1","server_port":31100},
            {"server":"127.0.0.1","server_port":1080},
            {"server":"vpn.example","server_port":443}
          ]
        }"#;
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let endpoints = runtime_endpoints_from_value(&value).unwrap();
        let (clash, ports) = runtime_ports_from_value(&value, &endpoints).unwrap();
        assert_eq!(clash, 9191);
        assert_eq!(ports, vec![7899, 9191, 31100]);
    }

    #[tokio::test]
    async fn stop_epoch_invalidates_an_in_flight_start() {
        let state = SingboxState::default();
        let epoch = state.start_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(ensure_start_current(&state, epoch).await.is_ok());
        state.start_epoch.fetch_add(1, Ordering::SeqCst);
        assert!(ensure_start_current(&state, epoch).await.is_err());
    }

    fn published_runtime_record() -> RuntimeRecord {
        RuntimeRecord {
            process_generation: 5,
            source_fingerprint: Some("fingerprint".into()),
            config_hash: None,
            mode: "systemProxy".into(),
            strict_privacy: false,
            pinned_node_tag: None,
            logs_disabled: false,
            endpoints: RuntimeEndpoints {
                control: ControlEndpoint {
                    address: "127.0.0.1:9090".parse().unwrap(),
                },
                probe_proxy: None,
            },
            listener_ready: true,
            clash_port: 9090,
            clash_ready: true,
            system_proxy_endpoint: None,
        }
    }

    // The watchdog checks the registry only against the address the runtime published itself.
    // Port 1 isn't set as the system proxy on a test machine, so a published
    // address is always "lost" there; without publishing and during a stop it isn't.
    #[test]
    fn system_proxy_loss_is_reported_only_for_a_published_endpoint() {
        let state = SingboxState::default();
        *state.runtime.lock_recover() = Some(published_runtime_record());
        assert!(!system_proxy_lost(&state), "прокси не публиковался");

        state
            .runtime
            .lock_recover()
            .as_mut()
            .unwrap()
            .system_proxy_endpoint = Some("127.0.0.1:1".into());
        assert!(system_proxy_lost(&state));

        state.stopping.store(true, Ordering::SeqCst);
        assert!(!system_proxy_lost(&state), "остановка снимает прокси сама");
        state.stopping.store(false, Ordering::SeqCst);

        forget_system_proxy_endpoint(&state);
        assert!(!system_proxy_lost(&state));
    }

    // Cancelling operation ownership (a latest-wins source switch) must leave
    // exactly the same state as cancelling by epoch: without this, stop_singbox with an already
    // revoked token returns refused, and the brought-up set stays alive.
    // We don't publish ports: the bind probe outcome depends on the machine, and here
    // it's exactly the cleanup of the published state being checked.
    #[tokio::test]
    async fn cancelled_start_clears_published_runtime_state() {
        let state = SingboxState::default();
        *state.runtime.lock_recover() = Some(published_runtime_record());

        abort_started_runtime(&state).await;

        assert!(state.runtime.lock_recover().is_none());
        assert!(state.runtime_ports.lock_recover().is_empty());
        assert!(!compute_singbox_running(&state));
        // Without live children and without ports the cleanup is confirmed immediately.
        assert!(state.pending_cleanup.lock_recover().is_none());
        // The cancellation is marked as a planned exit of this generation — otherwise the monitor
        // would log our own kill as a core crash.
        assert_eq!(
            state.expected_exit_generation.load(Ordering::SeqCst),
            state.process_generation.load(Ordering::SeqCst)
        );
    }

    // The main reason cancellation stopped being a bare kill: an unconfirmed
    // cleanup must leave a debt. Otherwise the next start passes the
    // `child.is_some()` guard and brings up a second set on still busy ports.
    #[tokio::test]
    async fn cancelled_start_records_unreleased_ports_as_pending_cleanup() {
        let held = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .expect("занять порт под тест");
        let port = held.local_addr().expect("адрес слушателя").port();

        let state = SingboxState::default();
        *state.runtime_ports.lock_recover() = vec![port];
        *state.runtime.lock_recover() = Some(published_runtime_record());

        abort_started_runtime(&state).await;

        let pending = state.pending_cleanup.lock_recover().clone();
        let pending = pending.expect("занятый порт обязан оставить долг очистки");
        assert!(pending.ports.contains(&port));
        // The published state is removed anyway: it must not be kept,
        // the debt lives separately in pending_cleanup.
        assert!(state.runtime.lock_recover().is_none());
        assert!(state.runtime_ports.lock_recover().is_empty());
        drop(held);
    }

    // A spawn failure is no proof of port ownership: a foreign process on our
    // port is exactly what brings the start down. A debt on such a port would lock both doors —
    // start would answer "repeat the disconnect", and stop can't free a foreign
    // port and would leave the debt again, until the app is restarted.
    #[tokio::test]
    async fn failed_start_does_not_turn_a_foreign_port_into_a_debt() {
        let held = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .expect("занять порт под тест");
        let port = held.local_addr().expect("адрес слушателя").port();

        let state = SingboxState::default();
        *state.runtime_ports.lock_recover() = vec![port];
        *state.runtime.lock_recover() = Some(published_runtime_record());

        abort_started_runtime_scoped(&state, PortDebt::Unproven).await;

        assert!(state.pending_cleanup.lock_recover().is_none());
        // The published state is removed in both modes: it must not be kept.
        assert!(state.runtime.lock_recover().is_none());
        assert!(state.runtime_ports.lock_recover().is_empty());
        drop(held);
    }

    // The start steps cancel the launch themselves (wait_start_delay → ensure_start_current),
    // and the outer handler of their error calls the cancellation again. The second pass
    // must be empty: otherwise it "confirms" an already removed state and erases
    // the debt left by the first one.
    #[tokio::test]
    async fn second_abort_does_not_erase_the_debt_left_by_the_first() {
        let held = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .expect("занять порт под тест");
        let port = held.local_addr().expect("адрес слушателя").port();

        let state = SingboxState::default();
        *state.runtime_ports.lock_recover() = vec![port];
        *state.runtime.lock_recover() = Some(published_runtime_record());

        abort_started_runtime(&state).await;
        let after_first = state.pending_cleanup.lock_recover().clone();
        assert!(after_first
            .as_ref()
            .is_some_and(|pending| pending.ports.contains(&port)));

        abort_started_runtime_scoped(&state, PortDebt::Unproven).await;
        assert_eq!(state.pending_cleanup.lock_recover().clone(), after_first);
        drop(held);
    }

    #[test]
    fn pending_cleanup_merges_instead_of_replacing() {
        let existing = PendingCleanup {
            processes: vec![TrackedProcess {
                pid: 10,
                creation_time: Some(100),
            }],
            ports: vec![7890],
        };
        let incoming = PendingCleanup {
            processes: vec![
                TrackedProcess {
                    pid: 10,
                    creation_time: Some(100),
                },
                TrackedProcess {
                    pid: 20,
                    creation_time: Some(200),
                },
            ],
            ports: vec![9090, 7890],
        };
        let merged =
            merge_pending_cleanup(Some(existing), incoming).expect("долг не должен исчезать");
        assert_eq!(merged.ports, vec![7890, 9090]);
        assert_eq!(
            merged.processes.iter().map(|p| p.pid).collect::<Vec<_>>(),
            vec![10, 20]
        );
        assert!(merge_pending_cleanup(None, PendingCleanup::default()).is_none());
    }

    #[test]
    fn repeated_stop_keeps_and_deduplicates_pending_targets() {
        let pending = PendingCleanup {
            processes: vec![
                TrackedProcess {
                    pid: 20,
                    creation_time: Some(200),
                },
                TrackedProcess {
                    pid: 10,
                    creation_time: Some(100),
                },
                TrackedProcess {
                    pid: 20,
                    creation_time: Some(200),
                },
            ],
            ports: vec![9090, 31100],
        };
        let (ports, processes) = cleanup_targets(&[7890, 9090], pending);
        assert_eq!(ports, vec![7890, 9090, 31100]);
        assert_eq!(
            processes,
            vec![
                TrackedProcess {
                    pid: 10,
                    creation_time: Some(100),
                },
                TrackedProcess {
                    pid: 20,
                    creation_time: Some(200),
                },
            ]
        );
    }
}
