// Регистрация Ninety как обработчика top-level VPN-схем (vless/vmess/...)
// в HKEY_CURRENT_USER\Software\Classes. Без admin прав, per-user.
//
// Tauri-plugin-deep-link регистрирует только статически заявленные в
// tauri.conf.json схемы (у нас — "ninety"). Для opt-in регистрации
// дополнительных протоколов (vless/vmess/ss/trojan/hysteria2/hy2/tuic/sub/tt/
// naive+https/naive+quic)
// делаем то же самое что и tauri-plugin-deep-link, но руками, чтобы юзер
// мог включить/выключить из Settings → Общие.
//
// Структура per-scheme в HKCU\Software\Classes\<scheme>:
//   (Default) = "URL:<Scheme> Protocol"
//   URL Protocol = ""
//   \shell\open\command\(Default) = "\"<exe>\" \"%1\""

pub const SUPPORTED_SCHEMES: &[&str] = &[
    "vless",
    "vmess",
    "ss",
    "trojan",
    "hysteria2",
    "hy2",
    "tuic",
    "sub",
    "tt",
    "naive+https",
    "naive+quic",
];

const ALL_DEEP_LINK_SCHEMES: &[&str] = &[
    "ninety",
    "vless",
    "vmess",
    "ss",
    "trojan",
    "hysteria2",
    "hy2",
    "tuic",
    "sub",
    "tt",
    "naive+https",
    "naive+quic",
];

fn deep_link_scheme(s: &str) -> Option<&str> {
    let idx = s.find("://")?;
    Some(&s[..idx])
}

fn handler_is_owned(actual: Option<&str>, expected: &str, last_owned: Option<&str>) -> bool {
    actual.is_some_and(|value| {
        value.eq_ignore_ascii_case(expected)
            || last_owned.is_some_and(|owned| value.eq_ignore_ascii_case(owned))
    })
}

