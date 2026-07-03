// Ninety · бэкап состояния фронта (localStorage → app_config_dir).
//
// localStorage живёт в профиле WebView2 (каталог EBWebView) — его сносят
// чистилки диска, антивирусы и переустановка системы, и юзер молча теряет
// профили/подписки/настройки. Фронт (state-backup.js) периодически шлёт сюда
// снапшот всех ninety.*-ключей; при пустом localStorage на старте забирает
// его обратно и перезагружает webview.
//
// Снапшот содержит URL подписок и UUID/пароли всех нод — на диске лежит
// DPAPI-блобом (secrets.rs), не plaintext'ом. Легаси plaintext-JSON читается
// как есть; первый же state_backup_save перезапишет его шифрованным.

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
    let sealed = crate::secrets::seal(json.as_bytes())?;
    std::fs::write(&tmp, &sealed).map_err(|e| format!("write tmp: {e}"))?;
    // На Windows rename поверх существующего файла падает. Прежний снапшот не
    // удаляем, а откладываем в .bak: краш в окне «удалили старый, не переименовали
    // новый» оставлял бы юзера вообще без бэкапа — теперь жив хотя бы прошлый.
    if path.exists() {
        let bak = path.with_extension("json.bak");
        if bak.exists() {
            std::fs::remove_file(&bak).map_err(|e| format!("remove bak: {e}"))?;
        }
        std::fs::rename(&path, &bak).map_err(|e| format!("rotate old: {e}"))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))
}

// Чтение одного файла снапшота: DPAPI-блоб либо легаси plaintext-JSON.
// None — файла нет / не расшифровался / битая кодировка.
fn read_snapshot(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if crate::secrets::is_plaintext_json(&bytes) {
        return String::from_utf8(bytes).ok();
    }
    String::from_utf8(crate::secrets::unseal(&bytes).ok()?).ok()
}

/// Содержимое бэкапа либо None, если его ещё не делали. Битый/пропавший
/// основной файл фолбэчится на .bak (прошлый снапшот, см. save).
#[tauri::command]
pub fn state_backup_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = backup_path(&app)?;
    Ok(read_snapshot(&path).or_else(|| read_snapshot(&path.with_extension("json.bak"))))
}
