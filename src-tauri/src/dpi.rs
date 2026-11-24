// Ninety · DPI bypass (winws engine). Starting/stopping the winws engine (zapret),
// managing strategies and lists. winws loads the WinDivert kernel driver →
// needs admin rights: before starting, the frontend ensures elevation (the same infra
// as TUN: is_elevated/relaunch_elevated), winws starts as our child and
// inherits the rights. Engine binaries are read-only in resource_dir (install dir),
// lists are a writable copy in app_data (for excluding VPN nodes and the ipset mode).
//
// backend↔frontend integration points: dpi_start/stop/running, dpi_strategies,
// dpi_domains_count, dpi_set_active_vpn_endpoint (the main risk from the spike — the VPN
// node must be excluded, otherwise winws mangles encrypted VLESS).

use std::net::IpAddr;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::atomic_file::{copy_replace, overwrite_in_place, write_bytes_replace, write_replace};
use crate::util::MutexExt;
use reqwest::Response;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

mod custom;

#[derive(Default)]
pub struct DpiState {
    // Child winws.exe. None — not running. The handle is mutable for try_wait/kill.
    child: Mutex<Option<Child>>,
    // Short start/autotest operations are serialized and get a generation.
    // stop bumps the generation: old async code after any await sees
    // the cancellation and cannot revive the process or overwrite the new session's state.
    control: Mutex<DpiControl>,
    // operation in control is reset immediately on cancel, but async start/autotest
    // may still be finishing its current await. This flag lives until the guard's Drop and keeps
    // stop/unload from reporting success before the task has actually finished.
    operation_active: AtomicBool,
    // Whether the WinDivert kernel driver was loaded in this session (winws started at least once).
    // Gate for sc unloading on exit: if DPI was never enabled, there are no services to remove —
    // and an unconditional `sc.exe` on every exit produced a 0xc0000142 error window on
    // PC shutdown (sc.exe can't start in a session that is being torn down). Reset
    // after the service is actually unloaded (full_unload).
    driver_loaded: AtomicBool,
    // Services whose ImagePath was verified as belonging to the Ninety directory.
    // We never stop the global WinDivert/WinDivert14 blindly.
    owned_services: Mutex<Vec<String>>,
    // Mutations of the signed DPI set, local lists and ACTIVE_*.bin must
    // be linear: sync carries them into the new generation before the pointer commit.
    data: tokio::sync::Mutex<()>,
    // The winws session started by dpi_start: id = generation of its operation. 0 — no regular
    // session (stopped, restarting, or auto-tuning is running). Changes
    // only under the child lock: a process exit while the session is live is a crash and
    // the dpi:exited event, while a planned stop resets the session first.
    runtime_session: AtomicU64,
    // Counter of VPN node exclusion requests. DNS is awaited outside the data lock, so
    // a request overtaken by a newer one does not write its result.
    endpoint_seq: AtomicU64,
}

#[derive(Default)]
struct DpiControl {
    generation: u64,
    operation: Option<&'static str>,
}

const CHILD_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const DRIVER_UNLOAD_TIMEOUT: Duration = Duration::from_secs(3);

fn terminate_child_bounded(child: &mut Child, label: &str) -> Result<(), String> {
    let kill_error = child.kill().err();
    let deadline = Instant::now() + CHILD_STOP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => return Err(format!("{label} did not exit within 2 seconds")),
            Err(e) => return Err(format!("could not confirm that {label} stopped: {e}")),
        }
        if let Some(e) = kill_error.as_ref() {
            // A kill error is acceptable only if try_wait above has already confirmed
            // that the process managed to exit on its own.
            if Instant::now() >= deadline {
                return Err(format!("could not stop {label}: {e}"));
            }
        }
    }
}

fn stop_managed_child(state: &DpiState, label: &str) -> Result<(), String> {
    // Reset the session under the same lock under which we take the handle: the exit
    // watcher either saw the crash earlier (and then the handle is already gone), or
    // will see a zero session and won't call the planned stop a crash.
    let taken = {
        let mut guard = state.child.lock_recover();
        state.runtime_session.store(0, Ordering::SeqCst);
        guard.take()
    };
    let Some(mut child) = taken else {
        return Ok(());
    };
    match terminate_child_bounded(&mut child, label) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Don't lose the handle: a repeated command must actually retry
            // the stop rather than take None for a confirmed success.
            *state.child.lock_recover() = Some(child);
            Err(e)
        }
    }
}

fn stop_dpi_runtime(state: &DpiState, label: &str) -> Result<(), String> {
    let cancelled = cancel_dpi_operation(state);
    stop_managed_child(state, label)?;
    // sync_channel doesn't spawn processes — it moves generation files, and on
    // a slow disk that takes noticeably longer than two seconds. Waiting for such an operation
    // turned a normal bypass shutdown into a "cancellable operation did not
    // finish" error, although winws is physically stopped by then.
    if !operation_can_spawn(cancelled) {
        return Ok(());
    }
    let deadline = Instant::now() + CHILD_STOP_TIMEOUT;
    while state.operation_active.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return Err(format!(
                "{label}: the cancelled operation did not finish within 2 seconds"
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // The operation may have managed to spawn a child between the first take and the generation
    // check. After the guard's Drop we do a final confirmed stop.
    stop_managed_child(state, label)
}

fn begin_dpi_operation(state: &DpiState, name: &'static str) -> Result<u64, String> {
    if state.operation_active.swap(true, Ordering::SeqCst) {
        return Err(crate::util::i18n_error("backend.dpi.busy"));
    }
    let mut control = state.control.lock_recover();
    if control.operation.is_some() {
        state.operation_active.store(false, Ordering::SeqCst);
        return Err(crate::util::i18n_error("backend.dpi.busy"));
    }
    control.generation = control.generation.wrapping_add(1);
    control.operation = Some(name);
    Ok(control.generation)
}

fn dpi_operation_current(state: &DpiState, generation: u64) -> bool {
    let control = state.control.lock_recover();
    control.generation == generation && control.operation.is_some()
}

async fn wait_dpi_cancelled(state: &DpiState, generation: u64) {
    while dpi_operation_current(state, generation) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn dpi_sleep_or_cancel(
    state: &DpiState,
    generation: u64,
    duration: Duration,
) -> Result<(), String> {
    tokio::select! {
        _ = tokio::time::sleep(duration) => Ok(()),
        _ = wait_dpi_cancelled(state, generation) => Err(crate::util::i18n_error("backend.dpi.cancelled")),
    }
}

fn cancel_dpi_operation(state: &DpiState) -> Option<&'static str> {
    let mut control = state.control.lock_recover();
    control.generation = control.generation.wrapping_add(1);
    control.operation.take()
}

// Operations that bring up winws themselves. Only their stop must wait:
// such an operation may spawn the process after stop has already taken the handle,
// and without waiting the stop would report success on a live process.
fn operation_can_spawn(name: Option<&str>) -> bool {
    matches!(name, Some("start") | Some("autotest"))
}

struct DpiOperationGuard<'a> {
    state: &'a DpiState,
    generation: u64,
}

impl Drop for DpiOperationGuard<'_> {
    fn drop(&mut self) {
        let mut control = self.state.control.lock_recover();
        if control.generation == self.generation {
            control.operation = None;
        }
        self.state.operation_active.store(false, Ordering::SeqCst);
    }
}

// ── winws exit watcher ─────────────────────────────────────────────
// Previously nobody noticed winws crashing mid-session: the frontend kept
// showing "Running" until the user opened the section themselves. The watcher
// only reports the fact — what to show and whether to bring the engine up again
// is decided by the frontend.
const DPI_EXITED_EVENT: &str = "dpi:exited";
const DPI_EXIT_POLL: Duration = Duration::from_millis(500);

#[derive(Serialize, Clone, Debug)]
struct DpiExitedEvent {
    // generation of the dpi_start operation that brought up the crashed session.
    generation: u64,
    code: Option<i32>,
    // i18n token for the error banner.
    message: String,
}

fn dpi_exited_event(generation: u64, code: Option<i32>) -> DpiExitedEvent {
    let code_text = code.map_or_else(|| "?".to_string(), |code| code.to_string());
    DpiExitedEvent {
        generation,
        code,
        message: crate::util::i18n_error_with(
            "backend.dpi.exitedUnexpectedly",
            &[("code", &code_text)],
        ),
    }
}

// Take the winws handle if the regular session died on its own. expected=Some(id) — the watcher
// of a specific session: it doesn't touch another (newer) session. None — any
// current session (dpi_running may also be the first to stumble on the corpse).
fn reap_unexpected_exit(state: &DpiState, expected: Option<u64>) -> Option<DpiExitedEvent> {
    let mut guard = state.child.lock_recover();
    let session = state.runtime_session.load(Ordering::SeqCst);
    if session == 0 || expected.is_some_and(|id| id != session) {
        return None;
    }
    let status = match guard.as_mut()?.try_wait() {
        Ok(Some(status)) => status,
        _ => return None,
    };
    *guard = None;
    state.runtime_session.store(0, Ordering::SeqCst);
    Some(dpi_exited_event(session, status.code()))
}

fn spawn_dpi_exit_watcher(app: AppHandle, session: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(DPI_EXIT_POLL).await;
            let exited = {
                let state = app.state::<DpiState>();
                if state.runtime_session.load(Ordering::SeqCst) != session {
                    return; // a planned stop or a new session — not our case
                }
                reap_unexpected_exit(&state, Some(session))
            };
            if let Some(event) = exited {
                let _ = app.emit(DPI_EXITED_EVENT, event);
                return;
            }
        }
    });
}

#[derive(Deserialize, Serialize)]
struct Strategy {
    id: String,
    #[serde(default)]
    name: String,
    // Description for the UI; not passed to winws.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    desc: String,
    #[serde(default)]
    experimental: bool,
    args: Vec<String>,
}

// Strategy data channel: a signed prerelease asset that is manually
// published by the reviewed dpi-channel.yml workflow from a pinned Flowseal release.
// Ninety pulls it on the fly,
// verifies the minisign signature and applies it — WITHOUT updating the app. It carries only
// data (strategies.json + lists + .bin); the engine ships via OTA (see engine-watch).
const CHANNEL_BASE: &str =
    "https://github.com/pathetixx/190x4-Ninety/releases/download/dpi-channel";
const MAX_CHANNEL_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHANNEL_SIGNATURE_BYTES: u64 = 64 * 1024;
const MAX_CHANNEL_TEXT_BYTES: u64 = 256 * 1024;
const MAX_CHANNEL_ENTRIES: usize = 2048;
const MAX_CHANNEL_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CHANNEL_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;
static TEMP_FILE_SEQ: AtomicU64 = AtomicU64::new(0);
const CHANNEL_POINTER_FILE: &str = "channel-current";
const CHANNEL_GENERATIONS_DIR: &str = "channel-generations";
const CHANNEL_LIST_FILES: [&str; 4] = [
    "list-general.txt",
    "list-google.txt",
    "list-exclude.txt",
    "ipset-exclude.txt",
];
const LOCAL_LIST_FILES: [&str; 9] = [
    "list-general-user.txt",
    "list-exclude-user.txt",
    "ipset-exclude-user.txt",
    "active-vpn-domain.txt",
    "active-vpn-ip.txt",
    "ipset-all.txt",
    IPSET_BASE_FILE,
    "ipset-game.txt",
    // The autolist is the result of learning on live traffic, not part of the channel:
    // without carrying it over, every strategy update would wipe it, and blocked
    // sites would again open only on the third try.
    AUTO_HOSTLIST_FILE,
];
const IPSET_SERVICE_FILE: &str = "ipset-service.txt";
const IPSET_BASE_FILE: &str = "ipset-all.base.txt";
const CHANNEL_SERVICE_FILES: [&str; 2] = ["hosts", IPSET_SERVICE_FILE];
// The signed bundle and its signature live in the generation next to the unpacked
// files. The data directory is writable by a regular user, so
// service files (hosts goes into a system file from an elevated process) are read
// not from disk on trust but from the bundle after the signature is verified.
const GENERATION_BUNDLE_FILE: &str = "bundle.zip";
const GENERATION_SIGNATURE_FILE: &str = "bundle.zip.sig";

struct StagingDirGuard {
    path: PathBuf,
    keep: bool,
}

impl Drop for StagingDirGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
// Dedicated DPI channel key. New bundles are signed only with it.
// base64 of the minisign-pubkey file; it deliberately does NOT match the OTA updater key.
const CHANNEL_DEDICATED_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ4NDI2MThEQTc1QTVBMEYKUldRUFdscW5qV0ZDMklsd25RR2JhQlZLTWt3dmQ2L3gvSWozdTV4My9xS3Fhcy84MElXZ1h4LzYK";
// Transitional trust: the already published dpi-channel is signed with the legacy OTA key.
// Remove only in a separate release after manually rotating the channel, see
// docs/DPI_CHANNEL_KEY_ROTATION.md.
const CHANNEL_LEGACY_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc1N0I1RTAwMEQ3MUQ3OUUKUldTZTEzRU5BRjU3ZGN3TkZoK28yeFRVa2tLdlhxNy8zUXo1aUdXN1lOSUE3MzZLUmVCRnFYamsK";

// ── Paths ────────────────────────────────────────────────────────────
// Engine directory in resources (read-only): <resource_dir>/dpi.
fn res_dpi(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?
        .join("dpi");
    Ok(dir)
}
// monkey=true → the bin-monkey directory: the same winws.exe + cygwin1.dll, but a WinDivert.dll
// with patched wide strings (service WinDivert→Monkey, driver file
// WinDivert64.sys→Monkey64.sys; the device name \\.\WinDivert is kept — it is
// created by the .sys itself in DriverEntry, Monkey64.sys is byte-identical to WinDivert64.sys).
// The driver loads with the same Microsoft/WDF signature, but in SCM and on disk it shows up
// as "Monkey" → the WinDivert name doesn't appear in the service/file lists. It has no effect
// on bypass functionality.
fn bin_dir(app: &AppHandle, monkey: bool) -> Result<PathBuf, String> {
    Ok(res_dpi(app)?.join(if monkey { "bin-monkey" } else { "bin" }))
}
fn res_lists(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(res_dpi(app)?.join("lists"))
}

fn valid_channel_generation_name(name: &str) -> bool {
    name.starts_with("gen-")
        && name.len() <= 128
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn validate_channel_generation(path: &Path) -> Result<(), String> {
    let required_files = [
        path.join("strategies.json"),
        path.join("version.txt"),
        path.join("lists").join(CHANNEL_LIST_FILES[0]),
        path.join("lists").join(CHANNEL_LIST_FILES[1]),
        path.join("lists").join(CHANNEL_LIST_FILES[2]),
        path.join("lists").join(CHANNEL_LIST_FILES[3]),
        path.join("service").join(CHANNEL_SERVICE_FILES[0]),
        path.join("service").join(CHANNEL_SERVICE_FILES[1]),
    ];
    for file in required_files {
        let metadata = std::fs::symlink_metadata(&file).map_err(|e| {
            format!(
                "DPI channel generation incomplete ({}): {e}",
                file.display()
            )
        })?;
        if !metadata.file_type().is_file() {
            return Err(format!(
                "DPI channel generation contains a non-file: {}",
                file.display()
            ));
        }
    }
    let bin = path.join("bin-data");
    let metadata = std::fs::symlink_metadata(&bin)
        .map_err(|e| format!("DPI channel generation has no bin-data: {e}"))?;
    if !metadata.file_type().is_dir() {
        return Err("DPI channel generation bin-data is not a directory".into());
    }
    Ok(())
}

struct ChannelResolution {
    // The generation we actually use: the one in pointer, or the newest
    // intact one among the saved ones. None — built-in resources.
    active: Option<PathBuf>,
    // pointer exists but points to a corrupted/vanished generation.
    pointer_broken: bool,
}

// Diagnostics of a corrupted generation are written once per distinct message:
// resolution is called from every DPI command, and the log would otherwise fill with one line.
static LAST_CHANNEL_DIAGNOSTIC: Mutex<String> = Mutex::new(String::new());

fn report_channel_diagnostic(message: &str) {
    let mut last = LAST_CHANNEL_DIAGNOSTIC.lock_recover();
    if *last != message {
        eprintln!("{message}");
        *last = message.to_string();
    }
}

// Generation freshness key: gen-<nanos>-<pid>-<seq>. A broken name goes to the very bottom.
fn channel_generation_age_key(name: &str) -> (u128, u64) {
    let mut parts = name.split('-').skip(1);
    let nanos = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let seq = parts.nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    (nanos, seq)
}

// The newest intact generation, except the corrupted `skip`. cleanup keeps the previous
// generation for exactly this case.
fn newest_valid_channel_generation(generations: &Path, skip: Option<&str>) -> Option<PathBuf> {
    let entries = std::fs::read_dir(generations).ok()?;
    let mut best: Option<((u128, u64), String)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_channel_generation_name(&name) || skip == Some(name.as_str()) {
            continue;
        }
        if validate_channel_generation(&entry.path()).is_err() {
            continue;
        }
        let key = channel_generation_age_key(&name);
        if best
            .as_ref()
            .is_none_or(|(best_key, best_name)| (key, &name) > (*best_key, best_name))
        {
            best = Some((key, name));
        }
    }
    best.map(|(_, name)| generations.join(name))
}

// A corrupted active generation no longer breaks the whole DPI section (including
// "Update", which is what repairs it): we fall back to the previous intact
// generation or to the built-in resources and remember that a sync is needed.
fn resolve_channel_generation(dpi_data: &Path) -> ChannelResolution {
    let pointer = dpi_data.join(CHANNEL_POINTER_FILE);
    let generations = dpi_data.join(CHANNEL_GENERATIONS_DIR);
    let (problem, skip) = match std::fs::read_to_string(&pointer) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ChannelResolution {
                active: None,
                pointer_broken: false,
            }
        }
        Err(e) => (format!("read DPI channel pointer: {e}"), None),
        Ok(raw) => {
            let name = raw.trim().to_string();
            if !valid_channel_generation_name(&name) {
                ("DPI channel pointer is invalid".to_string(), None)
            } else {
                match validate_channel_generation(&generations.join(&name)) {
                    Ok(()) => {
                        return ChannelResolution {
                            active: Some(generations.join(name)),
                            pointer_broken: false,
                        }
                    }
                    Err(error) => (error, Some(name)),
                }
            }
        }
    };
    let fallback = newest_valid_channel_generation(&generations, skip.as_deref());
    report_channel_diagnostic(&format!(
        "{problem}; falling back to {}",
        fallback.as_ref().map_or_else(
            || "the bundled DPI set".to_string(),
            |path| path.display().to_string()
        )
    ));
    ChannelResolution {
        active: fallback,
        pointer_broken: true,
    }
}

fn active_channel_generation_from_dpi(dpi_data: &Path) -> Option<PathBuf> {
    resolve_channel_generation(dpi_data).active
}

fn active_channel_generation(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let dpi_data = crate::app_paths::data_dir(app)?.join("dpi");
    Ok(active_channel_generation_from_dpi(&dpi_data))
}

fn channel_generation_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("gen-{nanos}-{}-{seq}", std::process::id())
}

#[cfg(target_os = "windows")]
fn finalize_channel_generation(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|e| format!("finalize DPI channel generation: {e}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn finalize_channel_generation(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| format!("finalize DPI channel generation: {e}"))
}

// ── Ninety's own additions to the lists ────────────────────────────
// The channel (dpi-channel.yml) copies the Flowseal lists as is, so Ninety's
// additions don't live in the base files: after "Update" they would disappear. They
// are stored here and overlaid on top of any base set — built-in
// or channel — on every write, without duplicates.
// Vivox (Unity voice, AS35028): 85.236.104.0/23 is not within the /21.
const NINETY_GENERAL_ADDITIONS: [&str; 1] = ["vivox.com"];
const NINETY_IPSET_ADDITIONS: [&str; 2] = ["85.236.96.0/21", "85.236.104.0/23"];
// Version marker of the built-in base lists in the legacy directory (no channel).
const BUNDLED_LISTS_MARKER: &str = ".bundled-lists-version";

// List text with the additions at the end. None — all additions are already present (compared
// case-insensitively, comments and empty lines don't count).
fn with_list_additions(text: &str, additions: &[&str]) -> Option<String> {
    let present: std::collections::HashSet<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("//"))
        .map(str::to_ascii_lowercase)
        .collect();
    let mut seen = std::collections::HashSet::new();
    let missing: Vec<&str> = additions
        .iter()
        .copied()
        .filter(|entry| {
            let key = entry.to_ascii_lowercase();
            !present.contains(&key) && seen.insert(key)
        })
        .collect();
    if missing.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(text.len() + missing.len() * 24);
    out.push_str(text);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for entry in missing {
        out.push_str(entry);
        out.push('\n');
    }
    Some(out)
}

fn apply_list_additions(path: &Path, additions: &[&str], label: &str) -> Result<(), String> {
    let text = read_list_text(path)?;
    if let Some(updated) = with_list_additions(&text, additions) {
        write_replace(path, &updated, label)?;
    }
    Ok(())
}

// Version of the built-in lists: changes with every app and set version.
fn bundled_lists_stamp(app: &AppHandle) -> String {
    format!(
        "{}+{}",
        app.package_info().version,
        bundled_strategies_version()
    )
}

// Base lists of the legacy directory (installation without a channel) — a copy of the app's
// resources. Previously they were copied only when the file was missing, and on old
// installations they stayed forever from the first install. Now, when the
// app/set version changes, the base files are rewritten from resources.
// User lists (*-user.txt), session lists and the autolist are not touched here,
// nor is the writable ipset base (moved by "Update list").
fn refresh_bundled_base_lists(dst: &Path, src: &Path, stamp: &str) -> Result<(), String> {
    let marker = dst.join(BUNDLED_LISTS_MARKER);
    let current = std::fs::read_to_string(&marker).unwrap_or_default();
    let refresh = current.trim() != stamp;
    for name in CHANNEL_LIST_FILES {
        let to = dst.join(name);
        if !refresh && to.exists() {
            continue;
        }
        let from = src.join(name);
        if from.is_file() {
            copy_replace(&from, &to, &format!("bundled list {name}"))?;
        } else if !to.exists() {
            write_replace(&to, "", &format!("empty list {name}"))?;
        }
    }
    if refresh {
        write_replace(&marker, &format!("{stamp}\n"), "bundled lists version")?;
    }
    Ok(())
}

// Seed the writable lists. In a channel generation the base lists belong to
// the channel (we only recreate missing ones); in the legacy directory they belong to the app's
// resources and are updated together with it. Ninety's additions are overlaid on top
// in both cases; user lists are created empty. ipset-all.txt is written
// separately according to the mode.
fn ensure_lists(app: &AppHandle) -> Result<PathBuf, String> {
    let generation = active_channel_generation(app)?;
    let dst = match &generation {
        Some(generation) => generation.join("lists"),
        None => crate::app_paths::data_dir(app)?.join("dpi").join("lists"),
    };
    std::fs::create_dir_all(&dst).map_err(|e| format!("mkdir lists: {e}"))?;
    let src = res_lists(app)?;
    if generation.is_some() {
        for name in CHANNEL_LIST_FILES {
            let to = dst.join(name);
            if !to.exists() {
                let from = src.join(name);
                if from.is_file() {
                    copy_replace(&from, &to, &format!("seed {name}"))?;
                } else {
                    write_replace(&to, "", &format!("touch {name}"))?;
                }
            }
        }
    } else {
        refresh_bundled_base_lists(&dst, &src, &bundled_lists_stamp(app))?;
    }
    apply_list_additions(
        &dst.join("list-general.txt"),
        &NINETY_GENERAL_ADDITIONS,
        "Ninety list additions",
    )?;
    for name in [
        "list-general-user.txt",
        "list-exclude-user.txt",
        "ipset-exclude-user.txt",
        // Always empty: lifts the ipset gate from the Game Filter sections, independent of
        // the IPset mode (write_ipset_mode writes only ipset-all.txt).
        "ipset-game.txt",
        // Autolist of blocked domains. winws maintains it itself in the
        // "Blocked only" mode; we only need the file to exist —
        // winws opens it for reading at startup, before the first write.
        AUTO_HOSTLIST_FILE,
        "active-vpn-domain.txt",
        "active-vpn-ip.txt",
    ] {
        let to = dst.join(name);
        if !to.exists() {
            std::fs::write(&to, b"").map_err(|e| format!("touch {name}: {e}"))?;
        }
    }
    migrate_exclude_ips(&dst)?;
    Ok(dst)
}

// Writable directory of .bin payloads: bin-data of the active generation or legacy
// <app_data>/dpi/bin-data. The engine (winws.exe + driver) stays read-only in the
// resource. winws reads .bin by absolute path (%BIN%), regardless of cwd.
fn bindata_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match active_channel_generation(app)? {
        Some(generation) => generation.join("bin-data"),
        None => crate::app_paths::data_dir(app)?
            .join("dpi")
            .join("bin-data"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir bin-data: {e}"))?;
    Ok(dir)
}

// Keep the writable bin-data in working order. Without a channel overlay
// the app's built-in set is the source of truth: this matters when
// updating Ninety from Flowseal <1.10, where bin-data is no longer empty but ACTIVE_*.bin
// are still missing. With an overlay, its signed set is
// the only source of truth: files removed by the channel are not resurrected from the app.
// Exception — a generation whose strategies are not confirmed by a signature: then
// the built-in strategies are used, and the .bin files they lack are recreated from the resource
// (existing generation files and the UDP fake choice are left alone).
fn ensure_bindata(app: &AppHandle, active: &ActiveStrategies) -> Result<PathBuf, String> {
    let dst = bindata_dir(app)?;
    if active.channel.is_none() && active_channel_generation(app)?.is_some() {
        copy_missing_bundled_bins(app, &dst, &active.strategies)?;
    } else {
        sync_bundled_bindata(app, &dst)?;
    }
    let _ = reapply_fake_selection(app, &dst)?;
    Ok(dst)
}

fn copy_missing_bundled_bins(
    app: &AppHandle,
    dst: &Path,
    strategies: &[Strategy],
) -> Result<(), String> {
    let src = bin_dir(app, false)?;
    for name in referenced_bins(strategies) {
        if !valid_bin_filename(&name) || dst.join(&name).is_file() {
            continue;
        }
        let from = src.join(&name);
        if from.is_file() {
            copy_replace(&from, &dst.join(&name), &format!("bundled bin {name}"))?;
        }
    }
    Ok(())
}

const ACTIVE_DISCORD_FAKE: &str = "ACTIVE_DISCORD_UDP.bin";
const ACTIVE_GAME_FAKE: &str = "ACTIVE_GAME_UDP.bin";
const MAX_DPI_PAYLOAD_BYTES: u64 = 1024 * 1024;

#[derive(Default, Deserialize, Serialize)]
struct FakeSelection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    discord: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    game: Option<String>,
}

fn fake_selection_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(match active_channel_generation(app)? {
        Some(generation) => generation.join("fake-selection.json"),
        None => crate::app_paths::data_dir(app)?
            .join("dpi")
            .join("fake-selection.json"),
    })
}

fn valid_fake_filename(name: &str) -> bool {
    valid_bin_filename(name) && !name.to_ascii_lowercase().starts_with("active_")
}

fn valid_bin_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !name.is_empty()
        && name.len() <= 128
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && lower.ends_with(".bin")
}

fn fake_target(kind: &str) -> Result<&'static str, String> {
    match kind {
        "discord" => Ok(ACTIVE_DISCORD_FAKE),
        "game" => Ok(ACTIVE_GAME_FAKE),
        _ => Err("unknown UDP fake type".into()),
    }
}

