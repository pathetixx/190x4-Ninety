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
use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL};
use winreg::enums::*;
use winreg::RegKey;

// Имя задачи в Планировщике (Task Scheduler). Через неё реализован автозапуск:
// задача с RunLevel=Highest стартует Ninety уже с правами администратора при
// входе в Windows — без UAC-промпта на каждый логин (которым страдал прежний
// Run-ключ реестра: тот запускал не-elevated инстанс, и тот сам перезапускался
// через runas → UAC). См. autostart_enable / migrate_legacy_autostart.
const INSTALLED_TASK_NAME: &str = "Ninety";
const PORTABLE_TASK_NAME: &str = "Ninety Portable";
// CREATE_NO_WINDOW — не мигать чёрным окном консоли schtasks.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
// tauri-plugin-autostart писал значение под именем приложения; в разных сборках
// оно было "Ninety" и "ninety". Один список на все места, которые его читают,
// удаляют и мигрируют.
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

// InternetSetOptionW с NULL-handle работает синхронно. На части Windows
// SETTINGS_CHANGED/REFRESH ждут зависшие WinINet-клиенты десятки секунд. Реестр
// к этому моменту уже атомарно обновлён, поэтому оповещение выполняем вне IPC-
// shutdown. Generation-coalescing не даёт потерять последний запрос, пока
// предыдущий SETTINGS_CHANGED/REFRESH ещё выполняется.
fn run_proxy_notify_worker() {
    // Внешний цикл вместо самовызова: подхват «догнавшего» запроса не должен
    // наращивать стек — Rust не гарантирует хвостовую оптимизацию, а частота
    // вызовов задаётся снаружи и ничем не ограничена.
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
    // ERROR_CANCELLED (1223) надёжно отличает отказ пользователя в UAC от
    // обычного SE_ERR_ACCESSDENIED (5), когда Windows его выставляет.
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
    DisableOwnedProxy,
}

