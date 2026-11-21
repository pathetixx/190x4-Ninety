// Ninety · targeted cleanup of Discord's Chromium cache.
//
// Replicates the safe part of Flowseal service.bat: closes regular Discord and
// Discord PTB, then deletes only Cache / Code Cache / GPUCache in Roaming
// AppData. Cookies, Local Storage, settings and auth data are not touched.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CACHE_DIRS: [&str; 3] = ["Cache", "Code Cache", "GPUCache"];

fn cache_targets(roaming: &Path) -> Vec<(&'static str, &'static str, PathBuf)> {
    vec![
        ("Discord", "Discord.exe", roaming.join("discord")),
        ("Discord PTB", "DiscordPTB.exe", roaming.join("discordptb")),
    ]
}

#[cfg(target_os = "windows")]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn validate_client_root(roaming: &Path, client_root: &Path) -> Result<bool, String> {
    let metadata = match std::fs::symlink_metadata(client_root) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(crate::util::i18n_error_with(
                "backend.discord.dirUnavailable",
                &[("error", &e.to_string())],
            ))
        }
    };
    if is_link_or_reparse(&metadata) || !metadata.file_type().is_dir() {
        return Err(format!(
            "refusing a link instead of the Discord directory: {}",
            client_root.display()
        ));
    }
    let roaming_real =
        std::fs::canonicalize(roaming).map_err(|e| format!("Roaming AppData: {e}"))?;
    let client_real = std::fs::canonicalize(client_root).map_err(|e| {
        crate::util::i18n_error_with(
            "backend.discord.dirUnavailable",
            &[("error", &e.to_string())],
        )
    })?;
    if !client_real.starts_with(&roaming_real) || client_real == roaming_real {
        return Err(format!(
            "refusing an unsafe Discord directory: {}",
            client_root.display()
        ));
    }
    Ok(true)
}

fn remove_cache_dir(roaming: &Path, client_root: &Path, name: &str) -> Result<bool, String> {
    let target = client_root.join(name);
    if !target.exists() {
        return Ok(false);
    }
    let roaming_real =
        std::fs::canonicalize(roaming).map_err(|e| format!("Roaming AppData: {e}"))?;
    let client_real = std::fs::canonicalize(client_root).map_err(|e| {
        crate::util::i18n_error_with(
            "backend.discord.dirUnavailable",
            &[("error", &e.to_string())],
        )
    })?;
    let target_real = std::fs::canonicalize(&target)
        .map_err(|e| format!("cache '{name}' is unavailable: {e}"))?;
    if !client_real.starts_with(&roaming_real)
        || client_real == roaming_real
        || !target_real.starts_with(&client_real)
        || target_real == client_real
    {
        return Err(format!(
            "refusing an unsafe cache path: {}",
            target.display()
        ));
    }
    let link_meta =
        std::fs::symlink_metadata(&target).map_err(|e| format!("cache metadata: {e}"))?;
    if is_link_or_reparse(&link_meta) || !target_real.is_dir() {
        return Err(format!(
            "refusing a link instead of a directory: {}",
            target.display()
        ));
    }
    std::fs::remove_dir_all(&target).map_err(|e| {
        crate::util::i18n_error_with(
            "backend.discord.deleteFailed",
            &[
                ("path", &target.display().to_string()),
                ("error", &e.to_string()),
            ],
        )
    })?;
    if target.exists() {
        return Err(format!(
            "cache directory remained after removal: {}",
            target.display()
        ));
    }
    Ok(true)
}

// Absolute path to a system binary. The directory comes from GetSystemDirectoryW, not
// from %SystemRoot%: that environment variable is written by HKCU\Environment, i.e. a regular
// user, while taskkill/tasklist are launched from here in an elevated process.
#[cfg(target_os = "windows")]
fn system32(exe: &str) -> PathBuf {
    crate::util::system_directory().join(exe)
}

