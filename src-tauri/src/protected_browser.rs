use serde::Serialize;

const OFFICIAL_DOWNLOAD_URL: &str = "https://mullvad.net/en/download/browser/windows";
const DEFAULT_START_PAGE: &str = "about:blank";
// CreateProcessWithTokenW (нужен для de-elevation из TUN-режима) ограничивает
// всю командную строку 1024 символами. Оставляем запас под путь к exe.
const MAX_URL_LENGTH: usize = 768;
const MAX_VERSION_LENGTH: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedBrowserStatus {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[tauri::command]
pub fn protected_browser_status() -> ProtectedBrowserStatus {
    #[cfg(target_os = "windows")]
    {
        if let Some(browser) = windows_impl::discover() {
            return ProtectedBrowserStatus {
                available: true,
                path: Some(windows_impl::display_path(&browser.path)),
                version: browser.version,
            };
        }
    }

    ProtectedBrowserStatus {
        available: false,
        path: None,
        version: None,
    }
}

/// Переданный адрес намеренно ограничен обычными web-схемами. При отсутствии
/// адреса открывается пустая вкладка; произвольные browser-флаги из frontend
/// никогда не попадают в командную строку.
#[tauri::command]
pub fn protected_browser_launch(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    url: Option<String>,
) -> Result<(), String> {
    if !crate::vpn::protected_browser_tun_ready(&state) {
        return Err("Mullvad Browser можно запустить только при активном VPN · TUN".into());
    }
    let target = match url {
        Some(url) => validate_launch_url(&url)?,
        None => DEFAULT_START_PAGE.to_string(),
    };

    #[cfg(target_os = "windows")]
    {
        windows_impl::launch(&target)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("защищённый браузер поддерживается только в Windows".into())
    }
}

/// Только открывает официальную страницу Mullvad в браузере по умолчанию.
/// Загрузка и установка без явного действия пользователя не выполняются.
#[tauri::command]
pub fn protected_browser_open_download(
    state: tauri::State<'_, crate::vpn::SingboxState>,
) -> Result<(), String> {
    if !crate::vpn::protected_browser_tun_ready(&state) {
        return Err("страницу загрузки можно открыть только при активном VPN · TUN".into());
    }
    #[cfg(target_os = "windows")]
    {
        windows_impl::open_official_download()
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("защищённый браузер поддерживается только в Windows".into())
    }
}

fn validate_launch_url(raw: &str) -> Result<String, String> {
    if raw.is_empty() || raw.len() > MAX_URL_LENGTH || raw.trim() != raw {
        return Err("адрес должен быть непустым URL без пробелов по краям".into());
    }
    if raw.chars().any(|ch| ch.is_control() || ch == '"') {
        return Err("адрес содержит недопустимые символы".into());
    }

    let parsed = reqwest::Url::parse(raw).map_err(|_| "нужен полный адрес http:// или https://")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("разрешены только полные адреса http:// и https://".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("адрес со встроенными логином или паролем запрещён".into());
    }

    let normalized = parsed.to_string();
    if normalized.len() > MAX_URL_LENGTH {
        return Err("адрес слишком длинный".into());
    }
    Ok(normalized)
}

fn sanitize_version(raw: &str) -> Option<String> {
    let version = raw.trim();
    if version.is_empty()
        || version.len() > MAX_VERSION_LENGTH
        || !version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '+' | '_'))
    {
        return None;
    }
    Some(version.to_string())
}