fn fake_options(dir: &Path) -> Result<Vec<String>, String> {
    let mut options = Vec::new();
    let rd = std::fs::read_dir(dir).map_err(|e| format!("read bin-data: {e}"))?;
    for item in rd {
        let entry = item.map_err(|e| format!("read bin-data entry: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("fake file type: {e}"))?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_fake_filename(&name) {
            continue;
        }
        let size = entry
            .metadata()
            .map_err(|e| format!("fake metadata: {e}"))?
            .len();
        if (1..=MAX_DPI_PAYLOAD_BYTES).contains(&size) {
            options.push(name);
        }
    }
    options.sort_by_key(|name| name.to_ascii_lowercase());
    Ok(options)
}

fn load_fake_selection(app: &AppHandle) -> FakeSelection {
    let Ok(path) = fake_selection_path(app) else {
        return FakeSelection::default();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return FakeSelection::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_fake_selection(app: &AppHandle, selection: &FakeSelection) -> Result<(), String> {
    let path = fake_selection_path(app)?;
    save_fake_selection_at(&path, selection)
}

fn save_fake_selection_at(path: &Path, selection: &FakeSelection) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(selection)
        .map_err(|e| format!("serialize fake selection: {e}"))?;
    write_replace(path, &format!("{raw}\n"), "fake selection")
}

fn files_equal(left: &Path, right: &Path) -> bool {
    let Ok(left_meta) = std::fs::metadata(left) else {
        return false;
    };
    let Ok(right_meta) = std::fs::metadata(right) else {
        return false;
    };
    if !left_meta.is_file()
        || !right_meta.is_file()
        || left_meta.len() == 0
        || left_meta.len() != right_meta.len()
        || left_meta.len() > MAX_DPI_PAYLOAD_BYTES
    {
        return false;
    }
    match (std::fs::read(left), std::fs::read(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn sync_bundled_bindata(app: &AppHandle, dst: &Path) -> Result<(), String> {
    let src = bin_dir(app, false)?;
    if active_channel_generation(app)?.is_some() {
        return Ok(());
    }
    // The legacy overlay <data>/dpi/strategies.json is no longer read (see
    // load_strategies), so without a generation the built-in .bin set
    // is always authoritative — it goes together with the built-in strategies.
    let mut bundled = std::collections::HashSet::new();
    let rd = std::fs::read_dir(&src).map_err(|e| format!("read bundled bin: {e}"))?;
    for item in rd {
        let entry = item.map_err(|e| format!("read bundled bin entry: {e}"))?;
        if !entry
            .file_type()
            .map_err(|e| format!("bundled bin file type: {e}"))?
            .is_file()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_bin_filename(&name) {
            continue;
        }
        bundled.insert(name.clone());
        let from = entry.path();
        let to = dst.join(&name);
        if !to.exists() || !files_equal(&from, &to) {
            copy_replace(&from, &to, &format!("bundled bin {name}"))?;
        }
    }

    // Without a channel overlay we only delete outdated valid .bin files from our
    // managed directory. This way a vanished upstream candidate doesn't stay
    // available under its old name after an app update.
    let rd = std::fs::read_dir(dst).map_err(|e| format!("read bin-data: {e}"))?;
    for item in rd {
        let entry = item.map_err(|e| format!("read bin-data entry: {e}"))?;
        if !entry
            .file_type()
            .map_err(|e| format!("bin-data file type: {e}"))?
            .is_file()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if valid_bin_filename(&name) && !bundled.contains(&name) {
            std::fs::remove_file(entry.path())
                .map_err(|e| format!("remove stale bin {name}: {e}"))?;
        }
    }
    Ok(())
}

fn current_fake_name(
    dir: &Path,
    active_name: &str,
    options: &[String],
    preferred: Option<&str>,
) -> Option<String> {
    let active = dir.join(active_name);
    if let Some(name) = preferred.filter(|name| valid_fake_filename(name)) {
        if files_equal(&active, &dir.join(name)) {
            return Some(name.to_string());
        }
    }
    options
        .iter()
        .find(|name| files_equal(&active, &dir.join(name)))
        .cloned()
}

fn apply_fake_file(dir: &Path, kind: &str, file: &str) -> Result<(), String> {
    if !valid_fake_filename(file) {
        return Err("invalid fake file name".into());
    }
    let source = dir.join(file);
    let meta =
        std::fs::symlink_metadata(&source).map_err(|e| format!("fake '{file}' not found: {e}"))?;
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > MAX_DPI_PAYLOAD_BYTES {
        return Err("fake file is empty, too large or not a regular file".into());
    }
    let target = dir.join(fake_target(kind)?);
    copy_replace(&source, &target, &format!("{kind} UDP fake"))
}

fn fake_source_usable(dir: &Path, file: &str) -> bool {
    if !valid_fake_filename(file) {
        return false;
    }
    std::fs::symlink_metadata(dir.join(file))
        .map(|meta| meta.file_type().is_file() && (1..=MAX_DPI_PAYLOAD_BYTES).contains(&meta.len()))
        .unwrap_or(false)
}

// After a channel update the upstream ACTIVE_*.bin are replaced with defaults. The user's explicit
// choice is stored separately and overlaid on top of the fresh set.
// If the selected upstream file is gone, only that slot is reset to the new
// default — we don't block the whole sync because of an outdated choice.
fn reapply_fake_selection_with_inventory(
    app: &AppHandle,
    dir: &Path,
    inventory: Option<&std::collections::HashSet<String>>,
) -> Result<Vec<String>, String> {
    let mut selection = load_fake_selection(app);
    let reset = reapply_fake_selection_value(dir, inventory, &mut selection)?;
    if !reset.is_empty() {
        save_fake_selection(app, &selection)?;
    }
    Ok(reset)
}

fn reapply_fake_selection_value(
    dir: &Path,
    inventory: Option<&std::collections::HashSet<String>>,
    selection: &mut FakeSelection,
) -> Result<Vec<String>, String> {
    let mut reset = Vec::new();
    for kind in ["discord", "game"] {
        let selected = match kind {
            "discord" => selection.discord.clone(),
            _ => selection.game.clone(),
        };
        let Some(file) = selected else {
            continue;
        };
        if inventory.is_some_and(|files| !files.contains(&file)) || !fake_source_usable(dir, &file)
        {
            match kind {
                "discord" => selection.discord = None,
                _ => selection.game = None,
            }
            reset.push(kind.to_string());
            continue;
        }
        // An ACTIVE_* write error is a real I/O failure, not an outdated choice:
        // we don't hide it by resetting the marker and don't continue with a partially applied sync.
        apply_fake_file(dir, kind, &file)?;
    }
    Ok(reset)
}

fn reapply_fake_selection(app: &AppHandle, dir: &Path) -> Result<Vec<String>, String> {
    reapply_fake_selection_with_inventory(app, dir, None)
}

// ── Strategies: source and argument allowlist ─────────────────────
// Strategy arguments go to winws, which runs with
// administrator rights, while the data directory is writable by a regular user.
// So strategies.json is no longer read from disk on trust anywhere:
//   - a channel strategy comes only from the signed bundle.zip of the active
//     generation (the signature is checked on every read);
//   - a built-in one comes from the executable itself (include_str!), the same build
//     as the resource .bin files and lists;
//   - the legacy overlay <data>/dpi/strategies.json is ignored.
// The second line of defense is a flag allowlist, a mirror of gen_strategies.py::validate_arg.
const BUNDLED_STRATEGIES_JSON: &str = include_str!("../dpi/strategies.json");
const BUNDLED_STRATEGIES_VERSION: &str = include_str!("../dpi/version.txt");
const MAX_STRATEGIES: usize = 64;
const MAX_STRATEGY_ARGS: usize = 512;
const MAX_STRATEGY_ARG_LEN: usize = 4096;

fn bundled_strategies_version() -> String {
    let version = BUNDLED_STRATEGIES_VERSION.trim();
    if version.is_empty() {
        "—".into()
    } else {
        version.to_string()
    }
}

const DESYNC_VALUES: [&str; 9] = [
    "fake",
    "fake,fakedsplit",
    "fake,hostfakesplit",
    "fake,multidisorder",
    "fake,multisplit",
    "hostfakesplit",
    "multisplit",
    "syndata",
    "syndata,multidisorder",
];
const FOOLING_VALUES: [&str; 3] = ["badseq", "ts", "ts,md5sig"];
const L7_VALUES: [&str; 3] = ["quic", "discord,stun", "discord,stun,unknown"];
const BIN_FLAGS: [&str; 6] = [
    "--dpi-desync-fake-discord",
    "--dpi-desync-fake-http",
    "--dpi-desync-fake-quic",
    "--dpi-desync-fake-stun",
    "--dpi-desync-fake-unknown-udp",
    "--dpi-desync-split-seqovl-pattern",
];

// List file flags: only our names under %LISTS%. The service
// --hostlist-auto* flags and the active node exclusion are added by the app itself after
// validation; a strategy cannot set them.
fn allowed_list_values(flag: &str) -> Option<&'static [&'static str]> {
    match flag {
        "--hostlist" => Some(&[
            "%LISTS%list-general.txt",
            "%LISTS%list-general-user.txt",
            "%LISTS%list-google.txt",
        ]),
        "--hostlist-exclude" => Some(&["%LISTS%list-exclude.txt", "%LISTS%list-exclude-user.txt"]),
        "--ipset" => Some(&["%LISTS%ipset-all.txt"]),
        "--ipset-exclude" => Some(&["%LISTS%ipset-exclude.txt", "%LISTS%ipset-exclude-user.txt"]),
        _ => None,
    }
}

fn bounded_int(value: &str, low: u64, high: u64) -> bool {
    !value.is_empty()
        && value.len() <= 19
        && value.bytes().all(|b| b.is_ascii_digit())
        && value
            .parse::<u64>()
            .is_ok_and(|n| (low..=high).contains(&n))
}

// %BIN%name.bin: only [A-Za-z0-9._-] characters, no ".." and no path separators.
fn safe_bin_value(value: &str) -> bool {
    let Some(name) = value.strip_prefix("%BIN%") else {
        return false;
    };
    name.len() > ".bin".len()
        && name.ends_with(".bin")
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn safe_hex_value(value: &str) -> bool {
    value.strip_prefix("0x").is_some_and(|hex| {
        (2..=4096).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

// SAFE_DOMAIN from the generator: labels [A-Za-z0-9-] up to 63 characters without a hyphen at
// the edges, at least two labels, the last one 2..63 Latin letters.
fn safe_strategy_domain(value: &str) -> bool {
    let labels: Vec<&str> = value.split('.').collect();
    let Some((tld, rest)) = labels.split_last() else {
        return false;
    };
    !rest.is_empty()
        && (2..=63).contains(&tld.len())
        && tld.bytes().all(|b| b.is_ascii_alphabetic())
        && rest.iter().all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn valid_port_list(value: &str, placeholder: &str) -> bool {
    value.split(',').all(|part| {
        if part == placeholder {
            return true;
        }
        let (start, end) = part.split_once('-').unwrap_or((part, part));
        let port = |raw: &str| -> Option<u32> {
            if raw.is_empty() || raw.len() > 5 || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            raw.parse().ok()
        };
        match (port(start), port(end)) {
            (Some(start), Some(end)) => (1..=end).contains(&start) && end <= 65535,
            _ => false,
        }
    })
}

// \d{1,5}(,(midsld|sniext+\d{1,5}))?
fn valid_split_pos(value: &str) -> bool {
    let short_number =
        |raw: &str| (1..=5).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_digit());
    let (position, marker) = match value.split_once(',') {
        Some((position, marker)) => (position, Some(marker)),
        None => (value, None),
    };
    short_number(position)
        && match marker {
            None => true,
            Some("midsld") => true,
            Some(marker) => marker.strip_prefix("sniext+").is_some_and(short_number),
        }
}

/// Validate one strategy argument before placeholder substitution. Mirror of
/// gen_strategies.py::validate_arg: the channel generator already filters its output with it, and
/// the client repeats the check because a disk sits between the signature and winws.
fn validate_strategy_arg(arg: &str) -> Result<(), String> {
    let reject =
        || -> Result<(), String> { Err(format!("unsafe or unknown winws argument: {arg:?}")) };
    if arg.len() > MAX_STRATEGY_ARG_LEN || arg.contains(['\0', '\r', '\n']) {
        return reject();
    }
    let (flag, value) = match arg.split_once('=') {
        Some((flag, value)) => (flag, Some(value)),
        None => (arg, None),
    };
    let Some(value) = value else {
        // Without a value only the section separator is allowed.
        return if flag == "--new" { Ok(()) } else { reject() };
    };
    let ok = match flag {
        "--dpi-desync" => DESYNC_VALUES.contains(&value),
        "--dpi-desync-any-protocol" => value == "1",
        "--dpi-desync-badseq-increment" => bounded_int(value, 0, 2_147_483_647),
        "--dpi-desync-cutoff" => value.strip_prefix('n').is_some_and(|n| {
            (1..=2).contains(&n.len())
                && n.bytes().all(|b| b.is_ascii_digit())
                && !n.starts_with('0')
        }),
        flag if BIN_FLAGS.contains(&flag) => safe_bin_value(value),
        "--dpi-desync-fake-tls" => value == "!" || safe_bin_value(value) || safe_hex_value(value),
        "--dpi-desync-fake-unknown" => safe_bin_value(value) || safe_hex_value(value),
        "--dpi-desync-fakedsplit-pattern" => safe_hex_value(value),
        "--dpi-desync-fooling" => FOOLING_VALUES.contains(&value),
        "--dpi-desync-repeats" => bounded_int(value, 1, 1000),
        "--dpi-desync-split-seqovl" => bounded_int(value, 0, 65535),
        "--dpi-desync-split-pos" => valid_split_pos(value),
        "--dpi-desync-fake-tls-mod" => {
            value == "none"
                || value
                    .strip_prefix("rnd,dupsid,sni=")
                    .is_some_and(safe_strategy_domain)
        }
        "--dpi-desync-hostfakesplit-mod" => value.strip_prefix("host=").is_some_and(|rest| {
            safe_strategy_domain(rest.strip_suffix(",altorder=1").unwrap_or(rest))
        }),
        "--filter-l3" => value == "ipv4",
        "--filter-l7" => L7_VALUES.contains(&value),
        "--filter-tcp" | "--wf-tcp" => valid_port_list(value, "%GameFilterTCP%"),
        "--filter-udp" | "--wf-udp" => valid_port_list(value, "%GameFilterUDP%"),
        "--hostlist-domains" | "--hostlist-exclude-domains" => {
            value.split(',').all(safe_strategy_domain)
        }
        "--ip-id" => value == "zero",
        flag => allowed_list_values(flag).is_some_and(|allowed| allowed.contains(&value)),
    };
    if ok {
        Ok(())
    } else {
        reject()
    }
}

fn validate_strategy_args(args: &[String]) -> Result<(), String> {
    if args.is_empty() || args.len() > MAX_STRATEGY_ARGS {
        return Err(format!("invalid winws argument count: {}", args.len()));
    }
    args.iter().try_for_each(|arg| validate_strategy_arg(arg))
}

// Parse strategies.json and keep only strategies that fully passed
// the allowlist. A strategy with a forbidden argument is neither fixed nor
// truncated — it is dropped entirely: a partial winws argv is a different profile.
fn parse_checked_strategies(raw: &str) -> Result<Vec<Strategy>, String> {
    let parsed: Vec<Strategy> =
        serde_json::from_str(raw).map_err(|e| format!("parse strategies.json: {e}"))?;
    if parsed.len() > MAX_STRATEGIES {
        return Err(format!("too many strategies: {}", parsed.len()));
    }
    let mut checked = Vec::with_capacity(parsed.len());
    for strategy in parsed {
        match validate_strategy_args(&strategy.args) {
            Ok(()) => checked.push(strategy),
            Err(error) => eprintln!("DPI strategy {} rejected: {error}", strategy.id),
        }
    }
    if checked.is_empty() {
        return Err("no strategy passed the winws argument allowlist".into());
    }
    Ok(checked)
}

struct ActiveStrategies {
    strategies: Vec<Strategy>,
    // Version of exactly the set the strategies were taken from.
    version: String,
    // The generation whose signed bundle provided the strategies; None — the built-in set.
    channel: Option<PathBuf>,
    // The active generation is corrupted or cannot prove its strategies with a signature:
    // we run on the built-in set and offer a resync
    // even with the same channel version.
    needs_resync: bool,
}

// Strategies and version from the generation's signed bundle (one signature check).
fn signed_generation_strategies(generation: &Path) -> Result<(Vec<Strategy>, String), String> {
    let entries = read_signed_bundle_entries(
        generation,
        &[Path::new("strategies.json"), Path::new("version.txt")],
    )?;
    let strategies = parse_checked_strategies(&entries[0])?;
    let version = entries[1].trim().to_string();
    if !valid_channel_version(&version) {
        return Err("signed DPI bundle has an invalid version".into());
    }
    Ok((strategies, version))
}

fn load_strategies_from(dpi_data: &Path) -> Result<ActiveStrategies, String> {
    let resolution = resolve_channel_generation(dpi_data);
    let mut needs_resync = resolution.pointer_broken;
    if let Some(generation) = resolution.active {
        match signed_generation_strategies(&generation) {
            Ok((strategies, version)) => {
                return Ok(ActiveStrategies {
                    strategies,
                    version,
                    channel: Some(generation),
                    needs_resync,
                })
            }
            Err(error) => {
                report_channel_diagnostic(&format!(
                    "DPI channel generation {} has no verifiable strategies, using the bundled set: {error}",
                    generation.display()
                ));
                needs_resync = true;
            }
        }
    }
    Ok(ActiveStrategies {
        strategies: parse_checked_strategies(BUNDLED_STRATEGIES_JSON)?,
        version: bundled_strategies_version(),
        channel: None,
        needs_resync,
    })
}

fn load_strategies(app: &AppHandle) -> Result<ActiveStrategies, String> {
    load_strategies_from(&crate::app_paths::data_dir(app)?.join("dpi"))
}

// ipset mode → contents of ipset-all.txt (as in Flowseal's service.bat):
//   any    — empty file (bypass by domain match, recommended);
//   loaded — the full IP set from the resource ipset-all.base.txt;
//   off    — a placeholder (one nonexistent subnet, the filter is effectively off).
fn write_ipset_mode(app: &AppHandle, lists: &Path, mode: &str) -> Result<(), String> {
    let target = lists.join("ipset-all.txt");
    match mode {
        "loaded" => {
            // The writable copy of base (after dpi_update_ipset) takes priority over the resource one —
            // this way an updated IP list applies without reinstalling the app.
            let wbase = lists.join(IPSET_BASE_FILE);
            let base = if wbase.exists() {
                wbase
            } else {
                res_lists(app)?.join(IPSET_BASE_FILE)
            };
            // The base also comes from the channel (as Flowseal has it), so Ninety's
            // additions are overlaid on the final file that winws reads.
            let text = std::fs::read_to_string(&base)
                .map_err(|e| format!("read ipset base ({}): {e}", base.display()))?;
            match with_list_additions(&text, &NINETY_IPSET_ADDITIONS) {
                Some(updated) => write_replace(&target, &updated, "ipset loaded")?,
                None => write_replace(&target, &text, "ipset loaded")?,
            }
        }
        "off" => {
            write_replace(&target, "203.0.113.113/32\n", "ipset off")?;
        }
        // "any" and "auto": an empty ipset = "don't filter by IP". In "auto" the sections
        // are additionally re-gated onto the autohostlist (gate_by_autohostlist),
        // and they no longer have their own IP filter.
        _ => {
            write_replace(&target, "", "ipset any")?;
        }
    }
    Ok(())
}

// winws log (stdout+stderr) — critical for diagnosing instant crashes.
fn dpi_log_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::app_paths::log_dir(app).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("dpi.log"))
}

// A separate file for auto-tuning runs. Writing to dpi.log is not allowed: tuning
// stops the engine, and restoring it after the run calls dpi_start, which
// opens dpi.log truncating it — the run's diagnostics were wiped exactly at the
// moment they were needed. "Open logs" opens the directory, so
// the second file is visible next to it.
fn dpi_autotest_log_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::app_paths::log_dir(app).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("dpi-autotest.log"))
}

// autohostlist decision log: winws writes there why a domain ended up in the autolist
// (failure counter, protocol, client). Without it there is no way to answer after the fact "why
// did this site get the bypass". Obeys the global "disable logs".
fn auto_hostlist_log_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::app_paths::log_dir(app).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("dpi-autohostlist.log"))
}

// winws appends autohostlist decisions to the end of the file and never truncates it itself, and
// in the "Blocked only" mode a line appears for every suspicious
// disconnect. Before starting, we keep the file within the cap and preserve the fresh tail:
// the history of "why the site got the bypass" is needed, but not for months.
const AUTO_HOSTLIST_LOG_KEEP_BYTES: u64 = 1024 * 1024;

fn trim_auto_hostlist_log(path: &Path) {
    let oversized = std::fs::metadata(path).is_ok_and(|meta| meta.len() > DPI_LOG_CAP_BYTES);
    if !oversized {
        return;
    }
    let tail = crate::vpn::read_tail(path, Some(AUTO_HOSTLIST_LOG_KEEP_BYTES)).unwrap_or_default();
    let _ = std::fs::write(path, tail);
}

// Strip the Windows verbatim prefix (`\\?\C:\…` → `C:\…`, `\\?\UNC\srv\…` →
// `\\srv\…`). resource_dir()/canonicalize on Windows return such a path;
// CreateProcess accepts it, but winws itself opens .bin with its own parser, which
// doesn't understand `\\?\` → "could not read …". We strip it for strings that go into args.
fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p.to_string()
    }
}

// Substitutes the batch file's placeholders with absolute paths/ports.
fn subst(arg: &str, bin: &str, lists: &str, g_tcp: &str, g_udp: &str) -> String {
    let binp = format!("{bin}{MAIN_SEPARATOR}");
    let listp = format!("{lists}{MAIN_SEPARATOR}");
    arg.replace("%BIN%", &binp)
        .replace("%LISTS%", &listp)
        .replace("%GameFilterTCP%", g_tcp)
        .replace("%GameFilterUDP%", g_udp)
        .replace("%GameFilter%", g_tcp)
}

// [0] — exclusion by domain, [1] — by IP. They are distributed across sections differently, see
// spread_exclusion_across_sections.
fn active_vpn_exclusion_args(lists: &Path) -> [String; 2] {
    let active_domain = lists.join("active-vpn-domain.txt");
    let active_ip = lists.join("active-vpn-ip.txt");
    [
        format!(
            "--hostlist-exclude={}",
            strip_verbatim(&active_domain.to_string_lossy())
        ),
        format!(
            "--ipset-exclude={}",
            strip_verbatim(&active_ip.to_string_lossy())
        ),
    ]
}

// The argument that creates a hostlist collection in a winws profile. It is the presence
// of the collection (not its contents) that turns on the engine's known-host requirement —
// see spread_exclusion_across_sections.
fn is_hostlist_arg(arg: &str) -> bool {
    matches!(
        arg.split('=').next().unwrap_or(arg),
        "--hostlist"
            | "--hostlist-domains"
            | "--hostlist-exclude"
            | "--hostlist-exclude-domains"
            | "--hostlist-auto"
    )
}

/// Distribute the active VPN endpoint exclusion across the strategy's sections.
///
/// In winws syntax `--new` opens a new section, and filters apply only
/// within their own: an exclusion at the end of the line covered exactly the last section, while
/// VLESS to the server goes over TCP:443, i.e. through a different one.
///
/// BUT `--hostlist-exclude` must not be spread into every section indiscriminately. In zapret
/// (`nfq/desync.c`, `dp_match`) a profile with a non-empty hostlist collection doesn't
/// match at all if the host is unknown:
///
/// ```text
/// if (!dp->hostlist_auto && !hostname && !bHostlistsEmpty) return false;
/// ```
///
/// Discord voice (`--filter-l7=discord,stun`) and the Game Filter sections
/// (`--dpi-desync-any-protocol=1`) have no host by definition — that's why Flowseal
/// left them without hostlists. Our argument made the collection non-empty, the profile
/// stopped matching, voice UDP desync wasn't applied at all, and the ping in
/// the voice channel went through the roof. An empty file doesn't fill the collection
/// (`hostlist_collection_is_empty` looks at the loaded pool), so the bug hit
/// only those whose node address is a domain.
///
/// Result: `--ipset-exclude` goes into every section (the ipset check doesn't look
/// at the host), `--hostlist-exclude` only where a hostlist already exists and the host
/// is needed anyway. Both files always stay in argv, even when empty: winws
/// rereads them by mtime, and a node switch applies without restarting the engine.
fn spread_exclusion_across_sections(args: Vec<String>, exclusion: &[String; 2]) -> Vec<String> {
    let [hostlist_exclude, ipset_exclude] = exclusion;
    let sections = args.iter().filter(|a| a.as_str() == "--new").count() + 1;
    let mut out = Vec::with_capacity(args.len() + sections * exclusion.len());
    let mut section: Vec<String> = Vec::new();
    let flush = |section: &mut Vec<String>, out: &mut Vec<String>| {
        let hostname_aware = section.iter().any(|a| is_hostlist_arg(a.as_str()));
        out.append(section);
        if hostname_aware {
            out.push(hostlist_exclude.clone());
        }
        out.push(ipset_exclude.clone());
    };
    for arg in args {
        if arg == "--new" {
            flush(&mut section, &mut out);
            out.push(arg);
        } else {
            section.push(arg);
        }
    }
    flush(&mut section, &mut out);
    out
}

/// The game filter must not depend on the IPset switch.
///
/// The Game Filter sections were gated by the shared `ipset-all.txt`, and its contents are dictated by
/// the IPset mode: in "off" a known-nonexistent 203.0.113.113/32 is written there,
/// and game traffic desync wasn't applied to a single packet — the
/// "Game filter" toggle silently did nothing. In "loaded" the result is essentially the same:
/// the list of blocked IPs doesn't contain game servers (Photon, Vivox), for
/// which the filter is turned on in the first place, so again there are no matches.
///
/// So the game sections get their own ipset-game.txt, always empty:
/// an empty ipset collection in winws means "don't filter by IP", not "didn't
/// match" (the IPset=Any mode relies on exactly this property). Exclusions
/// (`--ipset-exclude`, including the active VPN node) are added separately in
/// spread_exclusion_across_sections and aren't touched here — the node stays
/// protected.
///
/// A section is considered a game section if `--filter-tcp/udp` matches the range
/// substituted by game_filter. Called only when the filter is on: with
/// "off" the range degenerates into placeholder port 12, and there is nothing to replace.
fn ungate_game_ipset(args: Vec<String>, lists: &Path, g_tcp: &str, g_udp: &str) -> Vec<String> {
    let gated = format!(
        "--ipset={}",
        strip_verbatim(&lists.join("ipset-all.txt").to_string_lossy())
    );
    let ungated = format!(
        "--ipset={}",
        strip_verbatim(&lists.join("ipset-game.txt").to_string_lossy())
    );
    let markers = [
        format!("--filter-tcp={g_tcp}"),
        format!("--filter-udp={g_udp}"),
    ];

    let mut out = Vec::with_capacity(args.len());
    let mut section: Vec<String> = Vec::new();
    let flush = |section: &mut Vec<String>, out: &mut Vec<String>| {
        let is_game = section.iter().any(|a| markers.contains(a));
        for arg in section.drain(..) {
            if is_game && arg == gated {
                out.push(ungated.clone());
            } else {
                out.push(arg);
            }
        }
    };
    for arg in args {
        if arg == "--new" {
            flush(&mut section, &mut out);
            out.push(arg);
        } else {
            section.push(arg);
        }
    }
    flush(&mut section, &mut out);
    out
}

// Autolist of blocked domains: winws maintains it itself in the "Blocked
// only" mode. The file name is known both to ensure_lists (creates it empty) and to the view/clear
// commands, so there is one literal for all of them.
const AUTO_HOSTLIST_FILE: &str = "list-auto.txt";
// Detection thresholds. They match zapret's defaults (3 events in 60 s, 3
// retransmissions) but are passed explicitly: the number is shown to the user in a UI hint,
// and a silent default change in the engine must not make that hint wrong.
const AUTO_FAIL_THRESHOLD: u32 = 3;
const AUTO_RETRANS_THRESHOLD: u32 = 3;

/// "Blocked only" mode: re-gate the strategy onto the winws autolist.
///
/// In the "All sites" mode the sections with `--ipset=ipset-all.txt` are ungated by an empty
/// ipset (an empty collection = "don't filter by IP"), and desync hits any
/// domain except the exclusions. This harms sites that aren't blocked:
/// the fake packet reaches the server, and if the server doesn't discard it by the selected
/// `--dpi-desync-fooling`, it accepts the fake instead of the real ClientHello —
/// the site stops opening until the domain is added to the exclusions by hand.
///
/// `--hostlist-auto` flips the logic: a domain that isn't in any
/// list goes WITHOUT the bypass, and winws watches the response (retransmissions of the first
/// request with the host, RST, an HTTP redirect to a foreign second-level domain) and
/// records in the file only what behaves as blocked. A profile with
/// autohostlist always wins by the l3/l4/l7 filter, but desync is applied
/// only to hosts from the file — see nfq/desync.c, the "not applying tampering to
/// this request" branch (identical for TCP and QUIC).
///
/// Game sections (`--dpi-desync-any-protocol=1`) are left alone: their traffic has
/// no host by definition, autohostlist gives nothing there and would only replace
/// a clear IP gate with a profile that always wins.
fn gate_by_autohostlist(args: Vec<String>, lists: &Path) -> Vec<String> {
    let gated = format!(
        "--ipset={}",
        strip_verbatim(&lists.join("ipset-all.txt").to_string_lossy())
    );
    let auto = format!(
        "--hostlist-auto={}",
        strip_verbatim(&lists.join(AUTO_HOSTLIST_FILE).to_string_lossy())
    );

    let mut out = Vec::with_capacity(args.len());
    let mut section: Vec<String> = Vec::new();
    let flush = |section: &mut Vec<String>, out: &mut Vec<String>| {
        let any_protocol = section
            .iter()
            .any(|a| a.as_str() == "--dpi-desync-any-protocol=1");
        for arg in section.drain(..) {
            if !any_protocol && arg == gated {
                out.push(auto.clone());
                out.push(format!(
                    "--hostlist-auto-fail-threshold={AUTO_FAIL_THRESHOLD}"
                ));
                out.push(format!(
                    "--hostlist-auto-retrans-threshold={AUTO_RETRANS_THRESHOLD}"
                ));
            } else {
                out.push(arg);
            }
        }
    };
    for arg in args {
        if arg == "--new" {
            flush(&mut section, &mut out);
            out.push(arg);
        } else {
            section.push(arg);
        }
    }
    flush(&mut section, &mut out);
    out
}

// Autolist domains for the UI: newest first, duplicates and comments dropped.
// winws maintains the file (appends to the end); we only read and rewrite it.
fn auto_domains_from(txt: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in txt.lines().rev() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with("//") {
            continue;
        }
        if !out.iter().any(|d| d.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    }
    out
}

// Absolute path to a utility in System32. We rely neither on PATH nor on
// %SystemRoot%: DPI commands run in an elevated process, and the user can override both
// values without administrator rights (PATH hijack,
// HKCU\Environment). We ask Windows itself for the directory.
#[cfg(target_os = "windows")]
fn system32(exe: &str) -> String {
    crate::util::system_directory()
        .join(exe)
        .to_string_lossy()
        .into_owned()
}
// Whether the path lies INSIDE the directory, not merely starts with the same string.
//
// A bare string `starts_with` doesn't check the directory boundary: for the root
// `...\Ninety\dpi` it also matched `...\Ninety\dpi-backup\winws.exe`, so
// a foreign process from a neighboring directory went into `taskkill /F` — exactly what
// kill_stray_winws promises to protect against. The same barrier is in
// proxy_win::autostart_uses_highest_run_level.
//
// Both strings arrive already lowercased (Windows paths are
// case-insensitive). Slicing at `root.len()` is safe: a successful
// `starts_with` guarantees it is a character boundary.
#[cfg(target_os = "windows")]
fn path_is_inside(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches(['\\', '/']);
    !root.is_empty() && path.starts_with(root) && path[root.len()..].starts_with(['\\', '/'])
}

