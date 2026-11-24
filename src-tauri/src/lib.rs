mod app_paths;
mod atomic_file;
mod backup;
mod clash;
mod clash_stream;
mod diagnose;
mod discord_cache;
mod dnscheck;
mod dpi;
mod feedback;
mod forwarding;
mod host_pressure;
mod hwid;
mod ipv6;
mod job_guard;
mod killswitch;
mod lan_auth;
mod netproc;
mod portable_update;
mod profile_store;
mod protected_browser;
mod quality;
mod rules_file;
mod runtime_ops;
mod scanner;
mod secrets;
mod subscription;
mod url_handler;
mod util;
mod vpn;
mod warp;
mod wifi;

#[cfg(not(target_os = "windows"))]
mod proxy_stub;
#[cfg(target_os = "windows")]
mod proxy_win;

#[cfg(not(target_os = "windows"))]
use proxy_stub as elevation;
#[cfg(target_os = "windows")]
use proxy_win as elevation;

use std::collections::HashMap;
use std::path::PathBuf;

use crate::util::MutexExt;
use tauri::{
    menu::{CheckMenuItem, IconMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, WindowEvent,
};

#[cfg(any(target_os = "windows", target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

use vpn::SingboxState;

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// Full Portable is detected by a marker next to Ninety.exe: writable data and
/// the WebView profile go to NinetyData, and the updater offers a new ZIP instead of
/// running NSIS and turning the unpacked copy into an installed one.
#[tauri::command]
fn is_portable() -> bool {
    app_paths::is_portable()
}

/// True if this launch should auto-connect after bootstrap:
///  --autostarted — Windows sign-in (window in the tray);
///  --connect     — a restart requested by the connection (window visible).
/// `--elevated` is not included here: it only speaks about rights. With it, Ninety
/// restarts both for DPI bypass and when switching modes with the VPN off,
/// and for "always run as administrator" — there the VPN used to come up unasked.
#[tauri::command]
fn should_autoconnect() -> bool {
    autoconnect_requested(std::env::args())
}

fn autoconnect_requested<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|a| matches!(a.as_ref(), "--autostarted" | "--connect"))
}

/// Arguments for restarting as administrator. `--autostarted` is carried over so
/// the window stays in the tray; `--connect` only if the frontend asked to connect.
/// `--wait-parent` — PID of the previous process, see wait_for_relaunching_parent.
fn elevated_relaunch_args(autostarted: bool, connect: bool, parent_pid: u32) -> Vec<String> {
    let mut extra = vec!["--elevated".to_string()];
    if autostarted {
        extra.push("--autostarted".into());
    }
    if connect {
        extra.push("--connect".into());
    }
    extra.push(format!("{WAIT_PARENT_ARG}{parent_pid}"));
    extra
}

/// ShellExecute takes a single parameter string, and a quote in it is an argument
/// boundary. The link comes from outside and with such a quote it would append its own flags
/// to a process running with administrator rights, so we don't pass such a link.
fn safe_relaunch_link(url: &str) -> bool {
    url.len() <= 2048
        && !url.contains('"')
        && !url.ends_with('\\')
        && !url.chars().any(char::is_control)
}

fn relaunch_self_elevated(
    autostarted: bool,
    connect: bool,
    links: &[String],
) -> Result<bool, String> {
    let mut extra = elevated_relaunch_args(autostarted, connect, std::process::id());
    extra.extend(links.iter().filter(|url| safe_relaunch_link(url)).cloned());
    let extra: Vec<&str> = extra.iter().map(String::as_str).collect();
    elevation::relaunch_self_elevated(&extra)
}

const WAIT_PARENT_ARG: &str = "--wait-parent=";
#[cfg(target_os = "windows")]
// Before exiting, the previous process stops the engines and restores the system proxy:
// five seconds weren't always enough for that.
const WAIT_PARENT_TIMEOUT_MS: u32 = 30_000;

fn parent_to_wait_for<I, S>(args: I) -> Option<u32>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .find_map(|a| a.as_ref().strip_prefix(WAIT_PARENT_ARG)?.parse().ok())
        .filter(|pid| *pid != 0)
}

/// The previous process exits on its own right after UAC, but the new one could start
/// before it managed to exit. Then the new process's single-instance found
/// a live mutex, handed the arguments to the exiting process and closed — and
/// not a single window was left. So before registering the plugin we wait for the
/// previous process to exit; the wait is bounded, and a vanished PID isn't waited on at all.
/// true — the previous process is gone (or there was nobody to wait for); false — it is still
/// alive when the wait expires.
#[cfg(target_os = "windows")]
fn wait_for_relaunching_parent() -> bool {
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    let Some(pid) = parent_to_wait_for(std::env::args()) else {
        return true;
    };
    if pid == std::process::id() {
        return true;
    }
    unsafe {
        // ERROR_INVALID_PARAMETER — the PID is already gone. Any other error (ACCESS_DENIED)
        // doesn't confirm the exit.
        let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
            return GetLastError() == ERROR_INVALID_PARAMETER;
        };
        let exited = WaitForSingleObject(handle, WAIT_PARENT_TIMEOUT_MS) == WAIT_OBJECT_0;
        let _ = CloseHandle(handle);
        exited
    }
}

#[cfg(not(target_os = "windows"))]
fn wait_for_relaunching_parent() -> bool {
    true
}

/// Deep-link URLs that arrived in argv on cold start. Needed for schemes
/// registered manually (vless://, tt://, naive+https://...): the deep-link
/// plugin knows only the static ninety:// from tauri.conf.json.
#[tauri::command]
fn startup_deep_links() -> Vec<String> {
    url_handler::extract_deep_link_urls(std::env::args())
}

/// True if the current process has administrator rights (elevated token).
/// TUN mode (Throne-style) requires this: the sing-box child inherits the rights and
/// brings up the TUN interface itself. The frontend checks before enabling TUN.
#[tauri::command]
fn is_elevated() -> bool {
    elevation::is_elevated()
}

/// Restarts Ninety as administrator (UAC) for TUN mode or DPI bypass.
/// `connect` — whether to bring up the VPN in the new process: the frontend passes true when
/// the restart comes from connecting or the VPN is already running. Returns:
///  Ok(true)  — the elevated instance started, the current process will exit on its own;
///  Ok(false) — the user cancelled UAC, we stay in the current (non-admin) process.
/// `keep_in_tray` — carry over `--autostarted` (window in the tray + auto-connect):
/// only for a restart from the Windows sign-in autostart scenario. Previously
/// the flag was always carried over, and an interactive restart for DPI or TUN after
/// sign-in hid the window and brought up the VPN by itself, even though the user had turned it off.
#[tauri::command]
fn relaunch_elevated(
    app: tauri::AppHandle,
    connect: Option<bool>,
    keep_in_tray: Option<bool>,
) -> Result<bool, String> {
    let autostarted =
        keep_in_tray.unwrap_or(false) && std::env::args().any(|a| a == "--autostarted");
    let started = relaunch_self_elevated(autostarted, connect.unwrap_or(false), &[])?;
    if started {
        // The elevated instance has already been created (the user agreed in UAC). The current
        // (non-admin) process must be killed IMMEDIATELY to release the
        // tauri-plugin-single-instance lock — otherwise the plugin would reject the new instance
        // as a duplicate and it would exit right away (like Throne: relaunch → quit → release
        // QLocalServer). std::process::exit bypasses RunEvent::Exit, so
        // we clean up the core and system proxy synchronously right here.
        if let Some(state) = app.try_state::<SingboxState>() {
            vpn::force_cleanup(&app, &state);
        }
        if let Some(state) = app.try_state::<dpi::DpiState>() {
            dpi::force_cleanup(&state);
        }
        std::process::exit(0);
    }
    Ok(false)
}

