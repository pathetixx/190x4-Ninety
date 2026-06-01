use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
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
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const INET_SETTINGS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const NINETY_KEY: &str = r"Software\Ninety";
const PROXY_OVERRIDE: &str = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>";

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

// Снапшот прежних ProxyEnable/ProxyServer — один раз, до того как Ninety
// перезапишет их своими. Без этого выключение Ninety затёрло бы прокси, который
// юзер мог настроить вне Ninety. Повторный enable снапшот не перетирает.
fn save_proxy_snapshot(hkcu: &RegKey, inet: &RegKey) {
    let Ok((nk, _)) = hkcu.create_subkey(NINETY_KEY) else { return };
    if nk.get_value::<u32, _>("SavedProxyValid").unwrap_or(0) == 1 {
        return;
    }
    let cur_enable: u32 = inet.get_value("ProxyEnable").unwrap_or(0);
    let cur_server: String = inet.get_value("ProxyServer").unwrap_or_default();
    let _ = nk.set_value("SavedProxyEnable", &cur_enable);
    let _ = nk.set_value("SavedProxyServer", &cur_server);
    let _ = nk.set_value("SavedProxyValid", &1u32);
}

// Восстановить прежнее состояние из снапшота. true — если снапшот был применён.
fn restore_proxy_snapshot(hkcu: &RegKey, inet: &RegKey) -> bool {
    let Ok(nk) = hkcu.open_subkey_with_flags(NINETY_KEY, KEY_READ | KEY_WRITE) else {
        return false;
    };
    if nk.get_value::<u32, _>("SavedProxyValid").unwrap_or(0) != 1 {
        return false;
    }
    let saved_enable: u32 = nk.get_value("SavedProxyEnable").unwrap_or(0);
    let saved_server: String = nk.get_value("SavedProxyServer").unwrap_or_default();
    let _ = inet.set_value("ProxyEnable", &saved_enable);
    if !saved_server.is_empty() {
        let _ = inet.set_value("ProxyServer", &saved_server);
    }
    let _ = nk.set_value("SavedProxyValid", &0u32);
    true
}

pub fn set_system_proxy(enable: bool, host_port: Option<&str>) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(INET_SETTINGS_KEY)
        .map_err(|e| format!("open Internet Settings: {e}"))?;

    if enable {
        save_proxy_snapshot(&hkcu, &key);
        let hp = host_port.unwrap_or("127.0.0.1:7890");
        key.set_value("ProxyServer", &hp.to_string())
            .map_err(|e| format!("set ProxyServer: {e}"))?;
        key.set_value("ProxyOverride", &PROXY_OVERRIDE.to_string())
            .map_err(|e| format!("set ProxyOverride: {e}"))?;
        key.set_value("ProxyEnable", &1u32)
            .map_err(|e| format!("set ProxyEnable: {e}"))?;
    } else if !restore_proxy_snapshot(&hkcu, &key) {
        // снапшота нет (Ninety не включал прокси) — просто выключаем
        key.set_value("ProxyEnable", &0u32)
            .map_err(|e| format!("clear ProxyEnable: {e}"))?;
    }

    unsafe {
        let _ = InternetSetOptionW(None, INTERNET_OPTION_SETTINGS_CHANGED, None, 0);
        let _ = InternetSetOptionW(None, INTERNET_OPTION_REFRESH, None, 0);
    }
    Ok(())
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
            HWND::default(),
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