// Remove an ORPHANED winws.exe FROM ANOTHER Ninety INSTANCE. Returns true if at least
// one was killed. Called from dpi_start before spawning our own winws: at that point
// our child is no longer alive (dedup would have returned "already running"), so a live winws from
// our engine directory is an orphan of a second Ninety instance (elevation starts
// a SECOND process with its own DpiState; dedup only sees its own child). Without this, two
// winws fight over one WinDivert kernel driver and the engine fails with "driver busy".
//
// We filter by image path: we kill ONLY winws inside our res_dpi. The old
// `taskkill /IM winws.exe` killed ALL processes with that name — including a separate
// zapret/equivalent the user launched independently of Ninety.
#[cfg(target_os = "windows")]
fn kill_stray_winws(dpi_root: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Processes are enumerated directly: EnumProcesses + image path. The old
    // PowerShell with a CIM query took a second or two to start on every bypass
    // launch, and with a hung WMI it waited without any timeout.
    // res_dpi may arrive in verbatim form — strip it for the prefix comparison.
    let root = strip_verbatim(&dpi_root.to_string_lossy()).to_lowercase();
    let mut killed = false;
    for pid in crate::netproc::running_pids() {
        let Some(path) = crate::netproc::process_image_path(pid) else {
            continue;
        };
        let path = path.to_lowercase();
        let is_winws = Path::new(&path)
            .file_name()
            .is_some_and(|name| name == "winws.exe");
        // Not our engine directory → someone else's winws, leave it alone.
        if !is_winws || !path_is_inside(&path, &root) {
            continue;
        }
        let ok = std::process::Command::new(system32("taskkill.exe"))
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        killed |= ok;
    }
    killed
}
#[cfg(not(target_os = "windows"))]
fn kill_stray_winws(_dpi_root: &Path) -> bool {
    false
}

// ── Commands ─────────────────────────────────────────────────────────

/// Strategy list for the UI (JSON array). The same verified path as
/// for launching: the generation's signed bundle or the built-in set, after the allowlist.
/// The user's own strategies follow the built-in set, marked `custom: true`.
#[tauri::command]
pub fn dpi_strategies(app: AppHandle) -> Result<String, String> {
    let active = load_strategies(&app)?;
    let mut list = serde_json::to_value(&active.strategies)
        .map_err(|e| format!("serialize strategies: {e}"))?;
    let store = custom::load_store(&dpi_data_dir(&app)?);
    if let Some(items) = list.as_array_mut() {
        for item in &store.items {
            let value = serde_json::to_value(custom::list_item(item))
                .map_err(|e| format!("serialize custom strategy: {e}"))?;
            items.push(value);
        }
    }
    serde_json::to_string(&list).map_err(|e| format!("serialize strategies: {e}"))
}

/// How many domains are in the active lists (for the "Domain lists" card).
#[tauri::command]
pub fn dpi_domains_count(app: AppHandle) -> Result<usize, String> {
    let lists = ensure_lists(&app)?;
    let mut n = 0usize;
    for name in [
        "list-general.txt",
        "list-general-user.txt",
        "list-google.txt",
    ] {
        if let Ok(txt) = std::fs::read_to_string(lists.join(name)) {
            n += txt
                .lines()
                .filter(|l| {
                    let t = l.trim();
                    !t.is_empty() && !t.starts_with('#') && !t.starts_with("//")
                })
                .count();
        }
    }
    Ok(n)
}

/// Available `.bin` files for the two active UDP slots from Flowseal 1.10+.
/// We return only regular files from the writable bin-data; the frontend doesn't set paths.
#[tauri::command]
pub async fn dpi_fake_payloads(
    app: AppHandle,
    state: State<'_, DpiState>,
) -> Result<serde_json::Value, String> {
    let _data = state.data.lock().await;
    let active = load_strategies(&app)?;
    let dir = ensure_bindata(&app, &active)?;
    let options = fake_options(&dir)?;
    let selection = load_fake_selection(&app);
    let referenced = referenced_bins(&active.strategies);
    let discord_supported =
        referenced.contains(ACTIVE_DISCORD_FAKE) && dir.join(ACTIVE_DISCORD_FAKE).is_file();
    let game_supported =
        referenced.contains(ACTIVE_GAME_FAKE) && dir.join(ACTIVE_GAME_FAKE).is_file();
    let discord = current_fake_name(
        &dir,
        ACTIVE_DISCORD_FAKE,
        &options,
        selection.discord.as_deref(),
    );
    let game = current_fake_name(&dir, ACTIVE_GAME_FAKE, &options, selection.game.as_deref());
    Ok(serde_json::json!({
        "options": options,
        "discord": discord,
        "game": game,
        "discord_supported": discord_supported,
        "game_supported": game_supported,
    }))
}

/// Atomically replace ACTIVE_DISCORD_UDP.bin or ACTIVE_GAME_UDP.bin with the selected
/// file from the current signed set and keep the choice across future syncs.
#[tauri::command]
pub async fn dpi_set_active_fake(
    app: AppHandle,
    state: State<'_, DpiState>,
    kind: String,
    file: String,
) -> Result<serde_json::Value, String> {
    let _data = state.data.lock().await;
    let active = load_strategies(&app)?;
    let dir = ensure_bindata(&app, &active)?;
    let options = fake_options(&dir)?;
    if !options.contains(&file) {
        return Err("fake file is not in the current signed set".into());
    }
    let target = dir.join(fake_target(&kind)?);
    let previous = match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_file() && meta.len() <= MAX_DPI_PAYLOAD_BYTES => Some(
            std::fs::read(&target)
                .map_err(|e| format!("could not save the current UDP fake: {e}"))?,
        ),
        Ok(_) => return Err("current ACTIVE file is unsafe or too large".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("could not save the current UDP fake: {e}")),
    };
    apply_fake_file(&dir, &kind, &file)?;
    let mut selection = load_fake_selection(&app);
    match kind.as_str() {
        "discord" => selection.discord = Some(file.clone()),
        "game" => selection.game = Some(file.clone()),
        _ => return Err("unknown UDP fake type".into()),
    }
    if let Err(marker_error) = save_fake_selection(&app, &selection) {
        let rollback = match previous {
            Some(bytes) => write_bytes_replace(&target, &bytes, "rollback UDP fake"),
            None => match std::fs::remove_file(&target) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("remove rollback UDP fake: {e}")),
            },
        };
        return match rollback {
            Ok(()) => Err(marker_error),
            Err(rollback_error) => Err(format!(
                "{marker_error}; rolling back the ACTIVE file also failed: {rollback_error}"
            )),
        };
    }
    Ok(serde_json::json!({ "kind": kind, "file": file }))
}

const DPI_LOG_CAP_BYTES: u64 = 8 * 1024 * 1024;

struct DpiLogWriter {
    path: PathBuf,
    file: std::fs::File,
    written: u64,
}

impl DpiLogWriter {
    fn append(&mut self, bytes: &[u8]) {
        use std::io::Write;
        // Truncation goes through a separate handle: on Windows an append handle cannot
        // truncate the file (see util::truncate_log_file).
        if self.written.saturating_add(bytes.len() as u64) > DPI_LOG_CAP_BYTES
            && crate::util::truncate_log_file(&self.path)
        {
            let marker = b"[dpi log truncated at 8 MB cap]\n";
            let _ = self.file.write_all(marker);
            self.written = marker.len() as u64;
        }
        if self.file.write_all(bytes).is_ok() {
            self.written = self.written.saturating_add(bytes.len() as u64);
        }
    }
}

fn prepare_dpi_log(path: &Path) -> Option<Arc<Mutex<DpiLogWriter>>> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .truncate(false)
        .open(path)
        .ok()?;
    // New session — new diagnostic log. The old `set_len(0)` on
    // an append handle didn't work on Windows, and dpi.log accumulated all sessions.
    let _ = crate::util::truncate_log_file(path);
    Some(Arc::new(Mutex::new(DpiLogWriter {
        path: path.to_path_buf(),
        file,
        written: 0,
    })))
}

fn spawn_dpi_log_pipe<R: std::io::Read + Send + 'static>(
    mut reader: R,
    writer: Arc<Mutex<DpiLogWriter>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => writer.lock_recover().append(&buf[..n]),
            }
        }
    });
}

#[cfg(target_os = "windows")]
fn remember_owned_driver_services(state: &DpiState, bin: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let sc = system32("sc.exe");
    let owned_root = strip_verbatim(&bin.to_string_lossy()).to_lowercase();
    let mut owned = state.owned_services.lock_recover();
    for svc in ["WinDivert", "WinDivert14", "Monkey"] {
        let Ok(mut child) = std::process::Command::new(&sc)
            .args(["qc", svc])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        else {
            continue;
        };
        let deadline = Instant::now() + CHILD_STOP_TIMEOUT;
        let completed = loop {
            match child.try_wait() {
                Ok(Some(_)) => break true,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                _ => break false,
            }
        };
        if !completed {
            let _ = child.kill();
            continue;
        }
        let Ok(out) = child.wait_with_output() else {
            continue;
        };
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
        .replace(r"\??\", "")
        .to_lowercase();
        if out.status.success() && text.contains(&owned_root) && !owned.iter().any(|x| x == svc) {
            owned.push(svc.to_string());
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn remember_owned_driver_services(_state: &DpiState, _bin: &Path) {}

fn dpi_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::app_paths::data_dir(app)?.join("dpi"))
}

// Pre-substitution winws arguments of the strategy to launch. Each part has
// passed its own allowlist right here, whatever path brought the strategy:
// the channel one for built-ins, the custom one for the user's text.
struct LaunchArgs {
    args: Vec<String>,
    // Payload files a custom strategy names; checked against bin-data.
    bins: Vec<String>,
    // "Custom strategy «name» doesn't start:" token for launch errors.
    broken_prefix: String,
}

fn custom_broken_prefix(name: &str) -> String {
    let name = name.replace(['{', '}'], "");
    crate::util::i18n_error_with("backend.dpi.customBroken", &[("name", &name)])
}

fn launch_args(
    app: &AppHandle,
    active: &ActiveStrategies,
    strategy_id: &str,
) -> Result<LaunchArgs, String> {
    let not_found =
        || crate::util::i18n_error_with("backend.dpi.strategyNotFound", &[("id", strategy_id)]);
    if custom::is_custom_id(strategy_id) {
        let store = custom::load_store(&dpi_data_dir(app)?);
        let item = store
            .items
            .iter()
            .find(|item| item.id == strategy_id)
            .ok_or_else(not_found)?;
        let broken_prefix = custom_broken_prefix(&item.name);
        let report = custom::check_tokens(&item.args, &|_| true);
        if let Some(issue) = report.first_error() {
            return Err(format!("{broken_prefix} {}", issue.token()));
        }
        return Ok(LaunchArgs {
            args: report.args,
            bins: report.bins,
            broken_prefix,
        });
    }
    let strat = active
        .strategies
        .iter()
        .find(|s| s.id == strategy_id)
        .ok_or_else(not_found)?;
    validate_strategy_args(&strat.args)?;
    Ok(LaunchArgs {
        args: strat.args.clone(),
        bins: Vec::new(),
        broken_prefix: String::new(),
    })
}

fn game_filter_ports(game_filter: &str) -> (&'static str, &'static str) {
    match game_filter {
        "tcpudp" => ("1024-65535", "1024-65535"),
        _ => ("12", "12"), // off — a harmless single port (like Flowseal's default)
    }
}

// The winws argv for a strategy after every substitution the app owns: paths,
// the game ipset, the autolist gate and the VPN endpoint exclusion. The real
// launch and the custom-strategy dry run share it, so the engine checks exactly
// what would start.
fn assemble_argv(
    strategy_args: &[String],
    bindata: &Path,
    lists: &Path,
    game_filter: &str,
    ipset: &str,
    auto_debug_log: Option<&Path>,
) -> Vec<String> {
    let (g_tcp, g_udp) = game_filter_ports(game_filter);
    let bindata_s = strip_verbatim(&bindata.to_string_lossy());
    let lists_s = strip_verbatim(&lists.to_string_lossy());
    let args: Vec<String> = strategy_args
        .iter()
        .map(|a| subst(a, &bindata_s, &lists_s, g_tcp, g_udp))
        .collect();
    // The active VPN endpoint gets separate managed files: a node switch replaces
    // the value, doesn't accumulate old addresses and doesn't touch user exclusions.
    // Game sections come before distributing exclusions: we lift the ipset gate from them, otherwise
    // with IPset=Off/Loaded the game filter matches nothing (see ungate_game_ipset).
    let args = if game_filter == "tcpudp" {
        ungate_game_ipset(args, lists, g_tcp, g_udp)
    } else {
        args
    };
    // "Blocked only": the sections that are ungated by an empty ipset in "All sites"
    // are switched to the winws autolist — the bypass applies only to domains
    // that behaved as blocked.
    let args = if ipset == "auto" {
        let mut args = gate_by_autohostlist(args, lists);
        if let Some(log) = auto_debug_log {
            args.insert(
                0,
                format!(
                    "--hostlist-auto-debug={}",
                    strip_verbatim(&log.to_string_lossy())
                ),
            );
        }
        args
    } else {
        args
    };
    spread_exclusion_across_sections(args, &active_vpn_exclusion_args(lists))
}

// Whether a payload named by a custom strategy is available to winws: the
// active bin-data or, without a channel set, the bundled payloads that
// dpi_start copies into bin-data before every launch.
fn custom_bin_lookup(
    app: &AppHandle,
    active: &ActiveStrategies,
) -> Result<impl Fn(&str) -> bool, String> {
    let bindata = bindata_dir(app)?;
    let bundled = match active.channel {
        Some(_) => None,
        None => Some(bin_dir(app, false)?),
    };
    Ok(move |name: &str| {
        bindata.join(name).is_file() || bundled.as_ref().is_some_and(|dir| dir.join(name).is_file())
    })
}

fn custom_issue(code: &str, arg: &str) -> String {
    crate::util::i18n_error_with(&format!("dpi.custom.issue.{code}"), &[("arg", arg)])
}

/// Live check of a custom strategy for the editor: issues per section, the
/// canonical sections and the final winws arguments. Accepts winws options, a
/// line from a zapret .bat file or JSON in the built-in strategy format.
#[tauri::command]
pub async fn dpi_custom_check(app: AppHandle, text: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let active = load_strategies(&app)?;
        let bin_exists = custom_bin_lookup(&app, &active)?;
        let report = custom::check_text(&text, &bin_exists);
        serde_json::to_value(&report).map_err(|e| format!("serialize check: {e}"))
    })
    .await
    .map_err(|e| format!("custom strategy check failed: {e}"))?
}

const DRY_RUN_TIMEOUT: Duration = Duration::from_secs(6);
const DRY_RUN_OUTPUT_TAIL: usize = 1500;
#[cfg(target_os = "windows")]
const ERROR_ELEVATION_REQUIRED: i32 = 740;

#[derive(Serialize)]
struct DryRunResult {
    // "ok" | "failed" | "needsAdmin" | "timeout" | "unavailable"
    status: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    output: String,
    warnings: Vec<String>,
}

impl DryRunResult {
    fn status(status: &'static str) -> Self {
        Self {
            status,
            output: String::new(),
            warnings: Vec::new(),
        }
    }
}

// A running winws refuses a second copy with the same WinDivert filter, even in
// --dry-run. One extra port makes the filter differ without touching what the
// check is about.
fn dry_run_argv(mut argv: Vec<String>) -> Vec<String> {
    match argv.iter_mut().find(|arg| arg.starts_with("--wf-tcp=")) {
        Some(arg) => arg.push_str(",1"),
        None => argv.insert(0, "--wf-tcp=1".to_string()),
    }
    argv.insert(0, "--dry-run".to_string());
    argv
}

fn tail_chars(text: &str, limit: usize) -> String {
    let chars: Vec<char> = text.trim().chars().collect();
    if chars.len() > limit {
        chars[chars.len() - limit..].iter().collect()
    } else {
        chars.into_iter().collect()
    }
}

#[cfg(target_os = "windows")]
fn run_dry_run(exe: &Path, bin: &Path, argv: &[String]) -> DryRunResult {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    let spawned = std::process::Command::new(exe)
        .args(argv)
        .current_dir(bin)
        .creation_flags(0x0800_0000)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        // winws.exe asks for administrator rights in its manifest.
        Err(e) if e.raw_os_error() == Some(ERROR_ELEVATION_REQUIRED) => {
            return DryRunResult::status("needsAdmin")
        }
        Err(e) => {
            return DryRunResult {
                status: "failed",
                output: format!("spawn winws: {e}"),
                warnings: Vec::new(),
            }
        }
    };
    crate::job_guard::bind_pid(child.id());
    // Both pipes are drained while waiting: a chatty winws must not block on a
    // full pipe and look like a hang.
    let read_pipe = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut out);
            }
            out
        })
    };
    let stdout = read_pipe(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = read_pipe(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let started = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() < DRY_RUN_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = terminate_child_bounded(&mut child, "winws --dry-run");
                return DryRunResult::status("timeout");
            }
        }
    };
    let mut output = String::from_utf8_lossy(&stdout.join().unwrap_or_default()).into_owned();
    output.push_str(&String::from_utf8_lossy(&stderr.join().unwrap_or_default()));
    let warnings = output
        .lines()
        .map(str::trim)
        .filter(|line| line.to_ascii_lowercase().contains("warning"))
        .map(|line| tail_chars(line, 300))
        .take(8)
        .collect();
    DryRunResult {
        status: if code == Some(0) { "ok" } else { "failed" },
        output: tail_chars(&output, DRY_RUN_OUTPUT_TAIL),
        warnings,
    }
}

#[cfg(not(target_os = "windows"))]
fn run_dry_run(_exe: &Path, _bin: &Path, _argv: &[String]) -> DryRunResult {
    DryRunResult::status("unavailable")
}

/// Ask winws itself whether it accepts a custom strategy: `--dry-run` with the
/// argv the launch would build for the current game filter and bypass scope.
#[tauri::command]
pub async fn dpi_custom_verify(
    app: AppHandle,
    state: State<'_, DpiState>,
    text: String,
    game_filter: String,
    ipset: String,
) -> Result<serde_json::Value, String> {
    let (exe, bin, argv) = {
        let _data = state.data.lock().await;
        let active = load_strategies(&app)?;
        let bin_exists = custom_bin_lookup(&app, &active)?;
        let report = custom::check_text(&text, &bin_exists);
        if let Some(issue) = report.first_error() {
            return Err(issue.token());
        }
        let bin = bin_dir(&app, false)?;
        let exe = bin.join("winws.exe");
        if !exe.exists() {
            return Err(crate::util::i18n_error_with(
                "backend.dpi.winwsMissing",
                &[("path", &exe.display().to_string())],
            ));
        }
        // The same files the launch uses; writing the scope file again with the
        // current mode leaves a running engine's view unchanged.
        let lists = ensure_lists(&app)?;
        write_ipset_mode(&app, &lists, &ipset)?;
        let bindata = ensure_bindata(&app, &active)?;
        let argv = assemble_argv(&report.args, &bindata, &lists, &game_filter, &ipset, None);
        (exe, bin, dry_run_argv(argv))
    };
    let result = tauri::async_runtime::spawn_blocking(move || run_dry_run(&exe, &bin, &argv))
        .await
        .map_err(|e| format!("winws dry run did not finish: {e}"))?;
    serde_json::to_value(&result).map_err(|e| format!("serialize dry run: {e}"))
}

/// Create (id = None) or update a custom strategy. The text must pass the same
/// check the launch does; at most MAX_CUSTOM_STRATEGIES are kept.
#[allow(clippy::too_many_arguments)] // Tauri IPC: named fields form the wire contract.
#[tauri::command]
pub async fn dpi_custom_save(
    app: AppHandle,
    state: State<'_, DpiState>,
    id: Option<String>,
    name: String,
    desc: Option<String>,
    experimental: Option<bool>,
    base: Option<String>,
    text: String,
) -> Result<serde_json::Value, String> {
    let _data = state.data.lock().await;
    let active = load_strategies(&app)?;
    let name = custom::normalize_name(&name).map_err(|code| custom_issue(code, ""))?;
    let desc = custom::normalize_desc(desc.as_deref().unwrap_or_default())
        .map_err(|code| custom_issue(code, ""))?;
    // The base only labels unchanged sections in the editor; an unknown id is dropped.
    let base = base
        .map(|b| b.trim().to_string())
        .filter(|b| active.strategies.iter().any(|s| s.id == *b));
    let bin_exists = custom_bin_lookup(&app, &active)?;
    let report = custom::check_text(&text, &bin_exists);
    if let Some(issue) = report.first_error() {
        return Err(issue.token());
    }
    let args = report.stored_args();

    let dpi_data = dpi_data_dir(&app)?;
    let mut store = custom::load_store(&dpi_data);
    // The UI keeps the selection by name, so a name may not shadow another strategy.
    let taken = active
        .strategies
        .iter()
        .any(|s| s.name.eq_ignore_ascii_case(&name) || s.id.eq_ignore_ascii_case(&name))
        || store
            .items
            .iter()
            .any(|s| Some(s.id.as_str()) != id.as_deref() && s.name.eq_ignore_ascii_case(&name));
    if taken {
        return Err(custom_issue("nameTaken", ""));
    }
    let item = custom::CustomStrategy {
        id: String::new(),
        name,
        desc,
        experimental: experimental.unwrap_or(false),
        base,
        args,
    };
    let saved_id = match id {
        Some(id) => {
            let slot = store
                .items
                .iter_mut()
                .find(|existing| existing.id == id)
                .ok_or_else(|| custom_issue("notFound", ""))?;
            *slot = custom::CustomStrategy {
                id: id.clone(),
                ..item
            };
            id
        }
        None => {
            if store.items.len() >= custom::MAX_CUSTOM_STRATEGIES {
                return Err(custom_issue(
                    "limit",
                    &custom::MAX_CUSTOM_STRATEGIES.to_string(),
                ));
            }
            let id = custom::new_id(&store.items);
            store.items.push(custom::CustomStrategy {
                id: id.clone(),
                ..item
            });
            id
        }
    };
    custom::save_store(&dpi_data, &store.items)?;
    let saved = store
        .items
        .iter()
        .find(|existing| existing.id == saved_id)
        .ok_or_else(|| custom_issue("notFound", ""))?;
    serde_json::to_value(custom::list_item(saved))
        .map_err(|e| format!("serialize custom strategy: {e}"))
}

#[tauri::command]
pub async fn dpi_custom_delete(
    app: AppHandle,
    state: State<'_, DpiState>,
    id: String,
) -> Result<(), String> {
    let _data = state.data.lock().await;
    let dpi_data = dpi_data_dir(&app)?;
    let mut store = custom::load_store(&dpi_data);
    let before = store.items.len();
    store.items.retain(|item| item.id != id);
    if store.items.len() == before {
        return Err(custom_issue("notFound", ""));
    }
    custom::save_store(&dpi_data, &store.items)
}

// A strategy file is small: 9 sections of a Flowseal profile take a few KB.
const MAX_STRATEGY_FILE_BYTES: u64 = 512 * 1024;

fn strategy_file_dialog(app: &AppHandle) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .add_filter("zapret .bat / .txt", &["bat", "cmd", "txt"]);
    if let Some(window) = app.get_webview_window("main") {
        builder = builder.set_parent(&window);
    }
    builder
}

fn read_strategy_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("open strategy file: {e}"))?;
    let mut body = Vec::new();
    file.take(MAX_STRATEGY_FILE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|e| format!("read strategy file: {e}"))?;
    if body.len() as u64 > MAX_STRATEGY_FILE_BYTES {
        return Err(custom_issue("tooLong", ""));
    }
    // .bat files from Windows are often in the OEM code page; their options are ASCII anyway.
    let text = String::from_utf8_lossy(&body);
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

/// Pick a strategy file (JSON in the built-in format, or a zapret .bat) in the
/// system dialog and return its text for the editor. `None` — the dialog was closed.
#[tauri::command]
pub async fn dpi_custom_import_file(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(picked) = strategy_file_dialog(&app).blocking_pick_file() else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|e| format!("strategy path: {e}"))?;
        read_strategy_file(&path).map(Some)
    })
    .await
    .map_err(|e| format!("strategy import did not finish: {e}"))?
}

// A file name derived from the strategy name, safe on Windows.
fn strategy_file_name(name: &str) -> String {
    let stem: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let stem = stem.trim_matches('-');
    if stem.is_empty() {
        "ninety-strategy.json".to_string()
    } else {
        format!("ninety-{stem}.json")
    }
}

/// Save a strategy as JSON in the built-in format to a file the user picks.
/// `false` — the dialog was closed.
#[tauri::command]
pub async fn dpi_custom_export_file(
    app: AppHandle,
    json: String,
    name: String,
) -> Result<bool, String> {
    if json.len() as u64 > MAX_STRATEGY_FILE_BYTES {
        return Err(custom_issue("tooLong", ""));
    }
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| custom_issue("json", &e.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = strategy_file_dialog(&app).set_file_name(strategy_file_name(&name));
        let Some(picked) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let path = picked
            .into_path()
            .map_err(|e| format!("strategy path: {e}"))?;
        write_replace(&path, &json, "strategy file")?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("strategy export did not finish: {e}"))?
}

/// Starts winws with the selected strategy. game_filter: "off"|"tcpudp";
/// ipset — the bypass scope: "any" (all domains) | "auto" (only those
/// that winws itself detected as blocked) | "loaded" (IPs from ipset-all) |
/// "off" (only domains from the lists). Must be called from an elevated process.
/// Returns the session id (generation): the dpi:exited event is tagged with it if
/// this winws later crashes on its own.
#[tauri::command]
pub async fn dpi_start(
    app: AppHandle,
    state: State<'_, DpiState>,
    strategy_id: String,
    game_filter: String,
    ipset: String,
    monkey: bool,
    logs_disabled: Option<bool>,
) -> Result<u64, String> {
    let logs_disabled = logs_disabled.unwrap_or(false);
    let generation = begin_dpi_operation(&state, "start")?;
    let _operation = DpiOperationGuard {
        state: &state,
        generation,
    };
    // Already running? Clean up the corpse / refuse.
    {
        let mut guard = state.child.lock_recover();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    // dead — restart it; we no longer report on the previous session
                    *guard = None;
                    state.runtime_session.store(0, Ordering::SeqCst);
                }
                Ok(None) => return Err(crate::util::i18n_error("backend.dpi.alreadyRunning")),
                Err(_) => return Err(crate::util::i18n_error("backend.dpi.alreadyRunning")),
            }
        }
    }

    // The lock serializes DPI set mutations, and a long sync_channel may be
    // holding it. We wait for it cancellably: otherwise a stop arriving at that moment
    // would get stuck behind a start that hasn't even begun checking for cancellation.
    let _data = tokio::select! {
        guard = state.data.lock() => guard,
        _ = wait_dpi_cancelled(&state, generation) => return Err(crate::util::i18n_error("backend.dpi.cancelled")),
    };
    let active = load_strategies(&app)?;
    let launch = launch_args(&app, &active, &strategy_id)?;

    let bin = bin_dir(&app, monkey)?;
    let exe = bin.join("winws.exe");
    if !exe.exists() {
        return Err(crate::util::i18n_error_with(
            "backend.dpi.winwsMissing",
            &[("path", &exe.display().to_string())],
        ));
    }
    let lists = ensure_lists(&app)?;
    write_ipset_mode(&app, &lists, &ipset)?;

    // %BIN% → writable bin-data (the channel overlay), NOT the engine: cwd below stays
    // on the read-only resource (winws.exe + WinDivert.dll are loaded from there).
    let bindata = ensure_bindata(&app, &active)?;
    // A payload missing from the set would make winws exit with "could not read":
    // name the file instead of showing the engine's raw output.
    if let Some(missing) = launch
        .bins
        .iter()
        .find(|name| !bindata.join(name).is_file())
    {
        return Err(format!(
            "{} {}",
            launch.broken_prefix,
            crate::util::i18n_error_with("dpi.custom.issue.binMissing", &[("arg", missing)])
        ));
    }
    let auto_debug_log = if ipset == "auto" && !logs_disabled {
        auto_hostlist_log_file(&app).inspect(|log| trim_auto_hostlist_log(log))
    } else {
        None
    };
    let args = assemble_argv(
        &launch.args,
        &bindata,
        &lists,
        &game_filter,
        &ipset,
        auto_debug_log.as_deref(),
    );

    if !dpi_operation_current(&state, generation) {
        return Err(crate::util::i18n_error("backend.dpi.cancelled"));
    }

    // Protection against a "double start": kill a stray winws (an orphan of another Ninety
    // instance — by its path in our res_dpi) before launching our own, otherwise two winws
    // fight over the WinDivert driver. If someone was killed, give the driver time to detach
    // from the dead handle before our start.
    let dpi_root = res_dpi(&app)?;
    let killed_stray = tauri::async_runtime::spawn_blocking(move || kill_stray_winws(&dpi_root))
        .await
        .unwrap_or(false);
    if killed_stray {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&args).current_dir(&bin); // cwd = bin → WinDivert.dll is loaded from next door
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // Redirect winws stdout+stderr into the capped dpi.log — without this the cause
    // of an instant exit (bad argument / .bin not found / WinDivert) is lost.
    // With logs_disabled ("Disable logs completely") we don't create the file — winws output
    // goes nowhere (CREATE_NO_WINDOW → no console); crash diagnostics won't be
    // kept then, the user disabled logs themselves.
    let log = if logs_disabled {
        None
    } else {
        dpi_log_file(&app)
    };
    let log_writer = log.as_ref().and_then(|lp| prepare_dpi_log(lp));
    if log_writer.is_some() {
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn winws: {e}"))?;
    crate::vpn::prioritize_datapath_process(child.id());
    // An orphaned winws fights over the WinDivert driver with the next launch (see
    // kill_stray_winws); the job removes it before it gets a chance to outlive us.
    crate::job_guard::bind_pid(child.id());
    if let Some(writer) = log_writer {
        if let Some(stdout) = child.stdout.take() {
            spawn_dpi_log_pipe(stdout, writer.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_dpi_log_pipe(stderr, writer);
        }
    }
    // stop may have arrived between the last check and spawn. We check the generation
    // under the control lock and only then publish the child in the shared state.
    {
        let control = state.control.lock_recover();
        if control.generation != generation || control.operation.is_none() {
            drop(control);
            let _ = terminate_child_bounded(&mut child, "winws");
            return Err(crate::util::i18n_error("backend.dpi.cancelled"));
        }
        let mut published = state.child.lock_recover();
        *published = Some(child);
        state.runtime_session.store(generation, Ordering::SeqCst);
    }
    // winws brought up the WinDivert driver — the service will need to be removed on exit.
    state.driver_loaded.store(true, Ordering::SeqCst);

    // Give winws ~700 ms to crash (busy driver / no rights / bad args).
    dpi_sleep_or_cancel(&state, generation, Duration::from_millis(700)).await?;
    remember_owned_driver_services(&state, &bin);
    // Take it before the child lock: the control lock is acquired before child (as when
    // publishing the handle), the reverse order is not allowed.
    let still_current = dpi_operation_current(&state, generation);
    {
        let mut guard = state.child.lock_recover();
        let Some(child) = guard.as_mut() else {
            // The handle was taken by a stop that arrived after the sleep, or by dpi_running,
            // which stumbled on the corpse. In both cases winws isn't running, and
            // this is not a success.
            if !still_current {
                return Err(crate::util::i18n_error("backend.dpi.cancelled"));
            }
            return Err(crate::util::i18n_error_with(
                "backend.dpi.exitedAdmin",
                &[("code", "?")],
            ));
        };
        {
            if let Ok(Some(status)) = child.try_wait() {
                *guard = None;
                state.runtime_session.store(0, Ordering::SeqCst);
                let code = status
                    .code()
                    .map_or_else(|| "?".to_string(), |code| code.to_string());
                let tail = log
                    .as_ref()
                    .and_then(|p| std::fs::read(p).ok())
                    .map(|b| String::from_utf8_lossy(&b).trim().to_string())
                    .filter(|s| !s.is_empty())
                    .map(|s| {
                        let chars: Vec<char> = s.chars().collect();
                        let t: String = if chars.len() > 700 {
                            chars[chars.len() - 700..].iter().collect()
                        } else {
                            s.clone()
                        };
                        crate::util::i18n_error_with(
                            "backend.dpi.exitedOutput",
                            &[("code", &code), ("output", &t)],
                        )
                    })
                    .unwrap_or_else(|| {
                        crate::util::i18n_error_with("backend.dpi.exitedAdmin", &[("code", &code)])
                    });
                return Err(tail);
            }
        }
    }
    // Survived the startup window — from here on the exit watcher keeps an eye on it.
    spawn_dpi_exit_watcher(app, generation);
    Ok(generation)
}

// Stopping winws is confirmed physically: kill + try_wait up to 2 s, waiting for
// the cancellable operation up to 2 s and a final repeated stop. A synchronous command
// would hold all of this on the main thread — with a hung winws the window stopped
// responding for several seconds. The wait goes to the blocking pool; the IPC contract
// doesn't change (the command has no arguments).
#[tauri::command]
pub async fn dpi_stop(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DpiState>();
        stop_dpi_runtime(&state, "winws")
    })
    .await
    .map_err(|e| format!("waiting for winws to stop failed: {e}"))?
}

