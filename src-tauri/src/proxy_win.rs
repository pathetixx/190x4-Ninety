use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, HWND};
use windows::Win32::Networking::WinInet::{
    InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    ChangeWindowMessageFilterEx, FindWindowW, MSGFLT_ALLOW, SW_HIDE, SW_SHOWNORMAL, WM_COPYDATA,
};
use winreg::enums::*;
use winreg::RegKey;

// Task Scheduler task name. Autostart is implemented through it:
// a task with RunLevel=Highest starts Ninety already with administrator rights at
// Windows sign-in — without a UAC prompt on every login (which plagued the former
// registry Run key: it launched a non-elevated instance, which then restarted itself
// via runas → UAC). See autostart_enable / migrate_legacy_autostart.
const INSTALLED_TASK_NAME: &str = "Ninety";
const PORTABLE_TASK_NAME: &str = "Ninety Portable";
// CREATE_NO_WINDOW — no flashing black schtasks console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
// tauri-plugin-autostart wrote a value under the app name; in different builds
// it was "Ninety" and "ninety". One list for all the places that read,
// delete and migrate it.
const LEGACY_RUN_VALUES: [&str; 2] = ["Ninety", "ninety"];
const AUTOSTART_BACKOFF_MS: &[u64] = &[100, 150, 250, 400, 650, 1_000, 1_500, 2_000, 2_500];

const INET_SETTINGS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const NINETY_KEY: &str = r"Software\Ninety";
const PROXY_OVERRIDE: &str = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>";
const PROXY_OVERRIDE_LOOPBACK_ONLY: &str = "localhost;127.*";
static PROXY_NOTIFY_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static PROXY_NOTIFY_REQUESTED: AtomicU64 = AtomicU64::new(0);
static PROXY_NOTIFY_APPLIED: AtomicU64 = AtomicU64::new(0);
static AUTOSTART_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SystemProxyState {
    pub proxy_enable: bool,
    pub proxy_server: Option<String>,
    pub owned: bool,
}

fn autostart_lock() -> &'static Mutex<()> {
    AUTOSTART_LOCK.get_or_init(|| Mutex::new(()))
}

// InternetSetOptionW with a NULL handle runs synchronously. On some Windows systems
// SETTINGS_CHANGED/REFRESH wait tens of seconds for hung WinINet clients. The registry
// has already been updated atomically by then, so the notification runs outside IPC
// shutdown. Generation coalescing ensures the last request isn't lost while
// the previous SETTINGS_CHANGED/REFRESH is still running.
fn run_proxy_notify_worker() {
    // An outer loop instead of a self-call: picking up a "catching up" request must not
    // grow the stack — Rust doesn't guarantee tail call optimization, and the call frequency
    // is set from outside and is unbounded.
    loop {
        loop {
            let target = PROXY_NOTIFY_REQUESTED.load(Ordering::Acquire);
            if PROXY_NOTIFY_APPLIED.load(Ordering::Acquire) >= target {
                break;
            }
            unsafe {
                let _ = InternetSetOptionW(None, INTERNET_OPTION_SETTINGS_CHANGED, None, 0);
                let _ = InternetSetOptionW(None, INTERNET_OPTION_REFRESH, None, 0);
            }
            PROXY_NOTIFY_APPLIED.store(target, Ordering::Release);
        }

        PROXY_NOTIFY_IN_FLIGHT.store(false, Ordering::Release);
        // Close the race between the last loop check and clearing in-flight. A
        // caller that arrived in that window may have observed true and returned.
        if PROXY_NOTIFY_APPLIED.load(Ordering::Acquire)
            >= PROXY_NOTIFY_REQUESTED.load(Ordering::Acquire)
        {
            return;
        }
        if PROXY_NOTIFY_IN_FLIGHT
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
    }
}

fn notify_proxy_change() -> u64 {
    let generation = PROXY_NOTIFY_REQUESTED.fetch_add(1, Ordering::AcqRel) + 1;
    if PROXY_NOTIFY_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        let spawned = std::thread::Builder::new()
            .name("ninety-proxy-notify".into())
            .spawn(run_proxy_notify_worker);
        if spawned.is_err() {
            // Keep the contract even if thread creation is unavailable.
            run_proxy_notify_worker();
        }
    }
    generation
}

pub fn proxy_notification_generations() -> (u64, u64) {
    (
        PROXY_NOTIFY_REQUESTED.load(Ordering::Acquire),
        PROXY_NOTIFY_APPLIED.load(Ordering::Acquire),
    )
}

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellLaunchStatus {
    Started,
    Cancelled,
    AccessDenied,
    FileNotFound,
    Failed { shell_code: isize, last_error: u32 },
}

fn classify_shell_launch(shell_code: isize, last_error: u32) -> ShellLaunchStatus {
    if shell_code > 32 {
        return ShellLaunchStatus::Started;
    }
    // ERROR_CANCELLED (1223) reliably distinguishes the user declining UAC from
    // a regular SE_ERR_ACCESSDENIED (5), when Windows sets it.
    if shell_code == 5 && last_error == 1223 {
        return ShellLaunchStatus::Cancelled;
    }
    match shell_code {
        2 | 3 => ShellLaunchStatus::FileNotFound,
        5 => ShellLaunchStatus::AccessDenied,
        _ => ShellLaunchStatus::Failed {
            shell_code,
            last_error,
        },
    }
}

fn shell_launch_status(handle: windows::Win32::Foundation::HINSTANCE) -> ShellLaunchStatus {
    let last_error = unsafe { GetLastError().0 };
    classify_shell_launch(handle.0 as isize, last_error)
}

const LEGACY_PROXY_SERVER: &str = "127.0.0.1:7890";