/// Installs the downloaded portable update and restarts Ninety with the new version.
/// The frontend has already stopped the engines; on success the process exits right here, as in
/// relaunch_elevated: the new instance waits for it to exit via --wait-parent.
#[tauri::command]
fn portable_update_apply(app: tauri::AppHandle, version: String) -> Result<(), String> {
    portable_update::apply_and_launch(&version)?;
    if let Some(state) = app.try_state::<SingboxState>() {
        vpn::force_cleanup(&app, &state);
    }
    if let Some(state) = app.try_state::<dpi::DpiState>() {
        dpi::force_cleanup(&state);
    }
    std::process::exit(0);
}

fn always_admin_marker(app: &tauri::AppHandle) -> Option<PathBuf> {
    app_paths::config_dir(app)
        .ok()
        .map(|dir| dir.join("always-admin"))
}

/// True if "always run as administrator" is enabled (a marker file
/// in the writable config dir). Read at startup in setup() for auto-elevation.
#[tauri::command]
fn is_always_admin(app: tauri::AppHandle) -> bool {
    always_admin_marker(&app)
        .map(|p| p.exists())
        .unwrap_or(false)
}

/// Enables/disables "always run as administrator". When enabled, on subsequent
/// starts Ninety restarts itself with UAC (see setup()).
#[tauri::command]
fn set_always_admin(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    let p = always_admin_marker(&app).ok_or("config dir is unavailable")?;
    if enable {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&p, b"1").map_err(|e| format!("write marker: {e}"))?;
    } else if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("remove marker: {e}"))?;
    }
    Ok(())
}

/// True if autostart at Windows sign-in is enabled (a Task Scheduler task).
#[tauri::command]
async fn autostart_is_enabled() -> Result<bool, String> {
    tokio::task::spawn_blocking(elevation::autostart_is_enabled)
        .await
        .map_err(|e| format!("autostart check was interrupted: {e}"))
}

/// Enables autostart via a Task Scheduler task. RunLevel=highest (starting as
/// administrator without UAC on every login) is granted only to an installation in Program
/// Files: for Full Portable and per-user installs the exe lives in a user-writable
/// directory, and there such a task would turn swapping the file into a silent privilege
/// escalation. If the process isn't elevated yet, it elevates only to create
/// the task (one UAC).
#[tauri::command]
async fn autostart_enable() -> Result<(), String> {
    tokio::task::spawn_blocking(elevation::autostart_enable)
        .await
        .map_err(|e| format!("autostart creation was interrupted: {e}"))?
}

/// Disables autostart (deletes the Task Scheduler task).
#[tauri::command]
async fn autostart_disable() -> Result<(), String> {
    tokio::task::spawn_blocking(elevation::autostart_disable)
        .await
        .map_err(|e| format!("autostart removal was interrupted: {e}"))?
}

/// CI smoke is a build check of the release artifact, not a user
/// mode: it writes and then wipes the live profile store, and in portable it also
/// overwrites the state backup. A single argv flag isn't enough for that — an accidental
/// `Ninety.exe --ci-smoke` (a shortcut, a .bat, someone else's instructions) would destroy
/// the only copy of nodes and subscriptions. We require an explicit opt-in via an environment
/// variable that only scripts/release-smoke.ps1 sets.
const CI_SMOKE_ENV: &str = "NINETY_CI_SMOKE";

fn ci_smoke_opt_in(has_flag: bool, env_value: Option<&str>) -> bool {
    has_flag && env_value == Some("1")
}

fn ci_smoke_requested(argv: &[String]) -> bool {
    let has_flag = argv.iter().any(|a| a == "--ci-smoke");
    let enabled = ci_smoke_opt_in(has_flag, std::env::var(CI_SMOKE_ENV).ok().as_deref());
    if has_flag && !enabled {
        eprintln!("--ci-smoke ignored: this is a build check and requires {CI_SMOKE_ENV}=1");
    }
    enabled
}

// Names of the files holding the only copy of profiles/subscriptions and keys.
const CI_SMOKE_PROTECTED_FILES: &[&str] = &[
    "profile-store.v1",
    "profile-store.v1.bak",
    "profile-store.v1.legacy.bak",
    "state-backup.json",
    "state-backup.json.bak",
    "state-backup.json.legacy.bak",
];

/// Second barrier: even with the opt-in, smoke doesn't touch already existing state.
/// A clean runner has none, so the CI check runs fully, while on
/// a machine with data the destructive part is simply skipped.
fn ci_smoke_state_is_empty_in(dir: &std::path::Path) -> bool {
    !CI_SMOKE_PROTECTED_FILES
        .iter()
        .any(|name| dir.join(name).exists())
}

fn ci_smoke_state_is_empty(app: &tauri::AppHandle) -> bool {
    match app_paths::config_dir(app) {
        Ok(dir) => ci_smoke_state_is_empty_in(&dir),
        // The directory couldn't be determined — treat the state as non-empty: skipping
        // the check is safer than writing to an unknown location.
        Err(_) => false,
    }
}

fn main_window_icon() -> Option<tauri::image::Image<'static>> {
    const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");
    tauri::image::Image::from_bytes(ICON).ok()
}

fn apply_main_window_icon(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // We don't use default_window_icon(): Windows may return a cached resource
        // of the previous version for it. The embedded PNG reassigns
        // WM_SETICON for the window thumbnail/hover every time.
        if let Some(icon) = main_window_icon() {
            let _ = w.set_icon(icon);
        }
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        apply_main_window_icon(app);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[derive(serde::Deserialize, Default)]
struct TraySrv {
    id: String,
    label: String,
    #[serde(default)]
    selected: bool,
    /// ISO country code (2 letters, lowercase) for the tray flag. None → no icon.
    #[serde(default)]
    iso: Option<String>,
}

/// A country and its nodes. Within a group we don't draw a flag on every row: it is the same
/// for the whole country, and the icon is the most expensive part of a menu item.
#[derive(serde::Deserialize, Default)]
struct TrayServerGroup {
    #[serde(default)]
    label: String,
    #[serde(default)]
    items: Vec<TraySrv>,
}

/// Layout of the "Server" submenu, computed by the frontend (tray-servers.js).
/// `flat` is non-empty only for a small subscription — there's nothing to group there.
#[derive(serde::Deserialize, Default)]
struct TrayServers {
    #[serde(default)]
    current: Option<TraySrv>,
    #[serde(default)]
    flat: Vec<TraySrv>,
    #[serde(default)]
    favourites: Vec<TraySrv>,
    #[serde(default)]
    fast: Vec<TraySrv>,
    #[serde(default)]
    groups: Vec<TrayServerGroup>,
    #[serde(default)]
    total: u32,
}

impl TrayServers {
    fn is_empty(&self) -> bool {
        self.total == 0
    }
}

/// Loads a country flag from resources (flags/<iso>.png, rasterized from SVG)
/// for IconMenuItem. Best-effort: no file/code → None (item without an icon).
/// Cached by ISO: the tray menu is rebuilt on every state change
/// (connect/node switch/DPI), and the PNG flags never change — without a cache that's extra
/// disk I/O on every rebuild.
fn flag_icon(app: &tauri::AppHandle, iso: &Option<String>) -> Option<tauri::image::Image<'static>> {
    let iso = iso.as_ref()?;
    if iso.len() != 2 || !iso.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    static FLAG_CACHE: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, Option<tauri::image::Image<'static>>>>,
    > = std::sync::OnceLock::new();
    let cache = FLAG_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock_recover().get(iso).cloned() {
        return hit;
    }
    // Flags are read-only resources next to the binary (<resource_dir>/flags/<iso>.png),
    // like the DPI engine. resource_dir is validated in dpi.rs.
    let img = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("flags").join(format!("{iso}.png")))
        .and_then(|p| tauri::image::Image::from_path(p).ok());
    cache.lock_recover().insert(iso.clone(), img.clone());
    img
}

