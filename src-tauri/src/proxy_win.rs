use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use winreg::enums::*;
use winreg::RegKey;
use windows::core::PCWSTR;
use windows::Win32::Networking::WinInet::{
    InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

const INET_SETTINGS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const PROXY_OVERRIDE: &str = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>";

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

pub fn set_system_proxy(enable: bool, host_port: Option<&str>) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(INET_SETTINGS_KEY)
        .map_err(|e| format!("open Internet Settings: {e}"))?;

    if enable {
        let hp = host_port.unwrap_or("127.0.0.1:7890");
        key.set_value("ProxyServer", &hp.to_string())
            .map_err(|e| format!("set ProxyServer: {e}"))?;
        key.set_value("ProxyOverride", &PROXY_OVERRIDE.to_string())
            .map_err(|e| format!("set ProxyOverride: {e}"))?;
        key.set_value("ProxyEnable", &1u32)
            .map_err(|e| format!("set ProxyEnable: {e}"))?;
    } else {
        key.set_value("ProxyEnable", &0u32)
            .map_err(|e| format!("clear ProxyEnable: {e}"))?;
    }

    unsafe {
        let _ = InternetSetOptionW(None, INTERNET_OPTION_SETTINGS_CHANGED, None, 0);
        let _ = InternetSetOptionW(None, INTERNET_OPTION_REFRESH, None, 0);
    }
    Ok(())
}

pub fn run_elevated(exe: &str, args: &[&str]) -> Result<(), String> {
    let params = args
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
    let verb = to_wide("runas");
    let file = to_wide(exe);
    let params_w = to_wide(&params);

    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR(params_w.as_ptr()),
            PCWSTR::null(),
            SW_HIDE,
        )
    };
    let code = result.0 as isize;
    if code <= 32 {
        return Err(format!("ShellExecuteW runas failed (code {code})"));
    }
    Ok(())
}

pub fn taskkill_singbox() {
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/IM", "sing-box.exe"])
        .output();
}