// Старые версии Ninety сохраняли snapshot, но не ActiveProxyServer. Для них
// поддерживаем только известный исторический адрес по умолчанию и только при
// полностью валидном snapshot. Один лишь loopback никогда не доказывает
// владение: это может быть Clash/Fiddler/Charles или корпоративный агент.
fn proxy_recovery_action(
    current_server: &str,
    current_enable: u32,
    current_override: Option<&str>,
    active: Option<&str>,
    snapshot_valid: bool,
) -> ProxyRecoveryAction {
    let settings_still_match = current_enable == 1
        && matches!(
            current_override,
            Some(value) if value == PROXY_OVERRIDE || value == PROXY_OVERRIDE_LOOPBACK_ONLY
        );
    match active {
        Some(value) if settings_still_match && current_server.eq_ignore_ascii_case(value) => {
            if snapshot_valid {
                ProxyRecoveryAction::RestoreSnapshot
            } else {
                ProxyRecoveryAction::DisableOwnedProxy
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
        return Err(format!("неожиданное значение ProxyEnable={enable}"));
    }
    Ok(ProxySnapshot {
        enable,
        server: inet.get_value::<String, _>("ProxyServer").ok(),
        proxy_override: inet.get_value::<String, _>("ProxyOverride").ok(),
    })
}

// Снапшот прежних proxy-настроек — один раз, до того как Ninety перезапишет их
// своими. Без этого выключение Ninety затёрло бы прокси/bypass-лист, которые
// юзер мог настроить вне Ninety. Повторный enable снапшот не перетирает.
fn save_proxy_snapshot(hkcu: &RegKey, inet: &RegKey) -> Result<(), String> {
    let (nk, _) = hkcu
        .create_subkey(NINETY_KEY)
        .map_err(|e| format!("create Ninety proxy state: {e}"))?;
    if nk.get_value::<u32, _>("SavedProxyValid").unwrap_or(0) == 1 {
        return if read_proxy_snapshot(&nk).is_some() {
            Ok(())
        } else {
            Err("сохранённое состояние системного proxy повреждено; включение отменено".into())
        };
    }
    let cur_enable: u32 = inet.get_value("ProxyEnable").unwrap_or(0);
    if cur_enable > 1 {
        return Err(format!(
            "неожиданное значение ProxyEnable={cur_enable}; включение отменено"
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

// Восстановить полностью проверенное исходное состояние при обычном disable.
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
                "{apply_error}; rollback системного proxy тоже не удался: {rollback_error}"
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
        // SavedProxy* остаётся исходным состоянием до первого enable и нужен для
        // окончательного disable. Этот отдельный snapshot относится только к
        // текущему вызову: повторная настройка A → B при ошибке должна вернуть A.
        let rollback = capture_enable_rollback(&ninety, &key)?;
        save_proxy_snapshot(&hkcu, &key)?;
        let override_list = if bypass_lan.unwrap_or(true) {
            PROXY_OVERRIDE
        } else {
            PROXY_OVERRIDE_LOOPBACK_ONLY
        };

        // Все записи до ProxyEnable — подготовка, ProxyEnable — commit. Любая
        // ошибка возвращает состояние до текущего вызова, не исходный snapshot
        // первой сессии Ninety.
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
            // Даже после успешного rollback часть WinINet-клиентов могла увидеть
            // промежуточные значения; заставляем их перечитать восстановленный state.
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
                // Кто-то сменил proxy после Ninety либо доказательств владения
                // нет. Настройки Windows не трогаем, stale-маркеры забываем.
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
            ProxyRecoveryAction::DisableOwnedProxy => {
                // Явный ActiveProxyServer совпал, но snapshot отсутствует либо
                // повреждён. Отключаем только доказанно наш proxy и не пытаемся
                // восстанавливать частичные значения.
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
    // Регистронезависимо — как в proxy_recovery_action. Адрес endpoint'а мы
    // нормализуем сами, но в ProxyServer могла попасть запись, сделанная вне
    // Ninety (или прежней сборкой) в другом регистре: строгое сравнение тогда
    // объявляло наш собственный прокси чужим, и disable оставлял его включённым.
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

// True если текущий процесс запущен с правами администратора (elevated token).
// Throne-style TUN требует чтобы всё приложение было elevated — sing-box,
// поднимающий TUN-инбаунд, работает дочерним процессом и наследует права.
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

// Перезапускает текущий exe с правами администратора через runas (UAC).
// Fire-and-forget: вызывающий после Ok(true) должен завершить текущий процесс.
//  - Ok(true)  — elevated-инстанс стартовал;
//  - Ok(false) — юзер отменил UAC (текущий процесс НЕ трогаем, остаёмся как есть);
//  - Err       — системная ошибка запуска.
// extra_args передаются новому процессу (напр. "--elevated" для авто-коннекта).
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
                Err("Windows отказала в запуске Ninety с правами администратора".into())
            }
            ShellLaunchStatus::FileNotFound => {
                Err("Windows не нашла исполняемый файл Ninety".into())
            }
            ShellLaunchStatus::Failed {
                shell_code,
                last_error,
            } => Err(format!(
                "не удалось запустить Ninety с правами администратора (ShellExecute={shell_code}, Win32={last_error})"
            )),
        }
    }
}

// ── Автозапуск через Планировщик заданий ──────────────────────────────────
// schtasks.exe — полный путь, чтобы не зависеть от PATH/cwd elevated-контекста.
fn schtasks_exe() -> String {
    crate::util::system_directory()
        .join("schtasks.exe")
        .to_string_lossy()
        .into_owned()
}

// Системные корни, запись в которые уже требует прав администратора. Только для
// exe оттуда задача автозапуска имеет право работать с RunLevel=highest.
// Источник — HKLM (см. util::program_files_roots): одноимённые переменные
// окружения переопределяются из HKCU обычным пользователем, и тогда решение о
// выдаче highest принималось бы по значению, которое подсунул он сам.
fn program_files_roots() -> Vec<PathBuf> {
    crate::util::program_files_roots()
}

// Задача с /rl highest стартует exe от администратора без UAC на каждый логин.
// Если сам exe лежит там, куда обычный пользователь может писать (Full Portable
// из ZIP, per-user установка в AppData), подмена файла превращается в тихое
// повышение прав. В таком размещении автозапуск остаётся обычного уровня: TUN
// при необходимости запросит UAC штатно.
fn autostart_uses_highest_run_level(exe: &Path, roots: &[PathBuf]) -> bool {
    let exe = exe.to_string_lossy().to_lowercase();
    roots.iter().any(|root| {
        let root = root.to_string_lossy().to_lowercase();
        !root.is_empty() && exe.starts_with(&root) && exe[root.len()..].starts_with(['\\', '/'])
    })
}

// Хвост команды создания задачи. /tr с кавычками внутри (путь exe может
// содержать пробелы) экранируется как \" — это документированный способ
// schtasks. Триггер onlogon; RunLevel=highest — только для системного каталога.
fn create_task_cmdline(exe: &str, highest: bool) -> String {
    format!(
        r#"/create /tn {} /tr "\"{}\" --autostarted --elevated" /sc onlogon{} /f"#,
        schtasks_name_arg(task_name()),
        exe,
        if highest { " /rl highest" } else { "" }
    )
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

// Запуск schtasks с поднятием прав (один UAC, само приложение не перезапускаем).
// SW_HIDE прячет окно консоли; подробный статус нужен для понятной ошибки UI.
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

fn elevated_task_error(action: &str, status: ShellLaunchStatus) -> Result<(), String> {
    match status {
        ShellLaunchStatus::Started => Ok(()),
        ShellLaunchStatus::Cancelled => Err(format!("{action} отменено пользователем в UAC")),
        ShellLaunchStatus::AccessDenied => Err(format!("{action}: Windows отказала в доступе")),
        ShellLaunchStatus::FileNotFound => Err(format!(
            "{action}: schtasks.exe не найден в системном каталоге Windows"
        )),
        ShellLaunchStatus::Failed {
            shell_code,
            last_error,
        } => Err(format!(
            "{action}: системная ошибка запуска (ShellExecute={shell_code}, Win32={last_error})"
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

// True если задача автозапуска зарегистрирована. Query прав не требует.
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

// Снять автозапуск прежнего поколения (Run-ключ реестра). Отдельная операция,
// потому что задачи Планировщика у такого пользователя может не быть вовсе:
// миграция заводит её только из elevated-процесса, а до тех пор автозапуск
// живёт исключительно в Run. Без этой уборки «Выключить автозапуск» ничего не
// делало — команда сразу выходила по «задачи нет», а autostart_is_enabled
// продолжал видеть Run-ключ и возвращал тумблер обратно во включённое
// положение. Отсутствие ключа — не ошибка: операция идемпотентна.
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
            "не удалось снять устаревший автозапуск: {}",
            errors.join("; ")
        ))
    }
}

pub fn autostart_is_enabled() -> bool {
    let _guard = autostart_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Пока фоновая миграция ещё не успела заменить старый Run-ключ задачей,
    // UI должен видеть фактический legacy-autostart, а не временный false.
    autostart_is_enabled_unlocked() || legacy_autostart_present()
}

// Создаёт/обновляет задачу. Если процесс уже elevated — напрямую (без UAC);
// иначе поднимает права только для schtasks (один UAC) и ждёт появления задачи.
fn autostart_enable_unlocked() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let highest = autostart_uses_highest_run_level(&exe, &program_files_roots());
    let cmdline = create_task_cmdline(&exe.to_string_lossy(), highest);
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
            Err("schtasks /create вернул ошибку".into())
        };
    }
    elevated_task_error("Создание автозапуска", run_schtasks_elevated(&cmdline))?;
    if wait_for_task_state(true) {
        return Ok(());
    }
    Err("задача автозапуска не появилась за 8,5 секунд".into())
}

pub fn autostart_enable() -> Result<(), String> {
    let _guard = autostart_lock()
        .lock()
        .map_err(|_| "блокировка автозапуска повреждена".to_string())?;
    autostart_enable_unlocked()
}

// Удаляет задачу автозапуска (симметрично enable — direct если elevated).
// Legacy Run-ключ снимаем ПЕРВЫМ и независимо от наличия задачи: он тоже
// автозапуск, его видит autostart_is_enabled, и без этого шага выключение
// оставалось бы no-op'ом для всех, кто пришёл со сборок на Run-ключе.
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
            Err("schtasks /delete вернул ошибку".into())
        };
    }
    elevated_task_error("Отключение автозапуска", run_schtasks_elevated(&cmdline))?;
    if wait_for_task_state(false) {
        return Ok(());
    }
    Err("задача автозапуска не удалилась за 8,5 секунд".into())
}