fn parse_application_ini_version(contents: &str) -> Option<String> {
    let mut in_app_section = false;
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_app_section = line.eq_ignore_ascii_case("[App]");
            continue;
        }
        if !in_app_section || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("Version") {
            return sanitize_version(value);
        }
    }
    None
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{parse_application_ini_version, sanitize_version, OFFICIAL_DOWNLOAD_URL};
    use std::collections::HashSet;
    use std::ffi::{OsStr, OsString};
    use std::fs::File;
    use std::io::Read;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
        TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{
        CreateProcessWithTokenW, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
        CREATE_PROCESS_LOGON_FLAGS, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, STARTUPINFOW,
    };
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetShellWindow, GetWindowThreadProcessId, SW_SHOWNORMAL,
    };
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };
    use winreg::RegKey;

    const APP_PATH_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\App Paths\mullvadbrowser.exe";
    const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    const MAX_UNINSTALL_KEYS: usize = 1_024;
    const MAX_APPLICATION_INI_BYTES: u64 = 64 * 1024;
    const MAX_TOKEN_COMMAND_LINE_UNITS: usize = 1_024;

    #[derive(Debug, Clone)]
    pub(super) struct InstalledBrowser {
        pub path: PathBuf,
        pub version: Option<String>,
    }

    #[derive(Debug, Clone)]
    struct BrowserCandidate {
        path: PathBuf,
        version: Option<String>,
    }

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    pub(super) fn discover() -> Option<InstalledBrowser> {
        let mut candidates = registry_candidates();
        candidates.extend(common_location_candidates());

        let mut seen = HashSet::new();
        for candidate in candidates {
            let Some(path) = verified_executable_path(&candidate.path) else {
                continue;
            };
            let path_key = path.to_string_lossy().to_ascii_lowercase();
            if !seen.insert(path_key) {
                continue;
            }
            let version = candidate.version.or_else(|| application_ini_version(&path));
            return Some(InstalledBrowser { path, version });
        }
        None
    }

    pub(super) fn display_path(path: &Path) -> String {
        let path = path.to_string_lossy();
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        path.strip_prefix(r"\\?\")
            .unwrap_or(path.as_ref())
            .to_string()
    }

    pub(super) fn launch(target: &str) -> Result<(), String> {
        let browser = discover().ok_or("Mullvad Browser не найден")?;
        // std::fs::canonicalize() на Windows обычно возвращает extended-length
        // путь (\\?\C:\...). Он подходит для проверки файла, но некоторые
        // CreateProcessWithTokenW/installer-комбинации не принимают такой путь
        // как application name или current directory.
        let elevated = crate::elevation::is_elevated();
        let executable = if elevated {
            without_extended_prefix(&browser.path)
        } else {
            browser.path.clone()
        };
        let working_dir = executable
            .parent()
            .ok_or("не удалось определить папку Mullvad Browser")?;

        if elevated {
            // TUN обычно запускает Ninety от администратора. Браузеру этот
            // токен передавать нельзя: берём medium-integrity token Explorer.
            spawn_as_interactive_user(&executable, &[target], working_dir)
        } else {
            Command::new(&executable)
                .arg(target)
                .current_dir(working_dir)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("не удалось запустить Mullvad Browser: {e}"))
        }
    }

    pub(super) fn open_official_download() -> Result<(), String> {
        if crate::elevation::is_elevated() {
            let (token, shell_executable) = interactive_shell_token()?;
            let is_explorer = shell_executable
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("explorer.exe"));
            if !is_explorer {
                return Err(
                    "не удалось безопасно открыть страницу: интерактивная оболочка Windows не найдена"
                        .into(),
                );
            }
            let working_dir = shell_executable
                .parent()
                .ok_or("не удалось определить папку оболочки Windows")?;
            return spawn_with_token(
                token.0,
                &shell_executable,
                &[OFFICIAL_DOWNLOAD_URL],
                working_dir,
            );
        }

        let verb = to_wide(OsStr::new("open"));
        let url = to_wide(OsStr::new(OFFICIAL_DOWNLOAD_URL));
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(url.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!(
                "Windows не смогла открыть официальную страницу Mullvad (код {})",
                result.0 as isize
            ))
        }
    }

    fn registry_candidates() -> Vec<BrowserCandidate> {
        let mut candidates = Vec::new();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        collect_uninstall(&hkcu, KEY_READ, &mut candidates);
        collect_app_path(&hkcu, KEY_READ, &mut candidates);

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            collect_uninstall(&hklm, KEY_READ | view, &mut candidates);
            collect_app_path(&hklm, KEY_READ | view, &mut candidates);
        }
        candidates
    }

    fn collect_app_path(root: &RegKey, flags: u32, candidates: &mut Vec<BrowserCandidate>) {
        let Ok(key) = root.open_subkey_with_flags(APP_PATH_KEY, flags) else {
            return;
        };
        let Ok(raw_path) = key.get_value::<String, _>("") else {
            return;
        };
        if let Some(path) = registry_path(&raw_path) {
            candidates.push(BrowserCandidate {
                path,
                version: None,
            });
        }
    }

    fn collect_uninstall(root: &RegKey, flags: u32, candidates: &mut Vec<BrowserCandidate>) {
        let Ok(uninstall) = root.open_subkey_with_flags(UNINSTALL_KEY, flags) else {
            return;
        };

        for name in uninstall
            .enum_keys()
            .take(MAX_UNINSTALL_KEYS)
            .filter_map(Result::ok)
        {
            let Ok(key) = uninstall.open_subkey_with_flags(name, KEY_READ) else {
                continue;
            };
            let Ok(display_name) = key.get_value::<String, _>("DisplayName") else {
                continue;
            };
            if !is_mullvad_browser_name(&display_name) {
                continue;
            }

            let version = key
                .get_value::<String, _>("DisplayVersion")
                .ok()
                .and_then(|value| sanitize_version(&value));
            if let Ok(location) = key.get_value::<String, _>("InstallLocation") {
                if let Some(base) = registry_path(&location) {
                    for relative in [
                        "mullvadbrowser.exe",
                        r"Browser\mullvadbrowser.exe",
                        r"Release\mullvadbrowser.exe",
                    ] {
                        candidates.push(BrowserCandidate {
                            path: base.join(relative),
                            version: version.clone(),
                        });
                    }
                }
            }
            if let Ok(display_icon) = key.get_value::<String, _>("DisplayIcon") {
                if let Some(path) = display_icon_path(&display_icon) {
                    candidates.push(BrowserCandidate {
                        path,
                        version: version.clone(),
                    });
                }
            }
        }
    }

    fn common_location_candidates() -> Vec<BrowserCandidate> {
        let mut paths = Vec::new();
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local_app_data);
            paths.push(base.join(r"Mullvad\MullvadBrowser\Release\mullvadbrowser.exe"));
            paths.push(base.join(r"Mullvad Browser\Browser\mullvadbrowser.exe"));
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            paths.push(
                PathBuf::from(profile).join(r"Desktop\Mullvad Browser\Browser\mullvadbrowser.exe"),
            );
        }
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(program_files) = std::env::var_os(variable) {
                let base = PathBuf::from(program_files);
                paths.push(base.join(r"Mullvad Browser\Browser\mullvadbrowser.exe"));
                paths.push(base.join(r"Mullvad\MullvadBrowser\Release\mullvadbrowser.exe"));
            }
        }

        paths
            .into_iter()
            .map(|path| BrowserCandidate {
                path,
                version: None,
            })
            .collect()
    }

    fn verified_executable_path(path: &Path) -> Option<PathBuf> {
        if !is_local_absolute_path(path)
            || !path
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("mullvadbrowser.exe"))
        {
            return None;
        }
        let canonical = std::fs::canonicalize(path).ok()?;
        if !is_local_absolute_path(&canonical)
            || !canonical
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("mullvadbrowser.exe"))
        {
            return None;
        }
        let metadata = canonical.metadata().ok()?;
        (metadata.is_file() && metadata.len() > 0).then_some(canonical)
    }

    fn without_extended_prefix(path: &Path) -> PathBuf {
        let value = path.to_string_lossy();
        if let Some(local) = value.strip_prefix(r"\\?\") {
            let bytes = local.as_bytes();
            if bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/')
            {
                return PathBuf::from(local);
            }
        }
        path.to_path_buf()
    }

    fn is_local_absolute_path(path: &Path) -> bool {
        if !path.is_absolute() {
            return false;
        }
        let value = path.as_os_str().to_string_lossy();
        let is_drive_path = |candidate: &str| {
            let bytes = candidate.as_bytes();
            bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/')
        };
        if let Some(extended) = value.strip_prefix(r"\\?\") {
            // canonicalize обычно даёт \\?\C:\..., но namespace также умеет
            // GLOBALROOT/Device/Mup. Разрешаем только локальную drive-letter
            // форму, чтобы registry не подсунул device/сетевой executable.
            return is_drive_path(extended);
        }
        is_drive_path(&value)
    }

    fn registry_path(raw: &str) -> Option<PathBuf> {
        let value = raw.trim();
        if value.is_empty() || value.chars().any(char::is_control) {
            return None;
        }
        let value = if let Some(quoted) = value.strip_prefix('"') {
            quoted.split_once('"')?.0
        } else {
            value
        };
        (!value.is_empty()).then(|| PathBuf::from(value))
    }

    fn display_icon_path(raw: &str) -> Option<PathBuf> {
        let value = raw.trim();
        let path = if let Some(quoted) = value.strip_prefix('"') {
            quoted.split_once('"')?.0
        } else {
            value
                .rsplit_once(',')
                .filter(|(_, suffix)| suffix.trim().parse::<i32>().is_ok())
                .map_or(value, |(path, _)| path.trim())
        };
        registry_path(path)
    }

    fn is_mullvad_browser_name(raw: &str) -> bool {
        let name = raw.trim();
        if name.eq_ignore_ascii_case("Mullvad Browser") {
            return true;
        }
        // Alpha устанавливается рядом со stable, но сама Mullvad предупреждает
        // о более слабых гарантиях. Для privacy-функции автоматически выбираем
        // только stable-запись (некоторые installers добавляют версию в имя).
        let prefix = "Mullvad Browser ";
        name.get(..prefix.len())
            .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
            && name[prefix.len()..]
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_digit())
    }

    fn application_ini_version(executable: &Path) -> Option<String> {
        let ini_path = executable.parent()?.join("application.ini");
        let mut file = File::open(ini_path).ok()?;
        let mut contents = Vec::new();
        file.by_ref()
            .take(MAX_APPLICATION_INI_BYTES + 1)
            .read_to_end(&mut contents)
            .ok()?;
        if contents.len() as u64 > MAX_APPLICATION_INI_BYTES {
            return None;
        }
        parse_application_ini_version(std::str::from_utf8(&contents).ok()?)
    }

    fn spawn_as_interactive_user(
        executable: &Path,
        arguments: &[&str],
        working_dir: &Path,
    ) -> Result<(), String> {
        let (token, _) = interactive_shell_token()?;
        spawn_with_token(token.0, executable, arguments, working_dir)
    }

    fn interactive_shell_token() -> Result<(OwnedHandle, PathBuf), String> {
        unsafe {
            let shell_window = GetShellWindow();
            if shell_window.0.is_null() {
                return Err("интерактивная оболочка Windows не найдена".into());
            }

            let mut process_id = 0;
            GetWindowThreadProcessId(shell_window, Some(&mut process_id));
            if process_id == 0 {
                return Err("не удалось определить процесс оболочки Windows".into());
            }

            let process = OwnedHandle(
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
                    .map_err(|e| format!("не удалось открыть процесс оболочки Windows: {e}"))?,
            );
            let shell_executable = process_image_path(process.0)?;

            let mut token = HANDLE::default();
            OpenProcessToken(
                process.0,
                TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY,
                &mut token,
            )
            .map_err(|e| format!("не удалось получить обычный пользовательский токен: {e}"))?;
            let token = OwnedHandle(token);
            if token_is_elevated(token.0)? {
                return Err(
                    "оболочка Windows тоже запущена от администратора; безопасный запуск браузера отменён"
                        .into(),
                );
            }
            Ok((token, shell_executable))
        }
    }

    fn token_is_elevated(token: HANDLE) -> Result<bool, String> {
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned_length = 0;
        unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned_length,
            )
            .map_err(|e| format!("не удалось проверить права пользовательского токена: {e}"))?;
        }
        Ok(elevation.TokenIsElevated != 0)
    }

    fn process_image_path(process: HANDLE) -> Result<PathBuf, String> {
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
            .map_err(|e| format!("не удалось определить путь оболочки Windows: {e}"))?;
        }
        if length == 0 || length as usize > buffer.len() {
            return Err("Windows вернула некорректный путь оболочки".into());
        }
        Ok(PathBuf::from(OsString::from_wide(
            &buffer[..length as usize],
        )))
    }

    fn spawn_with_token(
        token: HANDLE,
        executable: &Path,
        arguments: &[&str],
        working_dir: &Path,
    ) -> Result<(), String> {
        let executable_wide = to_wide(executable.as_os_str());
        let working_dir_wide = to_wide(working_dir.as_os_str());
        let command_line = windows_command_line(executable.as_os_str(), arguments);
        let mut command_line_wide = to_wide(OsStr::new(&command_line));
        if command_line_wide.len() > MAX_TOKEN_COMMAND_LINE_UNITS {
            return Err("адрес и путь к браузеру образуют слишком длинную командную строку".into());
        }
        let startup_info = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut process_info = PROCESS_INFORMATION::default();

        unsafe {
            CreateProcessWithTokenW(
                token,
                // Mullvad Browser должен получить обычный профиль и контекст
                // реестра интерактивного пользователя. Без флага запуск из
                // elevated Ninety может отличаться от ручного запуска.
                // Win32 LOGON_WITH_PROFILE = 0x00000001; windows-rs 0.62 не
                // экспонирует этот флаг как associated constant.
                CREATE_PROCESS_LOGON_FLAGS(0x0000_0001),
                PCWSTR(executable_wide.as_ptr()),
                Some(PWSTR(command_line_wide.as_mut_ptr())),
                PROCESS_CREATION_FLAGS(0),
                None,
                PCWSTR(working_dir_wide.as_ptr()),
                &startup_info,
                &mut process_info,
            )
            .map_err(|e| format!("не удалось запустить процесс без прав администратора: {e}"))?;

            let process = OwnedHandle(process_info.hProcess);
            let thread = OwnedHandle(process_info.hThread);
            drop((process, thread));
        }
        Ok(())
    }

    fn windows_command_line(executable: &OsStr, arguments: &[&str]) -> OsString {
        let mut command = OsString::from("\"");
        command.push(executable);
        command.push("\"");
        for argument in arguments {
            command.push(" \"");
            command.push(argument);
            command.push("\"");
        }
        command
    }

    fn to_wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    #[cfg(test)]
    mod windows_tests {
        use super::*;

        #[test]
        fn recognizes_expected_uninstall_names() {
            assert!(is_mullvad_browser_name("Mullvad Browser"));
            assert!(is_mullvad_browser_name("Mullvad Browser 15.0.18"));
            assert!(!is_mullvad_browser_name("Mullvad Browser Alpha"));
            assert!(!is_mullvad_browser_name("Mullvad VPN"));
            assert!(!is_mullvad_browser_name("Fake Mullvad Browser"));
        }

        #[test]
        fn parses_display_icon_without_accepting_arbitrary_suffix() {
            assert_eq!(
                display_icon_path(r#""C:\Mullvad\mullvadbrowser.exe",0"#),
                Some(PathBuf::from(r"C:\Mullvad\mullvadbrowser.exe"))
            );
            assert_eq!(
                display_icon_path(r"C:\Mullvad\mullvadbrowser.exe,-1"),
                Some(PathBuf::from(r"C:\Mullvad\mullvadbrowser.exe"))
            );
        }

        #[test]
        fn rejects_relative_and_unc_executable_paths() {
            assert!(!is_local_absolute_path(Path::new("mullvadbrowser.exe")));
            assert!(!is_local_absolute_path(Path::new(
                r"\\server\share\mullvadbrowser.exe"
            )));
            assert!(!is_local_absolute_path(Path::new(
                r"\\?\UNC\server\share\mullvadbrowser.exe"
            )));
            assert!(!is_local_absolute_path(Path::new(
                r"\\?\GLOBALROOT\Device\Mup\server\share\mullvadbrowser.exe"
            )));
            assert!(is_local_absolute_path(Path::new(
                r"C:\Mullvad\mullvadbrowser.exe"
            )));
            assert!(is_local_absolute_path(Path::new(
                r"\\?\C:\Mullvad\mullvadbrowser.exe"
            )));
        }

        #[test]
        fn strips_extended_prefix_for_process_creation() {
            assert_eq!(
                without_extended_prefix(Path::new(r"\\?\C:\Mullvad\mullvadbrowser.exe")),
                PathBuf::from(r"C:\Mullvad\mullvadbrowser.exe")
            );
            assert_eq!(
                without_extended_prefix(Path::new(r"C:\Mullvad\mullvadbrowser.exe")),
                PathBuf::from(r"C:\Mullvad\mullvadbrowser.exe")
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_absolute_http_urls() {
        assert_eq!(
            validate_launch_url("https://example.com/path?q=1").unwrap(),
            "https://example.com/path?q=1"
        );
        assert!(validate_launch_url("http://127.0.0.1:8080/").is_ok());
        for invalid in [
            "example.com",
            "about:blank",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "ftp://example.com/file",
            " https://example.com",
            "https://user:secret@example.com",
        ] {
            assert!(validate_launch_url(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn reads_only_version_from_app_section() {
        let ini = r#"
            Version=wrong
            [App]
            Name=Mullvad Browser
            Version=15.0.18
            [Gecko]
            Version=also-wrong
        "#;
        assert_eq!(
            parse_application_ini_version(ini).as_deref(),
            Some("15.0.18")
        );
        assert_eq!(
            parse_application_ini_version("[App]\nVersion=bad value"),
            None
        );
    }
}
