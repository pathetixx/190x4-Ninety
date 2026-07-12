use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::process::Command;
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
const TASK_NAME: &str = "Ninety";
// CREATE_NO_WINDOW — не мигать чёрным окном консоли schtasks.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_BACKOFF_MS: &[u64] = &[100, 150, 250, 400, 650, 1_000, 1_500, 2_000, 2_500];

const INET_SETTINGS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const NINETY_KEY: &str = r"Software\Ninety";
const PROXY_OVERRIDE: &str = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>";
const PROXY_OVERRIDE_LOOPBACK_ONLY: &str = "localhost;127.*";

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

#[derive(Debug)]
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

// Восстановить полностью проверенное прежнее состояние из snapshot.
fn restore_proxy_snapshot(
    nk: &RegKey,
    inet: &RegKey,
    snapshot: ProxySnapshot,
) -> Result<(), String> {
    if let Some(saved_server) = snapshot.server {
        inet.set_value("ProxyServer", &saved_server)
            .map_err(|e| format!("restore ProxyServer: {e}"))?;
    } else {
        match inet.delete_value("ProxyServer") {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("delete ProxyServer: {e}")),
        }
    }
    if let Some(saved_override) = snapshot.proxy_override {
        inet.set_value("ProxyOverride", &saved_override)
            .map_err(|e| format!("restore ProxyOverride: {e}"))?;
    } else {
        match inet.delete_value("ProxyOverride") {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("delete ProxyOverride: {e}")),
        }
    }
    // ProxyEnable is the commit marker visible to WinINet. Restore all
    // dependent values first so a partial registry failure never activates a
    // half-restored proxy configuration.
    inet.set_value("ProxyEnable", &snapshot.enable)
        .map_err(|e| format!("restore ProxyEnable: {e}"))?;
    nk.set_value("SavedProxyValid", &0u32)
        .map_err(|e| format!("clear proxy snapshot: {e}"))?;
    let _ = nk.delete_value("ActiveProxyServer");
    Ok(())
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
        save_proxy_snapshot(&hkcu, &key)?;
        let hp = host_port.unwrap_or("127.0.0.1:7890");
        let (ninety, _) = hkcu
            .create_subkey(NINETY_KEY)
            .map_err(|e| format!("open Ninety proxy state: {e}"))?;
        ninety
            .set_value("ActiveProxyServer", &hp.to_string())
            .map_err(|e| format!("save active proxy: {e}"))?;
        key.set_value("ProxyServer", &hp.to_string())
            .map_err(|e| format!("set ProxyServer: {e}"))?;
        let override_list = if bypass_lan.unwrap_or(true) {
            PROXY_OVERRIDE
        } else {
            PROXY_OVERRIDE_LOOPBACK_ONLY
        };
        key.set_value("ProxyOverride", &override_list.to_string())
            .map_err(|e| format!("set ProxyOverride: {e}"))?;
        key.set_value("ProxyEnable", &1u32)
            .map_err(|e| format!("set ProxyEnable: {e}"))?;
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

    unsafe {
        let _ = InternetSetOptionW(None, INTERNET_OPTION_SETTINGS_CHANGED, None, 0);
        let _ = InternetSetOptionW(None, INTERNET_OPTION_REFRESH, None, 0);
    }
    Ok(())
}

pub fn recover_stale_system_proxy() -> Result<(), String> {
    set_system_proxy(false, None, None)
}

pub fn system_proxy_owned() -> bool {
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
    enabled && server.is_some() && server == active
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
            ShellLaunchStatus::Failed { shell_code, last_error } => Err(format!(
                "не удалось запустить Ninety с правами администратора (ShellExecute={shell_code}, Win32={last_error})"
            )),
        }
    }
}

// ── Автозапуск через Планировщик заданий ──────────────────────────────────
// schtasks.exe — полный путь, чтобы не зависеть от PATH/cwd elevated-контекста.
fn schtasks_exe() -> String {
    std::env::var("SystemRoot")
        .map(|r| format!(r"{r}\System32\schtasks.exe"))
        .unwrap_or_else(|_| "schtasks.exe".into())
}

// Хвост команды создания задачи. /tr с кавычками внутри (путь exe может
// содержать пробелы) экранируется как \" — это документированный способ
// schtasks. RunLevel=highest + триггер onlogon → старт от админа без UAC.
fn create_task_cmdline(exe: &str) -> String {
    format!(
        r#"/create /tn {} /tr "\"{}\" --autostarted --elevated" /sc onlogon /rl highest /f"#,
        TASK_NAME, exe
    )
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
        autostart_is_enabled,
        |delay| std::thread::sleep(std::time::Duration::from_millis(delay)),
    )
}

// True если задача автозапуска зарегистрирована. Query прав не требует.
pub fn autostart_is_enabled() -> bool {
    Command::new(schtasks_exe())
        .args(["/query", "/tn", TASK_NAME])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// Создаёт/обновляет задачу. Если процесс уже elevated — напрямую (без UAC);
// иначе поднимает права только для schtasks (один UAC) и ждёт появления задачи.
pub fn autostart_enable() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let cmdline = create_task_cmdline(&exe.to_string_lossy());
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

// Удаляет задачу автозапуска (симметрично enable — direct если elevated).
pub fn autostart_disable() -> Result<(), String> {
    if !autostart_is_enabled() {
        return Ok(());
    }
    let cmdline = format!("/delete /tn {} /f", TASK_NAME);
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

// Миграция с прежнего автозапуска (Run-ключ реестра плагина autostart). Тот
// стартовал не-elevated инстанс → relaunch через UAC на каждый логин. Сносим
// ключ и, если мы в elevated-инстансе, заводим задачу планировщика взамен.
// Удаляем Run-ключ ТОЛЬКО при успешном создании задачи — иначе у юзера без
// always-admin (которому хватает не-elevated автозапуска) автозапуск бы пропал.
pub fn migrate_legacy_autostart() {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(run) = hkcu.open_subkey_with_flags(RUN_KEY, KEY_READ | KEY_WRITE) else {
        return;
    };
    // tauri-plugin-autostart писал значение под именем приложения; имя в разных
    // сборках бывало "Ninety"/"ninety" — проверяем оба.
    let names = ["Ninety", "ninety"];
    let legacy = names.iter().any(|n| run.get_raw_value(n).is_ok());
    if !legacy {
        return;
    }
    if is_elevated() && autostart_enable().is_ok() {
        for n in names {
            let _ = run.delete_value(n);
        }
    }
}

// Актуализирует путь exe в задаче автозапуска (после переустановки в другой
// каталог /create /f перезапишет команду). Только если задача уже есть и мы
// elevated — иначе пропускаем: создание не-elevated дёрнуло бы лишний UAC.
pub fn autostart_refresh_path() {
    if is_elevated() && autostart_is_enabled() {
        let _ = autostart_enable();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn schtasks_command_quotes_spaces_and_unicode() {
        let cmd = create_task_cmdline(r"C:\Program Files\Найнти\Ninety.exe");
        assert_eq!(
            cmd,
            r#"/create /tn Ninety /tr "\"C:\Program Files\Найнти\Ninety.exe\" --autostarted --elevated" /sc onlogon /rl highest /f"#
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
