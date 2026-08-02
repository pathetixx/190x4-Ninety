// Ninety · бэкап состояния фронта (localStorage → writable config dir).
//
// localStorage живёт в профиле WebView2 (каталог EBWebView) — его сносят
// чистилки диска, антивирусы и переустановка системы, и юзер молча теряет
// профили/подписки/настройки. Фронт (state-backup.js) периодически шлёт
// сюда отфильтрованный снапшот восстанавливаемых ninety.*-ключей; при
// пустом localStorage на старте забирает его обратно и перезагружает webview.
//
// Снапшот содержит URL подписок и UUID/пароли всех нод. В установленной версии
// он защищён DPAPI; Full Portable по умолчанию ничего нового не пишет без
// явного пароля, а после задания пароля использует portable envelope (см.
// secrets.rs и предупреждение README).

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;

static BACKUP_LOCK: Mutex<()> = Mutex::new(());
// Clear повышает поколение под BACKUP_LOCK. Save запоминает его при входе и
// после получения lock отказывается писать, если очистка успела пройти раньше.
static BACKUP_GENERATION: AtomicU64 = AtomicU64::new(0);
const BACKUP_SCHEMA_VERSION: u64 = 2;
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;

fn backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("state-backup.json"))
}

fn backup_generation_matches(generation: &AtomicU64, captured: u64) -> bool {
    generation.load(Ordering::Acquire) == captured
}