fn validate_proxy_endpoint(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() || value.contains("//") || value.chars().any(char::is_whitespace) {
        return Err("system proxy endpoint must be loopback host:port".into());
    }

    if let Ok(address) = value.parse::<std::net::SocketAddr>() {
        let allowed = match address.ip() {
            std::net::IpAddr::V4(ip) => ip == std::net::Ipv4Addr::LOCALHOST,
            std::net::IpAddr::V6(ip) => ip == std::net::Ipv6Addr::LOCALHOST,
        };
        if allowed && address.port() != 0 {
            return Ok(address.to_string());
        }
        return Err("system proxy endpoint must use 127.0.0.1 or ::1".into());
    }

    let Some((host, port)) = value.rsplit_once(':') else {
        return Err("system proxy endpoint must include a port".into());
    };
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or("system proxy port must be in 1..=65535")?;
    if host.eq_ignore_ascii_case("localhost") {
        return Ok(format!("localhost:{port}"));
    }
    Err("system proxy endpoint must use 127.0.0.1, localhost or ::1".into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxyRecoveryAction {
    LeaveUntouched,
    RestoreSnapshot,
    RestoreSnapshotKeepOverride,
    DisableOwnedProxy,
}

// Old Ninety versions saved the snapshot but not ActiveProxyServer. For them
// we support only the known historical default address and only with
// a fully valid snapshot. Loopback alone never proves
// ownership: it could be Clash/Fiddler/Charles or a corporate agent.
fn proxy_recovery_action(
    current_server: &str,
    current_enable: u32,
    current_override: Option<&str>,
    active: Option<&str>,
    snapshot_valid: bool,
) -> ProxyRecoveryAction {
    let override_is_ours = matches!(
        current_override,
        Some(value) if value == PROXY_OVERRIDE || value == PROXY_OVERRIDE_LOOPBACK_ONLY
    );
    let settings_still_match = current_enable == 1 && override_is_ours;
    match active {
        // An enabled proxy with our address stays ours even if the exclusion
        // list was changed during the session (by the user in Windows settings
        // or by another program). Leaving it untouched would mean abandoning
        // ProxyEnable=1 on an already closed port: browsers lose internet, and the ownership
        // markers are erased, so the next launch doesn't fix it either. Foreign
        // exclusions are preserved in that case.
        Some(value) if current_enable == 1 && current_server.eq_ignore_ascii_case(value) => {
            match (snapshot_valid, override_is_ours) {
                (true, true) => ProxyRecoveryAction::RestoreSnapshot,
                (true, false) => ProxyRecoveryAction::RestoreSnapshotKeepOverride,
                (false, _) => ProxyRecoveryAction::DisableOwnedProxy,
            }
        }
        Some(_) => ProxyRecoveryAction::LeaveUntouched,
        None if snapshot_valid
            && settings_still_match
            && current_server.eq_ignore_ascii_case(LEGACY_PROXY_SERVER) =>
        {
            ProxyRecoveryAction::RestoreSnapshot
        }
        None => ProxyRecoveryAction::LeaveUntouched,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProxySnapshot {
    enable: u32,
    server: Option<String>,
    proxy_override: Option<String>,
}

fn read_proxy_snapshot(nk: &RegKey) -> Option<ProxySnapshot> {
    if nk.get_value::<u32, _>("SavedProxyValid").ok()? != 1 {
        return None;
    }
    let enable = nk.get_value::<u32, _>("SavedProxyEnable").ok()?;
    if enable > 1 {
        return None;
    }
    let server_present = nk.get_value::<u32, _>("SavedProxyServerPresent").ok()?;
    let override_present = nk.get_value::<u32, _>("SavedProxyOverridePresent").ok()?;
    if server_present > 1 || override_present > 1 {
        return None;
    }
    let server = match server_present {
        1 => Some(nk.get_value::<String, _>("SavedProxyServer").ok()?),
        _ => None,
    };
    let proxy_override = match override_present {
        1 => Some(nk.get_value::<String, _>("SavedProxyOverride").ok()?),
        _ => None,
    };
    Some(ProxySnapshot {
        enable,
        server,
        proxy_override,
    })
}

fn capture_proxy_settings(inet: &RegKey) -> Result<ProxySnapshot, String> {
    let enable: u32 = inet.get_value("ProxyEnable").unwrap_or(0);
    if enable > 1 {
        return Err(format!("unexpected ProxyEnable={enable}"));
    }
    Ok(ProxySnapshot {
        enable,
        server: inet.get_value::<String, _>("ProxyServer").ok(),
        proxy_override: inet.get_value::<String, _>("ProxyOverride").ok(),
    })
}

// Snapshot of the previous proxy settings — taken once, before Ninety overwrites them
// with its own. Without it, turning Ninety off would wipe the proxy/bypass list the
// user may have configured outside Ninety. A repeated enable doesn't overwrite the snapshot.
fn save_proxy_snapshot(hkcu: &RegKey, inet: &RegKey) -> Result<(), String> {
    let (nk, _) = hkcu
        .create_subkey(NINETY_KEY)
        .map_err(|e| format!("create Ninety proxy state: {e}"))?;
    if nk.get_value::<u32, _>("SavedProxyValid").unwrap_or(0) == 1 {
        return if read_proxy_snapshot(&nk).is_some() {
            Ok(())
        } else {
            Err(crate::util::i18n_error("backend.proxy.stateCorrupted"))
        };
    }
    let cur_enable: u32 = inet.get_value("ProxyEnable").unwrap_or(0);
    if cur_enable > 1 {
        return Err(format!(
            "unexpected ProxyEnable={cur_enable}; enabling cancelled"
        ));
    }
    nk.set_value("SavedProxyEnable", &cur_enable)
        .map_err(|e| format!("save ProxyEnable: {e}"))?;
    match inet.get_value::<String, _>("ProxyServer") {
        Ok(v) => {
            nk.set_value("SavedProxyServer", &v)
                .map_err(|e| format!("save ProxyServer: {e}"))?;
            nk.set_value("SavedProxyServerPresent", &1u32)
                .map_err(|e| format!("save ProxyServer flag: {e}"))?;
        }
        Err(_) => {
            nk.set_value("SavedProxyServer", &"".to_string())
                .map_err(|e| format!("clear saved ProxyServer: {e}"))?;
            nk.set_value("SavedProxyServerPresent", &0u32)
                .map_err(|e| format!("save ProxyServer absent flag: {e}"))?;
        }
    }
    match inet.get_value::<String, _>("ProxyOverride") {
        Ok(v) => {
            nk.set_value("SavedProxyOverride", &v)
                .map_err(|e| format!("save ProxyOverride: {e}"))?;
            nk.set_value("SavedProxyOverridePresent", &1u32)
                .map_err(|e| format!("save ProxyOverride flag: {e}"))?;
        }
        Err(_) => {
            nk.set_value("SavedProxyOverride", &"".to_string())
                .map_err(|e| format!("clear saved ProxyOverride: {e}"))?;
            nk.set_value("SavedProxyOverridePresent", &0u32)
                .map_err(|e| format!("save ProxyOverride absent flag: {e}"))?;
        }
    }
    nk.set_value("SavedProxyValid", &1u32)
        .map_err(|e| format!("commit proxy snapshot: {e}"))?;
    Ok(())
}

fn restore_optional_string(key: &RegKey, name: &str, value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value {
        key.set_value(name, &value.to_string())
            .map_err(|e| format!("restore {name}: {e}"))
    } else {
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("delete {name}: {e}")),
        }
    }
}

fn restore_proxy_settings(inet: &RegKey, snapshot: &ProxySnapshot) -> Result<(), String> {
    restore_optional_string(inet, "ProxyServer", snapshot.server.as_deref())?;
    restore_optional_string(inet, "ProxyOverride", snapshot.proxy_override.as_deref())?;
    // ProxyEnable is the commit marker visible to WinINet. Restore all
    // dependent values first so a partial registry failure never activates a
    // half-restored proxy configuration.
    inet.set_value("ProxyEnable", &snapshot.enable)
        .map_err(|e| format!("restore ProxyEnable: {e}"))
}

// Restore the fully verified original state on a regular disable.
fn restore_proxy_snapshot(
    nk: &RegKey,
    inet: &RegKey,
    snapshot: ProxySnapshot,
) -> Result<(), String> {
    restore_proxy_settings(inet, &snapshot)?;
    nk.set_value("SavedProxyValid", &0u32)
        .map_err(|e| format!("clear proxy snapshot: {e}"))?;
    let _ = nk.delete_value("ActiveProxyServer");
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EnableRollbackSnapshot {
    settings: ProxySnapshot,
    active_server: Option<String>,
    had_saved_snapshot: bool,
}

fn capture_enable_rollback(nk: &RegKey, inet: &RegKey) -> Result<EnableRollbackSnapshot, String> {
    Ok(EnableRollbackSnapshot {
        settings: capture_proxy_settings(inet)?,
        active_server: nk.get_value::<String, _>("ActiveProxyServer").ok(),
        had_saved_snapshot: read_proxy_snapshot(nk).is_some(),
    })
}

fn rollback_failed_enable(
    nk: &RegKey,
    inet: &RegKey,
    snapshot: EnableRollbackSnapshot,
) -> Result<(), String> {
    restore_proxy_settings(inet, &snapshot.settings)?;
    restore_optional_string(nk, "ActiveProxyServer", snapshot.active_server.as_deref())?;
    if !snapshot.had_saved_snapshot {
        nk.set_value("SavedProxyValid", &0u32)
            .map_err(|e| format!("clear failed enable snapshot: {e}"))?;
    }
    Ok(())
}

fn apply_with_rollback<A, R>(apply: A, rollback: R) -> Result<(), String>
where
    A: FnOnce() -> Result<(), String>,
    R: FnOnce() -> Result<(), String>,
{
    match apply() {
        Ok(()) => Ok(()),
        Err(apply_error) => match rollback() {
            Ok(()) => Err(apply_error),
            Err(rollback_error) => Err(format!(
                "{apply_error}; rolling back the system proxy also failed: {rollback_error}"
            )),
        },
    }
}

pub fn set_system_proxy(
    enable: bool,
    host_port: Option<&str>,
    bypass_lan: Option<bool>,
) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(INET_SETTINGS_KEY)
        .map_err(|e| format!("open Internet Settings: {e}"))?;

    if enable {
        let hp = validate_proxy_endpoint(host_port.unwrap_or("127.0.0.1:7890"))?;
        let (ninety, _) = hkcu
            .create_subkey(NINETY_KEY)
            .map_err(|e| format!("open Ninety proxy state: {e}"))?;
        // SavedProxy* remains the original state until the first enable and is needed for
        // the final disable. This separate snapshot applies only to
        // the current call: a repeated A → B setup must return to A on error.
        let rollback = capture_enable_rollback(&ninety, &key)?;
        save_proxy_snapshot(&hkcu, &key)?;
        let override_list = if bypass_lan.unwrap_or(true) {
            PROXY_OVERRIDE
        } else {
            PROXY_OVERRIDE_LOOPBACK_ONLY
        };

        // All writes before ProxyEnable are preparation, ProxyEnable is the commit. Any
        // error restores the state from before the current call, not the original snapshot
        // of the first Ninety session.
        if let Err(e) = apply_with_rollback(
            || {
                ninety
                    .set_value("ActiveProxyServer", &hp.to_string())
                    .map_err(|e| format!("save active proxy: {e}"))?;
                key.set_value("ProxyServer", &hp.to_string())
                    .map_err(|e| format!("set ProxyServer: {e}"))?;
                key.set_value("ProxyOverride", &override_list.to_string())
                    .map_err(|e| format!("set ProxyOverride: {e}"))?;
                key.set_value("ProxyEnable", &1u32)
                    .map_err(|e| format!("set ProxyEnable: {e}"))?;
                Ok(())
            },
            || rollback_failed_enable(&ninety, &key, rollback),
        ) {
            // Even after a successful rollback some WinINet clients may have seen
            // intermediate values; we make them reread the restored state.
            notify_proxy_change();
            return Err(e);
        }
    } else {
        let current: String = key.get_value("ProxyServer").unwrap_or_default();
        let current_enable: u32 = key.get_value("ProxyEnable").unwrap_or(0);
        let current_override = key.get_value::<String, _>("ProxyOverride").ok();
        let state = hkcu
            .open_subkey_with_flags(NINETY_KEY, KEY_READ | KEY_WRITE)
            .ok();
        let active = state
            .as_ref()
            .and_then(|k| k.get_value::<String, _>("ActiveProxyServer").ok());
        let snapshot = state.as_ref().and_then(read_proxy_snapshot);
        match proxy_recovery_action(
            &current,
            current_enable,
            current_override.as_deref(),
            active.as_deref(),
            snapshot.is_some(),
        ) {
            ProxyRecoveryAction::LeaveUntouched => {
                // Someone changed the proxy after Ninety, or there is no proof of ownership.
                // We don't touch the Windows settings, we forget the stale markers.
                if let Some(nk) = state.as_ref() {
                    let _ = nk.set_value("SavedProxyValid", &0u32);
                    let _ = nk.delete_value("ActiveProxyServer");
                }
            }
            ProxyRecoveryAction::RestoreSnapshot => {
                let nk = state.as_ref().ok_or("proxy snapshot key disappeared")?;
                let snapshot = snapshot.ok_or("proxy snapshot disappeared")?;
                restore_proxy_snapshot(nk, &key, snapshot)?;
            }
            ProxyRecoveryAction::RestoreSnapshotKeepOverride => {
                // The address and enable flag are restored from the snapshot, while the exclusion
                // list is left as it was made without us.
                let nk = state.as_ref().ok_or("proxy snapshot key disappeared")?;
                let mut snapshot = snapshot.ok_or("proxy snapshot disappeared")?;
                snapshot.proxy_override = current_override.clone();
                restore_proxy_snapshot(nk, &key, snapshot)?;
            }
            ProxyRecoveryAction::DisableOwnedProxy => {
                // The explicit ActiveProxyServer matched, but the snapshot is missing or
                // damaged. We disable only the proxy proven to be ours and don't try
                // to restore partial values.
                key.set_value("ProxyEnable", &0u32)
                    .map_err(|e| format!("clear ProxyEnable: {e}"))?;
                if let Some(nk) = state.as_ref() {
                    let _ = nk.set_value("SavedProxyValid", &0u32);
                    let _ = nk.delete_value("ActiveProxyServer");
                }
            }
        }
    }

    notify_proxy_change();
    Ok(())
}

pub fn recover_stale_system_proxy() -> Result<(), String> {
    set_system_proxy(false, None, None)
}

pub fn system_proxy_state() -> SystemProxyState {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let current = hkcu
        .open_subkey_with_flags(INET_SETTINGS_KEY, KEY_READ)
        .ok();
    let ninety = hkcu.open_subkey_with_flags(NINETY_KEY, KEY_READ).ok();
    let enabled = current
        .as_ref()
        .and_then(|k| k.get_value::<u32, _>("ProxyEnable").ok())
        == Some(1);
    let server = current
        .as_ref()
        .and_then(|k| k.get_value::<String, _>("ProxyServer").ok());
    let active = ninety
        .as_ref()
        .and_then(|k| k.get_value::<String, _>("ActiveProxyServer").ok());
    // Case-insensitive — as in proxy_recovery_action. We normalize the endpoint
    // address ourselves, but ProxyServer may contain an entry made outside
    // Ninety (or by an earlier build) in a different case: a strict comparison then
    // declared our own proxy foreign, and disable left it enabled.
    let same_endpoint = match (server.as_deref(), active.as_deref()) {
        (Some(server), Some(active)) => server.eq_ignore_ascii_case(active),
        _ => false,
    };
    let owned = enabled && same_endpoint;
    SystemProxyState {
        proxy_enable: enabled,
        proxy_server: server,
        owned,
    }
}

pub fn system_proxy_owned() -> bool {
    system_proxy_state().owned
}

pub fn system_proxy_matches(expected: &str) -> bool {
    let state = system_proxy_state();
    if !state.proxy_enable || !state.owned {
        return false;
    }
    let actual = state.proxy_server.as_deref();
    actual.is_some_and(|value| value.eq_ignore_ascii_case(expected))
}

// True if the current process runs with administrator rights (elevated token).
// Throne-style TUN requires the whole app to be elevated — sing-box,
// which brings up the TUN inbound, runs as a child process and inherits the rights.
pub fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut ret_len: u32 = 0;
        let size = std::mem::size_of::<TOKEN_ELEVATION>() as u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
            size,
            &mut ret_len,
        );
        let _ = CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    }
}

