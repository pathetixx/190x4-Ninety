use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::process::Command;
use winreg::enums::*;
use winreg::RegKey;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::Networking::WinInet::{
    InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
};
use windows::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL};

// Имя задачи в Планировщике (Task Scheduler). Через неё реализован автозапуск:
// задача с RunLevel=Highest стартует Ninety уже с правами администратора при
// входе в Windows — без UAC-промпта на каждый логин (которым страдал прежний
// Run-ключ реестра: тот запускал не-elevated инстанс, и тот сам перезапускался
// через runas → UAC). См. autostart_enable / migrate_legacy_autostart.
const TASK_NAME: &str = "Ninety";
// CREATE_NO_WINDOW — не мигать чёрным окном консоли schtasks.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

const INET_SETTINGS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const NINETY_KEY: &str = r"Software\Ninety";
const PROXY_OVERRIDE: &str = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>";
const PROXY_OVERRIDE_LOOPBACK_ONLY: &str = "localhost;127.*";

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn proxy_owned_by_ninety(current: &str, active: Option<&str>) -> bool {
    active
        .map(|value| current.eq_ignore_ascii_case(value))
        .unwrap_or_else(|| current.starts_with("127.0.0.1:"))
}

// Снапшот прежних proxy-настроек — один раз, до того как Ninety перезапишет их
// своими. Без этого выключение Ninety затёрло бы прокси/bypass-лист, которые
// юзер мог настроить вне Ninety. Повторный enable снапшот не перетирает.
fn save_proxy_snapshot(hkcu: &RegKey, inet: &RegKey) -> Result<(), String> {
    let (nk, _) = hkcu
        .create_subkey(NINETY_KEY)
        .map_err(|e| format!("create Ninety proxy state: {e}"))?;
    if nk.get_value::<u32, _>("SavedProxyValid").unwrap_or(0) == 1 {
        return Ok(());
    }
    let cur_enable: u32 = inet.get_value("ProxyEnable").unwrap_or(0);
    nk.set_value("SavedProxyEnable", &cur_enable)
        .map_err(|e| format!("save ProxyEnable: {e}"))?;
    match inet.get_value::<String, _>("ProxyServer") {
        Ok(v) => {
            nk.set_value("SavedProxyServer", &v).map_err(|e| format!("save ProxyServer: {e}"))?;
            nk.set_value("SavedProxyServerPresent", &1u32).map_err(|e| format!("save ProxyServer flag: {e}"))?;
        }
        Err(_) => {
            nk.set_value("SavedProxyServer", &"".to_string()).map_err(|e| format!("clear saved ProxyServer: {e}"))?;
            nk.set_value("SavedProxyServerPresent", &0u32).map_err(|e| format!("save ProxyServer absent flag: {e}"))?;
        }
    }
    match inet.get_value::<String, _>("ProxyOverride") {
        Ok(v) => {
            nk.set_value("SavedProxyOverride", &v).map_err(|e| format!("save ProxyOverride: {e}"))?;
            nk.set_value("SavedProxyOverridePresent", &1u32).map_err(|e| format!("save ProxyOverride flag: {e}"))?;
        }
        Err(_) => {
            nk.set_value("SavedProxyOverride", &"".to_string()).map_err(|e| format!("clear saved ProxyOverride: {e}"))?;
            nk.set_value("SavedProxyOverridePresent", &0u32).map_err(|e| format!("save ProxyOverride absent flag: {e}"))?;
        }
    }
    nk.set_value("SavedProxyValid", &1u32)
        .map_err(|e| format!("commit proxy snapshot: {e}"))?;
    Ok(())
}