/// Tray menu strings — they arrive from the frontend localized (the UI language,
/// see tray.* in the i18n catalogs). Default = a Russian fallback: it is visible only
/// for a second or two between creating the tray in setup() and the first set_tray_menu
/// from the frontend bootstrap.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TrayLabels {
    show: String,
    connect: String,
    disconnect: String,
    mode_title: String,
    mode_proxy: String,
    mode_system: String,
    mode_tun: String,
    server: String,
    no_servers: String,
    favourites: String,
    fast: String,
    all_servers: String,
    /// Template with {n} — "…and {n} more on the Servers screen".
    dpi_title: String,
    dpi_status_on: String,
    dpi_status_off: String,
    dpi_enable: String,
    dpi_disable: String,
    quit: String,
    /// Template with {ver} — "Update to v{ver}".
    update_to: String,
    tip_off: String,
    /// Template with {mode} — "Ninety · {mode} · connected".
    tip_connected: String,
    /// Template with {ver}. Second tooltip line when an update is found: in the tray this is
    /// the only sign that doesn't depend on OS notifications (on
    /// Windows those are silently lost if the build has no shortcut with an AppUserModelID).
    tip_update: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            show: "Show Ninety".into(),
            connect: "Connect".into(),
            disconnect: "Disconnect".into(),
            mode_title: "Connection mode".into(),
            mode_proxy: "Proxy".into(),
            mode_system: "System proxy".into(),
            mode_tun: "VPN · TUN".into(),
            server: "Server".into(),
            no_servers: "No servers".into(),
            favourites: "Favourites".into(),
            fast: "Fastest".into(),
            all_servers: "All servers…".into(),
            dpi_title: "DPI bypass".into(),
            dpi_status_on: "Status: on".into(),
            dpi_status_off: "Status: off".into(),
            dpi_enable: "Enable DPI bypass".into(),
            dpi_disable: "Disable DPI bypass".into(),
            quit: "Quit".into(),
            update_to: "Update to v{ver}".into(),
            tip_off: "Ninety · disconnected".into(),
            tip_connected: "Ninety · {mode} · connected".into(),
            tip_update: "Update v{ver} is available".into(),
        }
    }
}

#[derive(serde::Deserialize, Default)]
struct TrayMenuPayload {
    #[serde(default)]
    connected: bool,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    servers: TrayServers,
    #[serde(default, rename = "dpiActive")]
    dpi_active: bool,
    /// Version of an available update found by the background check while the window is in
    /// the tray. Some → show the highlighted "Update to vX" item. None → nothing.
    #[serde(default, rename = "updateVersion")]
    update_version: Option<String>,
    /// While OTA is downloading/installing, network actions in the native menu
    /// are blocked: otherwise the user could kill the proxy in the middle of the download
    /// or start a reconnect at the same time as the runtime is stopping.
    #[serde(default, rename = "updateBusy")]
    update_busy: bool,
    #[serde(default)]
    labels: TrayLabels,
}

/// Server row with a country flag. The current one is marked with "●": IconMenuItem has no
/// checked state, and the indent on the others keeps the labels aligned vertically.
fn server_item(
    app: &tauri::AppHandle,
    srv: &TraySrv,
    enabled: bool,
    with_icon: bool,
) -> tauri::Result<IconMenuItem<tauri::Wry>> {
    let label = if srv.selected {
        format!("●  {}", srv.label)
    } else {
        format!("    {}", srv.label)
    };
    let icon = if with_icon {
        flag_icon(app, &srv.iso)
    } else {
        None
    };
    IconMenuItem::with_id(
        app,
        format!("srv:{}", srv.id),
        &label,
        enabled,
        icon,
        None::<&str>,
    )
}

