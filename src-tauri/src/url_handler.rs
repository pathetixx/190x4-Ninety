// Регистрация Ninety как обработчика top-level VPN-схем (vless/vmess/...)
// в HKEY_CURRENT_USER\Software\Classes. Без admin прав, per-user.
//
// Tauri-plugin-deep-link регистрирует только статически заявленные в
// tauri.conf.json схемы (у нас — "ninety"). Для opt-in регистрации
// дополнительных протоколов (vless/vmess/ss/trojan/hysteria2/hy2/tuic/sub)
// делаем то же самое что и tauri-plugin-deep-link, но руками, чтобы юзер
// мог включить/выключить из Settings → Общие.
//
// Структура per-scheme в HKCU\Software\Classes\<scheme>:
//   (Default) = "URL:<Scheme> Protocol"
//   URL Protocol = ""
//   \shell\open\command\(Default) = "\"<exe>\" \"%1\""

pub const SUPPORTED_SCHEMES: &[&str] = &[
    "vless", "vmess", "ss", "trojan", "hysteria2", "hy2", "tuic", "sub",
];

#[cfg(target_os = "windows")]
fn current_exe_quoted() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    Ok(exe.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn scheme_handler_path(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn register_url_handler(scheme: String) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let scheme = scheme.to_lowercase();
    if !SUPPORTED_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!("unsupported scheme: {scheme}"));
    }

    let exe = current_exe_quoted()?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let base = format!("Software\\Classes\\{scheme}");

    let (key, _) = hkcu
        .create_subkey(&base)
        .map_err(|e| format!("create {base}: {e}"))?;
    key.set_value("", &format!("URL:{} Protocol", scheme.to_uppercase()))
        .map_err(|e| format!("set default {base}: {e}"))?;
    key.set_value("URL Protocol", &"")
        .map_err(|e| format!("set URL Protocol {base}: {e}"))?;

    let (cmd, _) = hkcu
        .create_subkey(format!("{base}\\shell\\open\\command"))
        .map_err(|e| format!("create command subkey: {e}"))?;
    cmd.set_value("", &scheme_handler_path(&exe))
        .map_err(|e| format!("set command: {e}"))?;
    Ok(())
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn unregister_url_handler(scheme: String) -> Result<(), String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let scheme = scheme.to_lowercase();
    if !SUPPORTED_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!("unsupported scheme: {scheme}"));
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let base = format!("Software\\Classes\\{scheme}");
    // delete_subkey_all — рекурсивное удаление; отсутствие ключа = Ok(()) в нашем
    // понимании (нечего удалять). NotFound маппим в Ok.
    match hkcu.delete_subkey_all(&base) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {base}: {e}")),
    }
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn is_url_handler_registered(scheme: String) -> Result<bool, String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let scheme = scheme.to_lowercase();
    if !SUPPORTED_SCHEMES.contains(&scheme.as_str()) {
        return Ok(false);
    }

    let exe = current_exe_quoted()?;
    let expected = scheme_handler_path(&exe);

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!("Software\\Classes\\{scheme}\\shell\\open\\command");
    match hkcu.open_subkey(&path) {
        Ok(k) => {
            let actual: String = k.get_value("").unwrap_or_default();
            Ok(actual.eq_ignore_ascii_case(&expected))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("open {path}: {e}")),
    }
}

// non-Windows stubs — Tauri command'ы должны существовать, чтобы invoke_handler
// собирался без cfg-условий.
#[tauri::command]
#[cfg(not(target_os = "windows"))]
pub fn register_url_handler(_scheme: String) -> Result<(), String> {
    Err("url handler registration is Windows-only".into())
}

#[tauri::command]
#[cfg(not(target_os = "windows"))]
pub fn unregister_url_handler(_scheme: String) -> Result<(), String> {
    Err("url handler registration is Windows-only".into())
}

#[tauri::command]
#[cfg(not(target_os = "windows"))]
pub fn is_url_handler_registered(_scheme: String) -> Result<bool, String> {
    Ok(false)
}