// Восстановить прежнее состояние из снапшота. true — если снапшот был применён.
fn restore_proxy_snapshot(hkcu: &RegKey, inet: &RegKey) -> Result<bool, String> {
    let Ok(nk) = hkcu.open_subkey_with_flags(NINETY_KEY, KEY_READ | KEY_WRITE) else {
        return Ok(false);
    };
    if nk.get_value::<u32, _>("SavedProxyValid").unwrap_or(0) != 1 {
        return Ok(false);
    }
    let saved_enable: u32 = nk.get_value("SavedProxyEnable").unwrap_or(0);
    let saved_server: String = nk.get_value("SavedProxyServer").unwrap_or_default();
    let saved_server_present = nk
        .get_value::<u32, _>("SavedProxyServerPresent")
        .map(|v| v == 1)
        .unwrap_or(!saved_server.is_empty());
    let saved_override: String = nk.get_value("SavedProxyOverride").unwrap_or_default();
    let saved_override_present = nk
        .get_value::<u32, _>("SavedProxyOverridePresent")
        .map(|v| v == 1)
        .unwrap_or(false);
    if saved_server_present {
        inet.set_value("ProxyServer", &saved_server).map_err(|e| format!("restore ProxyServer: {e}"))?;
    } else {
        match inet.delete_value("ProxyServer") {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("delete ProxyServer: {e}")),
        }
    }
    if saved_override_present {
        inet.set_value("ProxyOverride", &saved_override).map_err(|e| format!("restore ProxyOverride: {e}"))?;
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
    inet.set_value("ProxyEnable", &saved_enable)
        .map_err(|e| format!("restore ProxyEnable: {e}"))?;
    nk.set_value("SavedProxyValid", &0u32).map_err(|e| format!("clear proxy snapshot: {e}"))?;
    let _ = nk.delete_value("ActiveProxyServer");
    Ok(true)
}

pub fn set_system_proxy(enable: bool, host_port: Option<&str>, bypass_lan: Option<bool>) -> Result<(), String> {
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
        let active = hkcu
            .open_subkey(NINETY_KEY)
            .ok()
            .and_then(|k| k.get_value::<String, _>("ActiveProxyServer").ok());
        if !proxy_owned_by_ninety(&current, active.as_deref()) {
            // Кто-то сменил proxy после Ninety — не перетираем новый выбор.
            // Это также покрывает legacy snapshot без ActiveProxyServer.
            if let Ok(nk) = hkcu.open_subkey_with_flags(NINETY_KEY, KEY_READ | KEY_WRITE) {
                let _ = nk.set_value("SavedProxyValid", &0u32);
                let _ = nk.delete_value("ActiveProxyServer");
            }
        } else if !restore_proxy_snapshot(&hkcu, &key)? {
            // Legacy crash без snapshot ownership: гасим только наш loopback.
            let owned = proxy_owned_by_ninety(&current, active.as_deref());
            if owned {
                key.set_value("ProxyEnable", &0u32)
                    .map_err(|e| format!("clear ProxyEnable: {e}"))?;
                if let Ok(nk) = hkcu.open_subkey_with_flags(NINETY_KEY, KEY_READ | KEY_WRITE) {
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
        // ShellExecuteW возвращает HINSTANCE: >32 = успех. <=32 (часто 5 —
        // SE_ERR_ACCESSDENIED / ERROR_CANCELLED) трактуем как отказ юзера в UAC.
        let code = h.0 as isize;
        if code > 32 {
            Ok(true)
        } else {
            Ok(false)
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
// SW_HIDE прячет окно консоли. Ok(true) — UAC принят, Ok(false) — отменён.
fn run_schtasks_elevated(cmdline: &str) -> bool {
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
        h.0 as isize > 32
    }
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
        return if ok { Ok(()) } else { Err("schtasks /create вернул ошибку".into()) };
    }
    if !run_schtasks_elevated(&cmdline) {
        return Err("Создание автозапуска отменено".into());
    }
    for _ in 0..20 {
        if autostart_is_enabled() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err("задача автозапуска не появилась".into())
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
        return if ok { Ok(()) } else { Err("schtasks /delete вернул ошибку".into()) };
    }
    if !run_schtasks_elevated(&cmdline) {
        return Err("Отключение автозапуска отменено".into());
    }
    for _ in 0..20 {
        if !autostart_is_enabled() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err("задача автозапуска не удалилась".into())
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

    #[test]
    fn proxy_ownership_prefers_explicit_marker() {
        assert!(proxy_owned_by_ninety("127.0.0.1:7890", Some("127.0.0.1:7890")));
        assert!(!proxy_owned_by_ninety("127.0.0.1:8080", Some("127.0.0.1:7890")));
        assert!(proxy_owned_by_ninety("127.0.0.1:7890", None));
        assert!(!proxy_owned_by_ninety("corp.example:8080", None));
    }
}
