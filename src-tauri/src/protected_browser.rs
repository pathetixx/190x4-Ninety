use serde::Serialize;

const OFFICIAL_DOWNLOAD_URL: &str = "https://mullvad.net/en/download/browser/windows";
// Для IPC и запуска оставляем консервативную границу, хотя ShellExecute из
// Explorer допускает более длинную командную строку.
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
/// адреса браузер запускается без параметров; произвольные browser-флаги из
/// frontend никогда не попадают в командную строку.
#[tauri::command]
pub fn protected_browser_launch(
    state: tauri::State<'_, crate::vpn::SingboxState>,
    url: Option<String>,
) -> Result<(), String> {
    if !crate::vpn::protected_browser_tun_ready(&state) {
        return Err("Mullvad Browser можно запустить только при активном VPN · TUN".into());
    }
    let target = url.map(|url| validate_launch_url(&url)).transpose()?;

    #[cfg(target_os = "windows")]
    {
        windows_impl::launch(target.as_deref())
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
    if normalized.len() > MAX_URL_LENGTH || normalized.chars().any(char::is_whitespace) {
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
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use windows::core::{Interface, BSTR, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Security::Cryptography::{
        CertGetNameStringW, CERT_CONTEXT, CERT_NAME_SIMPLE_DISPLAY_TYPE,
    };
    use windows::Win32::Security::WinTrust::{
        WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain,
        WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2,
        WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE,
        WTD_REVOCATION_CHECK_CHAIN, WTD_REVOKE_WHOLECHAIN, WTD_STATEACTION_CLOSE,
        WTD_STATEACTION_VERIFY, WTD_UICONTEXT_EXECUTE, WTD_UI_NONE,
    };
    use windows::Win32::Storage::FileSystem::{
        GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
    };
    use windows::Win32::System::Com::{
        CoAllowSetForegroundWindow, CoCreateInstance, CoInitializeEx, CoUninitialize, IDispatch,
        IServiceProvider, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Shell::{
        IShellBrowser, IShellDispatch2, IShellFolderViewDual, IShellWindows, SID_STopLevelBrowser,
        ShellExecuteW, ShellWindows, SVGIO_BACKGROUND, SWC_DESKTOP, SWFO_NEEDDISPATCH,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };
    use winreg::RegKey;

    const APP_PATH_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\App Paths\mullvadbrowser.exe";
    const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    const MAX_UNINSTALL_KEYS: usize = 1_024;
    const MAX_APPLICATION_INI_BYTES: u64 = 64 * 1024;

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

    pub(super) fn launch(target: Option<&str>) -> Result<(), String> {
        let browser =
            discover().ok_or("защищённый браузер не найден или не прошёл проверку подписи")?;
        // Re-canonicalize, reject reparse points and verify Authenticode again
        // immediately before spawning. Discovery is intentionally not treated as
        // a durable trust decision because a user-writable path can change after
        // status discovery.
        let verified = verified_executable_path(&browser.path)
            .ok_or("защищённый браузер не прошёл проверку подписи")?;
        // std::fs::canonicalize() на Windows обычно возвращает extended-length
        // путь (\\?\C:\...). Он подходит для проверки файла, но Windows Shell
        // и некоторые installers не принимают такую форму при запуске.
        let elevated = crate::elevation::is_elevated();
        let executable = if elevated {
            without_extended_prefix(&verified)
        } else {
            verified
        };
        let working_dir = executable
            .parent()
            .ok_or("не удалось определить папку Mullvad Browser")?
            .to_path_buf();

        if elevated {
            // TUN обычно запускает Ninety от администратора. Просим обычный
            // Explorer выполнить ShellExecute: это официальный Windows-путь
            // запуска без повышения и не требует SeImpersonatePrivilege.
            shell_execute_as_interactive_user(
                executable.into_os_string(),
                target.map(browser_url_shell_arguments),
                Some(working_dir.into_os_string()),
            )
        } else {
            let mut command = Command::new(&executable);
            if let Some(target) = target {
                command.args(["-osint", "-url", target]);
            }
            command
                .current_dir(&working_dir)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("не удалось запустить Mullvad Browser: {e}"))
        }
    }

    pub(super) fn open_official_download() -> Result<(), String> {
        if crate::elevation::is_elevated() {
            return shell_execute_as_interactive_user(
                OsString::from(OFFICIAL_DOWNLOAD_URL),
                None,
                None,
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
        if !metadata.is_file()
            || metadata.len() == 0
            // Проверяем и исходный путь, и canonical target: canonicalize
            // follows junctions, поэтому проверка только target уже не видит
            // reparse-компонент, через который к нему пришли.
            || has_reparse_point(path)
            || has_reparse_point(&canonical)
        {
            return None;
        }
        verify_authenticode(&canonical).then_some(canonical)
    }

    fn has_reparse_point(path: &Path) -> bool {
        let mut current = path.to_path_buf();
        loop {
            let wide = to_wide(current.as_os_str());
            let attributes = unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) };
            if attributes == INVALID_FILE_ATTRIBUTES
                || (attributes & FILE_ATTRIBUTE_REPARSE_POINT.0) != 0
            {
                return true;
            }
            let Some(parent) = current.parent() else {
                break;
            };
            if parent == current || parent.as_os_str().is_empty() {
                break;
            }
            current = parent.to_path_buf();
        }
        false
    }

    fn certificate_subject(cert: *const CERT_CONTEXT) -> Option<String> {
        if cert.is_null() {
            return None;
        }
        unsafe {
            let required =
                CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, None) as usize;
            if !(2..=4096).contains(&required) {
                return None;
            }
            let mut buffer = vec![0u16; required];
            let written = CertGetNameStringW(
                cert,
                CERT_NAME_SIMPLE_DISPLAY_TYPE,
                0,
                None,
                Some(&mut buffer),
            ) as usize;
            let end = written.saturating_sub(1).min(buffer.len());
            (end > 0).then(|| String::from_utf16_lossy(&buffer[..end]))
        }
    }

    fn verify_authenticode(path: &Path) -> bool {
        let wide = to_wide(path.as_os_str());
        let mut file_info = WINTRUST_FILE_INFO {
            cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: PCWSTR(wide.as_ptr()),
            ..Default::default()
        };
        let mut data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_WHOLECHAIN,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 {
                pFile: &mut file_info,
            },
            dwStateAction: WTD_STATEACTION_VERIFY,
            dwProvFlags: WTD_REVOCATION_CHECK_CHAIN,
            dwUIContext: WTD_UICONTEXT_EXECUTE,
            ..Default::default()
        };
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let verified = unsafe {
            let status = WinVerifyTrust(
                HWND::default(),
                &mut action,
                &mut data as *mut WINTRUST_DATA as *mut core::ffi::c_void,
            );
            let mut allowed = status == 0;
            if allowed {
                let provider = WTHelperProvDataFromStateData(data.hWVTStateData);
                let signer = if provider.is_null() {
                    std::ptr::null_mut()
                } else {
                    WTHelperGetProvSignerFromChain(provider, 0, false, 0)
                };
                if signer.is_null() || (*signer).dwError != 0 || (*signer).csCertChain == 0 {
                    allowed = false;
                } else {
                    let cert = WTHelperGetProvCertFromChain(signer, 0);
                    allowed = !cert.is_null()
                        && (*cert).dwError == 0
                        && certificate_subject((*cert).pCert)
                            .is_some_and(|subject| super::allowlisted_publisher(&subject));
                }
            }
            // WinVerifyTrust keeps provider state alive until CLOSE. Always
            // close it, including failed and unallowlisted signatures.
            data.dwStateAction = WTD_STATEACTION_CLOSE;
            let _ = WinVerifyTrust(
                HWND::default(),
                &mut action,
                &mut data as *mut WINTRUST_DATA as *mut core::ffi::c_void,
            );
            allowed
        };
        verified
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

    struct ComApartment;

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    fn shell_execute_as_interactive_user(
        file: OsString,
        arguments: Option<OsString>,
        working_dir: Option<OsString>,
    ) -> Result<(), String> {
        let thread = std::thread::Builder::new()
            .name("ninety-explorer-shell".into())
            .spawn(move || {
                shell_execute_from_explorer(
                    file.as_os_str(),
                    arguments.as_deref(),
                    working_dir.as_deref(),
                )
            })
            .map_err(|e| format!("не удалось создать поток запуска браузера: {e}"))?;

        match thread.join() {
            Ok(result) => result,
            Err(_) => Err("поток запуска браузера завершился аварийно".into()),
        }
    }

    fn shell_execute_from_explorer(
        file: &OsStr,
        arguments: Option<&OsStr>,
        working_dir: Option<&OsStr>,
    ) -> Result<(), String> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
                .ok()
                .map_err(|e| format!("не удалось инициализировать Windows COM: {e}"))?;
        }
        let _apartment = ComApartment;

        unsafe {
            let shell_windows: IShellWindows =
                CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)
                    .map_err(|e| format!("не удалось подключиться к Windows Explorer: {e}"))?;

            let empty = VARIANT::default();
            let mut desktop_hwnd = 0;
            let desktop = shell_windows
                .FindWindowSW(
                    &empty,
                    &empty,
                    SWC_DESKTOP,
                    &mut desktop_hwnd,
                    SWFO_NEEDDISPATCH,
                )
                .map_err(|e| format!("не удалось найти рабочий стол Windows Explorer: {e}"))?;
            let services: IServiceProvider = desktop
                .cast()
                .map_err(|e| format!("рабочий стол Windows не отдал системные службы: {e}"))?;
            let shell_browser: IShellBrowser = services
                .QueryService(&SID_STopLevelBrowser)
                .map_err(|e| format!("не удалось получить окно Windows Explorer: {e}"))?;
            let shell_view = shell_browser
                .QueryActiveShellView()
                .map_err(|e| format!("не удалось получить представление рабочего стола: {e}"))?;
            let background: IDispatch = shell_view
                .GetItemObject(SVGIO_BACKGROUND)
                .map_err(|e| format!("не удалось получить оболочку рабочего стола: {e}"))?;
            let folder_view: IShellFolderViewDual = background
                .cast()
                .map_err(|e| format!("рабочий стол не поддерживает Windows Automation: {e}"))?;
            let application = folder_view
                .Application()
                .map_err(|e| format!("не удалось получить приложение Windows Explorer: {e}"))?;
            let shell: IShellDispatch2 = application
                .cast()
                .map_err(|e| format!("Windows Explorer не поддерживает ShellExecute: {e}"))?;
            // Firefox/Mullvad делает тот же best-effort вызов перед запуском,
            // чтобы новое окно могло выйти на передний план.
            let _ = CoAllowSetForegroundWindow(&shell, None);

            let file = bstr_from_os(file);
            let arguments = variant_string(arguments);
            let working_dir = variant_string(working_dir);
            let operation = VARIANT::from("open");
            let show = VARIANT::from(SW_SHOWNORMAL.0);
            shell
                .ShellExecute(&file, &arguments, &working_dir, &operation, &show)
                .map_err(|e| format!("Windows Explorer не смог запустить браузер: {e}"))
        }
    }

    fn bstr_from_os(value: &OsStr) -> BSTR {
        BSTR::from_wide(&value.encode_wide().collect::<Vec<_>>())
    }

    fn variant_string(value: Option<&OsStr>) -> VARIANT {
        value
            .map(|value| VARIANT::from(bstr_from_os(value)))
            .unwrap_or_default()
    }

    fn browser_url_shell_arguments(target: &str) -> OsString {
        let mut arguments = OsString::from("-osint -url ");
        arguments.push(target);
        arguments
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
        fn strips_extended_prefix_for_shell_launch() {
            assert_eq!(
                without_extended_prefix(Path::new(r"\\?\C:\Mullvad\mullvadbrowser.exe")),
                PathBuf::from(r"C:\Mullvad\mullvadbrowser.exe")
            );
            assert_eq!(
                without_extended_prefix(Path::new(r"C:\Mullvad\mullvadbrowser.exe")),
                PathBuf::from(r"C:\Mullvad\mullvadbrowser.exe")
            );
        }

        #[test]
        fn builds_official_delegated_url_arguments() {
            assert_eq!(
                browser_url_shell_arguments("https://mullvad.net/en/check"),
                OsString::from("-osint -url https://mullvad.net/en/check")
            );
        }
    }
}

fn allowlisted_publisher(raw: &str) -> bool {
    let normalized: String = raw
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace())
        .flat_map(|ch| ch.to_lowercase())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    matches!(normalized.as_str(), "mullvad vpn ab")
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

    #[test]
    fn publisher_allowlist_is_exact() {
        assert!(allowlisted_publisher("Mullvad VPN AB"));
        assert!(allowlisted_publisher("Mullvad VPN AB."));
        assert!(!allowlisted_publisher("The Tor Project, Inc."));
        assert!(!allowlisted_publisher("Mullvad Browser"));
        assert!(!allowlisted_publisher("Fake Mullvad VPN AB"));
    }
}