/// Атомарная запись снапшота: tmp + rename. Краш посреди записи не оставит
/// битый бэкап — прежний файл до rename остаётся целым.
#[tauri::command]
pub fn state_backup_save(app: AppHandle, json: String) -> Result<(), String> {
    // Захватываем поколение ДО потенциально дорогой JSON-валидации/DPAPI. Если
    // параллельный state_backup_clear завершится раньше получения lock, старый
    // запрос не имеет права воскресить уже удалённые профили.
    let generation = BACKUP_GENERATION.load(Ordering::Acquire);
    // Валидация обязана быть ДО seal/tmp/rotation. Иначе две подряд невалидные
    // записи сначала вытеснят рабочий primary в .bak, а затем удалят и его.
    validate_snapshot_for_save(&json)?;
    let _guard = BACKUP_LOCK
        .lock()
        .map_err(|_| "state backup lock poisoned")?;
    if !backup_generation_matches(&BACKUP_GENERATION, generation) {
        return Err("state backup save invalidated by sensitive-data clear".into());
    }
    let path = backup_path(&app)?;
    let sealed = crate::secrets::seal_for_app(&app, json.as_bytes())?;
    // Если пользователь включил passphrase уже после восстановления старого
    // plaintext snapshot, не переносим этот plaintext в обычный .bak при
    // следующей записи. Сначала переводим старый primary в ту же политику, а
    // затем стандартная ротация оставляет зашифрованную rollback-копию.
    let old_backup = path.with_extension("json.bak");
    let old_rollback = path.with_extension("json.legacy.bak");
    for old_path in [&path, &old_backup, &old_rollback] {
        migrate_plaintext_backup_if_needed(&app, old_path)?;
    }
    let tmp = path.with_extension("json.tmp");
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
    let bak = old_backup;
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

fn snapshot_keys(value: &serde_json::Value) -> Option<&serde_json::Map<String, serde_json::Value>> {
    let root = value.as_object()?;
    match root.get("keys") {
        None => Some(root),
        Some(serde_json::Value::Object(keys)) => Some(keys),
        Some(_) => None,
    }
}

fn embedded_json(
    keys: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<serde_json::Value> {
    let raw = keys.get(key)?.as_str()?;
    serde_json::from_str(raw).ok()
}

fn active_id_exists(items: &[serde_json::Value], active: &str) -> bool {
    items
        .iter()
        .any(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(active))
}

fn valid_snapshot_value(value: &serde_json::Value) -> bool {
    let Some(keys) = snapshot_keys(value) else {
        return false;
    };

    if let Some(version) = keys.get("__schemaVersion") {
        if version.as_u64() != Some(BACKUP_SCHEMA_VERSION) {
            return false;
        }
    }

    let Some(options) = embedded_json(keys, "ninety.options.v1") else {
        return false;
    };
    let Some(profiles) = embedded_json(keys, "ninety.profiles.v1") else {
        return false;
    };
    let Some(subscriptions) = embedded_json(keys, "ninety.subscriptions.v1") else {
        return false;
    };
    let (Some(_), Some(profiles), Some(subscriptions)) = (
        options.as_object(),
        profiles.as_array(),
        subscriptions.as_array(),
    ) else {
        return false;
    };

    let kind = keys
        .get("ninety.active.kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("single");
    let (active_key, items) = if kind == "sub" {
        ("ninety.subscriptions.active", subscriptions)
    } else {
        ("ninety.profiles.active", profiles)
    };
    match keys.get(active_key) {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::String(active)) if active.is_empty() => true,
        Some(serde_json::Value::String(active)) => active_id_exists(items, active),
        Some(_) => false,
    }
}

fn valid_snapshot_str(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .is_some_and(|value| valid_snapshot_value(&value))
}

fn validate_snapshot_for_save(raw: &str) -> Result<(), String> {
    if raw.len() > MAX_SNAPSHOT_BYTES {
        return Err(format!("state backup exceeds {MAX_SNAPSHOT_BYTES} bytes"));
    }
    if !valid_snapshot_str(raw) {
        return Err("state backup snapshot is invalid".into());
    }
    Ok(())
}

fn migrate_plaintext_backup_if_needed(app: &AppHandle, path: &Path) -> Result<(), String> {
    let Ok(previous) = std::fs::read(path) else {
        return Ok(());
    };
    if !crate::secrets::is_plaintext_json(&previous) {
        return Ok(());
    }
    let sealed = crate::secrets::seal_for_app(app, &previous)?;
    let is_rollback = path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.ends_with(".legacy.bak"));
    if is_rollback {
        crate::atomic_file::write_bytes_replace(path, &sealed, "state backup rollback migration")
    } else {
        crate::secrets::migrate_legacy_blob(path, &sealed, "state backup migration")
    }
}

// Чтение одного файла снапшота: versioned envelope, легаси DPAPI либо легаси
// plaintext-JSON. При валидном legacy JSON и доступной текущей политике запись
// мигрируется атомарно; при ошибке исходный файл остаётся на месте.
// None — файла нет / не расшифровался / битая кодировка / невалидный JSON.
fn read_snapshot(app: &AppHandle, path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let legacy_plaintext = crate::secrets::is_plaintext_json(&bytes);
    let raw = String::from_utf8(crate::secrets::open_for_app(app, &bytes).ok()?).ok()?;
    // Читаемый UTF-8 и даже JSON-объект ещё не означают пригодный snapshot:
    // primary обязан пройти тот же минимальный контракт, что frontend, иначе он
    // не должен блокировать fallback на целый .bak.
    if !valid_snapshot_str(&raw) {
        return None;
    }
    if legacy_plaintext && crate::secrets::can_persist_secrets() {
        match crate::secrets::seal_for_app(app, raw.as_bytes()) {
            Ok(sealed) => {
                if let Err(error) =
                    crate::secrets::migrate_legacy_blob(path, &sealed, "state backup migration")
                {
                    eprintln!("state backup legacy migration failed: {error}");
                }
            }
            Err(error) => eprintln!("state backup legacy sealing failed: {error}"),
        }
    }
    Some(raw)
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
    // Проверяем оба файла даже если primary валиден: это даёт возможность
    // мигрировать оставшийся legacy plaintext .bak и не держать второй
    // чувствительный снимок в открытом виде после первого успешного старта.
    let primary = read_snapshot(&app, &path);
    let backup_path = path.with_extension("json.bak");
    let backup = read_snapshot(&app, &backup_path);
    let migration_backup = read_snapshot(&app, &path.with_extension("json.legacy.bak"));
    Ok(primary.or(backup).or(migration_backup))
}

/// Явная приватная очистка: фронт уже удалил localStorage-профили, здесь стираем
/// encrypted snapshot и временные файлы, чтобы старые ноды не восстановились
/// после следующего старта WebView2.
#[tauri::command]
pub fn state_backup_clear(app: AppHandle) -> Result<u32, String> {
    let _guard = BACKUP_LOCK
        .lock()
        .map_err(|_| "state backup lock poisoned")?;
    // Инвалидация идёт до удаления файлов: даже если remove завершится ошибкой,
    // запросы save, начатые до clear, уже не смогут записать старый snapshot.
    BACKUP_GENERATION.fetch_add(1, Ordering::AcqRel);
    let path = backup_path(&app)?;
    let mut removed = 0;
    for p in [
        path.clone(),
        path.with_extension("json.bak"),
        path.with_extension("json.tmp"),
        path.with_extension("json.legacy.bak"),
    ] {
        if remove_file_if_exists(&p)? {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_snapshot() -> String {
        serde_json::json!({
            "__schemaVersion": 2,
            "ninety.options.v1": "{}",
            "ninety.profiles.v1": "[]",
            "ninety.subscriptions.v1": "[]"
        })
        .to_string()
    }

    fn valid_snapshot_json(raw: String) -> Option<String> {
        super::valid_snapshot_str(&raw).then_some(raw)
    }

    #[test]
    fn clear_generation_invalidates_older_save_request() {
        let generation = AtomicU64::new(7);
        let captured = generation.load(Ordering::Acquire);
        assert!(backup_generation_matches(&generation, captured));
        generation.fetch_add(1, Ordering::AcqRel);
        assert!(!backup_generation_matches(&generation, captured));
        assert!(backup_generation_matches(
            &generation,
            generation.load(Ordering::Acquire)
        ));
    }

    #[test]
    fn malformed_primary_allows_valid_backup_fallback() {
        let primary = valid_snapshot_json(r#"{"ninety.profiles.v1":"[]""#.to_string());
        let expected = valid_snapshot();
        let backup = valid_snapshot_json(expected.clone());
        let selected = primary.or(backup);
        assert_eq!(selected.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn semantic_corruption_allows_valid_backup_fallback() {
        let primary = valid_snapshot_json(r#"{"__schemaVersion":2}"#.to_string());
        let expected = valid_snapshot();
        let backup = valid_snapshot_json(expected.clone());
        assert!(primary.is_none());
        assert_eq!(primary.or(backup).as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn invalid_or_oversized_save_is_rejected_before_rotation() {
        assert!(validate_snapshot_for_save(&valid_snapshot()).is_ok());
        assert!(validate_snapshot_for_save(r#"{"__schemaVersion":2}"#).is_err());
        let oversized = "x".repeat(MAX_SNAPSHOT_BYTES + 1);
        assert!(validate_snapshot_for_save(&oversized).is_err());
    }

    #[test]
    fn active_id_must_exist_in_selected_collection() {
        let invalid = serde_json::json!({
            "__schemaVersion": 2,
            "ninety.options.v1": "{}",
            "ninety.profiles.v1": "[]",
            "ninety.subscriptions.v1": "[]",
            "ninety.active.kind": "single",
            "ninety.profiles.active": "missing"
        })
        .to_string();
        assert!(valid_snapshot_json(invalid).is_none());
    }

    #[test]
    fn legacy_keys_wrapper_is_accepted() {
        let wrapped = serde_json::json!({
            "keys": serde_json::from_str::<serde_json::Value>(&valid_snapshot()).unwrap()
        })
        .to_string();
        assert!(valid_snapshot_json(wrapped).is_some());
    }

    #[test]
    fn malformed_keys_wrapper_is_rejected() {
        let wrapped = serde_json::json!({
            "keys": [],
            "__schemaVersion": 2,
            "ninety.options.v1": "{}",
            "ninety.profiles.v1": "[]",
            "ninety.subscriptions.v1": "[]"
        })
        .to_string();
        assert!(valid_snapshot_json(wrapped).is_none());
    }

    #[test]
    fn non_object_json_is_not_a_snapshot() {
        assert!(valid_snapshot_json("[]".to_string()).is_none());
        assert!(valid_snapshot_json("null".to_string()).is_none());
    }
}
