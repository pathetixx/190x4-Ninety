// Ninety · бэкап состояния фронта (localStorage → app_config_dir).
//
// localStorage живёт в профиле WebView2 (каталог EBWebView) — его сносят
// чистилки диска, антивирусы и переустановка системы, и юзер молча теряет
// профили/подписки/настройки. Фронт (state-backup.js) периодически шлёт сюда
// снапшот всех ninety.*-ключей; при пустом localStorage на старте забирает
// его обратно и перезагружает webview.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("state-backup.json"))
}

/// Атомарная запись снапшота: tmp + rename. Краш посреди записи не оставит
/// битый бэкап — прежний файл до rename остаётся целым.
#[tauri::command]
pub fn state_backup_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = backup_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    // На Windows rename поверх существующего файла падает — сносим старый.
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("remove old: {e}"))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))
}

/// Содержимое бэкапа либо None, если его ещё не делали.
#[tauri::command]
pub fn state_backup_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = backup_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("read: {e}"))
}