/// Submenu with a ready list of nodes — "Favourites", "Fastest" and each country.
/// Flags are drawn only where the countries differ: within a country every row's icon
/// is the same, and the icon is the most expensive part of a menu item.
fn server_group_submenu(
    app: &tauri::AppHandle,
    title: &str,
    items: &[TraySrv],
    enabled: bool,
    with_icons: bool,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let entries: Vec<IconMenuItem<tauri::Wry>> = items
        .iter()
        .map(|srv| server_item(app, srv, enabled, with_icons))
        .collect::<tauri::Result<_>>()?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = entries
        .iter()
        .map(|i| i as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    Submenu::with_items(app, format!("{title}  ·  {}", items.len()), enabled, &refs)
}

/// The "Server" submenu. With a subscription of hundreds of nodes a flat list is unreadable and expensive,
/// so a large list arrives from the frontend already laid out: the current node,
/// favorites, the fastest, then countries. The last row leads to the
/// "Servers" screen — that's where search and the full list are, which can't fit in a menu.
fn build_server_submenu(
    app: &tauri::AppHandle,
    payload: &TrayMenuPayload,
    enabled: bool,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let l = &payload.labels;
    let servers = &payload.servers;
    if servers.is_empty() {
        let none = MenuItem::with_id(app, "srv:none", &l.no_servers, false, None::<&str>)?;
        return Submenu::with_items(app, &l.server, false, &[&none]);
    }

    // The item owners live until the end of the build: Submenu::with_items takes references.
    let mut flat: Vec<IconMenuItem<tauri::Wry>> = Vec::new();
    let mut current: Option<IconMenuItem<tauri::Wry>> = None;
    let mut shortcuts: Vec<Submenu<tauri::Wry>> = Vec::new();
    let mut countries: Vec<Submenu<tauri::Wry>> = Vec::new();
    let mut separators: Vec<PredefinedMenuItem<tauri::Wry>> = Vec::new();

    if !servers.flat.is_empty() {
        for srv in &servers.flat {
            flat.push(server_item(app, srv, enabled, true)?);
        }
    } else {
        if let Some(srv) = servers.current.as_ref() {
            current = Some(server_item(app, srv, enabled, true)?);
        }
        if !servers.favourites.is_empty() {
            shortcuts.push(server_group_submenu(
                app,
                &l.favourites,
                &servers.favourites,
                enabled,
                true,
            )?);
        }
        if !servers.fast.is_empty() {
            shortcuts.push(server_group_submenu(
                app,
                &l.fast,
                &servers.fast,
                enabled,
                true,
            )?);
        }
        for group in &servers.groups {
            countries.push(server_group_submenu(
                app,
                &group.label,
                &group.items,
                enabled,
                false,
            )?);
        }
        // Exactly as many separators as will be needed below.
        for _ in 0..3 {
            separators.push(PredefinedMenuItem::separator(app)?);
        }
    }

    let all = MenuItem::with_id(
        app,
        "srv:all",
        format!("{}  ·  {}", l.all_servers, servers.total),
        true,
        None::<&str>,
    )?;

    let mut refs: Vec<&dyn IsMenuItem<tauri::Wry>> = Vec::new();
    if !flat.is_empty() {
        for item in &flat {
            refs.push(item as &dyn IsMenuItem<tauri::Wry>);
        }
    } else {
        let mut separators = separators.iter();
        if let Some(item) = current.as_ref() {
            refs.push(item as &dyn IsMenuItem<tauri::Wry>);
            if let Some(sep) = separators.next() {
                refs.push(sep as &dyn IsMenuItem<tauri::Wry>);
            }
        }
        if !shortcuts.is_empty() {
            for item in &shortcuts {
                refs.push(item as &dyn IsMenuItem<tauri::Wry>);
            }
            if let Some(sep) = separators.next() {
                refs.push(sep as &dyn IsMenuItem<tauri::Wry>);
            }
        }
        for item in &countries {
            refs.push(item as &dyn IsMenuItem<tauri::Wry>);
        }
        if let Some(sep) = separators.next() {
            refs.push(sep as &dyn IsMenuItem<tauri::Wry>);
        }
    }
    refs.push(&all as &dyn IsMenuItem<tauri::Wry>);
    Submenu::with_items(app, &l.server, enabled, &refs)
}

/// Builds the tray context menu for the current state: connection mode
/// selection (radio check) and the server list of the active subscription. The
/// "Server" submenu is active only while the VPN is up — otherwise greyed out (disabled).
fn build_tray_menu(
    app: &tauri::AppHandle,
    payload: &TrayMenuPayload,
) -> tauri::Result<Menu<tauri::Wry>> {
    let l = &payload.labels;
    let show_item = MenuItem::with_id(app, "show", &l.show, true, None::<&str>)?;

    // Connect / Disconnect — according to the actual VPN state
    let toggle_label = if payload.connected {
        &l.disconnect
    } else {
        &l.connect
    };
    let runtime_actions_enabled = !payload.update_busy;
    let conn_item = MenuItem::with_id(
        app,
        "toggle-vpn",
        toggle_label,
        runtime_actions_enabled,
        None::<&str>,
    )?;

    // Connection mode
    let m_proxy = CheckMenuItem::with_id(
        app,
        "mode:proxy",
        &l.mode_proxy,
        runtime_actions_enabled,
        payload.mode == "proxy",
        None::<&str>,
    )?;
    let m_sys = CheckMenuItem::with_id(
        app,
        "mode:systemProxy",
        &l.mode_system,
        runtime_actions_enabled,
        payload.mode == "systemProxy",
        None::<&str>,
    )?;
    let m_tun = CheckMenuItem::with_id(
        app,
        "mode:tun",
        &l.mode_tun,
        runtime_actions_enabled,
        payload.mode == "tun",
        None::<&str>,
    )?;
    let mode_sub = Submenu::with_items(
        app,
        &l.mode_title,
        runtime_actions_enabled,
        &[&m_proxy, &m_sys, &m_tun],
    )?;

    // Server selection — active only while the VPN is up. The frontend computes the layout
    // (tray-servers.js): a small subscription arrives as a flat list, a large one as
    // the current server, quick picks and countries.
    let srv_enabled = runtime_actions_enabled && payload.connected && !payload.servers.is_empty();
    let server_sub = build_server_submenu(app, payload, srv_enabled)?;

    // DPI bypass — status (disabled, informational) + toggle
    let dpi_status = MenuItem::with_id(
        app,
        "dpi:status",
        if payload.dpi_active {
            &l.dpi_status_on
        } else {
            &l.dpi_status_off
        },
        false,
        None::<&str>,
    )?;
    let dpi_toggle = MenuItem::with_id(
        app,
        "dpi:toggle",
        if payload.dpi_active {
            &l.dpi_disable
        } else {
            &l.dpi_enable
        },
        runtime_actions_enabled,
        None::<&str>,
    )?;
    let dpi_sub = Submenu::with_items(
        app,
        &l.dpi_title,
        runtime_actions_enabled,
        &[&dpi_status, &dpi_toggle],
    )?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", &l.quit, true, None::<&str>)?;

    // An available update (found while the window was in the tray) — a highlighted item at the top.
    // Clicking shows the window and opens the install modal.
    if let Some(ver) = &payload.update_version {
        let upd = MenuItem::with_id(
            app,
            "update:install",
            format!("⤓  {}", l.update_to.replace("{ver}", ver)),
            !payload.update_busy,
            None::<&str>,
        )?;
        let sep0 = PredefinedMenuItem::separator(app)?;
        return Menu::with_items(
            app,
            &[
                &upd,
                &sep0,
                &show_item,
                &sep1,
                &conn_item,
                &mode_sub,
                &server_sub,
                &dpi_sub,
                &sep2,
                &quit_item,
            ],
        );
    }

    Menu::with_items(
        app,
        &[
            &show_item,
            &sep1,
            &conn_item,
            &mode_sub,
            &server_sub,
            &dpi_sub,
            &sep2,
            &quit_item,
        ],
    )
}

/// The frontend calls this on every state change (connect/disconnect, change of
/// mode/subscription/effective node) — we rebuild the tray menu for it.
// Tray icon per state: off (disconnected) / proxy / tun (synthwave purple).
// Embedded in the binary (include_bytes) — independent of resource_dir; 32px,
// Windows downscales to the size the notification area needs.
fn tray_state_icon(connected: bool, mode: &str) -> Option<tauri::image::Image<'static>> {
    const OFF: &[u8] = include_bytes!("../icons/tray/oni_off_32.png");
    const PROXY: &[u8] = include_bytes!("../icons/tray/oni_proxy_32.png");
    const TUN: &[u8] = include_bytes!("../icons/tray/oni_tun_32.png");
    let bytes = if !connected {
        OFF
    } else if mode == "tun" {
        TUN
    } else {
        PROXY
    };
    tauri::image::Image::from_bytes(bytes).ok()
}

// "Update available" badge on top of the tray icon. The menu item and tooltip are visible
// only after hover/right-click, so an app minimized to the tray said nothing about
// a found version until the user went into the menu themselves. The badge
// is drawn at runtime on top of the decoded RGBA — keeping a second
// set of three PNGs in the binary for one dot is pointless.
const BADGE_FILL: [f32; 3] = [255.0, 77.0, 109.0]; // neon accent
const BADGE_RING: [f32; 3] = [10.0, 8.0, 12.0]; // dark outline under any icon