#[tauri::command]
pub fn dpi_running(app: AppHandle, state: State<'_, DpiState>) -> bool {
    // A single poll under a single lock: previously the process could die between two
    // try_wait calls, and the second one forgot the handle without an event and without resetting the session —
    // the interface stayed "Running", and the watcher polled an empty slot forever.
    // The corpse of a regular session is the same crash the watcher catches: report it.
    let event = {
        let mut guard = state.child.lock_recover();
        let Some(child) = guard.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => return true,
            // State unknown — keep the handle, the stop will still take it.
            Err(_) => return false,
            Ok(Some(status)) => {
                *guard = None;
                let session = state.runtime_session.swap(0, Ordering::SeqCst);
                (session != 0).then(|| dpi_exited_event(session, status.code()))
            }
        }
    };
    if let Some(event) = event {
        let _ = app.emit(DPI_EXITED_EVENT, event);
    }
    false
}

// ── Excluding VPN nodes from winws ─────────────────────────────────────
// Batch limits: winws reads the exclusion files, and resolving is a network wait
// before the bypass starts, so both are bounded.
const MAX_ENDPOINT_IPS: usize = 1024;
const MAX_ENDPOINT_DOMAINS: usize = 512;
const MAX_ENDPOINT_RESOLVE: usize = 64;
const ENDPOINT_RESOLVE_PARALLEL: usize = 8;
const ENDPOINT_RESOLVE_BUDGET: Duration = Duration::from_secs(2);

#[derive(Debug, Default, PartialEq)]
struct EndpointBatch {
    // CIDR in ipset format: /32 and /128 for single addresses.
    ips: Vec<String>,
    domains: Vec<String>,
}

fn valid_port_text(port: &str) -> bool {
    (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit())
}

// Host without port: "[v6]:443" → "v6", "host:443" → "host". Bare IPv6
// (more than one colon) stays as is. None — the address is malformed.
fn endpoint_host(raw: &str) -> Option<&str> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(rest) = value.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port_ok = tail.is_empty() || tail.strip_prefix(':').is_some_and(valid_port_text);
        return (port_ok && !host.is_empty()).then_some(host);
    }
    match value.split_once(':') {
        Some((host, port)) if !port.contains(':') => {
            (!host.is_empty() && valid_port_text(port)).then_some(host)
        }
        _ => Some(value),
    }
}

// Address in canonical form: otherwise 2001:0db8::1 and 2001:db8::1 would end up
// as duplicates.
fn canonical_ip_entry(host: &str) -> Option<String> {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(addr)) => Some(format!("{addr}/32")),
        Ok(IpAddr::V6(addr)) => Some(format!("{addr}/128")),
        Err(_) if host.contains('/') => normalize_ipset_entry(host).ok(),
        Err(_) => None,
    }
}

fn push_unique(list: &mut Vec<String>, value: String, cap: usize) {
    if list.len() < cap && !list.contains(&value) {
        list.push(value);
    }
}

// Parse a batch of node addresses. Classification is by content, not by
// which list the line came in: a TrustTunnel address "ip:port" in domains is still
// an IP. A malformed line is dropped on its own and doesn't break the whole
// batch — otherwise the files would keep the exclusion of previous nodes.
fn endpoint_batch(ips: &[String], domains: &[String]) -> EndpointBatch {
    let mut batch = EndpointBatch::default();
    for raw in ips.iter().chain(domains) {
        let Some(host) = endpoint_host(raw) else {
            continue;
        };
        if let Some(entry) = canonical_ip_entry(host) {
            push_unique(&mut batch.ips, entry, MAX_ENDPOINT_IPS);
        } else if let Ok(domain) = normalize_exclude_domain(host.trim_end_matches('.')) {
            push_unique(&mut batch.domains, domain, MAX_ENDPOINT_DOMAINS);
        }
    }
    batch
}

fn render_list_lines(values: &[String]) -> String {
    if values.is_empty() {
        return String::new();
    }
    let mut out = values.join("\n");
    out.push('\n');
    out
}

fn resolvable_endpoint_domain(domain: &str) -> bool {
    !domain.contains('*') && domain.bytes().any(|b| b.is_ascii_alphabetic())
}

// Node domain addresses in ipset format. At most ENDPOINT_RESOLVE_PARALLEL
// simultaneous lookups and one shared budget for the whole batch: whatever doesn't make it
// is skipped, the rest is used.
async fn resolve_endpoint_domains(domains: &[String], budget: Duration) -> Vec<String> {
    use futures_util::StreamExt;
    let deadline = tokio::time::Instant::now() + budget;
    let targets: Vec<String> = domains
        .iter()
        .filter(|domain| resolvable_endpoint_domain(domain))
        .take(MAX_ENDPOINT_RESOLVE)
        .map(|domain| format!("{domain}:443"))
        .collect();
    let lookups = futures_util::stream::iter(targets)
        .map(move |target| async move {
            match tokio::time::timeout_at(deadline, tokio::net::lookup_host(target)).await {
                Ok(Ok(addrs)) => addrs.map(|addr| addr.ip()).collect::<Vec<IpAddr>>(),
                _ => Vec::new(),
            }
        })
        .buffer_unordered(ENDPOINT_RESOLVE_PARALLEL);
    let mut lookups = std::pin::pin!(lookups);
    let mut out = Vec::new();
    while let Ok(Some(addrs)) = tokio::time::timeout_at(deadline, lookups.next()).await {
        for addr in addrs {
            if let Some(entry) = canonical_ip_entry(&addr.to_string()) {
                push_unique(&mut out, entry, MAX_ENDPOINT_IPS);
            }
        }
    }
    out
}

/// Atomically replace the VPN node exclusion with one batch. This is session-managed
/// state, not a user list: a new batch replaces the previous one entirely and
/// doesn't touch the user's edits in *-user.txt.
///
/// The node's domain doesn't appear on the wire: VLESS Reality/XHTTP carries a decoy
/// SNI, so only the IP exclusion really protects. resolve=true —
/// we resolve domains ourselves (the frontend asks for this only when winws is running or
/// about to start): DNS is awaited outside the data lock, and the files are written as one batch
/// under the lock. The response of a request that was overtaken by a newer one is discarded.
/// Returns false for such an outdated request.
#[tauri::command]
pub async fn dpi_set_active_vpn_endpoint(
    app: AppHandle,
    state: State<'_, DpiState>,
    ips: Option<Vec<String>>,
    domains: Option<Vec<String>>,
    resolve: Option<bool>,
) -> Result<bool, String> {
    let ticket = state
        .endpoint_seq
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    let mut batch = endpoint_batch(
        ips.as_deref().unwrap_or_default(),
        domains.as_deref().unwrap_or_default(),
    );
    if resolve.unwrap_or(false) && !batch.domains.is_empty() {
        // Best-effort: DNS may already be broken by TSPU, and a resolve failure must not
        // break the connection — the literals stay.
        for entry in resolve_endpoint_domains(&batch.domains, ENDPOINT_RESOLVE_BUDGET).await {
            push_unique(&mut batch.ips, entry, MAX_ENDPOINT_IPS);
        }
    }
    let _data = state.data.lock().await;
    if state.endpoint_seq.load(Ordering::SeqCst) != ticket {
        return Ok(false);
    }
    let lists = ensure_lists(&app)?;
    write_replace(
        &lists.join("active-vpn-domain.txt"),
        &render_list_lines(&batch.domains),
        "active VPN domains",
    )?;
    write_replace(
        &lists.join("active-vpn-ip.txt"),
        &render_list_lines(&batch.ips),
        "active VPN IPs",
    )?;
    Ok(true)
}

// User list name by kind: "exclude" → exclusions, otherwise → user bypass
// domains. We edit ONLY *-user.txt (the base Flowseal lists are left alone —
// the silent updater overwrites them).
fn user_list_name(kind: &str) -> &'static str {
    match kind {
        "exclude" => "list-exclude-user.txt",
        _ => "list-general-user.txt",
    }
}

// A missing file is an empty list, but a read error is not: the file may be locked or
// not in UTF-8, and treating it as empty would lead to overwriting the real contents.
fn read_list_text(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

// Exclusions accept domains and IP addresses or subnets alike, but winws reads
// addresses only from an ipset: in list-exclude-user.txt an IP matched nothing
// and the exclusion silently did nothing. Addresses live in this file instead.
const USER_IPSET_EXCLUDE: &str = "ipset-exclude-user.txt";

fn list_entries(text: &str) -> impl Iterator<Item = &str> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("//"))
}

// Split list text into the domain part (comments kept) and IP/CIDR entries.
fn split_domains_and_ips(text: &str) -> (String, Vec<String>) {
    let mut domains = String::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut ips = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with('#') || t.starts_with("//") {
            domains.push_str(t);
            domains.push('\n');
            continue;
        }
        if let Ok(entry) = normalize_ipset_entry(t) {
            if !ips.contains(&entry) {
                ips.push(entry);
            }
            continue;
        }
        if seen.insert(t.to_string()) {
            domains.push_str(t);
            domains.push('\n');
        }
    }
    (domains, ips)
}

// Move addresses typed into the domain exclusions before this fix into the ipset,
// so an exclusion that never worked starts working without reopening the editor.
fn migrate_exclude_ips(lists: &Path) -> Result<(), String> {
    let domain_path = lists.join("list-exclude-user.txt");
    let text = read_list_text(&domain_path)?;
    if !list_entries(&text).any(|entry| normalize_ipset_entry(entry).is_ok()) {
        return Ok(());
    }
    let (domains, moved) = split_domains_and_ips(&text);
    let ipset_path = lists.join(USER_IPSET_EXCLUDE);
    let mut ips: Vec<String> = list_entries(&read_list_text(&ipset_path)?)
        .map(str::to_string)
        .collect();
    for entry in moved {
        if !ips.contains(&entry) {
            ips.push(entry);
        }
    }
    write_replace(&ipset_path, &render_list_lines(&ips), "migrate exclude ips")?;
    write_replace(&domain_path, &domains, "migrate exclude domains")
}

/// Read a user list for the editor in the UI. kind: "user" (bypass domains) |
/// "exclude" (exclusions: domains, then IP addresses and subnets).
#[tauri::command]
pub fn dpi_read_list(app: AppHandle, kind: String) -> Result<String, String> {
    let lists = ensure_lists(&app)?;
    let mut text = read_list_text(&lists.join(user_list_name(&kind)))?;
    if kind == "exclude" {
        let ips = read_list_text(&lists.join(USER_IPSET_EXCLUDE))?;
        for entry in list_entries(&ips) {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(entry);
            text.push('\n');
        }
    }
    Ok(text)
}

/// Save a user list from the editor. Trims every line, drops empty lines and
/// duplicates, keeps # and // comments. In the exclusions IP addresses and
/// subnets go to the ipset; in "My domains" they are kept but reported, since a
/// hostlist matches only domains. Returns the domain count and both IP counts.
#[tauri::command]
pub async fn dpi_write_list(
    app: AppHandle,
    state: State<'_, DpiState>,
    kind: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let _data = state.data.lock().await;
    let lists = ensure_lists(&app)?;
    let name = user_list_name(&kind);
    let (domains, ips) = split_domains_and_ips(&content);
    let (body, moved, ignored) = if kind == "exclude" {
        write_replace(
            &lists.join(USER_IPSET_EXCLUDE),
            &render_list_lines(&ips),
            "write user ipset exclusions",
        )?;
        (domains, ips.len(), 0)
    } else {
        // The hostlist keeps the addresses the user typed, they are only reported.
        let mut body = domains;
        for entry in &ips {
            body.push_str(entry);
            body.push('\n');
        }
        (body, 0, ips.len())
    };
    write_replace(&lists.join(name), &body, &format!("write {name}"))?;
    let count = list_entries(&body)
        .filter(|entry| normalize_ipset_entry(entry).is_err())
        .count();
    Ok(serde_json::json!({ "count": count, "movedIps": moved, "ignoredIps": ignored }))
}

// A domain that goes into the winws hostlist. The IP branch is normalized separately
// (normalize_ipset_entry), while a domain used to be written as is after trim: a value
// with a line break inserted an arbitrary number of entries into the list, and dedup by
// whole line never worked on it — the file grew on every call.
fn normalize_exclude_domain(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 253 {
        return Err(crate::util::i18n_error("backend.dpi.badDomain"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '*'))
    {
        return Err(crate::util::i18n_error("backend.dpi.badDomain"));
    }
    Ok(value.to_ascii_lowercase())
}

fn normalize_ipset_entry(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if let Some((ip, prefix)) = value.split_once('/') {
        if ip.contains('/') || prefix.contains('/') {
            return Err(format!("invalid cidr: {value}"));
        }
        let addr = ip
            .parse::<IpAddr>()
            .map_err(|_| format!("invalid cidr ip: {value}"))?;
        let prefix = prefix
            .parse::<u8>()
            .map_err(|_| format!("invalid cidr prefix: {value}"))?;
        let max = match addr {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        if prefix > max {
            return Err(format!("invalid cidr prefix: {value}"));
        }
        return Ok(format!("{ip}/{prefix}"));
    }
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(_)) => Ok(format!("{value}/32")),
        Ok(IpAddr::V6(_)) => Ok(format!("{value}/128")),
        Err(_) => Err(format!("invalid ip: {value}")),
    }
}

// ── Versions / list updates ─────────────────────────────────────
// Strategy set version — the version of exactly the set the strategies are currently taken from
// (the generation's signed bundle or the built-in one). The legacy marker
// strategies-version.txt described the now-ignored overlay and is not read.
fn strat_version(app: &AppHandle) -> Result<String, String> {
    Ok(load_strategies(app)?.version)
}

// Channel version — a Flowseal tag like 1.10.2; there are letter suffixes on a
// component (1.6.3b), pre-releases via "-" and build metadata via "+".
type ParsedChannelVersion = (Vec<(u64, String)>, Option<String>);

fn parse_channel_version(raw: &str) -> Option<ParsedChannelVersion> {
    let value = raw.trim();
    let value = value.strip_prefix(['v', 'V']).unwrap_or(value);
    let value = value.split('+').next().unwrap_or(value);
    let (core, pre) = match value.split_once('-') {
        Some((core, pre)) if !pre.is_empty() => (core, Some(pre.to_ascii_lowercase())),
        Some(_) => return None,
        None => (value, None),
    };
    if core.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for part in core.split('.') {
        let digits = part.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || digits > 18 {
            return None;
        }
        let suffix = &part[digits..];
        if !suffix.bytes().all(|b| b.is_ascii_alphabetic()) {
            return None;
        }
        parts.push((part[..digits].parse().ok()?, suffix.to_ascii_lowercase()));
    }
    Some((parts, pre))
}

fn compare_prerelease(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering as CmpOrdering;
    let mut left_ids = left.split('.');
    let mut right_ids = right.split('.');
    loop {
        match (left_ids.next(), right_ids.next()) {
            (None, None) => return CmpOrdering::Equal,
            (None, Some(_)) => return CmpOrdering::Less,
            (Some(_), None) => return CmpOrdering::Greater,
            (Some(a), Some(b)) => {
                let order = match (a.parse::<u64>(), b.parse::<u64>()) {
                    (Ok(a), Ok(b)) => a.cmp(&b),
                    (Ok(_), Err(_)) => CmpOrdering::Less,
                    (Err(_), Ok(_)) => CmpOrdering::Greater,
                    (Err(_), Err(_)) => a.cmp(b),
                };
                if order != CmpOrdering::Equal {
                    return order;
                }
            }
        }
    }
}

// Compare channel versions as numeric tuples (1.10 > 1.9, 1.10 == 1.10.0,
// 1.6.3b > 1.6.3, 1.0.0-rc1 < 1.0.0). None — at least one doesn't parse.
fn compare_channel_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering as CmpOrdering;
    let (left_core, left_pre) = parse_channel_version(left)?;
    let (right_core, right_pre) = parse_channel_version(right)?;
    let zero = (0u64, String::new());
    for index in 0..left_core.len().max(right_core.len()) {
        let a = left_core.get(index).unwrap_or(&zero);
        let b = right_core.get(index).unwrap_or(&zero);
        let order = a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1));
        if order != CmpOrdering::Equal {
            return Some(order);
        }
    }
    Some(match (left_pre, right_pre) {
        (None, None) => CmpOrdering::Equal,
        (None, Some(_)) => CmpOrdering::Greater,
        (Some(_), None) => CmpOrdering::Less,
        (Some(a), Some(b)) => compare_prerelease(&a, &b),
    })
}

// "Update available" — only if the channel is strictly newer than the active set, or
// the active generation needs a resync and the channel is not older.
fn channel_update_available(remote: &str, local: &str, needs_resync: bool) -> bool {
    use std::cmp::Ordering as CmpOrdering;
    if !valid_channel_version(remote) {
        return false;
    }
    match compare_channel_versions(remote, local) {
        Some(CmpOrdering::Greater) => true,
        Some(CmpOrdering::Equal) => needs_resync,
        Some(CmpOrdering::Less) => false,
        // Active version unknown ("—") — a parseable channel replaces it.
        None => parse_channel_version(remote).is_some() && parse_channel_version(local).is_none(),
    }
}

// Whether to accept a signed bundle of version `incoming` over the active `active`.
// An old signed bundle passes the signature check too, so a version rollback
// is cut off separately; repeating the same version is allowed (generation repair).
fn channel_bundle_acceptable(incoming: &str, active: &str) -> bool {
    match compare_channel_versions(incoming, active) {
        Some(order) => order != std::cmp::Ordering::Less,
        None => parse_channel_version(active).is_none(),
    }
}

// Parse the engine version from the `winws --version` output (a banner like
// "github version 72.12 (...)" — printed by winws itself). We look for a token with digits
// after the word "version".
fn parse_engine_version(out: &str) -> Option<String> {
    for line in out.lines() {
        let low = line.to_lowercase();
        if let Some(idx) = low.find("version") {
            let after = &line[idx + "version".len()..];
            let tok: String = after
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '.')
                .collect();
            if tok.chars().any(|c| c.is_ascii_digit()) {
                return Some(tok);
            }
        }
    }
    None
}

// The actual winws engine version on the machine: we ask winws itself (--version).
// A bounded wait of ~1.5 s + kill, so we don't hang if the binary behaves
// unexpectedly. Windows-only (winws.exe is a Windows binary).
#[cfg(target_os = "windows")]
fn engine_version_runtime(app: &AppHandle) -> Option<String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    let bin = bin_dir(app, false).ok()?; // winws.exe is identical in both directories
    let exe = bin.join("winws.exe");
    if !exe.exists() {
        return None;
    }
    let mut child = std::process::Command::new(&exe)
        .arg("--version")
        .current_dir(&bin)
        .creation_flags(0x0800_0000)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    let mut waited = 0u64;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if waited >= 1500 {
                    let _ = terminate_child_bounded(&mut child, "winws --version");
                    return None;
                }
                std::thread::sleep(Duration::from_millis(100));
                waited += 100;
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut out);
    }
    if parse_engine_version(&out).is_none() {
        if let Some(mut se) = child.stderr.take() {
            let _ = se.read_to_string(&mut out);
        }
    }
    parse_engine_version(&out).map(|v| format!("zapret {v}"))
}

// Engine version: the real one from winws (--version) → bundled engine-version.txt → default.
fn engine_version(app: &AppHandle) -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some(v) = engine_version_runtime(app) {
            return v;
        }
    }
    res_dpi(app)
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("engine-version.txt")).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "winws (zapret)".into())
}

/// Three versions for the "Updates" card: app / engine / strategy set.
/// The engine ships as part of the app (app OTA), so it has no separate update
/// button — it is updated together with Ninety.
#[tauri::command]
pub fn dpi_versions(app: AppHandle) -> Result<serde_json::Value, String> {
    let strat = strat_version(&app)?;
    Ok(serde_json::json!({
        "app": app.package_info().version.to_string(),
        "engine": engine_version(&app),
        "strategies": strat,
    }))
}

// Auto-tuning targets. Discord is the main bypass scenario, and YouTube alone wasn't
// enough: with some ISPs YouTube is open while Discord is cut, and then
// even strategies on which Discord doesn't work got "all passed". Each
// target is its own SNI from our own lists (list-general.txt).
const AUTOTEST_TARGETS: [&str; 3] = [
    "https://discord.com/api/v10/gateway",
    "https://cdn.discordapp.com/embed/avatars/0.png",
    "https://www.youtube.com/",
];
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
// The WinDivert driver needs to detach from the dead winws before the next
// start. 150 ms 20 times in a row produced a race in which the engine didn't
// come up and the strategy looked broken.
const AUTOTEST_ENGINE_SETTLE: Duration = Duration::from_millis(500);
// Attempts to bring up the engine per strategy before counting a failure.
const AUTOTEST_ENGINE_ATTEMPTS: usize = 2;
// The video check. www.youtube.com only shows that the page opens, while the
// slowdown hits the servers that deliver the video itself (*.googlevideo.com).
// The redirector names the cache node assigned to this network.
const VIDEO_REDIRECTOR_URL: &str = "https://redirector.googlevideo.com/report_mapping?di=no";
const VIDEO_MAPPING_MAX_BYTES: usize = 16 * 1024;
// The redirector sits on googlevideo.com itself and may not answer without desync.
// Then it is asked again under strategies that opened every target, at most this
// many times.
const VIDEO_NODE_ATTEMPTS: usize = 3;
// Finals: the best candidates of the first pass are measured again, over several
// rounds and with the video check.
const AUTOTEST_FINALISTS: usize = 3;
const AUTOTEST_FINAL_ROUNDS: usize = 3;
// The current strategy stays when it is this close to the winner of the finals.
const AUTOTEST_KEEP_MARGIN_MS: u64 = 40;
const AUTOTEST_KEEP_MARGIN_PCT: u64 = 20;

// Client for one auto-tuning probe: no proxy, no connection reuse.
// A connection pool here is a source of false successes, see dpi_autotest.
fn probe_client() -> Result<reqwest::Client, String> {
    crate::util::direct_client_builder()
        .timeout(PROBE_TIMEOUT)
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|e| format!("http client: {e}"))
}

// Client for DOWNLOADING LISTS (hosts/ipset). port=Some(p>0) → through the sing-box mixed inbound
// (http://127.0.0.1:p), i.e. traffic goes through the bypass/VPN; otherwise a direct
// request. Difference from probe_client: a direct request to raw.githubusercontent.com
// from Russia is cut by TSPU — so with an active VPN (proxy/systemProxy) we fetch through
// the proxy and fall back to direct (the pattern is taken from quality::build_client).
fn list_client(port: Option<u16>) -> Result<reqwest::Client, String> {
    let mut b = crate::util::direct_client_builder().timeout(Duration::from_secs(20));
    if let Some(p) = port {
        if p > 0 {
            let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{p}"))
                .map_err(|e| format!("proxy: {e}"))?;
            b = b.proxy(proxy);
        }
    }
    b.build().map_err(|e| format!("http client: {e}"))
}

// Download attempt order: first through the proxy (if port>0 — the path through the bypass),
// then a direct fallback. port=None/0 (VPN off / TUN) → direct only. GitHub
// raw and releases are cut by TSPU from Russia, so with an active VPN we fetch through the tunnel.
fn fetch_routes(port: Option<u16>) -> Vec<Option<u16>> {
    let mut routes: Vec<Option<u16>> = Vec::new();
    if matches!(port, Some(p) if p > 0) {
        routes.push(port); // 1) through the mixed inbound (bypass)
    }
    routes.push(None); // 2) direct fallback
    routes
}

fn ensure_content_length_limit(
    content_length: Option<u64>,
    max_bytes: u64,
    label: &str,
) -> Result<(), String> {
    if let Some(n) = content_length.filter(|n| *n > max_bytes) {
        return Err(format!("{label} too large: {n} bytes > {max_bytes}"));
    }
    Ok(())
}

