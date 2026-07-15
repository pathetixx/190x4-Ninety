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

const PORTABLE_MARKER: &str = "Ninety.portable";
const PORTABLE_DATA: &str = "NinetyData";

fn executable_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "у Ninety.exe нет родительского каталога".into())
}

fn is_portable_dir(dir: &Path) -> bool {
    dir.join(PORTABLE_MARKER).is_file()
}

pub fn is_portable() -> bool {
    executable_dir()
        .map(|dir| is_portable_dir(&dir))
        .unwrap_or(false)
}

pub fn portable_root() -> Result<PathBuf, String> {
    let dir = executable_dir()?;
    if !is_portable_dir(&dir) {
        return Err("Portable marker не найден".into());
    }
    Ok(dir.join(PORTABLE_DATA))
}

pub fn ensure_portable_layout() -> Result<(), String> {
    let root = portable_root()?;
    for name in ["config", "data", "logs", "webview"] {
        std::fs::create_dir_all(root.join(name))
            .map_err(|e| format!("создание NinetyData/{name}: {e}"))?;
    }
    Ok(())
}

pub fn webview_dir() -> Result<PathBuf, String> {
    Ok(portable_root()?.join("webview"))
}

pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if is_portable() {
        Ok(portable_root()?.join("config"))
    } else {
        app.path()
            .app_config_dir()
            .map_err(|e| format!("app_config_dir: {e}"))
    }
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if is_portable() {
        Ok(portable_root()?.join("data"))
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))
    }
}

pub fn log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if is_portable() {
        Ok(portable_root()?.join("logs"))
    } else {
        app.path()
            .app_log_dir()
            .map_err(|e| format!("app_log_dir: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_marker_and_data_are_siblings() {
        let dir = Path::new(r"C:\Tools\Ninety");
        assert_eq!(dir.join(PORTABLE_MARKER), dir.join("Ninety.portable"));
        assert_eq!(dir.join(PORTABLE_DATA), dir.join("NinetyData"));
    }
}
