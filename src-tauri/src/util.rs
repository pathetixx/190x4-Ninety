// Ninety · small shared backend utilities.

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Taking a std mutex with recovery from poisoning.
///
/// `Mutex::lock().unwrap()` panics if a thread panicked while holding this lock
/// (poisoning). Behind such locks we keep the engine process handles
/// (sing-box/xray/winws), death flags and the WFP handle: one panic under a lock
/// would poison the mutex, and EVERY subsequent command with this `State` would also
/// panic on `.unwrap()` — the app would "get stuck" for no clear reason
/// (the core can't be stopped, the kill switch can't be removed). The data under our locks stays
/// consistent (short critical sections without invariant-breaking panics), so
/// continuing with a recovered guard is safer than bringing everything down.
pub trait MutexExt<T> {
    /// Like `lock().unwrap()`, but on poisoning returns the guard instead of panicking.
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// An error the interface will show: an i18n catalog key instead of ready text,
/// because only the frontend knows the interface language. The token is parsed by
/// `backend-errors.js`; in the log it stays readable.
pub fn i18n_error(key: &str) -> String {
    format!("[[{key}]]")
}

pub fn i18n_error_with(key: &str, vars: &[(&str, &str)]) -> String {
    let vars: serde_json::Map<String, serde_json::Value> = vars
        .iter()
        .map(|(name, value)| ((*name).to_string(), (*value).into()))
        .collect();
    format!("[[{key} {}]]", serde_json::Value::Object(vars))
}

/// Absolute path to the Windows system directory (`...\System32`).
///
/// `%SystemRoot%` is a process environment variable, and it can also be written by
/// `HKCU\Environment`, i.e. a regular user without administrator rights.
/// This is where the paths to `schtasks.exe`, `sc.exe`, `taskkill.exe` and
/// `powershell.exe` come from, which are launched via `runas`: a swapped variable
/// would turn the user's UAC confirmation into launching a foreign binary as
/// administrator. `GetSystemDirectoryW` doesn't read the environment.
#[cfg(target_os = "windows")]
pub fn system_directory() -> std::path::PathBuf {
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    let mut buffer = [0u16; 260];
    let len = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if len == 0 || len > buffer.len() {
        return std::path::PathBuf::from(r"C:\Windows\System32");
    }
    std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..len]))
}

// Outside Windows there are no system utilities at this path: the function is only needed
// so that shared code building such paths compiles.
#[cfg(not(target_os = "windows"))]
pub fn system_directory() -> std::path::PathBuf {
    std::path::PathBuf::from("/usr/bin")
}

/// Absolute path to the Windows directory (`C:\Windows`), the parent of `System32`.
///
/// The same argument as for [`system_directory`]: `explorer.exe` lives here, not
/// in `System32`, and it must not be launched via `%SystemRoot%` — the variable is written by
/// `HKCU\Environment`. `GetWindowsDirectoryW` doesn't read the environment.
#[cfg(target_os = "windows")]
pub fn windows_directory() -> std::path::PathBuf {
    use windows::Win32::System::SystemInformation::GetWindowsDirectoryW;
    let mut buffer = [0u16; 260];
    let len = unsafe { GetWindowsDirectoryW(Some(&mut buffer)) } as usize;
    if len == 0 || len > buffer.len() {
        return std::path::PathBuf::from(r"C:\Windows");
    }
    std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..len]))
}

/// The system `hosts` file (`...\System32\drivers\etc\hosts`).
///
/// Built from [`system_directory`], not from `%SystemRoot%`: the path is used to
/// rewrite the file from an elevated process, and a swapped variable would turn
/// that into writing an arbitrary file chosen by a regular user.
#[cfg(target_os = "windows")]
pub fn system_hosts_path() -> std::path::PathBuf {
    system_directory().join("drivers").join("etc").join("hosts")
}

/// Program Files roots that already require administrator rights to write to.
///
/// Taken from `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion` — only
/// an administrator writes there. Environment variables of the same name (`%ProgramFiles%` and
/// neighbors) are no good for this: they are overridden by `HKCU\Environment`, i.e.
/// a regular user, and these paths decide whether the autostart task gets
/// the `highest` level (running as administrator without UAC on every
/// login). An empty result is safe: it means "not a system directory".
#[cfg(target_os = "windows")]
pub fn program_files_roots() -> Vec<std::path::PathBuf> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let Ok(current_version) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion",
        KEY_READ | KEY_WOW64_64KEY,
    ) else {
        return Vec::new();
    };
    [
        "ProgramFilesDir",
        "ProgramFilesDir (x86)",
        "ProgramW6432Dir",
    ]
    .into_iter()
    .filter_map(|name| current_version.get_value::<String, _>(name).ok())
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .map(std::path::PathBuf::from)
    .collect()
}