async fn read_http_body_limited(
    mut resp: Response,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    ensure_content_length_limit(resp.content_length(), max_bytes, label)?;
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read body: {e}"))? {
        let next_len = body.len() as u64 + chunk.len() as u64;
        if next_len > max_bytes {
            return Err(format!("{label} too large: {next_len} bytes > {max_bytes}"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

// Download raw bytes robustly: proxy→direct (fetch_routes), 2 attempts on
// each. Retries + proxying raise the chance of getting through a flapping/cutting
// TSPU on GitHub. If the proxy isn't listening (VPN off), the proxy attempt fails fast.
// Bytes (not text): the channel's signed .zip bundle cannot be decoded as UTF-8;
// text assets (version.txt, .sig) are read by fetch_list_text on top of this.
async fn fetch_list_bytes_limited(
    url: &str,
    port: Option<u16>,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut last = String::from("no attempts");
    for via in fetch_routes(port) {
        let client = match list_client(via) {
            Ok(c) => c,
            Err(e) => {
                last = e;
                continue;
            }
        };
        for attempt in 0..2 {
            match client
                .get(url)
                .send()
                .await
                .and_then(|r| r.error_for_status())
            {
                Ok(resp) => match read_http_body_limited(resp, max_bytes, label).await {
                    Ok(b) => return Ok(b),
                    Err(e) => last = format!("read body: {e}"),
                },
                Err(e) => last = format!("send: {e}"),
            }
            if attempt == 0 {
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }
    }
    Err(last)
}

// Text channel asset (version.txt, .sig) on top of fetch_list_bytes. The assets
// are UTF-8 by design, so a lossy decode is safe and doesn't duplicate the retry loop.
async fn fetch_list_text_limited(
    url: &str,
    port: Option<u16>,
    max_bytes: u64,
    label: &str,
) -> Result<String, String> {
    let bytes = fetch_list_bytes_limited(url, port, max_bytes, label).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn fetch_list_text(url: &str, port: Option<u16>) -> Result<String, String> {
    fetch_list_text_limited(url, port, MAX_CHANNEL_TEXT_BYTES, "channel text").await
}

/// Whether a strategy set update is available. We compare with the version of OUR CHANNEL
/// (the version.txt asset of the dpi-channel release) — what the "Update" button will actually
/// install via dpi_sync_channel. NOT with the live Flowseal version: the channel
/// is published after review and may lag behind the latest
/// Flowseal release. If we compared with live, in the window "Flowseal released → the channel hasn't
/// synced yet" the check shows "update available" while the button pulls the old bundle
/// → local never catches up with remote → an endless "broken loop" of updating.
#[tauri::command]
pub async fn dpi_check_update(
    app: AppHandle,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let active = load_strategies(&app)?;
    // port>0 (VPN in proxy/systemProxy) → the check goes through the tunnel: the dpi-channel
    // release's version.txt is on GitHub, which is cut by TSPU from Russia when accessed directly.
    let remote = fetch_list_text(&format!("{CHANNEL_BASE}/version.txt"), port)
        .await
        .map_err(|e| format!("fetch version: {e}"))?
        .trim()
        .to_string();
    // Not "any difference": a channel that lags behind the built-in set is not
    // an update, and "Update" would reject it anyway.
    Ok(serde_json::json!({
        "local": active.version,
        "remote": remote,
        "available": channel_update_available(&remote, &active.version, active.needs_resync),
        "resync": active.needs_resync,
    }))
}

// ── Strategy data channel (signed, no reinstall) ──────────

fn decode_channel_public_key(key_b64: &str) -> Result<minisign_verify::PublicKey, String> {
    use base64::Engine;
    let std_b64 = base64::engine::general_purpose::STANDARD;
    // Tauri stores the pubkey as base64 of the full minisign .pub file. After
    // one decode here we must get a comment and one key line.
    // An extra base64 layer used to break clean installs before reading the legacy key.
    let pk_raw = std_b64
        .decode(key_b64)
        .map_err(|e| format!("pubkey b64: {e}"))?;
    let pk_text = String::from_utf8(pk_raw).map_err(|e| format!("pubkey utf8: {e}"))?;
    let key_line = pk_text
        .lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty() && !line.starts_with("untrusted comment"))
        .ok_or("pubkey: key line not found")?;
    minisign_verify::PublicKey::from_base64(key_line).map_err(|e| format!("pubkey decode: {e}"))
}

// Verify the bundle's minisign signature. The dedicated key is tried first, the legacy OTA
// key only for a safe transition from the old published channel.
// sig_b64 — contents of the .sig asset (base64 of the minisign signature, tauri format).
fn verify_channel(data: &[u8], sig_b64: &str) -> Result<(), String> {
    use base64::Engine;
    use minisign_verify::Signature;
    let std_b64 = base64::engine::general_purpose::STANDARD;
    // .sig: base64 → minisign signature text (with trusted/untrusted comment).
    let sig_raw = std_b64
        .decode(sig_b64.trim())
        .map_err(|e| format!("sig b64: {e}"))?;
    let sig_text = String::from_utf8(sig_raw).map_err(|e| format!("sig utf8: {e}"))?;
    let sig = Signature::decode(&sig_text).map_err(|e| format!("sig decode: {e}"))?;
    let mut key_errors = Vec::new();
    let mut usable_keys = 0usize;
    for key_b64 in [CHANNEL_DEDICATED_PUBKEY_B64, CHANNEL_LEGACY_PUBKEY_B64] {
        let pk = match decode_channel_public_key(key_b64) {
            Ok(pk) => pk,
            Err(error) => {
                key_errors.push(error);
                continue;
            }
        };
        usable_keys += 1;
        if pk.verify(data, &sig, true).is_ok() {
            return Ok(());
        }
    }
    if usable_keys == 0 {
        return Err(format!(
            "DPI channel keys are corrupted: {}",
            key_errors.join("; ")
        ));
    }
    Err(crate::util::i18n_error("backend.dpi.badSignature"))
}

// Which .bin files strategies.json uses (the %BIN%xxx.bin placeholder in args).
fn referenced_bins(strategies: &[Strategy]) -> std::collections::HashSet<String> {
    let mut need = std::collections::HashSet::new();
    for st in strategies {
        for a in &st.args {
            if let Some(p) = a.find("%BIN%") {
                let tail = &a[p + "%BIN%".len()..];
                let name: String = tail.chars().take_while(|c| !c.is_whitespace()).collect();
                if name.ends_with(".bin") {
                    need.insert(name);
                }
            }
        }
    }
    need
}

fn service_entry(name: &str) -> PathBuf {
    Path::new("service").join(name)
}

// A file from a signed bundle stored in directory `dir` (a channel generation
// or staging). The signature is checked on EVERY read, and the contents come from
// the archive itself: the unpacked copy next to it lives in a user directory,
// and a line appended to it would otherwise make it into the system hosts.
fn read_signed_bundle_file(dir: &Path, relative: &Path) -> Result<String, String> {
    let mut entries = read_signed_bundle_entries(dir, &[relative])?;
    Ok(entries.remove(0))
}

// Several files from a signed bundle with a single signature check. The order
// of the result matches `relatives`; any missing file is an error.
fn read_signed_bundle_entries(dir: &Path, relatives: &[&Path]) -> Result<Vec<String>, String> {
    let bundle = dir.join(GENERATION_BUNDLE_FILE);
    let size = std::fs::metadata(&bundle)
        .map_err(|e| format!("signed DPI bundle is missing: {e}"))?
        .len();
    if size > MAX_CHANNEL_BUNDLE_BYTES {
        return Err(format!("signed DPI bundle is too large: {size} bytes"));
    }
    let zip_bytes = std::fs::read(&bundle).map_err(|e| format!("read signed DPI bundle: {e}"))?;
    let sig_b64 = std::fs::read_to_string(dir.join(GENERATION_SIGNATURE_FILE))
        .map_err(|e| format!("read DPI bundle signature: {e}"))?;
    verify_channel(&zip_bytes, &sig_b64)?;

    let reader = std::io::Cursor::new(zip_bytes.as_slice());
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("open zip: {e}"))?;
    let mut found: Vec<Option<String>> = vec![None; relatives.len()];
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(slot) = entry.enclosed_name().and_then(|name| {
            relatives
                .iter()
                .position(|relative| name.as_path() == *relative)
        }) else {
            continue;
        };
        if found[slot].is_some() {
            continue;
        }
        let relative = relatives[slot];
        if entry.size() > MAX_CHANNEL_ENTRY_BYTES {
            return Err(format!(
                "signed DPI bundle entry is too large: {}",
                relative.display()
            ));
        }
        let mut raw = Vec::new();
        std::io::copy(&mut entry, &mut raw)
            .map_err(|e| format!("unzip {}: {e}", relative.display()))?;
        found[slot] = Some(
            String::from_utf8(raw)
                .map_err(|e| format!("{}: invalid UTF-8: {e}", relative.display()))?,
        );
    }
    found
        .into_iter()
        .zip(relatives)
        .map(|(text, relative)| {
            text.ok_or_else(|| format!("signed DPI bundle has no {}", relative.display()))
        })
        .collect()
}

// Download the channel's SIGNED bundle, verify the minisign signature BEFORE unpacking and
// unpack into a unique staging dir (zip-slip-safe). Returns the staging path; cleaning
// it up is the caller's job. The single entry point for trusted channel data: dpi_sync_channel
// applies strategies/lists/bin from here, and hosts/ipset take service/* — all three
// flows go through the signature, without unsigned github-raw on the open network.
// port>0 (VPN in proxy/systemProxy) → fetch through the tunnel: the dpi-channel release assets
// are on GitHub, cut by TSPU from Russia when accessed directly. The signature makes the delivery route untrusted.
async fn stage_verified_bundle(app: &AppHandle, port: Option<u16>) -> Result<PathBuf, String> {
    let sig_b64 = fetch_list_text_limited(
        &format!("{CHANNEL_BASE}/dpi-channel.zip.sig"),
        port,
        MAX_CHANNEL_SIGNATURE_BYTES,
        "channel signature",
    )
    .await
    .map_err(|e| format!("fetch sig: {e}"))?;
    let zip_bytes = fetch_list_bytes_limited(
        &format!("{CHANNEL_BASE}/dpi-channel.zip"),
        port,
        MAX_CHANNEL_BUNDLE_BYTES,
        "channel bundle",
    )
    .await
    .map_err(|e| format!("fetch zip: {e}"))?;

    // Signature VERIFICATION before any unpacking.
    verify_channel(&zip_bytes, &sig_b64)?;

    let dpi_data = crate::app_paths::data_dir(app)?.join("dpi");
    let seq = TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed);
    let staging = dpi_data.join(format!(".staging-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&staging).map_err(|e| format!("mkdir staging: {e}"))?;
    let mut staging_guard = StagingDirGuard {
        path: staging.clone(),
        keep: false,
    };

    let reader = std::io::Cursor::new(zip_bytes.as_slice());
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("open zip: {e}"))?;
    if zip.len() > MAX_CHANNEL_ENTRIES {
        return Err(format!(
            "channel bundle has too many entries: {} > {MAX_CHANNEL_ENTRIES}",
            zip.len()
        ));
    }
    let mut unpacked = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        if entry.size() > MAX_CHANNEL_ENTRY_BYTES {
            return Err(format!(
                "channel entry too large: {} ({} bytes)",
                entry.name().unwrap_or_default(),
                entry.size()
            ));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .ok_or("channel unpacked size overflow")?;
        if unpacked > MAX_CHANNEL_UNPACKED_BYTES {
            return Err(format!(
                "channel unpacked data too large: {unpacked} > {MAX_CHANNEL_UNPACKED_BYTES}"
            ));
        }
        // zip-slip protection: we only take a safe relative name.
        let name = match entry.enclosed_name() {
            Some(n) => n.to_path_buf(),
            None => {
                return Err(format!(
                    "unsafe channel zip path: {}",
                    entry.name().unwrap_or_default()
                ))
            }
        };
        let out = staging.join(&name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("mkdir {name:?}: {e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        let mut f = std::fs::File::create(&out).map_err(|e| format!("create {name:?}: {e}"))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("unzip {name:?}: {e}"))?;
    }
    // The bundle itself and its signature are placed next to the unpacked files: service files
    // are rechecked against them before use (read_signed_bundle_file). The write
    // happens after unpacking, so an archive entry with the same name can't replace them.
    std::fs::write(staging.join(GENERATION_BUNDLE_FILE), &zip_bytes)
        .map_err(|e| format!("store channel bundle: {e}"))?;
    std::fs::write(staging.join(GENERATION_SIGNATURE_FILE), sig_b64.as_bytes())
        .map_err(|e| format!("store channel signature: {e}"))?;
    staging_guard.keep = true;
    Ok(staging)
}

// Service file of the last applied generation (offline fallback). Taken
// only from that generation's signed bundle: we no longer trust the unpacked copy or the
// unsigned cache of previous versions — until the next channel sync
// such a fallback answers "channel not synced".
fn read_cached_service(app: &AppHandle, name: &str) -> Result<String, String> {
    let not_synced =
        || crate::util::i18n_error_with("backend.dpi.channelNotSynced", &[("name", name)]);
    let Some(generation) = active_channel_generation(app)? else {
        return Err(not_synced());
    };
    read_signed_bundle_file(&generation, &service_entry(name)).map_err(|_| not_synced())
}

// Service file of the active generation, if the channel is already at the published
// version. Then there is no point downloading the bundle: service/<name> in the generation is the very same
// signed file that is in the zip. Any hiccup (no generation, no file,
// versions diverged, network silent) → None, and the caller takes the regular path.
async fn current_channel_service(app: &AppHandle, port: Option<u16>, name: &str) -> Option<String> {
    let generation = active_channel_generation(app).ok().flatten()?;
    let local = strat_version(app).ok()?;
    let remote = fetch_list_text(&format!("{CHANNEL_BASE}/version.txt"), port)
        .await
        .ok()?;
    if remote.trim().is_empty() || remote.trim() != local {
        return None;
    }
    // A generation built before the saved bundle existed has nothing to verify against:
    // None sends the caller off for a fresh signed bundle.
    read_signed_bundle_file(&generation, &service_entry(name)).ok()
}

// Get a channel service file (hosts / ipset-service.txt) from the SIGNED bundle.
// Network → stage a fresh bundle (verify), extract service/<name>. No network →
// fall back to the service file from the active generation (or the legacy cache before the first migration).
// Previously hosts/ipset were fetched directly from raw.githubusercontent.com/Flowseal without
// a signature — that path is closed: we trust only minisign-verified data.
async fn fetch_channel_service(
    app: &AppHandle,
    port: Option<u16>,
    name: &str,
) -> Result<String, String> {
    // The channel bundle weighs tens of megabytes, and we need one file from it. As long as
    // the generation matches the published version, we limit ourselves to version.txt.
    if let Some(current) = current_channel_service(app, port, name).await {
        return Ok(current);
    }
    match stage_verified_bundle(app, port).await {
        Ok(staging) => {
            // Read from the bundle itself, not from the unpacked copy: staging lives
            // in a user directory. The active generation isn't changed because of a single
            // service file — it only switches as a whole.
            let result = read_signed_bundle_file(&staging, &service_entry(name))
                .or_else(|_| read_cached_service(app, name));
            let _ = std::fs::remove_dir_all(&staging);
            result
        }
        // Network unavailable → return the cached signed file if there is one; otherwise the network error.
        Err(net) => read_cached_service(app, name).map_err(|_| net),
    }
}

fn require_regular_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("{label} is missing: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    Ok(())
}

fn valid_channel_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 128
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
}

fn cleanup_channel_generations(
    generations: &Path,
    active: &str,
    previous: Option<&str>,
) -> Vec<String> {
    let mut warnings = Vec::new();
    let entries = match std::fs::read_dir(generations) {
        Ok(entries) => entries,
        Err(e) => {
            warnings.push(format!("read DPI channel generations: {e}"));
            return warnings;
        }
    };
    for item in entries {
        let entry = match item {
            Ok(entry) => entry,
            Err(e) => {
                warnings.push(format!("read DPI channel generation entry: {e}"));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == active || previous == Some(name.as_str()) {
            continue;
        }
        let is_dir = match entry.file_type() {
            Ok(kind) => kind.is_dir(),
            Err(e) => {
                warnings.push(format!("DPI channel generation type ({name}): {e}"));
                continue;
            }
        };
        if !is_dir {
            continue;
        }
        if let Err(e) = std::fs::remove_dir_all(entry.path()) {
            warnings.push(format!("remove stale DPI channel generation {name}: {e}"));
        }
    }
    warnings
}

/// Sync the strategy channel: download the signed bundle, verify the signature
/// BEFORE unpacking, validate it (strategies.json parses, all .bin are present) and
/// assemble a full generation in app_data. The only commit point is the atomic
/// replacement of channel-current after the directory is finalized. The engine is NOT touched.
#[tauri::command]
pub async fn dpi_sync_channel(
    app: AppHandle,
    state: State<'_, DpiState>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    // 1–3. Download + verify the signature + unpack into staging (shared helper).
    let dpi_data = crate::app_paths::data_dir(&app)?.join("dpi");
    let staging = stage_verified_bundle(&app, port).await?;
    // Switching the channel generation is a DPI lifecycle operation, not just
    // writing files: the old generation gets cleaned up, and it must not be swapped out under a running
    // start/autotest (winws runs from exactly this directory). The guard
    // is taken after the download so that a long download doesn't block starting the bypass.
    let generation = match begin_dpi_operation(&state, "sync_channel") {
        Ok(generation) => generation,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let _operation = DpiOperationGuard {
        state: &state,
        generation,
    };
    let _data = state.data.lock().await;

    let result = (|| -> Result<serde_json::Value, String> {
        std::fs::create_dir_all(&dpi_data).map_err(|e| format!("mkdir dpi data: {e}"))?;
        // A corrupted pointer doesn't get in the way: resolution has already fallen back to the previous
        // intact generation or the built-in set, the new generation is assembled
        // on top, and the pointer commit below overwrites the corrupted one.
        let current_generation = active_channel_generation_from_dpi(&dpi_data);
        let previous_name = current_generation
            .as_ref()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .map(str::to_string);
        let current_lists = ensure_lists(&app)?;
        let mut fake_selection = load_fake_selection(&app);
        let active_version = load_strategies_from(&dpi_data)?.version;

        // Strategies and version come only from the signed bundle (the signature
        // is rechecked: staging lives in a user directory), not from
        // the unpacked copies next to it.
        let signed = read_signed_bundle_entries(
            &staging,
            &[Path::new("strategies.json"), Path::new("version.txt")],
        )?;
        let strat_raw = &signed[0];
        let strategies = parse_checked_strategies(strat_raw)?;
        // The bundle must be self-contained: we can't accept a new strategy
        // that only happens to work while an old payload sits in bin-data.
        let staged_bin = staging.join("bin");
        if !staged_bin.is_dir() {
            return Err("the bundle has no bin directory".into());
        }
        let mut payloads = Vec::new();
        let mut incoming = std::collections::HashSet::new();
        let rd = std::fs::read_dir(&staged_bin).map_err(|e| format!("read staged bin: {e}"))?;
        for item in rd {
            let entry = item.map_err(|e| format!("read staged bin entry: {e}"))?;
            let path = entry.path();
            if path.extension().is_none_or(|extension| extension != "bin") {
                continue;
            }
            if !entry
                .file_type()
                .map_err(|e| format!("staged bin file type: {e}"))?
                .is_file()
            {
                return Err("channel payload is not a regular file".into());
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "channel .bin name is not UTF-8".to_string())?;
            if !valid_bin_filename(&name) {
                return Err(format!("invalid channel .bin name: {name}"));
            }
            let size = entry
                .metadata()
                .map_err(|e| format!("staged bin metadata: {e}"))?
                .len();
            if !(1..=MAX_DPI_PAYLOAD_BYTES).contains(&size) {
                return Err(format!("invalid channel .bin size: {name} ({size})"));
            }
            incoming.insert(name.clone());
            payloads.push((path, name));
        }
        if payloads.is_empty() || payloads.len() > 256 {
            return Err(format!("invalid channel .bin count: {}", payloads.len()));
        }
        for name in referenced_bins(&strategies) {
            if !incoming.contains(&name) {
                return Err(format!("the bundle has no .bin: {name}"));
            }
        }

        let ver = signed[1].trim().to_string();
        if !valid_channel_version(&ver) {
            return Err("invalid DPI channel version".into());
        }
        // The old bundle's signature is still valid: without this check
        // a spoofed "channel" response would roll the set back to an old version.
        if !channel_bundle_acceptable(&ver, &active_version) {
            return Err(crate::util::i18n_error_with(
                "backend.dpi.channelOlder",
                &[("remote", &ver), ("local", &active_version)],
            ));
        }

        let staged_lists = staging.join("lists");
        for name in CHANNEL_LIST_FILES {
            let from = staged_lists.join(name);
            require_regular_file(&from, &format!("staged list {name}"))?;
        }
        let staged_service = staging.join("service");
        for name in CHANNEL_SERVICE_FILES {
            require_regular_file(
                &staged_service.join(name),
                &format!("staged service {name}"),
            )?;
        }

        // Assemble the new generation separately from the active one. As long as channel-current
        // points to the old one, no reader will see these files.
        let generations = dpi_data.join(CHANNEL_GENERATIONS_DIR);
        std::fs::create_dir_all(&generations)
            .map_err(|e| format!("mkdir DPI channel generations: {e}"))?;
        let generation_name = channel_generation_name();
        let pending = generations.join(format!(".{generation_name}.pending"));
        let finalized = generations.join(&generation_name);
        std::fs::create_dir(&pending)
            .map_err(|e| format!("create pending DPI channel generation: {e}"))?;

        let build_result = (|| -> Result<Vec<String>, String> {
            let lists = pending.join("lists");
            let bin = pending.join("bin-data");
            let service = pending.join("service");
            std::fs::create_dir_all(&lists).map_err(|e| format!("mkdir pending DPI lists: {e}"))?;
            std::fs::create_dir_all(&bin)
                .map_err(|e| format!("mkdir pending DPI bin-data: {e}"))?;
            std::fs::create_dir_all(&service)
                .map_err(|e| format!("mkdir pending DPI service: {e}"))?;

            // Local user/session files are carried into the snapshot,
            // but the four base lists always come from the signed bundle.
            for name in LOCAL_LIST_FILES {
                let from = current_lists.join(name);
                let to = lists.join(name);
                if from.is_file() {
                    copy_replace(&from, &to, &format!("local list {name}"))?;
                } else if name == IPSET_BASE_FILE {
                    let bundled = res_lists(&app)?.join(name);
                    if bundled.is_file() {
                        copy_replace(&bundled, &to, "bundled ipset base")?;
                    } else {
                        write_replace(&to, "", "empty ipset base")?;
                    }
                } else {
                    write_replace(&to, "", &format!("empty local list {name}"))?;
                }
            }
            for name in CHANNEL_LIST_FILES {
                copy_replace(
                    &staged_lists.join(name),
                    &lists.join(name),
                    &format!("channel list {name}"),
                )?;
            }
            // The channel ships the Flowseal lists as is — Ninety's additions go on top.
            apply_list_additions(
                &lists.join("list-general.txt"),
                &NINETY_GENERAL_ADDITIONS,
                "Ninety list additions",
            )?;
            for (path, name) in &payloads {
                copy_replace(path, &bin.join(name), &format!("channel bin {name}"))?;
            }
            for name in CHANNEL_SERVICE_FILES {
                copy_replace(
                    &staged_service.join(name),
                    &service.join(name),
                    &format!("channel service {name}"),
                )?;
            }
            // The ipset base arrives in the same signed bundle as the strategies,
            // so we update it right here. Previously it was moved only by the
            // "Update list" button, and the "Sites from the IP list" mode could work for months
            // on the set from the installation while the channel moved ahead.
            // The write happens AFTER carrying over LOCAL_LIST_FILES: the fresh base must
            // override the one carried over from the previous generation, not the other way around.
            let staged_ipset = std::fs::read_to_string(staged_service.join(IPSET_SERVICE_FILE))
                .map_err(|e| format!("read staged {IPSET_SERVICE_FILE}: {e}"))?;
            if let Some(base) = ipset_base_from_service(&staged_ipset) {
                let base = with_list_additions(&base, &NINETY_IPSET_ADDITIONS).unwrap_or(base);
                write_replace(&lists.join(IPSET_BASE_FILE), &base, "channel ipset base")?;
            }
            // A copy for diagnostics and generation integrity checks; strategies
            // are still read only from bundle.zip.
            write_replace(
                &pending.join("strategies.json"),
                strat_raw,
                "channel strategies",
            )?;
            // The signed bundle goes into the generation in full: service files are later
            // rechecked against it (read_signed_bundle_file).
            for name in [GENERATION_BUNDLE_FILE, GENERATION_SIGNATURE_FILE] {
                copy_replace(
                    &staging.join(name),
                    &pending.join(name),
                    &format!("channel {name}"),
                )?;
            }
            write_replace(
                &pending.join("version.txt"),
                &format!("{ver}\n"),
                "channel version",
            )?;

            // The UDP fake choice is part of the new generation too. A vanished payload
            // is reset inside pending without changing the active set before the commit.
            let fake_selection_reset =
                reapply_fake_selection_value(&bin, Some(&incoming), &mut fake_selection)?;
            save_fake_selection_at(&pending.join("fake-selection.json"), &fake_selection)?;
            validate_channel_generation(&pending)?;

            // First atomically finalize the full directory, then switch readers to it
            // with one crash-safe replace.
            finalize_channel_generation(&pending, &finalized)?;
            validate_channel_generation(&finalized)?;
            write_replace(
                &dpi_data.join(CHANNEL_POINTER_FILE),
                &format!("{generation_name}\n"),
                "DPI channel pointer",
            )?;
            Ok(fake_selection_reset)
        })();

        let fake_selection_reset = match build_result {
            Ok(reset) => reset,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&pending);
                let _ = std::fs::remove_dir_all(&finalized);
                return Err(error);
            }
        };

        // Keep the previous generation: an already running winws may still read
        // the old paths until the frontend restart. Older/orphaned generations
        // are deleted best-effort; they don't take part in choosing the active set.
        let cleanup_warnings =
            cleanup_channel_generations(&generations, &generation_name, previous_name.as_deref());

        Ok(serde_json::json!({
            "version": ver,
            "applied": true,
            "fake_selection_reset": fake_selection_reset,
            "cleanup_warnings": cleanup_warnings,
        }))
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

// ── hosts file (bypassing DNS spoofing) + ipset base update ───────────
// Why hosts in addition to winws: when the ISP doesn't cut packets but SPOOFS
// the DNS answer, the domain resolves to garbage and the handshake never starts — winws has nothing
// to desync. We nail down working IPs (Discord voice servers,
// web Telegram, GitHub). We write ONLY our own block between the markers and don't touch other
// hosts lines; idempotent — a repeated apply replaces the block entirely.
const HOSTS_BEGIN: &str = "# >>> 190x4 Ninety (DPI hosts) >>>";
const HOSTS_END: &str = "# <<< 190x4 Ninety (DPI hosts) <<<";

// The path is built from GetSystemDirectoryW (util::system_hosts_path), not from
// %SystemRoot%: HKCU\Environment overrides that environment variable, and this
// path is used to rewrite the file from an elevated process.
#[cfg(target_os = "windows")]
fn system_hosts_path() -> PathBuf {
    crate::util::system_hosts_path()
}
#[cfg(not(target_os = "windows"))]
fn system_hosts_path() -> PathBuf {
    PathBuf::from("/etc/hosts")
}

// Whether OUR managed block is present. The marker must be a separate line —
// exactly how strip_managed_block and the block parsing in dpi_hosts_status look for it.
// The old `content.contains(HOSTS_BEGIN)` was a substring search over the whole file:
// a comment like `# <marker> tail` gave applied=true with an empty block, and in
// dpi_hosts_apply it also picked the wrong body for the first hosts backup.
fn has_managed_block(content: &str) -> bool {
    content.lines().any(|line| line.trim() == HOSTS_BEGIN)
}

// Remove our managed block (BEGIN..END inclusive) from the hosts text without touching
// the rest. Returns the text without the block (with a trailing \n on every line).
fn strip_managed_block(content: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut skip = false;
    let mut blocks = 0usize;
    for line in content.lines() {
        let t = line.trim();
        if t == HOSTS_BEGIN {
            if skip {
                return Err("hosts: nested Ninety BEGIN marker".into());
            }
            skip = true;
            blocks += 1;
            continue;
        }
        if t == HOSTS_END {
            if !skip {
                return Err("hosts: Ninety END marker without BEGIN".into());
            }
            skip = false;
            continue;
        }
        if skip {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if skip {
        return Err("hosts: Ninety BEGIN marker without END".into());
    }
    if blocks > 1 {
        return Err(format!(
            "hosts: several managed Ninety blocks found ({blocks})"
        ));
    }
    Ok(out)
}

// The system hosts file is read as bytes. Windows doesn't require it to be UTF-8: third-party
// utilities write comments there in an ANSI encoding, and `read_to_string` on such
// a file failed — the hosts feature became unavailable entirely. Each byte
// maps to a character U+0000..U+00FF and back losslessly, and Ninety's markers and
// entries are ASCII, so foreign bytes go back into the file exactly as they were.
fn read_hosts_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read hosts ({}): {e}", path.display()))?;
    Ok(decode_hosts_bytes(&bytes))
}

fn decode_hosts_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| char::from(byte)).collect()
}

fn encode_hosts_text(text: &str) -> Result<Vec<u8>, String> {
    text.chars()
        .map(u8::try_from)
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| "hosts: character outside the single-byte encoding".to_string())
}

// Trailing spaces and line breaks are stripped as ASCII only. A Unicode trim_end
// would also cut bytes 0x85/0xA0, which in hosts can be part of foreign characters
// (UTF-8 "Р" is D0 A0).
fn trim_hosts_end(text: &str) -> &str {
    text.trim_end_matches([' ', '\t', '\r', '\n'])
}

// Preserve the original hosts line endings. strip_managed_block works via
// lines() and returns LF text, so the user's CRLF file would otherwise be silently
// normalized entirely — including foreign lines we never touched.
fn apply_hosts_line_endings(rendered: &str, original: &str) -> String {
    if original.contains("\r\n") {
        rendered.replace('\n', "\r\n")
    } else {
        rendered.to_string()
    }
}

// How many valid "IP domain" entries are in the text (excluding empty lines and comments).
fn count_hosts_entries(body: &str) -> usize {
    body.lines()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with('#') && t.split_whitespace().count() >= 2
        })
        .count()
}

fn valid_hosts_domain(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 {
        return false;
    }
    name.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

// Shape check of the block that will go into the system hosts.
//
// The body comes from the signed bundle (see read_signed_bundle_file), and this is
// a second line of defense on top of the signature: every line must have the form
// "IP domain [domain…]", so that nothing but entries makes it into the system hosts from
// an elevated process. CI does the same shape check before signing the channel.
fn sanitize_hosts_body(body: &str) -> Result<String, String> {
    let mut out = Vec::new();
    for (index, line) in body.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push(trimmed.to_string());
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let address = parts.next().unwrap_or_default();
        if address.parse::<std::net::IpAddr>().is_err() {
            return Err(format!(
                "hosts: line {} does not start with an IP address: {trimmed}",
                index + 1
            ));
        }
        let domains: Vec<&str> = parts.take_while(|token| !token.starts_with('#')).collect();
        if domains.is_empty() {
            return Err(format!(
                "hosts: line {} has no domain: {trimmed}",
                index + 1
            ));
        }
        for domain in &domains {
            if !valid_hosts_domain(domain) {
                return Err(format!(
                    "hosts: line {} has an invalid name \"{domain}\"",
                    index + 1
                ));
            }
        }
        out.push(format!("{address} {}", domains.join(" ")));
    }
    Ok(out.join("\n"))
}

/// System hosts status: whether our block is applied and how many entries it has.
#[tauri::command]
pub fn dpi_hosts_status(_app: AppHandle) -> Result<serde_json::Value, String> {
    let path = system_hosts_path();
    let content = read_hosts_file(&path)?;
    // Damaged markers must not be shown as a normal applied state:
    // apply/clear will also stop without writing in that case.
    let _ = strip_managed_block(&content)?;
    let mut inside = false;
    let mut applied = false;
    let mut block = String::new();
    for line in content.lines() {
        let t = line.trim();
        if t == HOSTS_BEGIN {
            inside = true;
            applied = true;
            continue;
        }
        if t == HOSTS_END {
            inside = false;
            continue;
        }
        if inside {
            block.push_str(line);
            block.push('\n');
        }
    }
    Ok(serde_json::json!({
        "applied": applied,
        "entries": count_hosts_entries(&block),
    }))
}

/// Download the current hosts from the repository and (re)write our managed block into
/// the system hosts. Requires admin rights (the frontend elevates before the call). Makes
/// a backup of the original on the first write and flushes the DNS cache. Returns the number of entries.
#[tauri::command]
pub async fn dpi_hosts_apply(
    app: AppHandle,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    // hosts pins IP↔domain in the system hosts — the most sensitive of the
    // DPI paths, so we take it strictly from the minisign-signed channel (it used to be
    // a direct unsigned fetch from Flowseal raw).
    let raw = fetch_channel_service(&app, port, "hosts")
        .await
        .map_err(|e| format!("fetch hosts: {e}"))?;
    let body = raw.replace("\r\n", "\n");
    let body = body.trim();
    if count_hosts_entries(body) == 0 {
        return Err(crate::util::i18n_error("backend.dpi.hostsNoRecords"));
    }
    // Check the shape BEFORE writing — a second line of defense on top of the bundle signature.
    let sanitized = sanitize_hosts_body(body)?;
    let backup_dir = crate::app_paths::data_dir(&app)?.join("dpi");
    // What follows is a file in System32 under Defender interception and waiting for
    // `ipconfig /flushdns`: blocking work that occupied an async runtime
    // thread for seconds (dpi_hosts_clear is moved off the same way).
    let entries = tauri::async_runtime::spawn_blocking(move || {
        write_hosts_block_blocking(&backup_dir, sanitized.trim())
    })
    .await
    .map_err(|e| format!("waiting for the hosts write failed: {e}"))??;
    Ok(serde_json::json!({ "entries": entries }))
}

fn write_hosts_block_blocking(bdir: &Path, body: &str) -> Result<usize, String> {
    let path = system_hosts_path();
    let current = read_hosts_file(&path)?;
    let base = strip_managed_block(&current)?;

    // Back up the original once — before our first write. A backup error blocks
    // the system write: hosts must not be changed without a verifiable rollback.
    std::fs::create_dir_all(bdir).map_err(|e| format!("mkdir hosts backup: {e}"))?;
    let backup = bdir.join("hosts.backup");
    if !backup.exists() {
        // When migrating from an old version the managed block may already exist while the backup
        // doesn't yet. In that case we save the restored base without our block.
        let backup_body = encode_hosts_text(if has_managed_block(&current) {
            &base
        } else {
            &current
        })?;
        write_bytes_replace(&backup, &backup_body, "hosts backup")?;
        let saved = std::fs::read(&backup).map_err(|e| format!("verify hosts backup: {e}"))?;
        if saved != backup_body {
            return Err("hosts backup check: contents differ".into());
        }
    } else if backup.exists() {
        std::fs::File::open(&backup).map_err(|e| format!("open hosts backup: {e}"))?;
    }

    // Remove the old block (if any), append the fresh one at the end.
    let base = trim_hosts_end(&base);
    let mut out = String::new();
    out.push_str(base);
    if !base.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(HOSTS_BEGIN);
    out.push('\n');
    out.push_str(body);
    out.push('\n');
    out.push_str(HOSTS_END);
    out.push('\n');

    // The system hosts is rewritten IN PLACE, not swapped: replacing the file
    // would give the target the temporary object's DACL, and Controlled Folder Access and some
    // antiviruses block exactly the swap. overwrite_in_place rolls back a broken write
    // itself; hosts.backup above is insurance in case even that fails.
    let out = encode_hosts_text(&apply_hosts_line_endings(&out, &current))?;
    let original = encode_hosts_text(&current)?;
    overwrite_in_place(&path, &out, &original, "system hosts").map_err(|e| {
        crate::util::i18n_error_with(
            "backend.dpi.hostsAdmin",
            &[("error", &format!("{}: {e}", path.display()))],
        )
    })?;
    flush_dns();
    Ok(count_hosts_entries(body))
}

/// Remove our managed block from the system hosts (full rollback). Requires admin rights.
///
/// async + spawn_blocking: the body reads and rewrites a file in System32 (under
/// Defender interception) and then waits for `ipconfig /flushdns` to finish. On
/// the main thread this sent the window into "not responding" for seconds.
#[tauri::command]
pub async fn dpi_hosts_clear(_app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(dpi_hosts_clear_blocking)
        .await
        .map_err(|e| format!("waiting for the hosts cleanup failed: {e}"))?
}

fn dpi_hosts_clear_blocking() -> Result<(), String> {
    let path = system_hosts_path();
    let current = read_hosts_file(&path)?;
    if !has_managed_block(&current) {
        // Even clear must not silently accept an extra END marker.
        let _ = strip_managed_block(&current)?;
        return Ok(());
    }
    let stripped = format!("{}\n", trim_hosts_end(&strip_managed_block(&current)?));
    let stripped = encode_hosts_text(&apply_hosts_line_endings(&stripped, &current))?;
    let original = encode_hosts_text(&current)?;
    overwrite_in_place(&path, &stripped, &original, "system hosts")
        .map_err(|e| crate::util::i18n_error_with("backend.dpi.hostsAdmin", &[("error", &e)]))?;
    flush_dns();
    Ok(())
}

fn flush_dns() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new(system32("ipconfig.exe"))
            .arg("/flushdns")
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

// How many IP entries are in the ipset list file (lines excluding empty ones and comments).
fn count_ipset_lines(txt: &str) -> usize {
    txt.lines()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with('#')
        })
        .count()
}

/// Domains that winws itself detected as blocked (the "Blocked
/// only" mode). Newest first: the file is appended to at the end.
#[tauri::command]
pub fn dpi_auto_domains(app: AppHandle) -> Result<Vec<String>, String> {
    let lists = ensure_lists(&app)?;
    let txt = read_list_text(&lists.join(AUTO_HOSTLIST_FILE))?;
    Ok(auto_domains_from(&txt))
}

/// Remove a domain from the autolist: the bypass will stop applying to it until winws
/// sees signs of blocking again. Returns the rest of the list.
/// Only the exclusion list prevents it from coming back — just as
/// zapret itself advises; the "to exclusions" button in the UI calls dpi_write_list.
#[tauri::command]
pub async fn dpi_auto_forget(
    app: AppHandle,
    state: State<'_, DpiState>,
    domain: String,
) -> Result<Vec<String>, String> {
    let _data = state.data.lock().await;
    let lists = ensure_lists(&app)?;
    let path = lists.join(AUTO_HOSTLIST_FILE);
    let txt = read_list_text(&path)?;
    let target = domain.trim();
    if target.is_empty() {
        return Err("empty domain".into());
    }
    let mut kept = String::new();
    for line in txt.lines() {
        if line.trim().eq_ignore_ascii_case(target) {
            continue;
        }
        kept.push_str(line);
        kept.push('\n');
    }
    // winws rereads the autolist by the file signature, so restarting
    // the engine is not needed — the edit is picked up on the next connection.
    write_replace(&path, &kept, "auto hostlist forget")?;
    Ok(auto_domains_from(&kept))
}

/// Clear the autolist entirely — learning starts over.
#[tauri::command]
pub async fn dpi_auto_clear(app: AppHandle, state: State<'_, DpiState>) -> Result<(), String> {
    let _data = state.data.lock().await;
    let lists = ensure_lists(&app)?;
    write_replace(&lists.join(AUTO_HOSTLIST_FILE), "", "auto hostlist clear")
}

// ipset base body from the channel's service file. None — no entries: such a file
// doesn't replace the base, neither on a manual update nor on a channel sync. The previous
// working list is more useful than a wiped one, and an empty ipset collection in winws actually
// means "don't filter by IP" — the "Sites from the IP list" mode would silently
// turn into "All sites".
fn ipset_base_from_service(raw: &str) -> Option<String> {
    let body = raw.replace("\r\n", "\n");
    (count_ipset_lines(&body) > 0).then_some(body)
}

/// Current number of IPs in the active ipset base (writable override → resource).
#[tauri::command]
pub fn dpi_ipset_count(app: AppHandle) -> Result<usize, String> {
    let lists = ensure_lists(&app)?;
    let wbase = lists.join(IPSET_BASE_FILE);
    let path = if wbase.exists() {
        wbase
    } else {
        res_lists(&app)?.join(IPSET_BASE_FILE)
    };
    let txt = std::fs::read_to_string(&path).unwrap_or_default();
    Ok(count_ipset_lines(&txt))
}

/// Update the ipset base (ipset-all) with the current list from the repository. We write to
/// the writable app_data copy — the IPSet "Loaded" mode takes it with priority. If
/// the engine is running in this mode, restarting winws is up to the frontend.
/// Returns the number of loaded IPs.
#[tauri::command]
pub async fn dpi_update_ipset(
    app: AppHandle,
    state: State<'_, DpiState>,
    port: Option<u16>,
) -> Result<usize, String> {
    let _data = state.data.lock().await;
    let lists = ensure_lists(&app)?;
    // The ipset base also comes from the signed channel (it used to be a direct fetch from Flowseal raw).
    let raw = fetch_channel_service(&app, port, IPSET_SERVICE_FILE)
        .await
        .map_err(|e| format!("fetch ipset: {e}"))?;
    let body = ipset_base_from_service(&raw)
        .ok_or_else(|| crate::util::i18n_error("backend.dpi.ipsetNoRecords"))?;
    let body = with_list_additions(&body, &NINETY_IPSET_ADDITIONS).unwrap_or(body);
    let n = count_ipset_lines(&body);
    write_replace(&lists.join(IPSET_BASE_FILE), &body, "write ipset base")?;
    Ok(n)
}

// ── Strategy auto-tuning ───────────────────────────────────────────
#[derive(serde::Serialize, Clone)]
struct AutotestProgress {
    i: usize,
    total: usize,
    name: String,
    // "screen" — the first pass over all strategies, "final" — re-measuring the best.
    stage: &'static str,
}

/// googlevideo hostnames encode the node name from report_mapping with a fixed
/// substitution: the character at index i of `[0-9a-z]` becomes the one at
/// (7 * i + 7) mod 36, `-` stays as is (waw02s20 → sn-f5f7lnl7).
fn encode_video_node(name: &str) -> Option<String> {
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if name.is_empty() || name.len() > 40 || name.starts_with('-') || name.ends_with('-') {
        return None;
    }
    name.bytes()
        .map(|c| {
            if c == b'-' {
                return Some('-');
            }
            let i = ALPHABET.iter().position(|&a| a == c)?;
            Some(ALPHABET[(7 * i + 7) % 36] as char)
        })
        .collect()
}

/// The video node host from a report_mapping answer. Its first line looks like
/// `<client ip> => waw02s20 (<prefix>) [u]`.
fn video_node_host(mapping: &str) -> Option<String> {
    let line = mapping.lines().find(|line| line.contains("=>"))?;
    let name = line.split("=>").nth(1)?.split_whitespace().next()?;
    Some(format!(
        "rr1---sn-{}.googlevideo.com",
        encode_video_node(name)?
    ))
}

/// Asks the redirector for this network's video node. None — the redirector didn't
/// answer, or the node name doesn't resolve.
async fn resolve_video_node(state: &DpiState, generation: u64) -> Result<Option<String>, String> {
    let client = probe_client()?;
    let fetch = async {
        match client.get(VIDEO_REDIRECTOR_URL).send().await {
            Ok(response) if response.status().is_success() => {
                crate::util::read_response_capped(response, VIDEO_MAPPING_MAX_BYTES, "video node")
                    .await
                    .ok()
            }
            _ => None,
        }
    };
    let body = tokio::select! {
        body = fetch => body,
        _ = wait_dpi_cancelled(state, generation) => {
            return Err(crate::util::i18n_error("backend.dpi.cancelled"));
        }
    };
    let Some(host) = body.and_then(|body| video_node_host(&String::from_utf8_lossy(&body))) else {
        return Ok(None);
    };
    // A name of an unexpected shape encodes into a host that doesn't exist, and then
    // the node check would fail every strategy alike. The redirector itself is
    // the safer video check in that case.
    let resolved =
        tokio::time::timeout(PROBE_TIMEOUT, tokio::net::lookup_host((host.as_str(), 443))).await;
    let exists = match resolved {
        Ok(Ok(mut addrs)) => addrs.next().is_some(),
        _ => false,
    };
    if !dpi_operation_current(state, generation) {
        return Err(crate::util::i18n_error("backend.dpi.cancelled"));
    }
    Ok(exists.then(|| format!("https://{host}/generate_204")))
}

/// One request with a fresh connection. Some(latency) — the target answered.
async fn autotest_probe(
    state: &DpiState,
    generation: u64,
    url: &str,
) -> Result<Option<u64>, String> {
    // A new client for each request. A shared reqwest::Client keeps a connection
    // pool: after the first success the following strategies reuse
    // the already established TCP+TLS, desync plays no part in it, and every single one
    // got "passed". DPI cuts exactly the connection establishment —
    // so only a fresh handshake should be measured.
    let client = probe_client()?;
    let t0 = Instant::now();
    let ok = tokio::select! {
        response = client.get(url).send() => match response {
            Ok(r) => r.status().is_success() || r.status().is_redirection(),
            Err(_) => false,
        },
        _ = wait_dpi_cancelled(state, generation) => {
            return Err(crate::util::i18n_error("backend.dpi.cancelled"));
        }
    };
    Ok(ok.then(|| t0.elapsed().as_millis() as u64))
}

/// Brings up winws for one autotest run and publishes it in the state, so dpi_stop/exit
/// can cancel and reap it. Ok(false) — the engine didn't come up.
async fn autotest_start_engine(
    state: &DpiState,
    generation: u64,
    exe: &Path,
    bin: &Path,
    args: &[String],
    log_writer: Option<&Arc<Mutex<DpiLogWriter>>>,
    label: &str,
) -> Result<bool, String> {
    // The engine gets a second attempt: "driver busy" is a racy state,
    // not a property of the strategy, and one such miss struck a working
    // profile out of tuning entirely.
    for attempt in 0..AUTOTEST_ENGINE_ATTEMPTS {
        let mut cmd = std::process::Command::new(exe);
        cmd.args(args).current_dir(bin);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        if let Some(writer) = log_writer {
            writer
                .lock_recover()
                .append(format!("\n=== autotest: {label} (try {}) ===\n", attempt + 1).as_bytes());
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
        }
        let mut child = match cmd.spawn() {
            Ok(c) => {
                // Auto-tuning brings up the same winws with the driver: an orphan of
                // it fights over WinDivert just like one of dpi_start.
                crate::job_guard::bind_pid(c.id());
                c
            }
            Err(e) => {
                if let Some(writer) = log_writer {
                    writer
                        .lock_recover()
                        .append(format!("spawn winws: {e}\n").as_bytes());
                }
                dpi_sleep_or_cancel(state, generation, AUTOTEST_ENGINE_SETTLE).await?;
                continue;
            }
        };
        if let Some(writer) = log_writer {
            if let Some(stdout) = child.stdout.take() {
                spawn_dpi_log_pipe(stdout, writer.clone());
            }
            if let Some(stderr) = child.stderr.take() {
                spawn_dpi_log_pipe(stderr, writer.clone());
            }
        }
        {
            let control = state.control.lock_recover();
            if control.generation != generation || control.operation.is_none() {
                drop(control);
                let _ = terminate_child_bounded(&mut child, "winws autotest");
                return Err(crate::util::i18n_error("backend.dpi.cancelled"));
            }
            *state.child.lock_recover() = Some(child);
        }
        state.driver_loaded.store(true, Ordering::SeqCst);
        dpi_sleep_or_cancel(state, generation, Duration::from_millis(700)).await?;
        remember_owned_driver_services(state, bin);

        // winws may have died on a bad argument or a busy driver. Without this
        // check a dead strategy counted as working: the request still
        // goes through if the site is open at the ISP anyway.
        let alive = {
            let mut guard = state.child.lock_recover();
            match guard.as_mut() {
                Some(child) => !matches!(child.try_wait(), Ok(Some(_))),
                None => false,
            }
        };
        if alive {
            return Ok(true);
        }
        *state.child.lock_recover() = None;
        dpi_sleep_or_cancel(state, generation, AUTOTEST_ENGINE_SETTLE).await?;
    }
    Ok(false)
}

// First-pass result of a strategy that opened at least one target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScreenScore {
    strategy: usize,
    covered: usize,
    // Sum over the opened targets.
    latency_ms: u64,
}

// Finals result of a strategy.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FinalScore {
    strategy: usize,
    // Successful requests over all rounds and targets.
    ok: usize,
    // Targets that opened in most rounds.
    targets_open: usize,
    // None — the run had no video check (a manual check of one site).
    video_ok: Option<bool>,
    median_ms: Option<u64>,
}

