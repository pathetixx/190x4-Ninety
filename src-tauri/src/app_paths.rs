// Ninety · единая маршрутизация writable-данных.
//
// Обычная установленная сборка использует стандартные каталоги Tauri.
// Full Portable определяется файлом Ninety.portable рядом с exe и хранит всё
// переносимое состояние в соседнем NinetyData:
//   config/  — backup localStorage, WARP и временные конфиги движков;
//   data/    — обновляемые DPI-списки/стратегии;
//   logs/    — логи движков;
//   webview/ — профиль WebView2, включая localStorage.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(crate) const PORTABLE_MARKER: &str = "Ninety.portable";
pub(crate) const PORTABLE_DATA: &str = "NinetyData";
/// Сколько уровней вложенности разбираем при ремонте: больше обновлений подряд
/// в сломанной схеме никто не сделает, а цикл по чужому дереву нужно ограничить.
pub(crate) const MAX_NESTED_DEPTH: usize = 64;

pub(crate) fn executable_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Ninety.exe has no parent directory".into())
}

pub(crate) fn is_portable_dir(dir: &Path) -> bool {
    dir.join(PORTABLE_MARKER).is_file()
}

pub fn is_portable() -> bool {
    executable_dir()
        .map(|dir| is_portable_dir(&dir))
        .unwrap_or(false)
}

/// Папка программы Full Portable: в ней лежат Ninety.exe и Ninety.portable.
/// Сюда ставится обновление; пользовательские данные — в `portable_data_dir`.
pub fn portable_app_dir() -> Result<PathBuf, String> {
    let dir = executable_dir()?;
    if !is_portable_dir(&dir) {
        return Err("portable marker not found".into());
    }
    Ok(dir)
}

/// Папка пользовательских данных Full Portable: `<папка программы>\NinetyData`.
pub fn portable_data_dir() -> Result<PathBuf, String> {
    Ok(portable_app_dir()?.join(PORTABLE_DATA))
}

fn is_data_dir_name(dir: &Path) -> bool {
    dir.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(PORTABLE_DATA))
}

/// Ссылка или junction (std относит к ним и mount point). Несуществующий путь
/// ссылкой не считается.
pub(crate) fn is_link(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir).is_ok_and(|m| m.file_type().is_symlink())
}

/// Portable 0.15.0–0.16.0 ставил обновление в `NinetyData` вместо папки
/// программы, и каждое следующее обновление уходило ещё на уровень глубже.
/// Для exe из такой вложенной копии возвращает исходную папку программы —
/// верхний уровень цепочки `…\NinetyData\NinetyData`, где у каждого родителя
/// есть Ninety.portable. Ссылки и разрывы цепочки останавливают подъём.
pub fn nested_portable_origin(exe_dir: &Path) -> Option<PathBuf> {
    if !is_portable_dir(exe_dir) {
        return None;
    }
    let mut current = exe_dir.to_path_buf();
    for _ in 0..MAX_NESTED_DEPTH {
        if !is_data_dir_name(&current) || is_link(&current) {
            break;
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if !is_portable_dir(parent) {
            break;
        }
        current = parent.to_path_buf();
    }
    (current != exe_dir).then_some(current)
}

pub fn ensure_portable_layout() -> Result<(), String> {
    let root = portable_data_dir()?;
    for name in ["config", "data", "logs", "webview"] {
        std::fs::create_dir_all(root.join(name))
            .map_err(|e| format!("create NinetyData/{name}: {e}"))?;
    }
    Ok(())
}

pub fn webview_dir() -> Result<PathBuf, String> {
    Ok(portable_data_dir()?.join("webview"))
}

pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if is_portable() {
        Ok(portable_data_dir()?.join("config"))
    } else {
        app.path()
            .app_config_dir()
            .map_err(|e| format!("app_config_dir: {e}"))
    }
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if is_portable() {
        Ok(portable_data_dir()?.join("data"))
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))
    }
}

pub fn log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if is_portable() {
        Ok(portable_data_dir()?.join("logs"))
    } else {
        app.path()
            .app_log_dir()
            .map_err(|e| format!("app_log_dir: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ninety-app-paths-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn portable_level(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(PORTABLE_MARKER), "portable=1").unwrap();
        std::fs::write(dir.join("Ninety.exe"), "exe").unwrap();
    }

    #[test]
    fn regular_portable_folder_is_not_nested() {
        let root = temp_dir("regular");
        portable_level(&root);
        std::fs::create_dir_all(root.join(PORTABLE_DATA).join("config")).unwrap();
        assert_eq!(nested_portable_origin(&root), None);
        // Папка данных без маркера — не установка программы.
        assert_eq!(nested_portable_origin(&root.join(PORTABLE_DATA)), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nested_install_resolves_to_the_top_program_folder_at_any_depth() {
        let root = temp_dir("nested");
        portable_level(&root);
        let mut level = root.clone();
        for depth in 1..=3 {
            level = level.join(PORTABLE_DATA);
            portable_level(&level);
            assert_eq!(
                nested_portable_origin(&level),
                Some(root.clone()),
                "depth {depth}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn data_folder_name_is_case_insensitive() {
        let root = temp_dir("case");
        portable_level(&root);
        let lower = root.join("ninetydata");
        portable_level(&lower);
        assert_eq!(nested_portable_origin(&lower), Some(root.clone()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn broken_chain_stops_the_walk() {
        let root = temp_dir("broken");
        // Родитель без маркера: это не наша вложенная установка.
        let first = root.join(PORTABLE_DATA);
        portable_level(&first);
        assert_eq!(nested_portable_origin(&first), None);
        let second = first.join(PORTABLE_DATA);
        portable_level(&second);
        assert_eq!(nested_portable_origin(&second), Some(first.clone()));
        let _ = std::fs::remove_dir_all(&root);
    }
}