pub fn autostart_disable() -> Result<(), String> {
    let _guard = autostart_lock()
        .lock()
        .map_err(|_| "блокировка автозапуска повреждена".to_string())?;
    autostart_disable_unlocked()
}

// Миграция с прежнего автозапуска (Run-ключ реестра плагина autostart). Тот
// стартовал не-elevated инстанс → relaunch через UAC на каждый логин. Сносим
// ключ и, если мы в elevated-инстансе, заводим задачу планировщика взамен.
// Удаляем Run-ключ ТОЛЬКО при успешном создании задачи — иначе у юзера без
// always-admin (которому хватает не-elevated автозапуска) автозапуск бы пропал.
pub fn migrate_legacy_autostart() {
    let _guard = autostart_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !legacy_autostart_present() {
        return;
    }
    // Ключ снимаем ТОЛЬКО после успешно созданной задачи: у пользователя без
    // always-admin не-elevated автозапуск через Run — единственный рабочий, и
    // терять его до появления замены нельзя.
    if is_elevated() && autostart_enable_unlocked().is_ok() {
        let _ = remove_legacy_autostart();
    }
}

// Актуализирует путь exe в задаче автозапуска (после переустановки в другой
// каталог /create /f перезапишет команду). Только если задача уже есть и мы
// elevated — иначе пропускаем: создание не-elevated дёрнуло бы лишний UAC.
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
    fn third_party_enable_or_override_change_is_untouched() {
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
        assert_eq!(
            proxy_recovery_action(
                "127.0.0.1:7890",
                1,
                Some("localhost;<local>"),
                Some("127.0.0.1:7890"),
                true,
            ),
            ProxyRecoveryAction::LeaveUntouched
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
    fn schtasks_command_quotes_spaces_and_unicode() {
        let cmd = create_task_cmdline(r"C:\Program Files\Найнти\Ninety.exe", true);
        assert_eq!(
            cmd,
            r#"/create /tn Ninety /tr "\"C:\Program Files\Найнти\Ninety.exe\" --autostarted --elevated" /sc onlogon /rl highest /f"#
        );
    }

    // Автозапуск с highest на user-writable exe — это тихое повышение прав для
    // любого процесса пользователя, который может перезаписать файл.
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
            // Совпадение префикса без границы каталога не делает путь системным.
            r"C:\Program Files Portable\Ninety\Ninety.exe",
        ] {
            assert!(
                !autostart_uses_highest_run_level(Path::new(user_writable), &roots),
                "{user_writable} не должен получать highest"
            );
        }
    }

    // Тест выше передаёт корни литералом, поэтому подмену САМОГО ИСТОЧНИКА он
    // увидеть не может. Продакшн берёт их из HKLM: переменные окружения пишет
    // HKCU\Environment, и через них обычный пользователь объявил бы свой каталог
    // системным, получив highest на подменяемый exe.
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
    fn portable_autostart_command_has_no_highest_run_level() {
        let cmd = create_task_cmdline(r"D:\Ninety\Ninety.exe", false);
        assert!(!cmd.contains("/rl highest"), "{cmd}");
        assert!(cmd.contains("/sc onlogon /f"), "{cmd}");
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