/// Draws the badge dot in the bottom-right corner of the RGBA buffer (straight alpha,
/// source-over). Subpixel sampling is mandatory: at 32px without antialiasing
/// the badge looks like a ragged square.
fn paint_update_badge(rgba: &mut [u8], width: u32, height: u32) {
    let (w, h) = (width as i64, height as i64);
    if w < 8 || h < 8 || rgba.len() < (w * h * 4) as usize {
        return;
    }
    let side = w.min(h) as f32;
    let r_out = side * 0.21;
    let r_in = (r_out - (side * 0.06).max(1.0)).max(1.0);
    let cx = w as f32 - r_out - side * 0.02;
    let cy = h as f32 - r_out - side * 0.02;
    const SUB: i64 = 4;
    let x0 = ((cx - r_out).floor() as i64).max(0);
    let x1 = ((cx + r_out).ceil() as i64).min(w - 1);
    let y0 = ((cy - r_out).floor() as i64).max(0);
    let y1 = ((cy + r_out).ceil() as i64).min(h - 1);
    for py in y0..=y1 {
        for px in x0..=x1 {
            let (mut fill_cov, mut ring_cov) = (0.0f32, 0.0f32);
            for sy in 0..SUB {
                for sx in 0..SUB {
                    let dx = px as f32 + (sx as f32 + 0.5) / SUB as f32 - cx;
                    let dy = py as f32 + (sy as f32 + 0.5) / SUB as f32 - cy;
                    let d = (dx * dx + dy * dy).sqrt();
                    if d <= r_in {
                        fill_cov += 1.0;
                    } else if d <= r_out {
                        ring_cov += 1.0;
                    }
                }
            }
            let total = (SUB * SUB) as f32;
            let (fill_cov, ring_cov) = (fill_cov / total, ring_cov / total);
            let src_a = fill_cov + ring_cov;
            if src_a <= 0.0 {
                continue;
            }
            let idx = ((py * w + px) * 4) as usize;
            let dst_a = rgba[idx + 3] as f32 / 255.0;
            let out_a = src_a + dst_a * (1.0 - src_a);
            for (offset, (fill, ring)) in BADGE_FILL.iter().zip(BADGE_RING.iter()).enumerate() {
                let src = (fill * fill_cov + ring * ring_cov) / src_a;
                let dst = rgba[idx + offset] as f32;
                let out = (src * src_a + dst * dst_a * (1.0 - src_a)) / out_a;
                rgba[idx + offset] = out.round().clamp(0.0, 255.0) as u8;
            }
            rgba[idx + 3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
}

/// Tray icon per state + the pending update badge.
fn tray_icon(
    connected: bool,
    mode: &str,
    update_pending: bool,
) -> Option<tauri::image::Image<'static>> {
    let icon = tray_state_icon(connected, mode)?;
    if !update_pending {
        return Some(icon);
    }
    let (w, h) = (icon.width(), icon.height());
    let mut rgba = icon.rgba().to_vec();
    paint_update_badge(&mut rgba, w, h);
    Some(tauri::image::Image::new_owned(rgba, w, h))
}

// Tray tooltip — gives the exact mode (the icon only signals status/type).
// Strings are localized by the frontend; the mode name is the same label as in the menu.
fn tray_tooltip(
    labels: &TrayLabels,
    connected: bool,
    mode: &str,
    update_version: Option<&str>,
) -> String {
    let state = if connected {
        let m = match mode {
            "tun" => &labels.mode_tun,
            "systemProxy" => &labels.mode_system,
            _ => &labels.mode_proxy,
        };
        labels.tip_connected.replace("{mode}", m)
    } else {
        labels.tip_off.clone()
    };
    match update_version {
        Some(ver) => format!("{state}\n{}", labels.tip_update.replace("{ver}", ver)),
        None => state,
    }
}

/// Windows doesn't report when the tray menu closed, but the state "a menu is
/// being shown right now" is visible on the foreground GUI thread.
fn menu_flags_indicate_open(flags: u32) -> bool {
    // GUI_INMENUMODE | GUI_POPUPMENUMODE
    flags & (0x0000_0004 | 0x0000_0010) != 0
}

/// While the menu is shown, it must not be swapped on the icon: the replacement destroys the already
/// open popup, and the user sees the menu collapse right after
/// the right click. Such a rebuild is postponed until the menu closes.
#[cfg(target_os = "windows")]
fn menu_mode_active() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetGUIThreadInfo, GUITHREADINFO};
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    // idThread = 0 means the foreground window's thread, and the tray menu is shown
    // exactly by it.
    unsafe { GetGUIThreadInfo(0, &mut info).is_ok() && menu_flags_indicate_open(info.flags.0) }
}

#[cfg(not(target_os = "windows"))]
fn menu_mode_active() -> bool {
    false
}

/// `applied = false` — the icon and tooltip were updated, but the menu stayed the same
/// because the user is holding it open. The frontend will retry.
#[derive(serde::Serialize)]
struct TrayMenuOutcome {
    applied: bool,
}