fn median_ms(samples: &mut [u64]) -> Option<u64> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_unstable();
    let mid = samples.len() / 2;
    Some(if samples.len() % 2 == 1 {
        samples[mid]
    } else {
        (samples[mid - 1] + samples[mid]) / 2
    })
}

/// Candidates for the finals: the fastest strategies among those with the best
/// coverage, plus the current one if its coverage is just as good — otherwise it
/// couldn't keep its place.
fn pick_finalists(scores: &[ScreenScore], current: Option<usize>, limit: usize) -> Vec<usize> {
    let Some(top) = scores.iter().map(|s| s.covered).max().filter(|&c| c > 0) else {
        return Vec::new();
    };
    let mut group: Vec<&ScreenScore> = scores.iter().filter(|s| s.covered == top).collect();
    group.sort_by_key(|s| (s.latency_ms, s.strategy));
    let mut out: Vec<usize> = group.iter().take(limit).map(|s| s.strategy).collect();
    if let Some(current) = current {
        if !out.contains(&current) && group.iter().any(|s| s.strategy == current) {
            out.push(current);
        }
    }
    out
}

/// Winner of the finals: the most successful requests, then the lowest median.
/// The current strategy keeps its place when it is just as reliable and within the
/// noise margin, otherwise two runs on the same network recommend different profiles.
/// The flag is true when the current strategy was kept over a faster one.
fn rank_finals(scores: &[FinalScore], current: Option<usize>) -> Option<(&FinalScore, bool)> {
    let best = scores.iter().filter(|s| s.ok > 0).min_by_key(|s| {
        (
            std::cmp::Reverse(s.ok),
            s.median_ms.unwrap_or(u64::MAX),
            s.strategy,
        )
    })?;
    let kept = current
        .filter(|&c| c != best.strategy)
        .and_then(|c| scores.iter().find(|s| s.strategy == c))
        .filter(|c| c.ok == best.ok)
        .filter(|c| match (c.median_ms, best.median_ms) {
            (Some(cm), Some(bm)) => {
                let margin = AUTOTEST_KEEP_MARGIN_MS.max(bm * AUTOTEST_KEEP_MARGIN_PCT / 100);
                cm <= bm.saturating_add(margin)
            }
            _ => false,
        });
    Some(match kept {
        Some(current) => (current, true),
        None => (best, false),
    })
}

fn video_status(video_ok: Option<bool>) -> &'static str {
    match video_ok {
        Some(true) => "ok",
        Some(false) => "failed",
        None => "skipped",
    }
}

/// Goes through the non-experimental strategies: brings up winws with each, probes all
/// targets once with a fresh connection each. The best of this pass by coverage
/// (up to AUTOTEST_FINALISTS, plus the current strategy) go to the finals: several
/// rounds over the same targets plus the YouTube video node, ranked by successful
/// requests and then by median latency. Progress goes out as the "dpi:autotest"
/// event, winws output goes to dpi-autotest.log. winws stays off after the test; the
/// frontend applies the choice and restores the previous engine state.
///
/// IMPORTANT: pointless in TUN — there the probe goes into the tunnel bypassing winws, and the frontend
/// doesn't allow such a run. In proxy/systemProxy the probe bypasses the system proxy
/// (probe_client), so it measures the real channel. Requires elevation.
#[tauri::command]
pub async fn dpi_autotest(
    app: AppHandle,
    state: State<'_, DpiState>,
    test_url: Option<String>,
    monkey: bool,
    logs_disabled: Option<bool>,
    current: Option<String>,
) -> Result<serde_json::Value, String> {
    let logs_disabled = logs_disabled.unwrap_or(false);
    let generation = begin_dpi_operation(&state, "autotest")?;
    let _operation = DpiOperationGuard {
        state: &state,
        generation,
    };
    // Kill the current winws without changing the generation: autotest now owns
    // the lifecycle and publishes each test child in the state, so dpi_stop/exit
    // can cancel and reap it.
    stop_managed_child(&state, "winws")?;
    // A single user URL replaces the whole set: a manual check of
    // a specific site is exactly one target, not an addition to the defaults.
    let custom_url = test_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let targets: Vec<String> = match &custom_url {
        Some(url) => vec![url.clone()],
        None => AUTOTEST_TARGETS.iter().map(|u| u.to_string()).collect(),
    };

    // The data mutex is held only while preparing files. Running the strategies takes
    // minutes, and under the shared lock it froze the whole DPI section together with
    // dpi_set_active_vpn_endpoint — which the VPN autostart waits for.
    let (strategies, bin, exe, bindata_s, lists, lists_s) = {
        let _data = state.data.lock().await;
        // EXP is available for manual selection, but an experimental profile must not
        // automatically become the autotest recommendation.
        let active = load_strategies(&app)?;
        let bin = bin_dir(&app, monkey)?;
        let exe = bin.join("winws.exe");
        if !exe.exists() {
            return Err(crate::util::i18n_error_with(
                "backend.dpi.winwsMissing",
                &[("path", &exe.display().to_string())],
            ));
        }
        let lists = ensure_lists(&app)?;
        // The run always goes in "All sites": it measures the strategy itself on test
        // domains, and in "Blocked only" they aren't in the autolist yet — the engine wouldn't
        // apply desync to a single request and all strategies would look the same.
        write_ipset_mode(&app, &lists, "any")?;
        let bindata = ensure_bindata(&app, &active)?;
        let bindata_s = strip_verbatim(&bindata.to_string_lossy());
        let lists_s = strip_verbatim(&lists.to_string_lossy());
        let strategies: Vec<Strategy> = active
            .strategies
            .into_iter()
            .filter(|strategy| !strategy.experimental)
            .collect();
        (strategies, bin, exe, bindata_s, lists, lists_s)
    };
    let exclusion = active_vpn_exclusion_args(&lists);
    // winws output for the run. Without it a strategy failure is indistinguishable from the
    // engine not coming up at all: in the report both looked like "didn't
    // pass", and there was nothing to diagnose with.
    let log_writer = if logs_disabled {
        None
    } else {
        dpi_autotest_log_file(&app)
            .as_deref()
            .and_then(prepare_dpi_log)
    };
    let total = strategies.len();
    let current_idx = current
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .and_then(|c| strategies.iter().position(|s| s.name == c || s.id == c));

    // The video node is looked up before the strategies, while winws is off: if the
    // redirector answers directly, every strategy is measured against the same node.
    // A manual check of one site measures exactly that site, without video.
    let mut video_node: Option<String> = None;
    if custom_url.is_none() {
        video_node = resolve_video_node(&state, generation).await?;
    }
    let mut node_attempts = 0usize;

    // argv of every strategy that came up, for the finals.
    let mut prepared: Vec<Option<Vec<String>>> = vec![None; total];
    let mut screen: Vec<ScreenScore> = Vec::new();
    let mut passed = 0usize;
    // Strategies on which the engine didn't come up. This is not "the strategy doesn't work",
    // and the report must tell them apart, otherwise a race for the driver reads as a failure of
    // half the set.
    let mut engine_failed = 0usize;

    for (idx, strat) in strategies.iter().enumerate() {
        if !dpi_operation_current(&state, generation) {
            return Err(crate::util::i18n_error("backend.dpi.cancelled"));
        }
        let _ = app.emit(
            "dpi:autotest",
            AutotestProgress {
                i: idx + 1,
                total,
                name: strat.name.clone(),
                stage: "screen",
            },
        );
        // The same allowlist as dpi_start, right before substitution.
        if let Err(error) = validate_strategy_args(&strat.args) {
            if let Some(writer) = log_writer.as_ref() {
                writer
                    .lock_recover()
                    .append(format!("skip {}: {error}\n", strat.name).as_bytes());
            }
            continue;
        }
        let args: Vec<String> = strat
            .args
            .iter()
            .map(|a| subst(a, &bindata_s, &lists_s, "12", "12"))
            .collect();
        // Exactly the same argv that dpi_start will build: otherwise autotest checks something other
        // than what will be launched later (the node exclusion changes profile matching).
        let args = spread_exclusion_across_sections(args, &exclusion);
        let alive = autotest_start_engine(
            &state,
            generation,
            &exe,
            &bin,
            &args,
            log_writer.as_ref(),
            &strat.name,
        )
        .await?;
        if !alive {
            engine_failed += 1;
            continue;
        }

        let mut ok_count = 0usize;
        let mut lat = 0u64;
        // All targets are checked: stopping at the first failure made the score
        // order-dependent — a strategy that fixes YouTube but not
        // Discord was indistinguishable from a completely broken one.
        for target in &targets {
            if let Some(ms) = autotest_probe(&state, generation, target).await? {
                ok_count += 1;
                lat = lat.saturating_add(ms);
            }
        }
        // The redirector didn't answer without desync: a strategy that opened every
        // target is the best chance to reach it.
        if custom_url.is_none()
            && video_node.is_none()
            && ok_count == targets.len()
            && node_attempts < VIDEO_NODE_ATTEMPTS
        {
            node_attempts += 1;
            video_node = resolve_video_node(&state, generation).await?;
        }

        if !dpi_operation_current(&state, generation) {
            return Err(crate::util::i18n_error("backend.dpi.cancelled"));
        }
        stop_managed_child(&state, "winws autotest")?;

        prepared[idx] = Some(args);
        if ok_count > 0 {
            if ok_count == targets.len() {
                passed += 1;
            }
            screen.push(ScreenScore {
                strategy: idx,
                covered: ok_count,
                latency_ms: lat,
            });
        }
        // pause so the driver can detach between runs
        dpi_sleep_or_cancel(&state, generation, AUTOTEST_ENGINE_SETTLE).await?;
    }

    // Finals. One request per target can't tell apart strategies that all opened
    // everything: the winner was decided by milliseconds of jitter, and two runs on the
    // same network recommended different profiles. The best candidates are measured
    // again over several rounds, now with the video check. Without a resolved node the
    // redirector itself is that check: the same googlevideo.com name for DPI.
    let video_target = custom_url
        .is_none()
        .then(|| video_node.unwrap_or_else(|| VIDEO_REDIRECTOR_URL.to_string()));
    let mut final_targets = targets.clone();
    final_targets.extend(video_target.iter().cloned());
    let finalists = pick_finalists(&screen, current_idx, AUTOTEST_FINALISTS);
    let mut finals: Vec<FinalScore> = Vec::new();

    for (n, &si) in finalists.iter().enumerate() {
        if !dpi_operation_current(&state, generation) {
            return Err(crate::util::i18n_error("backend.dpi.cancelled"));
        }
        let strat = &strategies[si];
        let Some(args) = prepared[si].as_ref() else {
            continue;
        };
        let _ = app.emit(
            "dpi:autotest",
            AutotestProgress {
                i: n + 1,
                total: finalists.len(),
                name: strat.name.clone(),
                stage: "final",
            },
        );
        let alive = autotest_start_engine(
            &state,
            generation,
            &exe,
            &bin,
            args,
            log_writer.as_ref(),
            &strat.name,
        )
        .await?;
        if !alive {
            continue;
        }

        let mut opened = vec![0usize; final_targets.len()];
        let mut failed = vec![0usize; final_targets.len()];
        let mut samples: Vec<u64> = Vec::new();
        for _ in 0..AUTOTEST_FINAL_ROUNDS {
            for (ti, target) in final_targets.iter().enumerate() {
                // Misses in half the rounds already decide the target: a blocked one
                // costs a full timeout per round, and another round adds nothing.
                if failed[ti] * 2 >= AUTOTEST_FINAL_ROUNDS {
                    continue;
                }
                match autotest_probe(&state, generation, target).await? {
                    Some(ms) => {
                        opened[ti] += 1;
                        samples.push(ms);
                    }
                    None => failed[ti] += 1,
                }
            }
        }

        if !dpi_operation_current(&state, generation) {
            return Err(crate::util::i18n_error("backend.dpi.cancelled"));
        }
        stop_managed_child(&state, "winws autotest")?;

        let majority = |n: usize| n * 2 > AUTOTEST_FINAL_ROUNDS;
        finals.push(FinalScore {
            strategy: si,
            ok: opened.iter().sum(),
            targets_open: opened.iter().filter(|&&n| majority(n)).count(),
            video_ok: video_target
                .as_ref()
                .map(|_| opened.last().is_some_and(|&n| majority(n))),
            median_ms: median_ms(&mut samples),
        });
        dpi_sleep_or_cancel(&state, generation, AUTOTEST_ENGINE_SETTLE).await?;
    }

    if let Some((winner, kept)) = rank_finals(&finals, current_idx) {
        let strat = &strategies[winner.strategy];
        return Ok(serde_json::json!({
            "best_id": strat.id, "best_name": strat.name, "passed": passed, "total": total,
            // The median of single requests: what the UI labels as latency.
            "latency_ms": winner.median_ms,
            "targets": final_targets.len(), "best_targets": winner.targets_open,
            "engine_failed": engine_failed,
            "video": video_status(winner.video_ok),
            "kept_current": kept,
        }));
    }

    // No finals result (the engine didn't come up for any finalist, or nothing opened
    // in the finals): the leader of the first pass.
    let leader = screen
        .iter()
        .min_by_key(|s| (std::cmp::Reverse(s.covered), s.latency_ms, s.strategy));
    match leader {
        // latency_ms is the sum over the opened targets, while the UI labels the number as
        // latency. We return the average per check, otherwise three successful probes look
        // like one three times slower.
        Some(s) => {
            let strat = &strategies[s.strategy];
            Ok(serde_json::json!({
                "best_id": strat.id, "best_name": strat.name, "passed": passed, "total": total,
                "latency_ms": s.latency_ms / s.covered.max(1) as u64,
                "targets": targets.len(), "best_targets": s.covered,
                "engine_failed": engine_failed,
                "video": "skipped", "kept_current": false,
            }))
        }
        None => Ok(serde_json::json!({
            "best_id": null, "best_name": null, "passed": 0, "total": total,
            "latency_ms": null, "targets": targets.len(), "best_targets": 0,
            "engine_failed": engine_failed,
            "video": "skipped", "kept_current": false,
        })),
    }
}