// Restarts the current exe with administrator rights via runas (UAC).
// Fire-and-forget: after Ok(true) the caller must terminate the current process.
//  - Ok(true)  — the elevated instance started;
//  - Ok(false) — the user cancelled UAC (the current process is NOT touched, we stay as is);
//  - Err       — a system launch error.
// extra_args are passed to the new process (e.g. "--elevated" for auto-connect).
pub fn relaunch_self_elevated(extra_args: &[&str]) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe_str = exe.to_string_lossy().to_string();
    let dir = exe
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let verb = to_wide("runas");
    let file = to_wide(&exe_str);
    let params = extra_args
        .iter()
        .map(|a| {
            if a.contains(' ') {
                format!("\"{}\"", a)
            } else {
                (*a).to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let params_w = to_wide(&params);
    let dir_w = to_wide(&dir);

    unsafe {
        let h = ShellExecuteW(
            Some(HWND::default()),
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR(params_w.as_ptr()),
            PCWSTR(dir_w.as_ptr()),
            SW_SHOWNORMAL,
        );
        match shell_launch_status(h) {
            ShellLaunchStatus::Started => Ok(true),
            ShellLaunchStatus::Cancelled => Ok(false),
            ShellLaunchStatus::AccessDenied => {
                Err(crate::util::i18n_error("backend.elevation.denied"))
            }
            ShellLaunchStatus::FileNotFound => {
                Err(crate::util::i18n_error("backend.elevation.exeMissing"))
            }
            ShellLaunchStatus::Failed {
                shell_code,
                last_error,
            } => Err(crate::util::i18n_error_with(
                "backend.elevation.failed",
                &[
                    ("shell", &shell_code.to_string()),
                    ("win32", &last_error.to_string()),
                ],
            )),
        }
    }
}

// ── Autostart via Task Scheduler ──────────────────────────────────
// schtasks.exe — full path, so as not to depend on PATH/cwd of the elevated context.
fn schtasks_exe() -> String {
    crate::util::system_directory()
        .join("schtasks.exe")
        .to_string_lossy()
        .into_owned()
}

// System roots that already require administrator rights to write to. Only for
// an exe from there may the autostart task run with RunLevel=highest.
// The source is HKLM (see util::program_files_roots): environment variables of the
// same name can be overridden from HKCU by a regular user, and then the decision to
// grant highest would be made based on a value they slipped in themselves.
fn program_files_roots() -> Vec<PathBuf> {
    crate::util::program_files_roots()
}

// A task with /rl highest starts the exe as administrator without UAC on every login.
// If the exe itself lives where a regular user can write (Full Portable
// from a ZIP, a per-user install in AppData), swapping the file becomes a silent
// privilege escalation. In such a location autostart stays at the regular level: TUN
// will request UAC the normal way if needed.
fn autostart_uses_highest_run_level(exe: &Path, roots: &[PathBuf]) -> bool {
    let exe = exe.to_string_lossy().to_lowercase();
    roots.iter().any(|root| {
        let root = root.to_string_lossy().to_lowercase();
        !root.is_empty() && exe.starts_with(&root) && exe[root.len()..].starts_with(['\\', '/'])
    })
}

// Tail of the task creation command. The parameters are in XML: schtasks arguments can't
// lift the battery restriction and the 72-hour limit, because of which Task Scheduler didn't start
// Ninety on a laptop and terminated it without cleaning up the system proxy.
fn create_task_cmdline(xml_path: &str) -> String {
    format!(
        r#"/create /tn {} /xml "{}" /f"#,
        schtasks_name_arg(task_name()),
        xml_path
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// The trigger is this user's sign-in; RunLevel=highest only for the system directory.
fn autostart_task_xml(exe: &str, highest: bool, user: &str) -> String {
    let exe = xml_escape(exe);
    let user = xml_escape(user);
    let run_level = if highest {
        "HighestAvailable"
    } else {
        "LeastPrivilege"
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>{run_level}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>--autostarted --elevated</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

// The task definition file. The file is held open without write and delete permission while
// the value lives: otherwise another user process could swap it between
// writing and schtasks reading it, which runs with administrator rights after UAC.
struct AutostartTaskFile {
    path: PathBuf,
    lock: Option<std::fs::File>,
}

impl AutostartTaskFile {
    fn create(xml: &str) -> Result<Self, String> {
        use std::io::{Read, Write};
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::FILE_SHARE_READ;

        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "ninety-autostart-{}-{nonce:x}.xml",
            std::process::id()
        ));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(|e| format!("autostart task file: {e}"))?;
        let mut file = Self { path, lock: None };
        let mut lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ.0)
            .open(&file.path)
            .map_err(|e| format!("autostart task file: {e}"))?;
        let mut stored = Vec::new();
        lock.read_to_end(&mut stored)
            .map_err(|e| format!("autostart task file: {e}"))?;
        file.lock = Some(lock);
        if stored != bytes {
            return Err("autostart task file was changed".into());
        }
        Ok(file)
    }
}

impl Drop for AutostartTaskFile {
    fn drop(&mut self) {
        self.lock.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

fn autostart_task_user() -> Result<String, String> {
    let user = std::env::var("USERNAME").unwrap_or_default();
    if user.is_empty() {
        return Err(crate::util::i18n_error("backend.autostart.taskFailed"));
    }
    Ok(match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.is_empty() => format!("{domain}\\{user}"),
        _ => user,
    })
}

// A regular process can't pass arguments to the window of a process with
// administrator rights: UIPI drops WM_COPYDATA, and a second launch with a link
// exits without a trace. We allow this message only for the single-instance window.
// The window and class names come from tauri-plugin-single-instance.
pub fn allow_second_instance_messages(identifier: &str) {
    if !is_elevated() {
        return;
    }
    let class = to_wide(&format!("{identifier}-sic"));
    let window = to_wide(&format!("{identifier}-siw"));
    unsafe {
        let Ok(hwnd) = FindWindowW(PCWSTR(class.as_ptr()), PCWSTR(window.as_ptr())) else {
            eprintln!("single-instance window not found");
            return;
        };
        if let Err(e) = ChangeWindowMessageFilterEx(hwnd, WM_COPYDATA, MSGFLT_ALLOW, None) {
            eprintln!("single-instance message filter: {e}");
        }
    }
}

fn task_name() -> &'static str {
    if crate::app_paths::is_portable() {
        PORTABLE_TASK_NAME
    } else {
        INSTALLED_TASK_NAME
    }
}

fn schtasks_name_arg(name: &str) -> String {
    if name.chars().any(char::is_whitespace) {
        format!(r#""{name}""#)
    } else {
        name.to_string()
    }
}

// Running schtasks with elevation (one UAC, the app itself is not restarted).
// SW_HIDE hides the console window; a detailed status is needed for a clear UI error.
fn run_schtasks_elevated(cmdline: &str) -> ShellLaunchStatus {
    let verb = to_wide("runas");
    let file = to_wide(&schtasks_exe());
    let params = to_wide(cmdline);
    unsafe {
        let h = ShellExecuteW(
            Some(HWND::default()),
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR(params.as_ptr()),
            PCWSTR::null(),
            SW_HIDE,
        );
        shell_launch_status(h)
    }
}

fn elevated_task_error(status: ShellLaunchStatus) -> Result<(), String> {
    match status {
        ShellLaunchStatus::Started => Ok(()),
        ShellLaunchStatus::Cancelled => Err(crate::util::i18n_error("backend.autostart.cancelled")),
        ShellLaunchStatus::AccessDenied => Err(crate::util::i18n_error("backend.autostart.denied")),
        ShellLaunchStatus::FileNotFound => {
            Err(crate::util::i18n_error("backend.autostart.noSchtasks"))
        }
        ShellLaunchStatus::Failed {
            shell_code,
            last_error,
        } => Err(crate::util::i18n_error_with(
            "backend.autostart.launchFailed",
            &[
                ("shell", &shell_code.to_string()),
                ("win32", &last_error.to_string()),
            ],
        )),
    }
}

fn wait_for_task_state_with<Q, S>(
    expected: bool,
    delays_ms: &[u64],
    mut query: Q,
    mut sleep: S,
) -> bool
where
    Q: FnMut() -> bool,
    S: FnMut(u64),
{
    if query() == expected {
        return true;
    }
    for &delay in delays_ms {
        sleep(delay);
        if query() == expected {
            return true;
        }
    }
    false
}

fn wait_for_task_state(expected: bool) -> bool {
    wait_for_task_state_with(
        expected,
        AUTOSTART_BACKOFF_MS,
        autostart_is_enabled_unlocked,
        |delay| std::thread::sleep(std::time::Duration::from_millis(delay)),
    )
}

// True if the autostart task is registered. Query doesn't require rights.
fn autostart_is_enabled_unlocked() -> bool {
    Command::new(schtasks_exe())
        .args(["/query", "/tn", task_name()])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn legacy_autostart_present() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(run) = hkcu.open_subkey_with_flags(RUN_KEY, KEY_READ) else {
        return false;
    };
    LEGACY_RUN_VALUES
        .iter()
        .any(|name| run.get_raw_value(name).is_ok())
}

// Remove the previous-generation autostart (registry Run key). A separate operation,
// because such a user may have no Task Scheduler task at all:
// the migration creates it only from an elevated process, and until then autostart
// lives exclusively in Run. Without this cleanup "Disable autostart" did nothing —
// the command exited immediately on "no task", while autostart_is_enabled
// kept seeing the Run key and flipped the toggle back to the enabled
// position. A missing key is not an error: the operation is idempotent.
fn remove_legacy_autostart() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(run) = hkcu.open_subkey_with_flags(RUN_KEY, KEY_READ | KEY_WRITE) else {
        return Ok(());
    };
    let mut errors = Vec::new();
    for name in LEGACY_RUN_VALUES {
        if run.get_raw_value(name).is_err() {
            continue;
        }
        if let Err(e) = run.delete_value(name) {
            errors.push(format!("{name}: {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "could not remove the outdated autostart: {}",
            errors.join("; ")
        ))
    }
}

pub fn autostart_is_enabled() -> bool {
    let _guard = autostart_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // While the background migration hasn't yet replaced the old Run key with a task,
    // the UI must see the actual legacy autostart, not a temporary false.
    autostart_is_enabled_unlocked() || legacy_autostart_present()
}

// Creates/updates the task. If the process is already elevated — directly (no UAC);
// otherwise elevates only for schtasks (one UAC) and waits for the task to appear.
fn autostart_enable_unlocked() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let highest = autostart_uses_highest_run_level(&exe, &program_files_roots());
    let xml = autostart_task_xml(&exe.to_string_lossy(), highest, &autostart_task_user()?);
    // The file is needed until the end of the function: schtasks with UAC reads it after
    // ShellExecute has already returned.
    let task_file = AutostartTaskFile::create(&xml)?;
    let cmdline = create_task_cmdline(&task_file.path.to_string_lossy());
    if is_elevated() {
        let ok = Command::new(schtasks_exe())
            .raw_arg(&cmdline)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("schtasks /create: {e}"))?
            .success();
        return if ok {
            Ok(())
        } else {
            Err(crate::util::i18n_error("backend.autostart.taskFailed"))
        };
    }
    elevated_task_error(run_schtasks_elevated(&cmdline))?;
    if wait_for_task_state(true) {
        return Ok(());
    }
    Err(crate::util::i18n_error("backend.autostart.timeout"))
}

pub fn autostart_enable() -> Result<(), String> {
    let _guard = autostart_lock()
        .lock()
        .map_err(|_| "autostart lock is poisoned".to_string())?;
    autostart_enable_unlocked()
}

// Deletes the autostart task (symmetric to enable — direct if elevated).
// The legacy Run key is removed FIRST and regardless of whether the task exists: it is also
// autostart, autostart_is_enabled sees it, and without this step disabling
// would remain a no-op for everyone who came from builds using the Run key.
fn autostart_disable_unlocked() -> Result<(), String> {
    remove_legacy_autostart()?;
    if !autostart_is_enabled_unlocked() {
        return Ok(());
    }
    let cmdline = format!("/delete /tn {} /f", schtasks_name_arg(task_name()));
    if is_elevated() {
        let ok = Command::new(schtasks_exe())
            .raw_arg(&cmdline)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("schtasks /delete: {e}"))?
            .success();
        return if ok {
            Ok(())
        } else {
            Err(crate::util::i18n_error("backend.autostart.taskFailed"))
        };
    }
    elevated_task_error(run_schtasks_elevated(&cmdline))?;
    if wait_for_task_state(false) {
        return Ok(());
    }
    Err(crate::util::i18n_error("backend.autostart.timeout"))
}

pub fn autostart_disable() -> Result<(), String> {
    let _guard = autostart_lock()
        .lock()
        .map_err(|_| "autostart lock is poisoned".to_string())?;
    autostart_disable_unlocked()
}

// Migration from the former autostart (the autostart plugin's registry Run key). It
// started a non-elevated instance → relaunch via UAC on every login. We remove
// the key and, if we are in an elevated instance, create a scheduler task instead.
// The Run key is deleted ONLY when the task is created successfully — otherwise a user without
// always-admin (for whom non-elevated autostart is enough) would lose autostart.
pub fn migrate_legacy_autostart() {
    let _guard = autostart_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !legacy_autostart_present() {
        return;
    }
    // The key is removed ONLY after the task was created successfully: for a user without
    // always-admin, non-elevated autostart via Run is the only working one, and
    // it must not be lost before the replacement appears.
    if is_elevated() && autostart_enable_unlocked().is_ok() {
        let _ = remove_legacy_autostart();
    }
}

// Updates the exe path in the autostart task (after reinstalling into a different
// directory, /create /f overwrites the command). Only if the task already exists and we are
// elevated — otherwise skip: creating it non-elevated would trigger an extra UAC.
pub fn autostart_refresh_path() {
    let _guard = autostart_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if is_elevated() && autostart_is_enabled_unlocked() {
        let _ = autostart_enable_unlocked();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn system_proxy_endpoint_accepts_only_explicit_loopback_hosts() {
        assert_eq!(
            validate_proxy_endpoint("127.0.0.1:7890").unwrap(),
            "127.0.0.1:7890"
        );
        assert_eq!(
            validate_proxy_endpoint("LOCALHOST:8080").unwrap(),
            "localhost:8080"
        );
        assert_eq!(validate_proxy_endpoint("[::1]:1080").unwrap(), "[::1]:1080");
        for invalid in [
            "0.0.0.0:7890",
            "127.0.0.2:7890",
            "192.168.1.10:7890",
            "example.com:7890",
            "http://127.0.0.1:7890",
            "localhost:0",
            "localhost",
        ] {
            assert!(
                validate_proxy_endpoint(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }

    fn recovery_action(
        server: &str,
        active: Option<&str>,
        snapshot_valid: bool,
    ) -> ProxyRecoveryAction {
        proxy_recovery_action(server, 1, Some(PROXY_OVERRIDE), active, snapshot_valid)
    }

    #[test]
    fn foreign_loopback_without_markers_is_untouched() {
        assert_eq!(
            recovery_action("127.0.0.1:8080", None, false),
            ProxyRecoveryAction::LeaveUntouched
        );
    }

    #[test]
    fn matching_active_proxy_restores_valid_snapshot() {
        assert_eq!(
            recovery_action("127.0.0.1:7890", Some("127.0.0.1:7890"), true),
            ProxyRecoveryAction::RestoreSnapshot
        );
    }

    #[test]
    fn matching_active_proxy_without_snapshot_only_disables_owned_value() {
        assert_eq!(
            recovery_action("127.0.0.1:7890", Some("127.0.0.1:7890"), false),
            ProxyRecoveryAction::DisableOwnedProxy
        );
    }

    #[test]
    fn mismatching_active_proxy_is_untouched_even_with_snapshot() {
        assert_eq!(
            recovery_action("127.0.0.1:8080", Some("127.0.0.1:7890"), true),
            ProxyRecoveryAction::LeaveUntouched
        );
    }

    #[test]
    fn valid_legacy_snapshot_only_accepts_historical_default() {
        assert_eq!(
            recovery_action(LEGACY_PROXY_SERVER, None, true),
            ProxyRecoveryAction::RestoreSnapshot
        );
        assert_eq!(
            recovery_action("127.0.0.1:8080", None, true),
            ProxyRecoveryAction::LeaveUntouched
        );
    }

    #[test]
    fn absent_or_corrupt_legacy_snapshot_never_claims_proxy() {
        assert_eq!(
            recovery_action(LEGACY_PROXY_SERVER, None, false),
            ProxyRecoveryAction::LeaveUntouched
        );
    }

    #[test]
    fn third_party_disable_is_untouched() {
        assert_eq!(
            proxy_recovery_action(
                "127.0.0.1:7890",
                0,
                Some(PROXY_OVERRIDE),
                Some("127.0.0.1:7890"),
                true,
            ),
            ProxyRecoveryAction::LeaveUntouched
        );
    }

    #[test]
    fn owned_proxy_with_foreign_override_is_still_turned_off() {
        assert_eq!(
            proxy_recovery_action(
                "127.0.0.1:7890",
                1,
                Some("localhost;<local>"),
                Some("127.0.0.1:7890"),
                true,
            ),
            ProxyRecoveryAction::RestoreSnapshotKeepOverride
        );
        assert_eq!(
            proxy_recovery_action(
                "127.0.0.1:7890",
                1,
                Some("localhost;<local>"),
                Some("127.0.0.1:7890"),
                false,
            ),
            ProxyRecoveryAction::DisableOwnedProxy
        );
        assert_eq!(
            proxy_recovery_action("127.0.0.1:7890", 1, None, Some("127.0.0.1:7890"), true),
            ProxyRecoveryAction::RestoreSnapshotKeepOverride
        );
    }

    #[test]
    fn failed_enable_runs_rollback_and_preserves_apply_error() {
        let rolled_back = Cell::new(false);
        let err = apply_with_rollback(
            || Err("set ProxyOverride failed".into()),
            || {
                rolled_back.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(rolled_back.get());
        assert_eq!(err, "set ProxyOverride failed");
    }

    #[test]
    fn rollback_failure_reports_both_errors() {
        let err = apply_with_rollback(
            || Err("set ProxyEnable failed".into()),
            || Err("restore ProxyServer failed".into()),
        )
        .unwrap_err();
        assert!(err.contains("set ProxyEnable failed"));
        assert!(err.contains("restore ProxyServer failed"));
    }

    #[test]
    fn reenable_rollback_snapshot_keeps_immediate_owned_state() {
        let original = ProxySnapshot {
            enable: 0,
            server: Some("corp.example:8080".into()),
            proxy_override: None,
        };
        let immediate = ProxySnapshot {
            enable: 1,
            server: Some("127.0.0.1:7890".into()),
            proxy_override: Some(PROXY_OVERRIDE.into()),
        };
        let rollback = EnableRollbackSnapshot {
            settings: immediate.clone(),
            active_server: Some("127.0.0.1:7890".into()),
            had_saved_snapshot: true,
        };
        assert_eq!(rollback.settings, immediate);
        assert_ne!(rollback.settings, original);
        assert_eq!(rollback.active_server.as_deref(), Some("127.0.0.1:7890"));
        assert!(rollback.had_saved_snapshot);
    }

    #[test]
    fn successful_enable_does_not_run_rollback() {
        let rolled_back = Cell::new(false);
        assert!(apply_with_rollback(
            || Ok(()),
            || {
                rolled_back.set(true);
                Ok(())
            },
        )
        .is_ok());
        assert!(!rolled_back.get());
    }

    #[test]
    fn latest_proxy_notification_generation_is_not_lost() {
        let first = notify_proxy_change();
        let latest = notify_proxy_change();
        assert!(latest > first);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let (requested, applied) = proxy_notification_generations();
            if requested >= latest && applied >= latest {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "proxy notification worker stalled"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn schtasks_command_quotes_xml_path_with_spaces_and_unicode() {
        let cmd = create_task_cmdline(r"C:\Users\Дима Ш\AppData\Local\Temp\task.xml");
        assert_eq!(
            cmd,
            r#"/create /tn Ninety /xml "C:\Users\Дима Ш\AppData\Local\Temp\task.xml" /f"#
        );
    }

    #[test]
    fn autostart_task_survives_battery_and_long_uptime() {
        let xml = autostart_task_xml(r"C:\Program Files\Ninety\Ninety.exe", true, r"PC\Дима");
        assert!(xml.contains("<DisallowStartIfOnBatteries>false<"), "{xml}");
        assert!(xml.contains("<StopIfGoingOnBatteries>false<"), "{xml}");
        assert!(xml.contains("<ExecutionTimeLimit>PT0S<"), "{xml}");
        assert!(xml.contains("<RunLevel>HighestAvailable<"), "{xml}");
        assert!(xml.contains(r"<UserId>PC\Дима</UserId>"), "{xml}");
    }

    #[test]
    fn autostart_task_escapes_xml_in_paths() {
        let xml = autostart_task_xml(r"D:\R&D <1>\Ninety.exe", false, "user");
        assert!(
            xml.contains(r"<Command>D:\R&amp;D &lt;1&gt;\Ninety.exe</Command>"),
            "{xml}"
        );
    }

    // Autostart with highest on a user-writable exe is a silent privilege escalation for
    // any user process that can overwrite the file.
    #[test]
    fn autostart_highest_only_for_admin_owned_locations() {
        let roots = vec![
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Program Files (x86)"),
        ];
        assert!(autostart_uses_highest_run_level(
            Path::new(r"C:\Program Files\Ninety\Ninety.exe"),
            &roots
        ));
        assert!(autostart_uses_highest_run_level(
            Path::new(r"c:\program files (x86)\Ninety\Ninety.exe"),
            &roots
        ));
        for user_writable in [
            r"C:\Users\dima\Downloads\Ninety\Ninety.exe",
            r"C:\Users\dima\AppData\Local\Ninety\Ninety.exe",
            // A prefix match without a directory boundary doesn't make a path a system one.
            r"C:\Program Files Portable\Ninety\Ninety.exe",
        ] {
            assert!(
                !autostart_uses_highest_run_level(Path::new(user_writable), &roots),
                "{user_writable} не должен получать highest"
            );
        }
    }

    // The test above passes the roots as a literal, so it can't see a substitution of
    // THE SOURCE ITSELF. Production takes them from HKLM: environment variables are written by
    // HKCU\Environment, and through them a regular user could declare their own directory
    // a system one, getting highest on a replaceable exe.
    #[test]
    fn program_files_roots_ignore_process_environment() {
        let planted = r"C:\Users\dima\AppData\Local\NinetyFake";
        for name in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            std::env::set_var(name, planted);
        }
        let roots = program_files_roots();
        for name in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            std::env::remove_var(name);
        }
        assert!(
            !roots.iter().any(|root| root == Path::new(planted)),
            "корни Program Files пришли из окружения: {roots:?}"
        );
        assert!(
            !autostart_uses_highest_run_level(
                Path::new(r"C:\Users\dima\AppData\Local\NinetyFake\Ninety.exe"),
                &roots
            ),
            "подменённое окружение выдало highest на user-writable exe"
        );
    }

    #[test]
    fn portable_autostart_task_has_no_highest_run_level() {
        let xml = autostart_task_xml(r"D:\Ninety\Ninety.exe", false, "user");
        assert!(xml.contains("<RunLevel>LeastPrivilege<"), "{xml}");
    }

    #[test]
    fn portable_task_name_is_quoted_for_raw_schtasks_command() {
        assert_eq!(schtasks_name_arg(INSTALLED_TASK_NAME), "Ninety");
        assert_eq!(
            schtasks_name_arg(PORTABLE_TASK_NAME),
            r#""Ninety Portable""#
        );
    }

    #[test]
    fn shell_launch_status_distinguishes_common_failures() {
        assert_eq!(classify_shell_launch(33, 0), ShellLaunchStatus::Started);
        assert_eq!(classify_shell_launch(5, 1223), ShellLaunchStatus::Cancelled);
        assert_eq!(classify_shell_launch(5, 5), ShellLaunchStatus::AccessDenied);
        assert_eq!(classify_shell_launch(2, 2), ShellLaunchStatus::FileNotFound);
        assert_eq!(
            classify_shell_launch(8, 8),
            ShellLaunchStatus::Failed {
                shell_code: 8,
                last_error: 8
            }
        );
    }

    #[test]
    fn autostart_backoff_covers_slow_scheduler() {
        assert_eq!(AUTOSTART_BACKOFF_MS.iter().sum::<u64>(), 8_550);
        assert!(AUTOSTART_BACKOFF_MS
            .windows(2)
            .all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn wait_accepts_late_task_appearance_and_removal() {
        let mut create_checks = 0;
        assert!(wait_for_task_state_with(
            true,
            AUTOSTART_BACKOFF_MS,
            || {
                create_checks += 1;
                create_checks >= 6
            },
            |_| {}
        ));

        let mut delete_checks = 0;
        assert!(wait_for_task_state_with(
            false,
            AUTOSTART_BACKOFF_MS,
            || {
                delete_checks += 1;
                delete_checks < 6
            },
            |_| {}
        ));
    }

    #[test]
    fn wait_times_out_when_scheduler_never_changes() {
        let mut sleeps = Vec::new();
        assert!(!wait_for_task_state_with(
            true,
            AUTOSTART_BACKOFF_MS,
            || false,
            |delay| sleeps.push(delay)
        ));
        assert_eq!(sleeps, AUTOSTART_BACKOFF_MS);
    }
}
