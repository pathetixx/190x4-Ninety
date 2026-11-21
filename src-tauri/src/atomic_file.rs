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

// Path for a direct Win32 call. std extends long paths with the `\\?\` prefix
// itself, but MoveFileExW without it is limited to MAX_PATH (the manifest has no
// longPathAware): in a deep portable folder the temporary file was created, but the
// replace failed, and no storage write went through. Short paths are left as is.
#[cfg(target_os = "windows")]
fn wide_path_for_win32(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    const LONG_PATH_THRESHOLD: usize = 240;
    let backslash = u16::from(b'\\');
    let units: Vec<u16> = path.as_os_str().encode_wide().collect();
    let verbatim = units.starts_with(&[backslash, backslash, u16::from(b'?'), backslash]);
    let long = units.len() >= LONG_PATH_THRESHOLD
        && !verbatim
        && path.is_absolute()
        && !units.contains(&u16::from(b'/'));
    let mut out: Vec<u16> = Vec::with_capacity(units.len() + 9);
    if long && units.starts_with(&[backslash, backslash]) {
        // \\server\share\x → \\?\UNC\server\share\x
        out.extend("\\\\?\\UNC".encode_utf16());
        out.extend_from_slice(&units[1..]);
    } else if long {
        out.extend("\\\\?\\".encode_utf16());
        out.extend_from_slice(&units);
    } else {
        out.extend_from_slice(&units);
    }
    out.push(0);
    out
}

#[cfg(target_os = "windows")]
fn replace_file(tmp: &Path, to: &Path, label: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from = wide_path_for_win32(tmp);
    let dest = wide_path_for_win32(to);
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

/// Rewrites the contents of an already existing file in place.
///
/// For system files (primarily `System32\drivers\etc\hosts`) this is more
/// correct than replacing via `MoveFileEx`: replace creates a NEW file object, and
/// the target gets the temporary file's DACL/owner instead of the original rights, while
/// Controlled Folder Access and some antiviruses block exactly the swap of a
/// system file but allow rewriting its contents. There is no atomicity here,
/// so the caller passes `original` — the previous contents: if the write
/// breaks off after the file was truncated, they are restored through the same handle.
pub fn overwrite_in_place(
    path: &Path,
    body: &[u8],
    original: &[u8],
    label: &str,
) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("open {label}: {e}"))?;
    overwrite_or_restore(&mut file, body, original, label)
}

/// A file whose contents are rewritten entirely through a single handle.
trait InPlaceTarget: std::io::Write + std::io::Seek {
    fn truncate_all(&mut self) -> std::io::Result<()>;
    fn sync(&mut self) -> std::io::Result<()>;
}

impl InPlaceTarget for std::fs::File {
    fn truncate_all(&mut self) -> std::io::Result<()> {
        self.set_len(0)
    }

    fn sync(&mut self) -> std::io::Result<()> {
        self.sync_all()
    }
}

fn rewrite(target: &mut impl InPlaceTarget, body: &[u8]) -> std::io::Result<()> {
    target.seek(std::io::SeekFrom::Start(0))?;
    target.truncate_all()?;
    target.write_all(body)?;
    target.sync()
}

// The file is already truncated and the write broke off (antivirus, disk, failure after
// opening): without a rollback the system would be left with an empty or partial hosts.
// It is the same handle, so reopening with its checks is not needed.
fn overwrite_or_restore(
    target: &mut impl InPlaceTarget,
    body: &[u8],
    original: &[u8],
    label: &str,
) -> Result<(), String> {
    let Err(error) = rewrite(target, body) else {
        return Ok(());
    };
    match rewrite(target, original) {
        Ok(()) => Err(format!(
            "write {label}: {error}; previous contents restored"
        )),
        Err(rollback) => Err(format!(
            "write {label}: {error}; previous contents could not be restored: {rollback}"
        )),
    }
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

    #[cfg(target_os = "windows")]
    #[test]
    fn long_paths_get_a_verbatim_prefix_for_win32() {
        let to_string = |wide: Vec<u16>| String::from_utf16_lossy(&wide[..wide.len() - 1]);
        let short = Path::new(r"C:\Ninety\NinetyData\config\profile-store.v1");
        assert_eq!(
            to_string(wide_path_for_win32(short)),
            short.to_string_lossy()
        );
        let deep = format!(r"C:\{}\profile-store.v1", "d".repeat(260));
        assert_eq!(
            to_string(wide_path_for_win32(Path::new(&deep))),
            format!(r"\\?\{deep}")
        );
        let unc = format!(r"\\server\share\{}\x", "d".repeat(260));
        assert_eq!(
            to_string(wide_path_for_win32(Path::new(&unc))),
            format!(r"\\?\UNC\server\share\{}\x", "d".repeat(260))
        );
    }

    #[test]
    fn in_place_overwrite_keeps_the_same_file_object() {
        let dir = std::env::temp_dir().join(format!("ninety-inplace-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hosts");
        std::fs::write(&file, b"# original\n127.0.0.1 localhost\n").unwrap();
        overwrite_in_place(&file, b"# managed\n", b"", "test hosts").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# managed\n");
        // No temporary files next to the target: in System32\drivers\etc such
        // garbage stays behind after a process crash.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        // The file may be missing — then it is created.
        let fresh = dir.join("fresh");
        overwrite_in_place(&fresh, b"new\n", b"", "test fresh").unwrap();
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "new\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Writes at most `fail_after` bytes, then fails once — like a disk
    // that ran out of space mid-write.
    struct FlakyFile {
        inner: std::io::Cursor<Vec<u8>>,
        fail_after: Option<usize>,
    }

    impl std::io::Write for FlakyFile {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            match self.fail_after {
                Some(0) => {
                    self.fail_after = None;
                    Err(std::io::Error::other("disk full"))
                }
                Some(left) => {
                    let n = buf.len().min(left);
                    self.fail_after = Some(left - n);
                    self.inner.write(&buf[..n])
                }
                None => self.inner.write(buf),
            }
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl std::io::Seek for FlakyFile {
        fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(pos)
        }
    }

    impl InPlaceTarget for FlakyFile {
        fn truncate_all(&mut self) -> std::io::Result<()> {
            self.inner.get_mut().clear();
            Ok(())
        }

        fn sync(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn broken_in_place_write_restores_the_original_content() {
        let original = b"127.0.0.1 localhost\n".to_vec();
        let mut file = FlakyFile {
            inner: std::io::Cursor::new(original.clone()),
            fail_after: Some(4),
        };
        let error =
            overwrite_or_restore(&mut file, b"# managed block\n", &original, "hosts").unwrap_err();
        assert!(error.contains("disk full"), "{error}");
        assert!(error.contains("restored"), "{error}");
        assert_eq!(file.inner.get_ref(), &original);

        let mut healthy = FlakyFile {
            inner: std::io::Cursor::new(original.clone()),
            fail_after: None,
        };
        overwrite_or_restore(&mut healthy, b"short\n", &original, "hosts").unwrap();
        assert_eq!(healthy.inner.get_ref(), b"short\n");
    }

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