pub fn force_cleanup(state: &DpiState) {
    let _ = stop_dpi_runtime(state, "winws");
}

/// Remove the WinDivert/Monkey driver kernel services. REQUIRES admin rights — call
/// only from an elevated process (with DPI running the app is already elevated: winws is our
/// child and inherits the token). On a kernel driver `sc stop` is blocking: it returns
/// control only AFTER the driver is unloaded from the kernel — and only then is the lock released on
/// `WinDivert64.sys`/`Monkey64.sys` in the install directory. `stop` goes before `delete`:
/// since stop is synchronous, by the time of delete the driver is already unloaded and no orphaned service
/// hangs in the kernel (otherwise it can't be removed without a reboot). The service name differs between winws builds —
/// WinDivert or WinDivert14 (as Flowseal's service.bat cleans up), plus Monkey (our
/// renamed variant, see bin_dir) — we remove them all.
#[cfg(target_os = "windows")]
fn run_sc_bounded(sc: &str, verb: &str, service: &str, deadline: Instant) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if Instant::now() >= deadline {
        return Err(crate::util::i18n_error("backend.dpi.driverTimeout"));
    }
    let mut child = std::process::Command::new(sc)
        .args([verb, service])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("sc {verb} {service}: {e}"))?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(-1);
                let idempotent = (verb == "stop" && matches!(code, 1060 | 1062))
                    || (verb == "delete" && matches!(code, 1060 | 1072));
                return if status.success() || idempotent {
                    Ok(())
                } else {
                    Err(format!("sc {verb} {service} exited with code {code}"))
                };
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                return Err(format!(
                    "sc {verb} {service} did not finish within the 3 second limit"
                ));
            }
            Err(e) => return Err(format!("sc {verb} {service}: {e}")),
        }
    }
}

#[cfg(target_os = "windows")]
pub fn unload_driver_services(state: &DpiState) -> Result<(), String> {
    let sc = system32("sc.exe");
    let services = state.owned_services.lock_recover().clone();
    let deadline = Instant::now() + DRIVER_UNLOAD_TIMEOUT;
    for svc in &services {
        run_sc_bounded(&sc, "stop", svc, deadline)?;
        run_sc_bounded(&sc, "delete", svc, deadline)?;
    }
    // Ownership is erased only after full confirmation. On error the whole
    // list stays for a safe repeated unload (the operations are idempotent).
    state.owned_services.lock_recover().clear();
    Ok(())
}
#[cfg(not(target_os = "windows"))]
pub fn unload_driver_services(_state: &DpiState) -> Result<(), String> {
    Ok(())
}

/// Full engine unload: kill winws AND remove the kernel driver. Called before
/// an OTA update (the command below) and when the driver mode changes. Otherwise the driver stays
/// resident in the kernel, its .sys locks a file in the install directory, and the next
/// (re)installation fails with "Cannot open file for writing". First we
/// confirm that winws has exited in a short bounded loop — the handle to
/// \\.\WinDivert is closed BEFORE `sc stop`, so the driver unloads on the first
/// try. All sc commands share one common three-second deadline.
pub fn full_unload(state: &DpiState) -> Result<(), String> {
    stop_dpi_runtime(state, "winws")?;
    unload_driver_services(state)?;
    state.driver_loaded.store(false, Ordering::SeqCst);
    Ok(())
}

/// true if the Windows session is currently ending (shutdown/logoff/reboot).
#[cfg(target_os = "windows")]
fn session_ending() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    // SM_SHUTTINGDOWN != 0 throughout the OS shutdown sequence.
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}
#[cfg(not(target_os = "windows"))]
fn session_ending() -> bool {
    false
}

/// Unload on app exit (lib.rs RunEvent::Exit). Unlike
/// full_unload, here we call `sc.exe` ONLY when it is justified:
///  - the OS is shutting down/logging off → skip: the driver unloads anyway on
///    reboot, and an `sc.exe` launched in a session being torn down can't
///    initialize and shows a 0xc0000142 error window (user report —
///    "pops up when shutting down the PC");
///  - DPI wasn't brought up in this session (driver_loaded=false) → nothing to remove,
///    and the unconditional 6 `sc.exe` launches on every exit were unnecessary.
///
/// The "release the .sys lock to reinstall without a reboot" case is covered by the explicit
/// dpi_unload_driver command (the frontend calls it before OTA) — that one does full_unload.
pub fn cleanup_on_exit(state: &DpiState) {
    force_cleanup(state); // kill the winws child — no sc.exe, always safe
    if session_ending() {
        return;
    }
    if state.driver_loaded.load(Ordering::SeqCst) && unload_driver_services(state).is_ok() {
        state.driver_loaded.store(false, Ordering::SeqCst);
    }
}