#[tauri::command]
fn set_tray_menu(
    app: tauri::AppHandle,
    payload: TrayMenuPayload,
) -> Result<TrayMenuOutcome, String> {
    let Some(tray) = app.tray_by_id("main") else {
        return Ok(TrayMenuOutcome { applied: true });
    };
    // The icon and tooltip are set FIRST and independently of the menu. They are cheap and
    // can fail to build only with a broken resource, while the menu for a large
    // subscription is hundreds of items, each with its own flag icon. Previously the menu
    // was built first, and any error in it returned from the function before
    // the icon was updated: the tray stayed in the initial "disconnected" with the VPN
    // up, and only restarting the app could fix it.
    if let Some(icon) = tray_icon(
        payload.connected,
        &payload.mode,
        payload.update_version.is_some(),
    ) {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = tray.set_tooltip(Some(tray_tooltip(
        &payload.labels,
        payload.connected,
        &payload.mode,
        payload.update_version.as_deref(),
    )));
    // The check comes after the icon and tooltip: they change independently of the menu
    // and don't interfere with an open popup.
    if menu_mode_active() {
        return Ok(TrayMenuOutcome { applied: false });
    }
    let menu = match build_tray_menu(&app, &payload) {
        Ok(menu) => menu,
        Err(e) => {
            // The icon and tooltip are already applied, but the menu stayed the same.
            // The frontend puts this error into the webview console, which the user will never
            // look at; we write to the same log the "Logs" screen reads, so that
            // next time the cause is in plain sight rather than inferred from the symptom.
            crate::vpn::append_runtime_diagnostic_at(
                &app,
                crate::vpn::DiagnosticLevel::Warn,
                &format!(
                    "tray_menu_rebuild_failed servers={} error={e}",
                    payload.servers.total
                ),
            );
            return Err(e.to_string());
        }
    };
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(TrayMenuOutcome { applied: true })
}

/// The last line of defense before an abnormal exit. The regular cleanup hangs on
/// `RunEvent::Exit`, but a main-thread panic never reaches it: unwinding
/// through the Windows window procedure ends in an abort, bypassing Tauri. The result:
/// the registry keeps `ProxyEnable=1` pointing to a dead loopback port, and
/// the user loses internet in everything that reads WinINet. The hook
/// runs BEFORE unwinding/abort, so this is the only place where the proxy can be removed.
///
/// Inside — only a registry write: no heavy allocations, no await and no
/// access to Tauri state (it may already be gone at this point).
///
/// The proxy is removed only on a main-thread panic: that's where the event loop
/// runs and synchronous commands execute, and such a panic terminates the process. The hook
/// is also called for panics that are caught later (`catch_unwind` in
/// netproc.rs, a panic inside a tokio task or an async command). After those the process
/// and sing-box keep living, and a removed proxy silently let browsers go direct
/// while the interface showed "connected".
fn install_failsafe_panic_hook() {
    let default_hook = std::panic::take_hook();
    let main_thread = std::thread::current().id();
    std::panic::set_hook(Box::new(move |info| {
        if panic_ends_process(std::thread::current().id(), main_thread) {
            restore_system_proxy_before_exit();
        }
        default_hook(info);
    }));
}

fn panic_ends_process(panicking: std::thread::ThreadId, main: std::thread::ThreadId) -> bool {
    panicking == main
}

fn restore_system_proxy_before_exit() {
    #[cfg(target_os = "windows")]
    if let Err(error) = elevation::set_system_proxy(false, None, None) {
        eprintln!("panic cleanup: system proxy not restored: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_failsafe_panic_hook();
    vpn::normalize_own_priority();
    // Before the Builder: single-instance is registered when the app is built.
    let parent_exited = wait_for_relaunching_parent();
    // An exe from a nested copy after a broken portable update moves
    // itself into the original folder and restarts from there — before it gets a chance
    // to create empty data next to itself. Only once the previous process has definitely
    // exited: its files are still locked, and its single-instance window would intercept
    // the launch of the original copy.
    if parent_exited && portable_update::repair_nested_install() {
        std::process::exit(0);
    }
    let portable = app_paths::is_portable();
    let mut context = tauri::generate_context!();
    if portable {
        // An absolute WebView2 data directory can only be set via the builder.
        // We forbid Tauri from automatically creating the window from tauri.conf and
        // create it in setup() with NinetyData/webview.
        if let Some(window) = context.config_mut().app.windows.first_mut() {
            window.create = false;
        }
    }

    tauri::Builder::default()
        // single-instance MUST be registered first: on a second launch
        // (the user clicked ninety://import/...) the system starts a second process;
        // single-instance intercepts argv and forwards it to the first one. Without
        // this the deep-link plugin would create a new window every time.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let urls = url_handler::extract_deep_link_urls(argv);
            if !urls.is_empty() {
                let _ = app.emit("deep-link:open", urls);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Autostart at Windows sign-in is implemented via a Task Scheduler task
        // (see autostart_enable/proxy_win). The former tauri-plugin-autostart wrote
        // a registry Run key → non-elevated start → relaunch with UAC on every login;
        // it was dropped, the migration is in setup() (migrate_legacy_autostart).
        .manage(SingboxState::default())
        .manage(dpi::DpiState::default())
        .manage(host_pressure::HostPressureState::default())
        .manage(clash_stream::ClashStreamState::default())
        .manage(killswitch::KillSwitchState::default())
        .manage(runtime_ops::RuntimeOperationCoordinator::default())
        .manage(scanner::WarpScanState::default())
        .setup(move |app| {
            if portable {
                portable_update::cleanup_on_start();
                app_paths::ensure_portable_layout()?;
                let config = app
                    .config()
                    .app
                    .windows
                    .first()
                    .cloned()
                    .ok_or("main window configuration is missing")?;
                tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                    .data_directory(app_paths::webview_dir()?)
                    .build()?;
            }

            let argv: Vec<String> = std::env::args().collect();
            let autostarted = argv.iter().any(|a| a == "--autostarted");
            let ci_smoke = ci_smoke_requested(&argv);
            // The engine lifecycle safety net is set up before the first spawn:
            // the job must exist before the first engine appears.
            job_guard::init();
            vpn::purge_stale_runtime_configs(app.handle());
            if let Err(e) = vpn::recover_stale_system_proxy() {
                eprintln!("stale system proxy recovery: {e}");
            }

            // Throne-style "always as admin": if the marker is set and we aren't
            // elevated yet — restart with UAC and exit. Done BEFORE showing the window
            // (the window is visible:false in the config), so there is no flicker. If the user
            // cancels UAC — we continue as a regular process (TUN simply won't
            // work, the frontend will ask for rights when it's enabled).
            #[cfg(target_os = "windows")]
            {
                let already_elevated = argv.iter().any(|a| a == "--elevated");
                if !already_elevated && !elevation::is_elevated() {
                    let want = always_admin_marker(app.handle())
                        .map(|p| p.exists())
                        .unwrap_or(false);
                    if want {
                        // A manual launch stays manual: "always as
                        // administrator" doesn't mean "connect at startup".
                        let connect = argv.iter().any(|a| a == "--connect");
                        // Otherwise the link the app was opened with gets lost.
                        let links = url_handler::extract_deep_link_urls(argv.iter());
                        if relaunch_self_elevated(autostarted, connect, &links).unwrap_or(false) {
                            // Release the single-instance lock immediately (the core
                            // isn't up yet at this stage — nothing to clean up).
                            std::process::exit(0);
                        }
                    }
                }
            }

            #[cfg(target_os = "windows")]
            elevation::allow_second_instance_messages(&app.config().identifier);

            // The host pressure sampler is started right away and for the whole process
            // lifetime: it needs a previous CPU counter sample to
            // compute the first delta, and by the time of connecting the answer to
            // "is the host to blame" must already be ready. It has no rights over the
            // runtime — only numbers for the quality engine.
            host_pressure::start(
                app.state::<host_pressure::HostPressureState>()
                    .inner()
                    .clone(),
            );

            // The window is hidden by default (visible:false). Show it now, except
            // for autostart at Windows sign-in — there we keep it in the tray.
            if let Some(w) = app.get_webview_window("main") {
                apply_main_window_icon(app.handle());
                if autostarted || ci_smoke {
                    let _ = w.hide();
                } else {
                    let _ = w.show();
                }
            }

            // schtasks /query and /create can take hundreds of milliseconds on a cold start.
            // They aren't needed to create the WebView/tray, so they run after
            // the window is shown, on a separate named thread. The network runtime and proxy recovery
            // stay in the synchronous fail-safe critical path above.
            #[cfg(target_os = "windows")]
            {
                let migrate_installed = !portable;
                let _ = std::thread::Builder::new()
                    .name("ninety-startup-maintenance".into())
                    .spawn(move || {
                        if migrate_installed {
                            elevation::migrate_legacy_autostart();
                        }
                        elevation::autostart_refresh_path();
                    });
            }

            // Registering ninety:// in HKCR on first launch. On an NSIS install
            // tauri-plugin-deep-link has already written the keys in the installer; register_all
            // is needed for dev mode / re-registering the installed version.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                // Full Portable doesn't write to the registry on a normal launch. Manual
                // VPN link handlers stay opt-in via Settings.
                if !portable {
                    if let Err(e) = app.deep_link().register_all() {
                        eprintln!("deep-link register_all: {e}");
                    }
                }
            }

            let init_payload = TrayMenuPayload::default();
            let menu = build_tray_menu(app.handle(), &init_payload)?;

            // Always start in the "disconnected" state — a grey icon; after
            // loading/auto-connect the frontend sends set_tray_menu with the current mode
            // and localized strings (until then — the Russian fallback labels).
            let init_icon = match tray_state_icon(false, "") {
                Some(icon) => icon,
                // default_window_icon() is empty in headless configurations; Windows doesn't create a tray
                // without an icon, but panicking in setup() is not allowed —
                // the app must get to the window and say so in words.
                None => app
                    .default_window_icon()
                    .cloned()
                    .ok_or("tray icon is unavailable")?,
            };
            let _tray = TrayIconBuilder::with_id("main")
                .icon(init_icon)
                .tooltip(tray_tooltip(&init_payload.labels, false, "", None))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "show" => show_main(app),
                        "quit" => app.exit(0),
                        "update:install" => {
                            show_main(app);
                            let _ = app.emit("tray:update", ());
                        }
                        "toggle-vpn" => {
                            let _ = app.emit("tray:toggle-vpn", ());
                        }
                        "dpi:toggle" => {
                            let _ = app.emit("tray:toggle-dpi", ());
                        }
                        "mode:proxy" => {
                            let _ = app.emit("tray:set-mode", "proxy");
                        }
                        "mode:systemProxy" => {
                            let _ = app.emit("tray:set-mode", "systemProxy");
                        }
                        "mode:tun" => {
                            let _ = app.emit("tray:set-mode", "tun");
                        }
                        // The full server list lives on its own screen: it doesn't fit
                        // in the menu, and there's no search there.
                        "srv:all" => {
                            show_main(app);
                            let _ = app.emit("tray:open-servers", ());
                        }
                        other if other.starts_with("srv:") => {
                            let tag = other.trim_start_matches("srv:");
                            if tag != "none" {
                                let _ = app.emit("tray:select-server", tag.to_string());
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => show_main(tray.app_handle()),
                    // The user reached for the icon — the only moment
                    // when we know for sure they are looking at the tray right now.
                    // A minimized window learns about a new version only on
                    // schedule, so here we ask the frontend to finish the OTA check:
                    // the menu is rebuilt on set_tray_menu, and by the next
                    // opening the "Update" item is already in place.
                    TrayIconEvent::Enter { .. }
                    | TrayIconEvent::Click {
                        button: MouseButton::Right,
                        ..
                    } => {
                        let _ = tray.app_handle().emit("tray:activity", ());
                    }
                    _ => {}
                })
                .build(app)?;

            // Qualification smoke in Windows CI: the app goes through the full
            // setup (including backend commands and tray), checks a safe ping
            // and properly ends the event loop itself. No VPN/DPI connections.
            if ci_smoke {
                if ping() != "pong" {
                    return Err("backend ping failed during CI smoke".into());
                }
                if portable {
                    for name in ["config", "data", "logs", "webview"] {
                        if !app_paths::portable_data_dir()?.join(name).is_dir() {
                            return Err(format!("portable directory missing: {name}").into());
                        }
                    }
                }
                // Below is the only part of smoke that writes to live
                // state. On a machine with already existing profiles it is
                // skipped entirely: a build check isn't worth the data.
                let state_is_empty = ci_smoke_state_is_empty(app.handle());
                if !state_is_empty {
                    eprintln!("CI smoke: skipping the store check, the config already has data");
                }
                if state_is_empty && portable {
                    // The portable profile store must use the same explicit
                    // in-memory passphrase policy as state-backup.
                    secrets::configure_portable_passphrase(
                        "ci-smoke-only-passphrase-2026".to_string(),
                    )?;
                }
                if state_is_empty {
                    let profile_store_before =
                        profile_store::profile_store_load_blocking(app.handle().clone())?;
                    let smoke_store = profile_store::ProfileStore {
                        schema_version: 1,
                        revision: profile_store_before.revision,
                        profiles: vec![serde_json::json!({
                            "id": "ci-smoke-profile",
                            "proto": "vless",
                            "host": "smoke.invalid"
                        })],
                        subscriptions: vec![],
                        active: profile_store::ActiveSelection {
                            kind: "single".into(),
                            profile_id: Some("ci-smoke-profile".into()),
                            subscription_id: None,
                        },
                        proxy_selection: std::collections::BTreeMap::from([(
                            "single:ci-smoke-profile".into(),
                            "node-smoke".into(),
                        )]),
                    };
                    let _ = profile_store::profile_store_replace_blocking(
                        app.handle().clone(),
                        profile_store_before.revision,
                        smoke_store,
                    )?;
                    let profile_store_after =
                        profile_store::profile_store_load_blocking(app.handle().clone())?;
                    if profile_store_after.store.is_none()
                        || profile_store_after.revision <= profile_store_before.revision
                    {
                        return Err("profile store roundtrip failed during CI smoke".into());
                    }
                    profile_store::profile_store_clear_blocking(app.handle().clone(), None)?;
                    if portable {
                        // A real write through the production-path helper: catches both
                        // an accidental AppData and DPAPI, which would make Full
                        // Portable unreadable after moving to another PC.
                        let smoke_snapshot = serde_json::json!({
                            "__schemaVersion": 2,
                            "ninety.options.v1": "{}",
                            "ninety.profiles.v1": "[]",
                            "ninety.subscriptions.v1": "[]"
                        });
                        // CI smoke intentionally exercises the portable encrypted
                        // path with an ephemeral in-memory passphrase. Production
                        // portable runs write plaintext until the user sets a
                        // passphrase in Settings.
                        // Synchronous variant: setup() is not an async context.
                        backup::state_backup_save_blocking(
                            app.handle().clone(),
                            smoke_snapshot.to_string(),
                        )?;
                        let snapshot = std::fs::read(
                            app_paths::portable_data_dir()?
                                .join("config")
                                .join("state-backup.json"),
                        )?;
                        if !secrets::is_portable_envelope(&snapshot) {
                            return Err("portable state backup is not encrypted envelope".into());
                        }
                    }
                }
                let handle = app.handle().clone();
                // Do not depend on the shared async runtime being scheduled
                // while WebView2/Defender finishes first-launch work on a fresh
                // Windows runner. This watchdog exists only for --ci-smoke.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    handle.exit(0);
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            is_portable,
            portable_update::portable_update_download,
            portable_update::portable_repair_report,
            portable_update_apply,
            secrets::portable_secrets_status,
            secrets::portable_secrets_set_passphrase,
            secrets::portable_secrets_clear_passphrase,
            profile_store::profile_store_load,
            profile_store::profile_store_replace,
            profile_store::profile_store_clear,
            should_autoconnect,
            startup_deep_links,
            is_elevated,
            relaunch_elevated,
            protected_browser::protected_browser_status,
            protected_browser::protected_browser_launch,
            protected_browser::protected_browser_open_download,
            is_always_admin,
            set_always_admin,
            autostart_is_enabled,
            autostart_enable,
            autostart_disable,
            set_tray_menu,
            vpn::start_singbox,
            vpn::stop_singbox,
            vpn::verify_runtime_dataplane,
            vpn::release_runtime_transition_barrier,
            runtime_ops::begin_frontend_runtime_operation,
            runtime_ops::begin_source_switch_operation,
            runtime_ops::record_frontend_runtime_event,
            runtime_ops::complete_frontend_runtime_operation,
            runtime_ops::cancel_frontend_runtime_operation,
            vpn::plan_bridge_ports,
            vpn::singbox_running,
            vpn::runtime_snapshot,
            vpn::verify_runtime_endpoint,
            vpn::health_snapshot,
            vpn::enable_system_proxy,
            vpn::disable_system_proxy,
            vpn::read_log_chunk,
            vpn::clear_log,
            vpn::singbox_log_path,
            vpn::open_log_dir,
            lan_auth::lan_auth_ensure,
            lan_auth::lan_auth_update,
            subscription::fetch_subscription,
            subscription::subscription_hwid,
            hwid::device_identity,
            feedback::send_feedback,
            clash::clash_get_proxies,
            clash::clash_get_connections,
            clash::clash_traffic_total,
            clash::clash_test_node,
            clash::clash_test_group,
            clash::clash_select_proxy,
            clash::clash_close_proxy_connections,
            clash::fetch_public_ip,
            clash_stream::clash_traffic_start,
            clash_stream::clash_traffic_stop,
            url_handler::register_url_handler,
            url_handler::unregister_url_handler,
            warp::warp_register,
            warp::warp_status,
            warp::warp_reset,
            scanner::warp_scan_endpoints,
            scanner::warp_scan_cancel,
            quality::probe_quality,
            dnscheck::dns_probe,
            diagnose::diagnose_trace,
            diagnose::diagnose_reach,
            diagnose::diagnose_leaks,
            diagnose::diagnose_probe,
            dpi::dpi_strategies,
            dpi::dpi_domains_count,
            dpi::dpi_fake_payloads,
            dpi::dpi_set_active_fake,
            dpi::dpi_start,
            dpi::dpi_stop,
            dpi::dpi_running,
            dpi::dpi_set_active_vpn_endpoint,
            dpi::dpi_versions,
            dpi::dpi_check_update,
            dpi::dpi_sync_channel,
            dpi::dpi_autotest,
            dpi::dpi_read_list,
            dpi::dpi_write_list,
            dpi::dpi_custom_check,
            dpi::dpi_custom_save,
            dpi::dpi_custom_delete,
            dpi::dpi_unload_driver,
            dpi::dpi_hosts_status,
            dpi::dpi_hosts_apply,
            dpi::dpi_hosts_clear,
            dpi::dpi_ipset_count,
            dpi::dpi_update_ipset,
            dpi::dpi_auto_domains,
            dpi::dpi_auto_forget,
            dpi::dpi_auto_clear,
            discord_cache::discord_cache_clear,
            ipv6::system_ipv6_available,
            forwarding::system_forwarding_status,
            netproc::list_network_processes,
            netproc::snapshot_network_tcp,
            wifi::current_wifi,
            killswitch::killswitch_arm,
            killswitch::killswitch_disarm,
            killswitch::killswitch_active,
            backup::state_backup_save,
            backup::state_backup_load,
            backup::state_backup_clear,
            rules_file::routing_rules_export_file,
            rules_file::routing_rules_import_file,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // setup() runs before the native event loop is fully created.
            // Repeating on Ready guarantees that Windows gets the new small/big
            // icon after all the internal Tauri/WebView2 window setup.
            if matches!(&event, RunEvent::Ready) {
                apply_main_window_icon(app);
            }
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SingboxState>() {
                    vpn::force_cleanup(app, &state);
                }
                if let Some(state) = app.try_state::<dpi::DpiState>() {
                    // cleanup_on_exit kills winws and removes the WinDivert/Monkey
                    // kernel driver, BUT skips sc.exe on OS shutdown
                    // (sc.exe fails there with 0xc0000142, and the reboot unloads the driver)
                    // and when DPI wasn't brought up in this session. The .sys lock for
                    // reinstalling without a reboot is released by the explicit dpi_unload_driver (OTA).
                    dpi::cleanup_on_exit(&state);
                }
                if let Some(state) = app.try_state::<killswitch::KillSwitchState>() {
                    killswitch::force_disarm(&state);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // The tray menu must not be swapped while it is open: the replacement destroys the shown
    // popup. The "a menu is being shown right now" sign is these two GUITHREADINFO bits.
    #[test]
    fn only_autostart_and_explicit_connect_request_a_connection() {
        assert!(autoconnect_requested(["ninety.exe", "--autostarted"]));
        assert!(autoconnect_requested([
            "ninety.exe",
            "--elevated",
            "--connect"
        ]));
        assert!(!autoconnect_requested(["ninety.exe", "--elevated"]));
        assert!(!autoconnect_requested(["ninety.exe"]));
    }

    #[test]
    fn elevated_relaunch_carries_connect_only_when_asked() {
        assert_eq!(
            elevated_relaunch_args(false, false, 42),
            ["--elevated", "--wait-parent=42"]
        );
        assert_eq!(
            elevated_relaunch_args(true, false, 42),
            ["--elevated", "--autostarted", "--wait-parent=42"]
        );
        assert_eq!(
            elevated_relaunch_args(false, true, 42),
            ["--elevated", "--connect", "--wait-parent=42"]
        );
    }

    #[test]
    fn relaunched_process_finds_the_parent_to_wait_for() {
        assert_eq!(
            parent_to_wait_for(["ninety.exe", "--elevated", "--wait-parent=4242"]),
            Some(4242)
        );
        assert_eq!(parent_to_wait_for(["ninety.exe", "--elevated"]), None);
        assert_eq!(parent_to_wait_for(["ninety.exe", "--wait-parent=0"]), None);
        assert_eq!(parent_to_wait_for(["ninety.exe", "--wait-parent=x"]), None);
    }

    #[test]
    fn open_menu_is_recognised_by_gui_thread_flags() {
        const GUI_INMENUMODE: u32 = 0x0000_0004;
        const GUI_POPUPMENUMODE: u32 = 0x0000_0010;
        const GUI_CARETBLINKING: u32 = 0x0000_0001;
        assert!(menu_flags_indicate_open(GUI_INMENUMODE));
        assert!(menu_flags_indicate_open(GUI_POPUPMENUMODE));
        assert!(menu_flags_indicate_open(
            GUI_POPUPMENUMODE | GUI_CARETBLINKING
        ));
        assert!(!menu_flags_indicate_open(0));
        assert!(!menu_flags_indicate_open(GUI_CARETBLINKING));
    }

    // The tray tooltip is the only update sign that doesn't depend on
    // OS notifications: on Windows a toast is silently lost if the build has no shortcut
    // with an AppUserModelID (a portable copy), and then nothing remains in the tray.
    #[test]
    fn tooltip_shows_the_pending_update_in_both_states() {
        let labels = TrayLabels::default();
        let idle = tray_tooltip(&labels, false, "proxy", Some("0.2.57"));
        assert!(idle.starts_with(&labels.tip_off));
        assert!(idle.contains("0.2.57"));

        let connected = tray_tooltip(&labels, true, "tun", Some("0.2.57"));
        assert!(connected.contains(&labels.mode_tun));
        assert!(connected.contains("0.2.57"));
    }

    // The tooltip goes into NOTIFYICONDATAW.szTip: 128 UTF-16 units including the null,
    // Windows silently cuts the tail — and the version number on the second
    // line is lost first. These labels are a fallback for when the frontend hasn't sent its own yet;
    // tests/i18n.test.mjs checks the same limit across all 15 catalogs.
    #[test]
    fn tooltip_fits_the_windows_tray_tip_buffer() {
        let labels = TrayLabels::default();
        for mode in ["proxy", "systemProxy", "tun"] {
            let tip = tray_tooltip(&labels, true, mode, Some("99.99.999"));
            let units = tip.encode_utf16().count();
            assert!(units <= 127, "{mode}: {units} UTF-16 единиц — {tip}");
        }
    }

    // The update badge must be visible on the icon itself: the user opens the tooltip and menu
    // themselves, while a minimized app must signal a
    // new version without a single click.
    #[test]
    fn update_badge_marks_only_the_corner_of_the_icon() {
        let (w, h) = (32u32, 32u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        paint_update_badge(&mut rgba, w, h);

        let px = |x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            (rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])
        };
        // The badge center is an opaque accent, the top-left corner is untouched.
        let (r, _, _, a) = px(25, 25);
        assert_eq!(a, 255);
        assert!(r > 200, "ожидали акцентный кружок, получили r={r}");
        assert_eq!(px(0, 0), (0, 0, 0, 0));
        assert_eq!(px(2, 20), (0, 0, 0, 0));
    }

    // The icon must not change without an update: otherwise the badge would "stick" after installation.
    #[test]
    fn tray_icon_is_badged_only_when_an_update_is_pending() {
        let plain = tray_icon(false, "", false).expect("значок трея встроен в бинарь");
        let badged = tray_icon(false, "", true).expect("значок трея встроен в бинарь");
        assert_eq!(plain.width(), badged.width());
        assert_ne!(plain.rgba(), badged.rgba());
        assert_eq!(plain.rgba(), tray_state_icon(false, "").unwrap().rgba());
    }

    // A buffer smaller than the badge (or broken dimensions) must not panic on an index.
    #[test]
    fn update_badge_ignores_degenerate_buffers() {
        let mut tiny = vec![0u8; 4 * 4 * 4];
        paint_update_badge(&mut tiny, 4, 4);
        assert!(tiny.iter().all(|b| *b == 0));

        let mut truncated = vec![0u8; 8];
        paint_update_badge(&mut truncated, 32, 32);
        assert!(truncated.iter().all(|b| *b == 0));
    }

    // A caught panic in a background thread doesn't terminate the process: sing-box
    // keeps running, and the system proxy must not be removed because of it.
    #[test]
    fn only_a_main_thread_panic_releases_the_system_proxy() {
        let main = std::thread::current().id();
        let worker = std::thread::spawn(|| std::thread::current().id())
            .join()
            .unwrap();
        assert!(panic_ends_process(main, main));
        assert!(!panic_ends_process(worker, main));
    }

    // A single argv flag must not start the build check: it wipes the
    // profile store and overwrites the state backup, and the flag easily ends up in
    // a shortcut or a .bat.
    #[test]
    fn ci_smoke_needs_both_the_flag_and_the_explicit_environment_opt_in() {
        assert!(ci_smoke_opt_in(true, Some("1")));
        assert!(!ci_smoke_opt_in(true, None));
        assert!(!ci_smoke_opt_in(true, Some("0")));
        assert!(!ci_smoke_opt_in(true, Some("true")));
        assert!(!ci_smoke_opt_in(false, Some("1")));
    }

    #[test]
    fn ci_smoke_never_touches_an_existing_store() {
        let dir = std::env::temp_dir().join(format!(
            "ninety-ci-smoke-guard-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(ci_smoke_state_is_empty_in(&dir));
        for name in CI_SMOKE_PROTECTED_FILES {
            std::fs::write(dir.join(name), b"user data").unwrap();
            assert!(!ci_smoke_state_is_empty_in(&dir), "{name} не защищён");
            std::fs::remove_file(dir.join(name)).unwrap();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tooltip_without_update_keeps_the_plain_state_line() {
        let labels = TrayLabels::default();
        assert_eq!(tray_tooltip(&labels, false, "proxy", None), labels.tip_off);
        assert_eq!(
            tray_tooltip(&labels, true, "systemProxy", None),
            labels.tip_connected.replace("{mode}", &labels.mode_system)
        );
    }
}
