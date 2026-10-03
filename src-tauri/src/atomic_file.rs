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

/// Перезапись содержимого уже существующего файла на месте.
///
/// Для системных файлов (в первую очередь `System32\drivers\etc\hosts`) это
/// правильнее замены через `MoveFileEx`: replace создаёт НОВЫЙ объект файла, и
/// цель получает DACL/владельца временного файла вместо исходных прав, а
/// Controlled Folder Access и часть антивирусов блокируют именно подмену
/// системного файла, пропуская перезапись содержимого. Атомарности здесь нет,
/// поэтому вызывающий передаёт `original` — прежнее содержимое: если запись
/// оборвётся уже после обрезки файла, оно возвращается через тот же хэндл.
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

/// Файл, содержимое которого целиком перезаписывается через один хэндл.
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

// Файл уже обрезан, а запись оборвалась (антивирус, диск, отказ после
// открытия): без отката система осталась бы с пустым или половинчатым hosts.
// Хэндл тот же, поэтому повторное открытие с его проверками не нужно.
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
            "write {label}: {error}; прежнее содержимое восстановлено"
        )),
        Err(rollback) => Err(format!(
            "write {label}: {error}; прежнее содержимое вернуть не удалось: {rollback}"
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

    #[test]
    fn in_place_overwrite_keeps_the_same_file_object() {
        let dir = std::env::temp_dir().join(format!("ninety-inplace-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hosts");
        std::fs::write(&file, b"# original\n127.0.0.1 localhost\n").unwrap();
        overwrite_in_place(&file, b"# managed\n", b"", "test hosts").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# managed\n");
        // Никаких временных файлов рядом с целью: в System32\drivers\etc такой
        // мусор остаётся после падения процесса.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        // Файла может не быть — тогда он создаётся.
        let fresh = dir.join("fresh");
        overwrite_in_place(&fresh, b"new\n", b"", "test fresh").unwrap();
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "new\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Пишет не больше `fail_after` байт, затем один раз отказывает — как диск,
    // который кончился посреди записи.
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
        assert!(error.contains("восстановлено"), "{error}");
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