/// Command from the frontend: before an OTA update and when the driver mode changes (WinDivert↔
/// Monkey). A thin wrapper over full_unload — kept as a #[tauri::command] under
/// invoke("dpi_unload_driver").
#[tauri::command]
pub async fn dpi_unload_driver(app: AppHandle) -> Result<(), String> {
    // Like dpi_stop: a confirmed winws stop plus blocking `sc
    // stop/delete` (on a kernel driver sc returns control only after
    // unloading) add up to seconds. The frontend calls this before OTA — there is no reason for the
    // window to freeze during the unload.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DpiState>();
        full_unload(&state)
    })
    .await
    .map_err(|e| format!("waiting for the DPI driver unload failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // The channel signature is checked when the bundle is loaded, but service files then
    // sit unpacked in a user directory and are read offline already
    // without a check. A line appended there must not make it into the system hosts.
    #[test]
    fn hosts_body_rejects_anything_but_ip_and_domains() {
        let good =
            "# comment\n1.2.3.4 discord.com\n2606:4700::1111 cdn.example.org extra.example\n";
        assert_eq!(
            sanitize_hosts_body(good).unwrap(),
            "# comment\n1.2.3.4 discord.com\n2606:4700::1111 cdn.example.org extra.example"
        );

        for planted in [
            "127.0.0.1 bank.example\nnot-an-ip evil.example",
            "1.2.3.4",
            "1.2.3.4 -bad-.example",
            "1.2.3.4 domain with space/slash",
            "cmd.exe /c whoami",
        ] {
            assert!(
                sanitize_hosts_body(planted).is_err(),
                "подменённая строка прошла: {planted}"
            );
        }
    }

    #[test]
    fn hosts_domain_shape() {
        assert!(valid_hosts_domain("discord.com"));
        assert!(valid_hosts_domain("a_b.example-1.org"));
        assert!(!valid_hosts_domain(""));
        assert!(!valid_hosts_domain("double..dot"));
        assert!(!valid_hosts_domain("-lead.example"));
        assert!(!valid_hosts_domain("trail-.example"));
        assert!(!valid_hosts_domain(&format!("{}.example", "x".repeat(64))));
    }

    #[test]
    fn strip_verbatim_forms() {
        assert_eq!(strip_verbatim(r"\\?\C:\dir\winws.exe"), r"C:\dir\winws.exe");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(strip_verbatim(r"C:\plain\path"), r"C:\plain\path");
        assert_eq!(strip_verbatim("/unix/style"), "/unix/style");
    }

    #[test]
    fn subst_replaces_placeholders() {
        let sep = MAIN_SEPARATOR;
        let out = subst("%BIN%tls.bin", "BIN", "LST", "12", "34");
        assert_eq!(out, format!("BIN{sep}tls.bin"));
        let lst = subst("%LISTS%list-general.txt", "BIN", "LST", "12", "34");
        assert_eq!(lst, format!("LST{sep}list-general.txt"));
        // Game filters: TCP/UDP are separate, while legacy %GameFilter% takes TCP.
        assert_eq!(
            subst("--wf-tcp=%GameFilterTCP%", "B", "L", "80", "443"),
            "--wf-tcp=80"
        );
        assert_eq!(
            subst("--wf-udp=%GameFilterUDP%", "B", "L", "80", "443"),
            "--wf-udp=443"
        );
        assert_eq!(subst("%GameFilter%", "B", "L", "80", "443"), "80");
    }

    #[test]
    fn active_vpn_exclusion_paths_are_joined_as_single_arguments() {
        let lists = PathBuf::from("C:\\Ninety Data\\Данные\\lists");
        let args = active_vpn_exclusion_args(&lists);
        assert!(!args[0].contains("listsactive-vpn"));
        assert!(!args[1].contains("listsactive-vpn"));
        assert!(args[1].ends_with(&format!("lists{MAIN_SEPARATOR}active-vpn-ip.txt")));
        assert!(args[0].contains("Ninety Data"));
        assert!(args[0].contains("Данные"));
    }

    #[cfg(windows)]
    #[test]
    fn active_vpn_exclusion_paths_use_windows_separator() {
        let args = active_vpn_exclusion_args(Path::new(r"C:\Ninety Data\dpi\lists"));
        assert!(args[1].ends_with(r"lists\active-vpn-ip.txt"));
    }

    // Regression: the active node exclusion was appended to the end of the line and covered
    // only the last section. VLESS goes over TCP:443 — that is, through another section,
    // and winws desynced traffic to our own server.
    #[test]
    fn active_vpn_exclusion_lands_in_every_section() {
        let exclusion = [
            "--hostlist-exclude=D".to_string(),
            "--ipset-exclude=I".to_string(),
        ];
        let args = vec![
            "--filter-udp=443".to_string(),
            "--hostlist=G".to_string(),
            "--dpi-desync=fake".to_string(),
            "--new".to_string(),
            "--filter-tcp=443".to_string(),
            "--hostlist-domains=discord.media".to_string(),
            "--new".to_string(),
            "--filter-tcp=1024-65535".to_string(),
            "--hostlist-auto=A".to_string(),
        ];
        let out = spread_exclusion_across_sections(args, &exclusion);

        // Three sections, each already has a hostlist → the exclusion appears in full three times.
        assert_eq!(
            out.iter()
                .filter(|a| a.as_str() == "--hostlist-exclude=D")
                .count(),
            3
        );
        assert_eq!(
            out.iter()
                .filter(|a| a.as_str() == "--ipset-exclude=I")
                .count(),
            3
        );

        // And exactly BEFORE the separator, otherwise the exclusion leaks into another section.
        for (i, a) in out.iter().enumerate() {
            if a == "--new" {
                assert_eq!(out[i - 2], "--hostlist-exclude=D");
                assert_eq!(out[i - 1], "--ipset-exclude=I");
            }
        }
        assert_eq!(out.last().unwrap(), "--ipset-exclude=I");
    }

    // A section without hostlists (Discord voice, Game Filter) catches traffic without
    // a known host. A hostlist in it prevents the profile from matching at all —
    // only the ipset exclusion goes there.
    #[test]
    fn active_vpn_exclusion_skips_hostlist_in_hostless_sections() {
        let exclusion = [
            "--hostlist-exclude=D".to_string(),
            "--ipset-exclude=I".to_string(),
        ];
        let args = vec![
            "--filter-udp=443".to_string(),
            "--hostlist=G".to_string(),
            "--new".to_string(),
            "--filter-udp=50000-50100".to_string(),
            "--filter-l7=discord,stun".to_string(),
            "--new".to_string(),
            "--filter-udp=12".to_string(),
            "--dpi-desync-any-protocol=1".to_string(),
        ];
        let out = spread_exclusion_across_sections(args, &exclusion);

        assert_eq!(
            out,
            vec![
                "--filter-udp=443",
                "--hostlist=G",
                "--hostlist-exclude=D",
                "--ipset-exclude=I",
                "--new",
                "--filter-udp=50000-50100",
                "--filter-l7=discord,stun",
                "--ipset-exclude=I",
                "--new",
                "--filter-udp=12",
                "--dpi-desync-any-protocol=1",
                "--ipset-exclude=I",
            ]
        );
    }

    // The game filter must work in any IPset mode. The Game Filter sections
    // go to their own empty ipset-game.txt, the rest stay on the shared
    // ipset-all.txt, which is controlled by the IPset switch.
    #[test]
    fn game_sections_get_their_own_ipset() {
        let lists = Path::new("L");
        let all = format!("--ipset={}", lists.join("ipset-all.txt").to_string_lossy());
        let game = format!("--ipset={}", lists.join("ipset-game.txt").to_string_lossy());
        let args = vec![
            "--filter-tcp=80,443".to_string(),
            all.clone(),
            "--new".to_string(),
            "--filter-tcp=1024-65535".to_string(),
            all.clone(),
            "--new".to_string(),
            "--filter-udp=1024-65535".to_string(),
            all.clone(),
            "--dpi-desync-any-protocol=1".to_string(),
        ];

        let out = ungate_game_ipset(args, lists, "1024-65535", "1024-65535");

        assert_eq!(
            out,
            vec![
                "--filter-tcp=80,443".to_string(),
                all.clone(),
                "--new".to_string(),
                "--filter-tcp=1024-65535".to_string(),
                game.clone(),
                "--new".to_string(),
                "--filter-udp=1024-65535".to_string(),
                game,
                "--dpi-desync-any-protocol=1".to_string(),
            ]
        );
    }

    // Lifting the gate must not affect exclusions: the active VPN node is protected
    // via --ipset-exclude, and replacing the main ipset doesn't touch it.
    #[test]
    fn game_ipset_ungate_keeps_exclusions() {
        let lists = Path::new("L");
        let all = format!("--ipset={}", lists.join("ipset-all.txt").to_string_lossy());
        let game = format!("--ipset={}", lists.join("ipset-game.txt").to_string_lossy());
        let args = vec![
            "--filter-udp=1024-65535".to_string(),
            all,
            "--ipset-exclude=EXCL".to_string(),
        ];

        let out = ungate_game_ipset(args, lists, "1024-65535", "1024-65535");

        assert_eq!(
            out,
            vec![
                "--filter-udp=1024-65535".to_string(),
                game,
                "--ipset-exclude=EXCL".to_string(),
            ]
        );
    }

    // A strategy channel update recreates the list directory: everything accumulated
    // locally is carried over by explicit enumeration. The autolist is accumulated data too.
    #[test]
    fn auto_hostlist_survives_a_channel_update() {
        assert!(LOCAL_LIST_FILES.contains(&AUTO_HOSTLIST_FILE));
        assert!(!CHANNEL_LIST_FILES.contains(&AUTO_HOSTLIST_FILE));
    }

    // The "Blocked only" mode removes the IP gate from a section and attaches the autolist
    // together with the detection thresholds.
    #[test]
    fn auto_mode_swaps_ipset_for_autohostlist() {
        let lists = Path::new("L");
        let all = format!("--ipset={}", lists.join("ipset-all.txt").to_string_lossy());
        let args = vec![
            "--filter-tcp=80,443,8443".to_string(),
            all,
            "--dpi-desync=fake".to_string(),
        ];

        let out = gate_by_autohostlist(args, lists);

        assert_eq!(
            out,
            vec![
                "--filter-tcp=80,443,8443".to_string(),
                format!(
                    "--hostlist-auto={}",
                    lists.join(AUTO_HOSTLIST_FILE).to_string_lossy()
                ),
                "--hostlist-auto-fail-threshold=3".to_string(),
                "--hostlist-auto-retrans-threshold=3".to_string(),
                "--dpi-desync=fake".to_string(),
            ]
        );
    }

    // Game sections have no host by definition: the autolist has nothing to decide there,
    // and a profile with it would always win. The IP gate stays as it was.
    #[test]
    fn auto_mode_keeps_any_protocol_sections_on_ipset() {
        let lists = Path::new("L");
        let all = format!("--ipset={}", lists.join("ipset-all.txt").to_string_lossy());
        let args = vec![
            "--filter-tcp=80,443".to_string(),
            all.clone(),
            "--new".to_string(),
            "--filter-tcp=1024-65535".to_string(),
            all.clone(),
            "--dpi-desync-any-protocol=1".to_string(),
        ];

        let out = gate_by_autohostlist(args, lists);

        assert_eq!(out[out.len() - 2], all);
        assert!(!out[..out.len() - 2].contains(&all));
        assert!(out.iter().any(|a| a.starts_with("--hostlist-auto=")));
    }

    // The autolist is a regular hostlist collection, so the active VPN node
    // must be in this section's exclusions: without this the bypass would hook
    // our own VLESS as soon as the node's domain once looked blocked.
    #[test]
    fn auto_mode_section_still_gets_vpn_exclusion() {
        let lists = Path::new("L");
        let all = format!("--ipset={}", lists.join("ipset-all.txt").to_string_lossy());
        let args = vec!["--filter-tcp=80,443".to_string(), all];

        let out = spread_exclusion_across_sections(
            gate_by_autohostlist(args, lists),
            &active_vpn_exclusion_args(lists),
        );

        assert!(out.iter().any(|a| a.starts_with("--hostlist-auto=")));
        assert!(out
            .iter()
            .any(|a| a.contains("--hostlist-exclude=") && a.contains("active-vpn-domain.txt")));
    }

    // winws maintains the file, appending to the end: we show the user the newest first,
    // without duplicates and comments.
    #[test]
    fn auto_domains_are_newest_first_without_dupes() {
        let txt = "# comment\nold.example\nDota2.ru\n\ndota2.ru\nfresh.example\n";
        assert_eq!(
            auto_domains_from(txt),
            vec![
                "fresh.example".to_string(),
                "dota2.ru".to_string(),
                "old.example".to_string(),
            ]
        );
    }

    // The --hostlist-auto-* pair doesn't create a hostlist collection and must not
    // count as a sign of a section with a known host.
    #[test]
    fn hostlist_arg_detection_ignores_auto_tuning_flags() {
        assert!(is_hostlist_arg("--hostlist=x"));
        assert!(is_hostlist_arg("--hostlist-exclude=x"));
        assert!(is_hostlist_arg("--hostlist-domains=a,b"));
        assert!(is_hostlist_arg("--hostlist-exclude-domains=a,b"));
        assert!(is_hostlist_arg("--hostlist-auto=x"));
        assert!(!is_hostlist_arg("--hostlist-auto-fail-threshold=3"));
        assert!(!is_hostlist_arg("--hostlist-auto-retrans-threshold=3"));
        assert!(!is_hostlist_arg("--filter-l7=discord,stun"));
    }

    // A strategy without --new is one section, the exclusion appears exactly once.
    #[test]
    fn active_vpn_exclusion_single_section_is_not_duplicated() {
        let exclusion = [
            "--hostlist-exclude=D".to_string(),
            "--ipset-exclude=I".to_string(),
        ];
        let out = spread_exclusion_across_sections(
            vec!["--filter-tcp=443".to_string(), "--hostlist=G".to_string()],
            &exclusion,
        );
        assert_eq!(
            out,
            vec![
                "--filter-tcp=443",
                "--hostlist=G",
                "--hostlist-exclude=D",
                "--ipset-exclude=I"
            ]
        );
    }

    #[test]
    fn referenced_bins_collects_only_bin_placeholders() {
        let strat = vec![
            Strategy {
                id: "a".into(),
                name: String::new(),
                desc: String::new(),
                experimental: false,
                args: vec![
                    "--fake-tls=%BIN%tls_clienthello_www_google_com.bin".into(),
                    "--dpi-desync-fake-quic=%BIN%quic_initial_www_google_com.bin".into(),
                    "--filter-tcp=443".into(),
                ],
            },
            Strategy {
                id: "b".into(),
                name: String::new(),
                desc: String::new(),
                experimental: false,
                // %LISTS% and a bare %BIN% without .bin must not get into the set.
                args: vec!["%LISTS%list-general.txt".into(), "%BIN%".into()],
            },
        ];
        let need = referenced_bins(&strat);
        assert_eq!(need.len(), 2);
        assert!(need.contains("tls_clienthello_www_google_com.bin"));
        assert!(need.contains("quic_initial_www_google_com.bin"));
    }

    #[test]
    fn fake_filename_validation_rejects_paths_and_active_slots() {
        assert!(valid_fake_filename("quic_initial_example_com.bin"));
        assert!(valid_fake_filename("stun2.bin"));
        for invalid in [
            "",
            "ACTIVE_DISCORD_UDP.bin",
            "active_game_udp.bin",
            "../fake.bin",
            r"..\fake.bin",
            r"C:\fake.bin",
            "/tmp/fake.bin",
            "fake.txt",
            "fake payload.bin",
        ] {
            assert!(!valid_fake_filename(invalid), "{invalid}");
        }
        assert_eq!(fake_target("discord").unwrap(), ACTIVE_DISCORD_FAKE);
        assert_eq!(fake_target("game").unwrap(), ACTIVE_GAME_FAKE);
        assert!(fake_target("other").is_err());
    }

    #[test]
    fn embedded_channel_public_keys_decode_after_exactly_one_base64_layer() {
        assert!(decode_channel_public_key(CHANNEL_DEDICATED_PUBKEY_B64).is_ok());
        assert!(decode_channel_public_key(CHANNEL_LEGACY_PUBKEY_B64).is_ok());
    }

    fn create_test_channel_generation(dpi_data: &Path, name: &str, version: &str) -> PathBuf {
        let generation = dpi_data.join(CHANNEL_GENERATIONS_DIR).join(name);
        std::fs::create_dir_all(generation.join("lists")).unwrap();
        std::fs::create_dir_all(generation.join("bin-data")).unwrap();
        std::fs::create_dir_all(generation.join("service")).unwrap();
        std::fs::write(generation.join("strategies.json"), b"[]\n").unwrap();
        std::fs::write(generation.join("version.txt"), format!("{version}\n")).unwrap();
        for file in CHANNEL_LIST_FILES {
            std::fs::write(generation.join("lists").join(file), b"data\n").unwrap();
        }
        for file in CHANNEL_SERVICE_FILES {
            std::fs::write(generation.join("service").join(file), b"data\n").unwrap();
        }
        generation
    }

    #[test]
    fn channel_generation_is_visible_only_after_pointer_commit() {
        let root = std::env::temp_dir().join(format!(
            "ninety-dpi-generation-test-{}-{}",
            std::process::id(),
            TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let old = create_test_channel_generation(&root, "gen-100-1-0", "old");
        write_replace(
            &root.join(CHANNEL_POINTER_FILE),
            "gen-100-1-0\n",
            "test channel pointer",
        )
        .unwrap();
        assert_eq!(active_channel_generation_from_dpi(&root), Some(old.clone()));

        // A fully assembled new generation is not active yet without the pointer commit.
        let new = create_test_channel_generation(&root, "gen-200-1-0", "new");
        assert_eq!(active_channel_generation_from_dpi(&root), Some(old.clone()));

        write_replace(
            &root.join(CHANNEL_POINTER_FILE),
            "gen-200-1-0\n",
            "test channel pointer",
        )
        .unwrap();
        assert_eq!(active_channel_generation_from_dpi(&root), Some(new.clone()));

        // A damaged committed generation doesn't break the section: fallback to
        // the previous intact generation and a corrupted-pointer flag.
        std::fs::remove_file(new.join("strategies.json")).unwrap();
        let resolution = resolve_channel_generation(&root);
        assert_eq!(resolution.active, Some(old));
        assert!(resolution.pointer_broken);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn channel_pointer_rejects_path_traversal() {
        for invalid in ["", "../gen-1", "gen-1/other", r"gen-1\other", ".gen-1"] {
            assert!(!valid_channel_generation_name(invalid), "{invalid}");
        }
        assert!(valid_channel_generation_name("gen-123-456-0"));
    }

    #[test]
    fn hosts_keeps_the_original_line_endings() {
        let crlf = "# base\r\n127.0.0.1 localhost\r\n";
        let rendered = "# base\n127.0.0.1 localhost\n";
        assert_eq!(apply_hosts_line_endings(rendered, crlf), crlf);
        assert_eq!(apply_hosts_line_endings(rendered, "# base\n"), rendered);
    }

    // hosts doesn't have to be UTF-8: an ANSI comment (0xCF 0xF0 — "Пр" in
    // cp1251) and a UTF-8 "Р" at the very end (D0 A0) must survive removal of our
    // block byte for byte.
    #[test]
    fn hosts_in_any_encoding_survives_our_block_byte_for_byte() {
        let mut original = b"# \xCF\xF0\xEE\xEA\xF1\xE8\r\n127.0.0.1 localhost\r\n".to_vec();
        let foreign_len = original.len();
        original.extend_from_slice(
            format!("{HOSTS_BEGIN}\r\n1.2.3.4 a.example\r\n{HOSTS_END}\r\n").as_bytes(),
        );
        original.extend_from_slice("# Р".as_bytes());

        let text = decode_hosts_bytes(&original);
        assert!(has_managed_block(&text));
        let stripped = strip_managed_block(&text).unwrap();
        let rendered = format!("{}\n", trim_hosts_end(&stripped));
        let bytes = encode_hosts_text(&apply_hosts_line_endings(&rendered, &text)).unwrap();

        let mut expected = original[..foreign_len].to_vec();
        expected.extend_from_slice("# Р\r\n".as_bytes());
        assert_eq!(bytes, expected);
        assert!(encode_hosts_text("ok\u{100}").is_err());
    }

    #[test]
    fn strip_managed_block_removes_only_our_block() {
        let content = format!(
            "127.0.0.1 localhost\n{HOSTS_BEGIN}\n1.2.3.4 discord.com\n{HOSTS_END}\n10.0.0.1 nas\n"
        );
        let out = strip_managed_block(&content).unwrap();
        assert!(out.contains("127.0.0.1 localhost"));
        assert!(out.contains("10.0.0.1 nas"));
        assert!(!out.contains("discord.com"));
        assert!(!out.contains(HOSTS_BEGIN));
        // Idempotency: without the block the text changes only by line ending normalization.
        let again = strip_managed_block(&out).unwrap();
        assert_eq!(out, again);
    }

    #[test]
    fn strip_managed_block_rejects_unbalanced_or_duplicate_markers() {
        let open = format!("127.0.0.1 localhost\n{HOSTS_BEGIN}\n1.2.3.4 example.test\n");
        assert!(strip_managed_block(&open)
            .unwrap_err()
            .contains("without END"));

        let close = format!("127.0.0.1 localhost\n{HOSTS_END}\n");
        assert!(strip_managed_block(&close)
            .unwrap_err()
            .contains("without BEGIN"));

        let nested = format!("{HOSTS_BEGIN}\n{HOSTS_BEGIN}\n{HOSTS_END}\n{HOSTS_END}\n");
        assert!(strip_managed_block(&nested).unwrap_err().contains("nested"));

        let duplicate = format!(
            "{HOSTS_BEGIN}\n1.1.1.1 one.test\n{HOSTS_END}\n{HOSTS_BEGIN}\n2.2.2.2 two.test\n{HOSTS_END}\n"
        );
        assert!(strip_managed_block(&duplicate)
            .unwrap_err()
            .contains("several"));
    }

    #[test]
    fn count_hosts_entries_ignores_comments_and_singletons() {
        let body = "# comment\n1.2.3.4 discord.com\n\n5.6.7.8 telegram.org\nonlyonetoken\n";
        assert_eq!(count_hosts_entries(body), 2);
    }

    #[test]
    fn count_ipset_lines_ignores_comments_and_blanks() {
        let txt = "# base\n1.1.1.0/24\n\n8.8.8.0/24\n  # spaced comment\n9.9.9.9/32\n";
        assert_eq!(count_ipset_lines(txt), 3);
    }

    // A channel sync overwrites the ipset base with its service file. An empty
    // or comment-only file must not touch the base: with an empty ipset the
    // "Sites from the IP list" mode would turn into "All sites" — exactly what
    // the user picks this mode to get away from.
    #[test]
    fn empty_ipset_service_leaves_the_base_alone() {
        assert_eq!(
            ipset_base_from_service("1.2.3.0/24\r\n8.8.8.8/32\r\n").as_deref(),
            Some("1.2.3.0/24\n8.8.8.8/32\n")
        );
        assert!(ipset_base_from_service("").is_none());
        assert!(ipset_base_from_service("# only comments\n\n   \n").is_none());
    }

    // Dima typed server addresses into "Exclusions" and they did nothing: winws
    // reads that file as a hostlist. Addresses must end up in the ipset.
    #[test]
    fn exclusion_addresses_are_split_from_domains() {
        let (domains, ips) =
            split_domains_and_ips("# note\nbank.ru\n1.2.3.4\nbank.ru\n10.0.0.0/8\n1.2.3.4/32\n");
        assert_eq!(domains, "# note\nbank.ru\n");
        assert_eq!(ips, vec!["1.2.3.4/32", "10.0.0.0/8"]);
    }

    #[test]
    fn exclusion_addresses_typed_earlier_are_migrated() {
        let root = std::env::temp_dir().join(format!(
            "ninety-dpi-exclude-migrate-{}-{}",
            std::process::id(),
            TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("list-exclude-user.txt"), "bank.ru\n5.6.7.8\n").unwrap();
        std::fs::write(root.join(USER_IPSET_EXCLUDE), "9.9.9.0/24\n").unwrap();
        migrate_exclude_ips(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("list-exclude-user.txt")).unwrap(),
            "bank.ru\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(USER_IPSET_EXCLUDE)).unwrap(),
            "9.9.9.0/24\n5.6.7.8/32\n"
        );
        // Nothing left to move: the files stay as they are.
        migrate_exclude_ips(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join(USER_IPSET_EXCLUDE)).unwrap(),
            "9.9.9.0/24\n5.6.7.8/32\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dry_run_changes_the_filter_so_a_running_engine_does_not_block_it() {
        let argv = dry_run_argv(vec![
            "--wf-tcp=80,443".to_string(),
            "--filter-tcp=443".to_string(),
        ]);
        assert_eq!(
            argv,
            vec!["--dry-run", "--wf-tcp=80,443,1", "--filter-tcp=443"]
        );
        let argv = dry_run_argv(vec!["--wf-udp=443".to_string()]);
        assert_eq!(argv, vec!["--dry-run", "--wf-tcp=1", "--wf-udp=443"]);
    }

    #[test]
    fn strategy_file_names_are_safe() {
        assert_eq!(
            strategy_file_name("ALT11 + GAME"),
            "ninety-alt11---game.json"
        );
        assert_eq!(strategy_file_name("Мой"), "ninety-strategy.json");
    }

    #[test]
    fn normalize_ipset_entry_wraps_ipv4_and_ipv6() {
        assert_eq!(normalize_ipset_entry("1.2.3.4").unwrap(), "1.2.3.4/32");
        assert_eq!(
            normalize_ipset_entry("2606:4700:d0::a29f:c001").unwrap(),
            "2606:4700:d0::a29f:c001/128"
        );
        assert_eq!(normalize_ipset_entry("10.0.0.0/8").unwrap(), "10.0.0.0/8");
        assert_eq!(
            normalize_ipset_entry("2001:db8::/32").unwrap(),
            "2001:db8::/32"
        );
        assert_eq!(normalize_ipset_entry("0.0.0.0/0").unwrap(), "0.0.0.0/0");
        assert_eq!(normalize_ipset_entry("::/0").unwrap(), "::/0");
        assert!(normalize_ipset_entry("1.2.3.4/999").is_err());
        assert!(normalize_ipset_entry("2001:db8::/129").is_err());
        assert!(normalize_ipset_entry("evil/thing").is_err());
        assert!(normalize_ipset_entry("1.2.3.4/24/extra").is_err());
        assert!(normalize_ipset_entry("example.com").is_err());
        assert!(normalize_ipset_entry("bad domain").is_err());
    }

    #[test]
    fn channel_content_length_limit_rejects_oversize_declared_body() {
        assert!(ensure_content_length_limit(Some(1024), 1024, "test body").is_ok());
        assert!(ensure_content_length_limit(None, 1024, "test body").is_ok());
        let err = ensure_content_length_limit(Some(1025), 1024, "test body").unwrap_err();
        assert!(err.contains("test body too large"));
    }

    #[test]
    fn parse_engine_version_extracts_token() {
        assert_eq!(
            parse_engine_version("github version 72.12 (abc)"),
            Some("72.12".into())
        );
        assert_eq!(
            parse_engine_version("winws VERSION v70"),
            Some("v70".into())
        );
        assert_eq!(parse_engine_version("no digits here"), None);
        assert_eq!(parse_engine_version(""), None);
    }

    // A domain goes into the winws hostlist line by line: a value with a line break
    // would insert arbitrary entries, and dedup by whole line didn't catch them.
    #[test]
    fn exclude_domain_rejects_multiline_and_control_input() {
        assert_eq!(
            normalize_exclude_domain("  Example.COM "),
            Ok("example.com".to_string())
        );
        assert_eq!(
            normalize_exclude_domain("*.example.com"),
            Ok("*.example.com".to_string())
        );
        // Surrounding whitespace is input garbage, not an injection: trim removes it, and
        // a clean entry goes into the file. We only reject what remains inside.
        assert_eq!(
            normalize_exclude_domain("example.com\t"),
            Ok("example.com".to_string())
        );
        for bad in [
            "example.com\nevil.com",
            "example.com\r\nevil.com",
            "exa mple.com",
            "exa\tmple.com",
            "example\u{0}.com",
            "",
            "   ",
            "прим.рф",
        ] {
            assert!(
                normalize_exclude_domain(bad).is_err(),
                "{bad:?} обязан отвергаться"
            );
        }
        assert!(normalize_exclude_domain(&"a".repeat(254)).is_err());
    }

    // A neighboring directory with the same string prefix is not our engine: a bare
    // starts_with sent taskkill to a foreign process.
    #[cfg(target_os = "windows")]
    #[test]
    fn stray_winws_lookup_respects_the_directory_boundary() {
        let root = r"c:\app\dpi";
        let inside = r"c:\app\dpi\bin\winws.exe";
        let sibling = r"c:\app\dpi-backup\winws.exe";
        assert!(path_is_inside(inside, root));
        assert!(!path_is_inside(sibling, root));
        // The root itself is not a process; an empty root matches nothing.
        assert!(!path_is_inside(root, root));
        assert!(!path_is_inside(inside, ""));
        // A trailing separator on the root doesn't break the boundary.
        assert!(path_is_inside(inside, "c:\\app\\dpi\\"));
    }

    // "Block applied" must be determined by a separate marker line, as
    // strip_managed_block and the block parsing in dpi_hosts_status do. A substring
    // gave applied=true with an empty block and the wrong body choice for the backup.
    #[test]
    fn managed_block_is_detected_by_a_whole_marker_line() {
        let applied = format!("127.0.0.1 localhost\n{HOSTS_BEGIN}\nx\n{HOSTS_END}\n");
        assert!(has_managed_block(&applied));
        assert!(has_managed_block(&format!("   {HOSTS_BEGIN}   \n")));
        // A marker inside a line is not our block.
        assert!(!has_managed_block(&format!("{HOSTS_BEGIN} и хвост\n")));
        assert!(!has_managed_block(&format!("# было: {HOSTS_BEGIN}\n")));
        assert!(!has_managed_block("127.0.0.1 localhost\n"));
    }

    #[test]
    fn user_list_name_maps_kind() {
        assert_eq!(user_list_name("exclude"), "list-exclude-user.txt");
        assert_eq!(user_list_name("user"), "list-general-user.txt");
        assert_eq!(user_list_name("anything-else"), "list-general-user.txt");
    }

    #[test]
    fn dpi_operation_generation_cancels_stale_work() {
        let state = DpiState::default();
        let first = begin_dpi_operation(&state, "start").unwrap();
        let first_guard = DpiOperationGuard {
            state: &state,
            generation: first,
        };
        assert!(dpi_operation_current(&state, first));
        assert!(begin_dpi_operation(&state, "autotest").is_err());

        assert_eq!(cancel_dpi_operation(&state), Some("start"));
        assert!(!dpi_operation_current(&state, first));
        assert!(begin_dpi_operation(&state, "autotest").is_err());
        drop(first_guard);

        let second = begin_dpi_operation(&state, "autotest").unwrap();
        assert_ne!(first, second);
        assert!(dpi_operation_current(&state, second));
    }

    // Waiting for completion makes sense only for operations capable of bringing up winws.
    #[test]
    fn only_spawning_operations_hold_up_stop() {
        assert!(operation_can_spawn(Some("start")));
        assert!(operation_can_spawn(Some("autotest")));
        assert!(!operation_can_spawn(Some("sync_channel")));
        assert!(!operation_can_spawn(None));
    }

    #[test]
    fn cancel_reports_which_operation_it_took() {
        let state = DpiState::default();
        let generation = begin_dpi_operation(&state, "sync_channel").unwrap();
        let guard = DpiOperationGuard {
            state: &state,
            generation,
        };
        assert_eq!(cancel_dpi_operation(&state), Some("sync_channel"));
        // A repeated cancel has nothing left to take — stop must not wait for nothing.
        assert_eq!(cancel_dpi_operation(&state), None);
        drop(guard);
    }

    fn test_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ninety-dpi-{tag}-{}-{}",
            std::process::id(),
            TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    // ── item 2: winws exit watcher ──

    fn short_lived_child(code: i32) -> Child {
        #[cfg(windows)]
        let child = std::process::Command::new("cmd")
            .args(["/C", &format!("exit {code}")])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = std::process::Command::new("sh")
            .args(["-c", &format!("exit {code}")])
            .spawn()
            .unwrap();
        child
    }

    fn wait_for_reap(state: &DpiState, expected: Option<u64>) -> Option<DpiExitedEvent> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(event) = reap_unexpected_exit(state, expected) {
                return Some(event);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }

    // A crash of the regular session is reported exactly once and with the exit code.
    #[test]
    fn crash_of_the_running_session_is_reported_once() {
        let state = DpiState::default();
        *state.child.lock_recover() = Some(short_lived_child(3));
        state.runtime_session.store(7, Ordering::SeqCst);

        // The watcher of another (old) session doesn't touch the new one.
        assert!(reap_unexpected_exit(&state, Some(6)).is_none());

        let event = wait_for_reap(&state, Some(7)).expect("падение не замечено");
        assert_eq!(event.generation, 7);
        assert_eq!(event.code, Some(3));
        assert!(event.message.contains("backend.dpi.exitedUnexpectedly"));
        assert!(state.child.lock_recover().is_none());
        assert_eq!(state.runtime_session.load(Ordering::SeqCst), 0);
        assert!(reap_unexpected_exit(&state, None).is_none());
    }

    // A planned stop resets the session under the same lock: no false event.
    #[test]
    fn planned_stop_is_not_reported_as_a_crash() {
        let state = DpiState::default();
        *state.child.lock_recover() = Some(short_lived_child(0));
        state.runtime_session.store(9, Ordering::SeqCst);

        stop_managed_child(&state, "test winws").unwrap();

        assert_eq!(state.runtime_session.load(Ordering::SeqCst), 0);
        assert!(reap_unexpected_exit(&state, Some(9)).is_none());
        assert!(reap_unexpected_exit(&state, None).is_none());
    }

    // Auto-tuning processes (session 0) live and die as planned.
    #[test]
    fn autotest_children_never_raise_the_event() {
        let state = DpiState::default();
        *state.child.lock_recover() = Some(short_lived_child(1));
        std::thread::sleep(Duration::from_millis(300));
        assert!(reap_unexpected_exit(&state, None).is_none());
        let _ = stop_managed_child(&state, "test winws");
    }

    // ── item 3: own additions and built-in base lists ──

    #[test]
    fn ninety_additions_are_layered_without_duplicates() {
        // A Flowseal list without the addition (as the channel ships it).
        let flowseal = "discord.com\nlive-video.net";
        assert_eq!(
            with_list_additions(flowseal, &NINETY_GENERAL_ADDITIONS).as_deref(),
            Some("discord.com\nlive-video.net\nvivox.com\n")
        );
        // Already present (in any case) — the file is not rewritten.
        assert!(with_list_additions("# c\nVIVOX.com\n", &NINETY_GENERAL_ADDITIONS).is_none());
        // A commented-out entry doesn't count as the addition.
        assert_eq!(
            with_list_additions("# vivox.com\n", &NINETY_GENERAL_ADDITIONS).as_deref(),
            Some("# vivox.com\nvivox.com\n")
        );
        // ipset: only the missing subnets are added.
        assert_eq!(
            with_list_additions("1.1.1.0/24\n85.236.96.0/21\n", &NINETY_IPSET_ADDITIONS).as_deref(),
            Some("1.1.1.0/24\n85.236.96.0/21\n85.236.104.0/23\n")
        );
        assert_eq!(
            with_list_additions("", &NINETY_IPSET_ADDITIONS).as_deref(),
            Some("85.236.96.0/21\n85.236.104.0/23\n")
        );
    }

    // Additions must not live only in the built-in files: the channel doesn't ship them.
    #[test]
    fn bundled_lists_already_carry_the_additions() {
        let general = include_str!("../dpi/lists/list-general.txt");
        assert!(with_list_additions(general, &NINETY_GENERAL_ADDITIONS).is_none());
    }

    #[test]
    fn bundled_base_lists_follow_the_app_version_but_not_user_lists() {
        let root = test_root("base-lists");
        let src = root.join("res");
        let dst = root.join("data");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("list-general.txt"), "fresh.example\n").unwrap();
        // Old installation: the base list from the first install, no marker.
        std::fs::write(dst.join("list-general.txt"), "stale.example\n").unwrap();
        std::fs::write(dst.join("list-general-user.txt"), "mine.example\n").unwrap();

        refresh_bundled_base_lists(&dst, &src, "0.18.0+1.10.2").unwrap();
        let read = |name: &str| std::fs::read_to_string(dst.join(name)).unwrap();
        assert_eq!(read("list-general.txt"), "fresh.example\n");
        assert_eq!(read("list-general-user.txt"), "mine.example\n");
        // No file in the resource — it is created empty instead of failing.
        assert_eq!(read("list-google.txt"), "");

        // The same version — files aren't rewritten on every call.
        std::fs::write(src.join("list-general.txt"), "newer.example\n").unwrap();
        refresh_bundled_base_lists(&dst, &src, "0.18.0+1.10.2").unwrap();
        assert_eq!(read("list-general.txt"), "fresh.example\n");

        // A new app version — the base lists come from the resources again.
        refresh_bundled_base_lists(&dst, &src, "0.18.1+1.10.2").unwrap();
        assert_eq!(read("list-general.txt"), "newer.example\n");
        assert_eq!(read("list-general-user.txt"), "mine.example\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── item 4: channel versions ──

    #[test]
    fn channel_versions_compare_as_numbers() {
        use std::cmp::Ordering as CmpOrdering;
        let cmp = compare_channel_versions;
        assert_eq!(cmp("1.10.2", "1.9.9"), Some(CmpOrdering::Greater));
        assert_eq!(cmp("1.10", "1.10.0"), Some(CmpOrdering::Equal));
        assert_eq!(cmp("v1.10.2", "1.10.2"), Some(CmpOrdering::Equal));
        assert_eq!(cmp("1.6.3b", "1.6.3"), Some(CmpOrdering::Greater));
        assert_eq!(cmp("1.6.3a", "1.6.3b"), Some(CmpOrdering::Less));
        assert_eq!(cmp("1.0.0-rc1", "1.0.0"), Some(CmpOrdering::Less));
        assert_eq!(cmp("1.0.0-rc.2", "1.0.0-rc.10"), Some(CmpOrdering::Less));
        assert_eq!(cmp("1.0.0+build7", "1.0.0"), Some(CmpOrdering::Equal));
        assert_eq!(cmp("—", "1.0.0"), None);
        assert_eq!(cmp("1..2", "1.2"), None);
        assert_eq!(cmp("latest", "1.2"), None);
    }

    // An old signed bundle passes the signature check but can't roll the set back.
    #[test]
    fn older_signed_bundle_is_rejected() {
        assert!(!channel_bundle_acceptable("1.10.1", "1.10.2"));
        assert!(!channel_bundle_acceptable("1.9.9", "1.10.0"));
        assert!(channel_bundle_acceptable("1.10.2", "1.10.2"));
        assert!(channel_bundle_acceptable("1.10.3", "1.10.2"));
        // An unparseable version can't "overtake" a known one.
        assert!(!channel_bundle_acceptable("latest", "1.10.2"));
        // Active version unknown — accept.
        assert!(channel_bundle_acceptable("1.10.2", "—"));
    }

    #[test]
    fn update_is_offered_only_for_a_strictly_newer_channel() {
        assert!(channel_update_available("1.10.3", "1.10.2", false));
        assert!(!channel_update_available("1.10.2", "1.10.2", false));
        assert!(!channel_update_available("1.10.1", "1.10.2", false));
        // A generation without provable strategies — resync the same version.
        assert!(channel_update_available("1.10.2", "1.10.2", true));
        assert!(!channel_update_available("1.10.1", "1.10.2", true));
        assert!(!channel_update_available("", "1.10.2", true));
        assert!(channel_update_available("1.10.2", "—", false));
    }

    // ── item 5: corrupted active generation ──

    #[test]
    fn broken_pointer_falls_back_and_never_fails() {
        let root = test_root("broken-pointer");
        // No pointer — built-in resources, nothing to sync.
        let none = resolve_channel_generation(&root);
        assert!(none.active.is_none() && !none.pointer_broken);

        let older = create_test_channel_generation(&root, "gen-100-1-0", "1.10.1");
        let newer = create_test_channel_generation(&root, "gen-200-1-0", "1.10.2");
        let pointer = root.join(CHANNEL_POINTER_FILE);

        // Garbage in pointer — the newest intact generation.
        std::fs::write(&pointer, "../evil\n").unwrap();
        let garbage = resolve_channel_generation(&root);
        assert_eq!(garbage.active, Some(newer.clone()));
        assert!(garbage.pointer_broken);

        // Corrupted active one — the previous intact one.
        std::fs::write(&pointer, "gen-200-1-0\n").unwrap();
        std::fs::remove_file(newer.join("service").join("hosts")).unwrap();
        let broken = resolve_channel_generation(&root);
        assert_eq!(broken.active, Some(older.clone()));
        assert!(broken.pointer_broken);

        // No intact ones left — the built-in set, not an error.
        std::fs::remove_dir_all(older.join("bin-data")).unwrap();
        let nothing = resolve_channel_generation(&root);
        assert!(nothing.active.is_none());
        assert!(nothing.pointer_broken);
        let _ = std::fs::remove_dir_all(&root);
    }

    // Strategies (and therefore dpi_start and sync itself) survive a corrupted generation.
    #[test]
    fn strategies_survive_a_broken_generation() {
        let root = test_root("broken-strategies");
        std::fs::write(root.join(CHANNEL_POINTER_FILE), "gen-300-1-0\n").unwrap();
        let active = load_strategies_from(&root).unwrap();
        assert!(active.channel.is_none());
        assert!(active.needs_resync);
        assert_eq!(active.version, bundled_strategies_version());
        assert!(!active.strategies.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── item 6: strategies only from the signed set + allowlist ──

    // A generation without bundle.zip/signature doesn't prove its strategies: even
    // a strategies.json planted next to it is not read, the built-in set is used.
    #[test]
    fn generation_without_signed_bundle_uses_the_bundled_strategies() {
        let root = test_root("unsigned-generation");
        let generation = create_test_channel_generation(&root, "gen-400-1-0", "9.9.9");
        std::fs::write(
            generation.join("strategies.json"),
            r#"[{"id":"evil","name":"evil","args":["--debug=@C:\\x"]}]"#,
        )
        .unwrap();
        std::fs::write(root.join(CHANNEL_POINTER_FILE), "gen-400-1-0\n").unwrap();

        let active = load_strategies_from(&root).unwrap();
        assert!(active.channel.is_none());
        assert!(active.needs_resync);
        assert_eq!(active.version, bundled_strategies_version());
        assert!(active.strategies.iter().all(|s| s.id != "evil"));
        // The generation's lists and bin-data stay in use in that case.
        assert_eq!(active_channel_generation_from_dpi(&root), Some(generation));
        let _ = std::fs::remove_dir_all(&root);
    }

    // All strategies of the built-in set pass the allowlist — otherwise it would break
    // working profiles.
    #[test]
    fn every_bundled_strategy_passes_the_allowlist() {
        let raw: Vec<Strategy> =
            serde_json::from_str(include_str!("../dpi/strategies.json")).unwrap();
        assert!(!raw.is_empty());
        let mut checked = 0usize;
        for strategy in &raw {
            for arg in &strategy.args {
                assert!(
                    validate_strategy_arg(arg).is_ok(),
                    "{}: аргумент отвергнут: {arg}",
                    strategy.id
                );
                checked += 1;
            }
        }
        assert!(checked > raw.len());
        assert_eq!(
            parse_checked_strategies(BUNDLED_STRATEGIES_JSON)
                .unwrap()
                .len(),
            raw.len()
        );
    }

    #[test]
    fn allowlist_keeps_the_strategy_grammar() {
        for arg in [
            "--new",
            "--filter-tcp=%GameFilterTCP%",
            "--filter-udp=19294-19344,50000-50100",
            "--wf-udp=443,19294-19344,50000-50100,%GameFilterUDP%",
            "--dpi-desync-fake-tls=!",
            "--dpi-desync-fake-tls=0x00000000",
            "--dpi-desync-fake-tls=%BIN%tls_clienthello_www_google_com.bin",
            "--dpi-desync-fake-quic=%BIN%quic_initial_4pda.to.bin",
            "--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1",
            "--dpi-desync-hostfakesplit-mod=host=www.google.com",
            "--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com",
            "--dpi-desync-split-pos=2,sniext+1",
            "--dpi-desync-split-pos=1,midsld",
            "--dpi-desync-cutoff=n2",
            "--hostlist=%LISTS%list-general.txt",
            "--ipset-exclude=%LISTS%ipset-exclude-user.txt",
            "--hostlist-domains=discord.media,dis.gd",
        ] {
            assert!(validate_strategy_arg(arg).is_ok(), "{arg}");
        }
    }

    #[test]
    fn allowlist_rejects_forged_arguments() {
        for arg in [
            r"--debug=@C:\x",
            "--debug",
            r"--pidfile=C:\x",
            r"--hostlist=..\..\x",
            r"--hostlist=C:\x",
            r"--hostlist=%LISTS%..\x",
            "--hostlist=@%LISTS%list-general.txt",
            "--hostlist=%LISTS%list-auto.txt",
            "--hostlist-auto=%LISTS%list-auto.txt",
            r"--hostlist-auto-debug=C:\x",
            "--hostlist-auto-fail-threshold=3",
            r"--dpi-desync-fake-quic=%BIN%..\x.bin",
            "--dpi-desync-fake-quic=%BIN%..bin",
            "--dpi-desync-fake-quic=@%BIN%x.bin",
            r"--dpi-desync-fake-tls=C:\x.bin",
            "--dpi-desync-fake-tls=%BIN%x.txt",
            "--ipset=%LISTS%ipset-all.txt\n--debug",
            "--new=1",
            "--filter-tcp=0",
            "--filter-tcp=80-70",
            "--wf-tcp=%GameFilterUDP%",
            "--dpi-desync-cutoff=n0",
            "--dpi-desync-repeats=0",
            "--dpi-desync-fake-tls-mod=rnd,dupsid,sni=../x",
            "--dpi-desync-hostfakesplit-mod=host=x.com,altorder=1,altorder=1",
            "--hostlist-domains=a.com,../b",
            "",
        ] {
            assert!(validate_strategy_arg(arg).is_err(), "{arg:?}");
        }
        assert!(
            validate_strategy_arg(&format!("--dpi-desync-fake-tls=0x{}", "0".repeat(5000)))
                .is_err()
        );
    }

    // A strategy with a forbidden argument is dropped entirely, the rest live on.
    #[test]
    fn tampered_strategy_is_dropped_whole() {
        let raw = r#"[
            {"id":"good","name":"G","args":["--filter-tcp=443","--dpi-desync=fake"]},
            {"id":"bad","name":"B","args":["--filter-tcp=443","--debug=@C:\\x"]}
        ]"#;
        let checked = parse_checked_strategies(raw).unwrap();
        assert_eq!(checked.len(), 1);
        assert_eq!(checked[0].id, "good");
        assert!(parse_checked_strategies(r#"[{"id":"bad","args":["--pidfile=C:\\x"]}]"#).is_err());
        assert!(parse_checked_strategies(r#"[{"id":"empty","args":[]}]"#).is_err());
    }

    // ── item 7: VPN node exclusion batch ──

    #[test]
    fn endpoint_hosts_drop_ports_and_keep_ipv6() {
        assert_eq!(endpoint_host("[2001:db8::1]:443"), Some("2001:db8::1"));
        assert_eq!(endpoint_host("[2001:db8::1]"), Some("2001:db8::1"));
        assert_eq!(endpoint_host("2001:db8::1"), Some("2001:db8::1"));
        assert_eq!(endpoint_host(" 162.159.192.1:2408 "), Some("162.159.192.1"));
        assert_eq!(
            endpoint_host("vpn.example.com:443"),
            Some("vpn.example.com")
        );
        assert_eq!(endpoint_host("vpn.example.com"), Some("vpn.example.com"));
        assert_eq!(endpoint_host("host:abc"), None);
        assert_eq!(endpoint_host("host:123456"), None);
        assert_eq!(endpoint_host("[::1]x"), None);
        assert_eq!(endpoint_host("[]:443"), None);
        assert_eq!(endpoint_host("   "), None);
    }

    #[test]
    fn endpoint_batch_dedups_and_formats_entries() {
        let ips: Vec<String> = [
            "1.2.3.4",
            "1.2.3.4:443",
            "[2001:0db8::1]:443",
            "2001:db8::1",
            "bad host",
        ]
        .map(String::from)
        .to_vec();
        let domains: Vec<String> = [
            "VPN.example.com",
            "vpn.example.com:8443",
            "vpn.example.com.",
            "5.6.7.8:2408",
            "*.example.org",
            "exa mple.com",
        ]
        .map(String::from)
        .to_vec();
        let batch = endpoint_batch(&ips, &domains);
        assert_eq!(
            batch,
            EndpointBatch {
                ips: vec![
                    "1.2.3.4/32".to_string(),
                    "2001:db8::1/128".to_string(),
                    "5.6.7.8/32".to_string(),
                ],
                domains: vec!["vpn.example.com".to_string(), "*.example.org".to_string()],
            }
        );
        assert_eq!(
            render_list_lines(&batch.ips),
            "1.2.3.4/32\n2001:db8::1/128\n5.6.7.8/32\n"
        );
        assert_eq!(render_list_lines(&[]), "");
        assert_eq!(endpoint_batch(&[], &[]), EndpointBatch::default());
    }

    #[test]
    fn only_real_names_are_resolved() {
        assert!(resolvable_endpoint_domain("vpn.example.com"));
        assert!(!resolvable_endpoint_domain("*.example.com"));
        assert!(!resolvable_endpoint_domain("999.1.1.1"));
    }

    #[test]
    fn endpoint_batch_is_capped() {
        let ips: Vec<String> = (0..MAX_ENDPOINT_IPS + 50)
            .map(|i| format!("10.{}.{}.1", i / 256, i % 256))
            .collect();
        assert_eq!(endpoint_batch(&ips, &[]).ips.len(), MAX_ENDPOINT_IPS);
    }

    // Pairs taken from live hosts: the redirector named waw02s20, and the watch page
    // on the same network served rr1---sn-f5f7lnl7 and rr1---sn-f5f7kn7e.
    #[test]
    fn video_node_name_encodes_like_googlevideo() {
        assert_eq!(encode_video_node("waw02s20").as_deref(), Some("f5f7lnl7"));
        assert_eq!(encode_video_node("waw07s01").as_deref(), Some("f5f7kn7e"));
        assert_eq!(encode_video_node("ab-c1").as_deref(), Some("5c-je"));
        let too_long = "a".repeat(41);
        for bad in ["", "-ab", "ab-", "WAW02S20", "waw.02", too_long.as_str()] {
            assert_eq!(encode_video_node(bad), None, "accepted {bad:?}");
        }
    }

    #[test]
    fn video_node_host_reads_the_mapping_line() {
        let body = "2001:db8::1 => waw02s20 (2001:db8::/62) [u]\n\nDebug Info:\nAbC\n";
        assert_eq!(
            video_node_host(body).as_deref(),
            Some("rr1---sn-f5f7lnl7.googlevideo.com")
        );
        assert_eq!(video_node_host("Debug Info:\nnothing here"), None);
        assert_eq!(video_node_host("1.2.3.4 => bad.name (x)"), None);
        assert_eq!(video_node_host("1.2.3.4 =>"), None);
    }

    #[test]
    fn median_of_samples() {
        assert_eq!(median_ms(&mut []), None);
        assert_eq!(median_ms(&mut [7]), Some(7));
        assert_eq!(median_ms(&mut [300, 100, 200]), Some(200));
        assert_eq!(median_ms(&mut [400, 100, 300, 200]), Some(250));
    }

    fn screen(strategy: usize, covered: usize, latency_ms: u64) -> ScreenScore {
        ScreenScore {
            strategy,
            covered,
            latency_ms,
        }
    }

    #[test]
    fn finalists_are_the_fastest_with_best_coverage_plus_current() {
        let scores = [
            screen(0, 3, 900),
            screen(1, 2, 100),
            screen(2, 3, 300),
            screen(3, 3, 200),
            screen(4, 3, 600),
        ];
        assert_eq!(pick_finalists(&scores, None, 3), vec![3, 2, 4]);
        // The current one is slower but just as complete: it gets a chance to stay.
        assert_eq!(pick_finalists(&scores, Some(0), 3), vec![3, 2, 4, 0]);
        // Lower coverage doesn't reach the finals even as the current one.
        assert_eq!(pick_finalists(&scores, Some(1), 3), vec![3, 2, 4]);
        assert_eq!(pick_finalists(&scores, Some(2), 3), vec![3, 2, 4]);
        assert!(pick_finalists(&[], Some(0), 3).is_empty());
    }

    fn fin(strategy: usize, ok: usize, median_ms: Option<u64>) -> FinalScore {
        FinalScore {
            strategy,
            ok,
            targets_open: 4,
            video_ok: Some(true),
            median_ms,
        }
    }

    #[test]
    fn finals_rank_reliability_then_median() {
        let scores = [
            fin(0, 12, Some(150)),
            fin(1, 11, Some(80)),
            fin(2, 12, Some(120)),
        ];
        let (winner, kept) = rank_finals(&scores, None).unwrap();
        assert_eq!((winner.strategy, kept), (2, false));
    }

    #[test]
    fn current_strategy_stays_within_noise_margin() {
        let scores = [fin(0, 12, Some(100)), fin(1, 12, Some(135))];
        // 35 ms behind: under the 40 ms floor of the margin.
        let (winner, kept) = rank_finals(&scores, Some(1)).unwrap();
        assert_eq!((winner.strategy, kept), (1, true));
        // The winner is the current one itself: nothing was kept over a faster one.
        let (winner, kept) = rank_finals(&scores, Some(0)).unwrap();
        assert_eq!((winner.strategy, kept), (0, false));
        // Far behind: the faster one wins.
        let slow = [fin(0, 12, Some(100)), fin(1, 12, Some(160))];
        assert_eq!(rank_finals(&slow, Some(1)).unwrap().0.strategy, 0);
        // The margin grows with latency: 20 % of 500 ms.
        let high = [fin(0, 12, Some(500)), fin(1, 12, Some(590))];
        assert_eq!(rank_finals(&high, Some(1)).unwrap().0.strategy, 1);
        // Less reliable: no margin helps.
        let flaky = [fin(0, 12, Some(100)), fin(1, 11, Some(100))];
        assert_eq!(rank_finals(&flaky, Some(1)).unwrap().0.strategy, 0);
    }

    #[test]
    fn finals_without_successes_have_no_winner() {
        assert!(rank_finals(&[fin(0, 0, None), fin(1, 0, None)], Some(0)).is_none());
    }
}