/// Truncates a log file through a separate handle with data write rights.
///
/// Engine logs are opened in append mode. On Windows std opens such a handle
/// without `FILE_WRITE_DATA`, and truncating the file needs exactly that: `set_len(0)` on
/// an append handle is denied access, and the 8 MB cap silently didn't work —
/// the log grew for the whole session. After truncation the append handle keeps writing at
/// the current end of the file, i.e. from zero.
pub(crate) fn truncate_log_file(path: &std::path::Path) -> bool {
    std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .is_ok()
}

/// An HTTP client that never reads the Windows system proxy.
///
/// reqwest has default features disabled in Cargo.toml, but Cargo unifies features
/// across the whole dependency graph: tauri and updater enable reading the system proxy,
/// and then any `Client::builder()` without `.proxy()`/`.no_proxy()` takes
/// `ProxyServer` from the registry. The `127.*` and `<local>` exclusions from `ProxyOverride`
/// don't apply to IP addresses, so even a request to the clash API on
/// 127.0.0.1 went to the proxy — someone else's, a dead one or our own. "Direct"
/// measurements in system proxy mode also went through the tunnel.
///
/// An explicit `.proxy()` on top of this builder works as usual: it adds
/// the proxy to an already empty list. All backend clients are built only from here —
/// tests/rust-http-clients.test.mjs checks this.
pub(crate) fn direct_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().no_proxy()
}

/// Body length increment with overflow and limit checks.
///
/// `pub(crate)` because the same guard must be used by those who need
/// their own error text and for whom `read_response_capped` as a whole
/// doesn't fit (subscription.rs). Custom arithmetic at the call site is
/// exactly the `current + incoming` without `checked_add` that is closed off here.
pub(crate) fn checked_body_len(
    current: usize,
    incoming: usize,
    max_bytes: usize,
) -> Result<usize, String> {
    let next = current
        .checked_add(incoming)
        .ok_or_else(|| "HTTP response size overflow".to_string())?;
    if next > max_bytes {
        return Err(format!("HTTP response exceeds {max_bytes} bytes"));
    }
    Ok(next)
}

/// Reads the HTTP body as a stream with a real limit, without trusting Content-Length.
pub async fn read_response_capped(
    mut response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if let Some(len) = response.content_length() {
        if len > max_bytes as u64 {
            return Err(format!("{label}: response exceeds {max_bytes} bytes"));
        }
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("{label}: body read: {e}"))?
    {
        checked_body_len(body.len(), chunk.len(), max_bytes)
            .map_err(|e| format!("{label}: {e}"))?;
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub async fn read_response_text_capped(
    response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<String, String> {
    let body = read_response_capped(response, max_bytes, label).await?;
    String::from_utf8(body).map_err(|e| format!("{label}: invalid UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_size_guard_rejects_overflow_and_limit_excess() {
        assert_eq!(checked_body_len(10, 5, 20).unwrap(), 15);
        assert!(checked_body_len(10, 11, 20).is_err());
        assert!(checked_body_len(usize::MAX, 1, usize::MAX).is_err());
    }

    fn scratch_log(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ninety-log-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("engine.log")
    }

    fn open_append(path: &std::path::Path) -> std::fs::File {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap()
    }

    // The reason the log cap didn't work: an append handle on Windows can't
    // truncate a file. If std ever changes this, the test will tell.
    #[cfg(target_os = "windows")]
    #[test]
    fn an_append_handle_cannot_truncate_on_windows() {
        let path = scratch_log("append-set-len");
        std::fs::write(&path, b"old line\n").unwrap();
        let appender = open_append(&path);
        assert!(appender.set_len(0).is_err());
        drop(appender);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_log_truncated_under_an_open_append_handle_restarts_from_zero() {
        use std::io::Write;
        let path = scratch_log("truncate");
        std::fs::write(&path, b"old line\n").unwrap();
        let mut appender = open_append(&path);
        assert!(truncate_log_file(&path));
        appender.write_all(b"new\n").unwrap();
        drop(appender);
        assert_eq!(std::fs::read(&path).unwrap(), b"new\n");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