pub fn extract_deep_link_urls<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .filter_map(|a| {
            let s = a.as_ref().trim();
            let scheme = deep_link_scheme(s)?.to_ascii_lowercase();
            if ALL_DEEP_LINK_SCHEMES.contains(&scheme.as_str()) {
                Some(s.to_string())
            } else {
                None
            }
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn current_exe_quoted() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    Ok(exe.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn scheme_handler_path(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

#[cfg(target_os = "windows")]
fn handler_backup_path(scheme: &str) -> String {
    format!("Software\\Ninety\\UrlHandlers\\{scheme}")
}

// Последний command, который Ninety записал для схемы. После переустановки в
// другой каталог (или перехода installed ↔ portable) актуальный exe уже не
// совпадает с записью в реестре, но владельцем остаёмся мы: без этого маркера
// disable молча ничего не снимал, а статус показывал «выключено» при живой
// регистрации на несуществующий путь.
#[cfg(target_os = "windows")]
fn owned_command_marker(hkcu: &winreg::RegKey, scheme: &str) -> Option<String> {
    hkcu.open_subkey(handler_backup_path(scheme))
        .ok()
        .and_then(|backup| backup.get_value::<String, _>("OwnedCommand").ok())
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
    let expected = scheme_handler_path(&exe);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let base = format!("Software\\Classes\\{scheme}");
    let command_path = format!("{base}\\shell\\open\\command");
    let backup_path = handler_backup_path(&scheme);

    // Перед КАЖДЫМ захватом чужой регистрации сохраняем её текущее значение.
    // Другой VPN-клиент мог стать владельцем уже после первого opt-in Ninety;
    // disable обязан вернуть именно его, а не исторический stale backup.
    let previous = hkcu
        .open_subkey(&command_path)
        .ok()
        .and_then(|k| k.get_value::<String, _>("").ok());
    let last_owned = owned_command_marker(&hkcu, &scheme);
    if !handler_is_owned(previous.as_deref(), &expected, last_owned.as_deref()) {
        let (backup, _) = hkcu
            .create_subkey(&backup_path)
            .map_err(|e| format!("create URL handler backup: {e}"))?;
        // Saved — commit marker. Сначала снимаем его, чтобы crash между
        // отдельными registry writes не оставил частично обновлённый backup
        // выглядеть завершённым.
        backup
            .set_value("Saved", &0u32)
            .map_err(|e| format!("begin URL handler backup: {e}"))?;
        backup
            .set_value("PreviousCommand", &previous.clone().unwrap_or_default())
            .map_err(|e| format!("save previous URL handler: {e}"))?;
        backup
            .set_value("PreviousCommandPresent", &u32::from(previous.is_some()))
            .map_err(|e| format!("save previous URL handler flag: {e}"))?;
        backup
            .set_value("Saved", &1u32)
            .map_err(|e| format!("commit URL handler backup: {e}"))?;
    }

    let (key, _) = hkcu
        .create_subkey(&base)
        .map_err(|e| format!("create {base}: {e}"))?;
    key.set_value("", &format!("URL:{} Protocol", scheme.to_uppercase()))
        .map_err(|e| format!("set default {base}: {e}"))?;
    key.set_value("URL Protocol", &"")
        .map_err(|e| format!("set URL Protocol {base}: {e}"))?;

    let (cmd, _) = hkcu
        .create_subkey(&command_path)
        .map_err(|e| format!("create command subkey: {e}"))?;
    cmd.set_value("", &expected)
        .map_err(|e| format!("set command: {e}"))?;
    // Отдельно помечаем последний command Ninety. После OTA exe может переехать:
    // старый путь остаётся нашим и не должен затереть backup чужого клиента.
    let (backup, _) = hkcu
        .create_subkey(&backup_path)
        .map_err(|e| format!("create URL handler ownership marker: {e}"))?;
    backup
        .set_value("OwnedCommand", &expected)
        .map_err(|e| format!("save URL handler ownership marker: {e}"))?;
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
    let command_path = format!("{base}\\shell\\open\\command");
    let expected = scheme_handler_path(&current_exe_quoted()?);
    let actual = hkcu
        .open_subkey(&command_path)
        .ok()
        .and_then(|k| k.get_value::<String, _>("").ok());
    // Другой клиент уже стал владельцем — его регистрацию не трогаем. Свою
    // прежнюю (записанную ещё по старому пути exe) снимать обязаны: иначе
    // выключение опции ничего не делает, а схема остаётся за мёртвым путём.
    let last_owned = owned_command_marker(&hkcu, &scheme);
    if !handler_is_owned(actual.as_deref(), &expected, last_owned.as_deref()) {
        return Ok(());
    }

    let backup_path = handler_backup_path(&scheme);
    let previous = hkcu.open_subkey(&backup_path).ok().and_then(|backup| {
        if backup.get_value::<u32, _>("Saved").unwrap_or(0) != 1
            || backup
                .get_value::<u32, _>("PreviousCommandPresent")
                .unwrap_or(0)
                != 1
        {
            return None;
        }
        backup.get_value::<String, _>("PreviousCommand").ok()
    });
    if let Some(previous) = previous {
        let (key, _) = hkcu
            .create_subkey(&base)
            .map_err(|e| format!("restore {base}: {e}"))?;
        key.set_value("", &format!("URL:{} Protocol", scheme.to_uppercase()))
            .map_err(|e| format!("restore default {base}: {e}"))?;
        key.set_value("URL Protocol", &"")
            .map_err(|e| format!("restore URL Protocol {base}: {e}"))?;
        let (cmd, _) = hkcu
            .create_subkey(&command_path)
            .map_err(|e| format!("restore command: {e}"))?;
        cmd.set_value("", &previous)
            .map_err(|e| format!("restore command value: {e}"))?;
        let _ = hkcu.delete_subkey_all(&backup_path);
        return Ok(());
    }
    // delete_subkey_all — рекурсивное удаление; отсутствие ключа = Ok(()) в нашем
    // понимании (нечего удалять). NotFound маппим в Ok.
    match hkcu.delete_subkey_all(&base) {
        Ok(()) => {
            let _ = hkcu.delete_subkey_all(&backup_path);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = hkcu.delete_subkey_all(&backup_path);
            Ok(())
        }
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
    let last_owned = owned_command_marker(&hkcu, &scheme);
    match hkcu.open_subkey(&path) {
        Ok(k) => {
            let actual: String = k.get_value("").unwrap_or_default();
            // Регистрация по прежнему пути exe остаётся нашей: статус обязан
            // это показывать, иначе UI предлагает включить уже включённое.
            Ok(handler_is_owned(
                Some(actual.as_str()),
                &expected,
                last_owned.as_deref(),
            ))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_supported_deep_link_args_only() {
        let urls = extract_deep_link_urls([
            r"C:\Program Files\Ninety\Ninety.exe",
            "--elevated",
            "vless://uuid@example.com:443",
            "tt://?abc",
            "naive+https://u:p@example.com:443",
            "https://example.com/sub",
        ]);
        assert_eq!(
            urls,
            vec![
                "vless://uuid@example.com:443",
                "tt://?abc",
                "naive+https://u:p@example.com:443",
            ]
        );
    }

    #[test]
    fn handler_ownership_survives_executable_path_change() {
        let old = r#""C:\Program Files\Ninety\Ninety.exe" "%1""#;
        let current = r#""D:\Apps\Ninety\Ninety.exe" "%1""#;
        let other = r#""C:\Program Files\Other VPN\other.exe" "%1""#;
        assert!(handler_is_owned(Some(old), current, Some(old)));
        assert!(handler_is_owned(Some(current), current, Some(old)));
        assert!(!handler_is_owned(Some(other), current, Some(old)));
        assert!(!handler_is_owned(None, current, Some(old)));
        assert!(!handler_is_owned(Some(""), current, Some(old)));
        // Без маркера владения прежний путь чужой: снимать его нельзя.
        assert!(!handler_is_owned(Some(old), current, None));
    }
}
