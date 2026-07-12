//! Crash-safe same-directory file replacement shared by stateful subsystems.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_path_for(to: &Path) -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = to
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| format!(".{n}.{}.{seq}.tmp", std::process::id()))
        .unwrap_or_else(|| format!(".ninety.{}.{seq}.tmp", std::process::id()));
    to.with_file_name(name)
}

#[cfg(target_os = "windows")]
fn replace_file(tmp: &Path, to: &Path, label: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
    let dest: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(dest.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|e| format!("replace {label}: {e}"))?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_file(tmp: &Path, to: &Path, label: &str) -> Result<(), String> {
    std::fs::rename(tmp, to).map_err(|e| format!("replace {label}: {e}"))
}

pub fn write_bytes_replace(to: &Path, body: &[u8], label: &str) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {label}: {e}"))?;
    }
    let tmp = temp_path_for(to);
    let result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("create {label} temp: {e}"))?;
        file.write_all(body)
            .map_err(|e| format!("write {label} temp: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("sync {label} temp: {e}"))?;
        drop(file);
        replace_file(&tmp, to, label)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub fn copy_replace(from: &Path, to: &Path, label: &str) -> Result<(), String> {
    let body = std::fs::read(from).map_err(|e| format!("read {label}: {e}"))?;
    write_bytes_replace(to, &body, label)
}

pub fn write_replace(to: &Path, body: &str, label: &str) -> Result<(), String> {
    write_bytes_replace(to, body.as_bytes(), label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_overwrites_without_leaving_temp_file() {
        let dir = std::env::temp_dir().join(format!("ninety-atomic-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("state.txt");
        write_replace(&file, "first", "test").unwrap();
        write_replace(&file, "second", "test").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "second");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