#[cfg(target_os = "windows")]
fn close_process(image: &str) -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut child = std::process::Command::new(system32("taskkill.exe"))
        .args(["/F", "/IM", image])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("taskkill {image}: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                timed_out = true;
                break;
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("taskkill {image}: {e}"));
            }
        }
    }
    let status = child
        .wait()
        .map_err(|e| format!("waiting for taskkill {image}: {e}"))?;
    if timed_out {
        Err(crate::util::i18n_error_with(
            "backend.discord.closeTimeout",
            &[("app", image)],
        ))
    } else {
        Ok(status.success())
    }
}

#[cfg(target_os = "windows")]
fn clear_windows(app: AppHandle) -> Result<serde_json::Value, String> {
    let roaming = app
        .path()
        .data_dir()
        .map_err(|e| format!("Roaming AppData: {e}"))?;
    let mut clients_found = 0usize;
    let mut processes_closed = 0usize;
    let mut dirs_removed = 0usize;
    let mut dirs_missing = 0usize;

    for (_label, image, root) in cache_targets(&roaming) {
        // Check root BEFORE taskkill: a swapped symlink/junction must neither
        // delete someone else's cache inside Roaming nor close Discord for no reason.
        if !validate_client_root(&roaming, &root)? {
            continue;
        }
        clients_found += 1;
        if close_process(image)? {
            processes_closed += 1;
        }
        for name in CACHE_DIRS {
            if remove_cache_dir(&roaming, &root, name)? {
                dirs_removed += 1;
            } else {
                dirs_missing += 1;
            }
        }
    }

    Ok(serde_json::json!({
        "clients_found": clients_found,
        "processes_closed": processes_closed,
        "dirs_removed": dirs_removed,
        "dirs_missing": dirs_missing,
    }))
}

/// Close Discord/Discord PTB and delete only three fixed cache directories.
/// Paths from the frontend are not accepted. Blocking taskkill/FS operations are moved
/// off the webview thread.
#[tauri::command]
pub async fn discord_cache_clear(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Discord cache cleanup is Windows-only".into())
    }

    #[cfg(target_os = "windows")]
    {
        match tauri::async_runtime::spawn_blocking(move || clear_windows(app)).await {
            Ok(inner) => inner,
            Err(e) => Err(format!("Discord cache cleanup was interrupted: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "ninety-discord-cache-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn targets_are_fixed_to_stable_and_ptb() {
        let root = Path::new("Roaming");
        let targets = cache_targets(root);
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].1, "Discord.exe");
        assert_eq!(targets[0].2, root.join("discord"));
        assert_eq!(targets[1].1, "DiscordPTB.exe");
        assert_eq!(targets[1].2, root.join("discordptb"));
    }

    #[test]
    fn removes_only_three_cache_directories() {
        let roaming = fixture_root();
        let client = roaming.join("discord");
        for name in CACHE_DIRS {
            let dir = client.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("entry"), b"cache").unwrap();
        }
        let local_storage = client.join("Local Storage");
        std::fs::create_dir_all(&local_storage).unwrap();
        std::fs::write(local_storage.join("keep"), b"account").unwrap();
        assert!(validate_client_root(&roaming, &client).unwrap());

        for name in CACHE_DIRS {
            assert!(remove_cache_dir(&roaming, &client, name).unwrap());
            assert!(!client.join(name).exists());
        }
        assert!(local_storage.join("keep").is_file());
        assert!(!remove_cache_dir(&roaming, &client, "Cache").unwrap());

        std::fs::remove_dir_all(&roaming).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_client_root_inside_roaming() {
        use std::os::unix::fs::symlink;

        let roaming = fixture_root();
        let other = roaming.join("other-client");
        std::fs::create_dir_all(other.join("Cache")).unwrap();
        let client = roaming.join("discord");
        symlink(&other, &client).unwrap();

        assert!(validate_client_root(&roaming, &client).is_err());
        assert!(other.join("Cache").is_dir());

        std::fs::remove_dir_all(&roaming).unwrap();
    }
}
