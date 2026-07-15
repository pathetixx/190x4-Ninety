// Ninety · бэкап состояния фронта (localStorage → writable config dir).
//
// localStorage живёт в профиле WebView2 (каталог EBWebView) — его сносят
// чистилки диска, антивирусы и переустановка системы, и юзер молча теряет
// профили/подписки/настройки. Фронт (state-backup.js) периодически шлёт
// сюда отфильтрованный снапшот восстанавливаемых ninety.*-ключей; при
// пустом localStorage на старте забирает его обратно и перезагружает webview.
//
// Снапшот содержит URL подписок и UUID/пароли всех нод. В установленной версии
// он защищён DPAPI; в Full Portable остаётся переносимым plaintext рядом с уже
// переносимым WebView/localStorage (см. secrets.rs и предупреждение README).

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

static BACKUP_LOCK: Mutex<()> = Mutex::new(());

fn backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("state-backup.json"))
}

/// Атомарная запись снапшота: tmp + rename. Краш посреди записи не оставит
/// битый бэкап — прежний файл до rename остаётся целым.
#[tauri::command]
pub fn state_backup_save(app: AppHandle, json: String) -> Result<(), String> {
    let _guard = BACKUP_LOCK
        .lock()
        .map_err(|_| "state backup lock poisoned")?;
    let path = backup_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    let sealed = crate::secrets::seal_for_app(&app, json.as_bytes())?;
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        file.write_all(&sealed)
            .map_err(|e| format!("write tmp: {e}"))?;
        file.sync_all().map_err(|e| format!("sync tmp: {e}"))?;
    }
    // На Windows rename поверх существующего файла падает. Прежний снапшот не
    // удаляем, а откладываем в .bak: краш в окне «удалили старый, не переименовали
    // новый» оставлял бы юзера вообще без бэкапа — теперь жив хотя бы прошлый.
    let bak = path.with_extension("json.bak");
    if path.exists() {
        if bak.exists() {
            std::fs::remove_file(&bak).map_err(|e| format!("remove bak: {e}"))?;
        }
        std::fs::rename(&path, &bak).map_err(|e| format!("rotate old: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        if bak.exists() && !path.exists() {
            let _ = std::fs::rename(&bak, &path);
        }
        return Err(format!("rename: {e}"));
    }
    Ok(())
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

fn remove_file_if_exists(path: &Path) -> Result<bool, String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

/// Содержимое бэкапа либо None, если его ещё не делали. Битый/пропавший
/// основной файл фолбэчится на .bak (прошлый снапшот, см. save).
#[tauri::command]
pub fn state_backup_load(app: AppHandle) -> Result<Option<String>, String> {
    let _guard = BACKUP_LOCK
        .lock()
        .map_err(|_| "state backup lock poisoned")?;
    let path = backup_path(&app)?;
    Ok(read_snapshot(&path).or_else(|| read_snapshot(&path.with_extension("json.bak"))))
}

/// Явная приватная очистка: фронт уже удалил localStorage-профили, здесь стираем
/// encrypted snapshot и временные файлы, чтобы старые ноды не восстановились
/// после следующего старта WebView2.
#[tauri::command]
pub fn state_backup_clear(app: AppHandle) -> Result<u32, String> {
    let _guard = BACKUP_LOCK
        .lock()
        .map_err(|_| "state backup lock poisoned")?;
    let path = backup_path(&app)?;
    let mut removed = 0;
    for p in [
        path.clone(),
        path.with_extension("json.bak"),
        path.with_extension("json.tmp"),
    ] {
        if remove_file_if_exists(&p)? {
            removed += 1;
        }
    }
    Ok(removed)
}
