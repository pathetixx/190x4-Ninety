//! Rust-owned storage for live profiles and subscriptions.
//!
//! The WebView must not be the source of truth for node URLs, credentials or
//! protocol keys.  This module keeps one validated domain envelope in the
//! writable config directory and lets `secrets` choose DPAPI or the explicit
//! portable protection policy for the bytes on disk.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const STORE_SCHEMA_VERSION: u64 = 1;
const MAX_STORE_BYTES: usize = 8 * 1024 * 1024;
const STORE_FILE: &str = "profile-store.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSelection {
    #[serde(default = "default_active_kind")]
    pub kind: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub subscription_id: Option<String>,
}

fn default_active_kind() -> String {
    "single".to_string()
}

impl Default for ActiveSelection {
    fn default() -> Self {
        Self {
            kind: default_active_kind(),
            profile_id: None,
            subscription_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStore {
    #[serde(default = "default_schema_version")]
    pub schema_version: u64,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub profiles: Vec<Value>,
    #[serde(default)]
    pub subscriptions: Vec<Value>,
    #[serde(default)]
    pub active: ActiveSelection,
    #[serde(default)]
    pub proxy_selection: BTreeMap<String, String>,
}

fn default_schema_version() -> u64 {
    STORE_SCHEMA_VERSION
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_SCHEMA_VERSION,
            revision: 0,
            profiles: Vec::new(),
            subscriptions: Vec::new(),
            active: ActiveSelection::default(),
            proxy_selection: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStoreLoadResponse {
    pub exists: bool,
    pub schema_version: u64,
    pub revision: u64,
    pub recovered_from_backup: bool,
    pub store: Option<ProfileStore>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStoreStatus {
    pub exists: bool,
    pub schema_version: Option<u64>,
    pub revision: Option<u64>,
    pub portable_protection: crate::secrets::PortableSecretMode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStoreReplaceResponse {
    pub revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStoreClearResponse {
    pub removed: u32,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("profile store mkdir: {e}"))?;
    Ok(dir.join(STORE_FILE))
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{}.bak", STORE_FILE))
}

fn legacy_backup_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{}.legacy.bak", STORE_FILE))
}

fn temporary_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{}.tmp", STORE_FILE))
}

fn valid_id(value: &Value) -> Option<&str> {
    let id = value.get("id")?.as_str()?;
    (!id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)).then_some(id)
}

fn unique_ids(items: &[Value], label: &str) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::with_capacity(items.len());
    for item in items {
        if !item.is_object() {
            return Err(format!("profile store {label} item is not an object"));
        }
        let Some(id) = valid_id(item) else {
            return Err(format!("profile store {label} item has invalid id"));
        };
        if !ids.insert(id.to_owned()) {
            return Err(format!("profile store {label} contains duplicate ids"));
        }
    }
    Ok(ids)
}

fn validate_store(store: &ProfileStore) -> Result<(), String> {
    if store.schema_version != STORE_SCHEMA_VERSION {
        return Err("profile store schema is unsupported".into());
    }
    if store.active.kind != "single" && store.active.kind != "sub" {
        return Err("profile store active kind is invalid".into());
    }
    let profile_ids = unique_ids(&store.profiles, "profiles")?;
    let subscription_ids = unique_ids(&store.subscriptions, "subscriptions")?;
    for (source, tag) in &store.proxy_selection {
        if source.is_empty()
            || source.len() > 512
            || tag.is_empty()
            || tag.len() > 512
            || source.chars().any(char::is_control)
            || tag.chars().any(char::is_control)
        {
            return Err("profile store proxy selection is invalid".into());
        }
    }
    if let Some(id) = store.active.profile_id.as_deref() {
        if id.is_empty() || !profile_ids.contains(id) {
            return Err("profile store active profile is missing".into());
        }
    }
    if let Some(id) = store.active.subscription_id.as_deref() {
        if id.is_empty() || !subscription_ids.contains(id) {
            return Err("profile store active subscription is missing".into());
        }
    }
    let encoded =
        serde_json::to_vec(store).map_err(|_| "profile store cannot be serialized".to_string())?;
    if encoded.len() > MAX_STORE_BYTES {
        return Err(format!("profile store exceeds {MAX_STORE_BYTES} bytes"));
    }
    Ok(())
}

fn serialized_store(store: &ProfileStore) -> Result<Vec<u8>, String> {
    validate_store(store)?;
    let encoded =
        serde_json::to_vec(store).map_err(|_| "profile store cannot be serialized".to_string())?;
    if encoded.len() > MAX_STORE_BYTES {
        return Err(format!("profile store exceeds {MAX_STORE_BYTES} bytes"));
    }
    Ok(encoded)
}

fn read_store_file(app: &AppHandle, path: &Path) -> Result<ProfileStore, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("profile store read: {e}"))?;
    if bytes.len() > MAX_STORE_BYTES + 1024 {
        return Err("profile store is too large".into());
    }
    let raw = crate::secrets::open_for_app(app, &bytes)?;
    let store: ProfileStore =
        serde_json::from_slice(&raw).map_err(|_| "profile store payload is invalid".to_string())?;
    validate_store(&store)?;

    // Legacy development/early-build files may be plaintext.  Once the
    // current policy allows persistence, seal the same validated bytes before
    // returning; on failure the readable source remains untouched.
    if crate::secrets::is_plaintext_json(&bytes) && crate::secrets::can_persist_secrets() {
        if let Ok(sealed) = crate::secrets::seal_for_app(app, &raw) {
            let _ = crate::secrets::migrate_legacy_blob(path, &sealed, "profile store migration");
        }
    }
    Ok(store)
}

fn load_store(app: &AppHandle, path: &Path) -> Result<Option<(ProfileStore, bool)>, String> {
    let candidates = [
        (path.to_path_buf(), false),
        (backup_path(path), true),
        (legacy_backup_path(path), true),
    ];
    let mut saw_file = false;
    for (candidate, recovered) in candidates {
        if !candidate.is_file() {
            continue;
        }
        saw_file = true;
        if let Ok(store) = read_store_file(app, &candidate) {
            return Ok(Some((store, recovered)));
        }
    }
    if saw_file {
        Err("profile store is unavailable or corrupted".into())
    } else {
        Ok(None)
    }
}

fn write_store(app: &AppHandle, path: &Path, store: &ProfileStore) -> Result<(), String> {
    let raw = serialized_store(store)?;
    let sealed = crate::secrets::seal_for_app(app, &raw)?;
    let backup = backup_path(path);
    if path.is_file() {
        if let Ok(previous) = std::fs::read(path) {
            if crate::secrets::is_plaintext_json(&previous) {
                let sealed_previous = crate::secrets::seal_for_app(app, &previous)?;
                crate::secrets::migrate_legacy_blob(
                    path,
                    &sealed_previous,
                    "profile store legacy migration",
                )?;
            }
        }
        // Ротация бэкапа — только если текущий primary читается. После
        // восстановления из .bak повреждённый primary ещё лежит на месте, и
        // слепое копирование затирало им единственную исправную копию: сбой
        // следующей записи оставлял пользователя вообще без профилей.
        if read_store_file(app, path).is_ok() {
            crate::atomic_file::copy_replace(path, &backup, "profile store backup")?;
        }
    }
    crate::atomic_file::write_bytes_replace(path, &sealed, "profile store")
}

fn remove_if_exists(path: &Path) -> Result<u32, String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(1),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(format!("profile store cleanup: {error}")),
    }
}

fn cleanup_temp_files(path: &Path) -> Result<u32, String> {
    let Some(parent) = path.parent() else {
        return Ok(0);
    };
    let prefix = format!(".{}.", STORE_FILE);
    let mut removed = 0;
    let entries = std::fs::read_dir(parent).map_err(|e| format!("profile store list: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("profile store list entry: {e}"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(&prefix) && name.ends_with(".tmp") {
            removed += remove_if_exists(&entry.path())?;
        }
    }
    Ok(removed)
}

// Argon2id (19 МиБ × 3) и файловый I/O. Синхронная Tauri-команда исполняется
// на главном потоке и морозила бы окно на каждом сохранении профиля.
#[tauri::command]
pub async fn profile_store_status(app: AppHandle) -> Result<ProfileStoreStatus, String> {
    tauri::async_runtime::spawn_blocking(move || profile_store_status_blocking(app))
        .await
        .map_err(|error| format!("profile_store_status: {error}"))?
}

pub(crate) fn profile_store_status_blocking(app: AppHandle) -> Result<ProfileStoreStatus, String> {
    let path = store_path(&app)?;
    let exists = [path.clone(), backup_path(&path), legacy_backup_path(&path)]
        .iter()
        .any(|candidate| candidate.is_file());
    let (schema_version, revision) = match load_store(&app, &path)? {
        Some((store, _)) => (Some(store.schema_version), Some(store.revision)),
        None => (None, None),
    };
    Ok(ProfileStoreStatus {
        exists,
        schema_version,
        revision,
        portable_protection: crate::secrets::portable_secrets_status().mode,
    })
}

// Argon2id (19 МиБ × 3) и файловый I/O. Синхронная Tauri-команда исполняется
// на главном потоке и морозила бы окно на каждом сохранении профиля.
#[tauri::command]
pub async fn profile_store_load(app: AppHandle) -> Result<ProfileStoreLoadResponse, String> {
    tauri::async_runtime::spawn_blocking(move || profile_store_load_blocking(app))
        .await
        .map_err(|error| format!("profile_store_load: {error}"))?
}

pub(crate) fn profile_store_load_blocking(
    app: AppHandle,
) -> Result<ProfileStoreLoadResponse, String> {
    let path = store_path(&app)?;
    let loaded = load_store(&app, &path)?;
    Ok(match loaded {
        Some((store, recovered_from_backup)) => ProfileStoreLoadResponse {
            exists: true,
            schema_version: store.schema_version,
            revision: store.revision,
            recovered_from_backup,
            store: Some(store),
        },
        None => ProfileStoreLoadResponse {
            exists: false,
            schema_version: STORE_SCHEMA_VERSION,
            revision: 0,
            recovered_from_backup: false,
            store: None,
        },
    })
}

// Argon2id (19 МиБ × 3) и файловый I/O. Синхронная Tauri-команда исполняется
// на главном потоке и морозила бы окно на каждом сохранении профиля.
#[tauri::command]
pub async fn profile_store_replace(
    app: AppHandle,
    expected_revision: u64,
    store: ProfileStore,
) -> Result<ProfileStoreReplaceResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        profile_store_replace_blocking(app, expected_revision, store)
    })
    .await
    .map_err(|error| format!("profile_store_replace: {error}"))?
}

pub(crate) fn profile_store_replace_blocking(
    app: AppHandle,
    expected_revision: u64,
    mut store: ProfileStore,
) -> Result<ProfileStoreReplaceResponse, String> {
    let path = store_path(&app)?;
    let current = load_store(&app, &path)?;
    let current_revision = current
        .as_ref()
        .map(|(value, _)| value.revision)
        .unwrap_or(0);
    if current_revision != expected_revision {
        return Err("profile store revision conflict".into());
    }
    store.schema_version = STORE_SCHEMA_VERSION;
    store.revision = current_revision
        .checked_add(1)
        .ok_or_else(|| "profile store revision overflow".to_string())?;
    write_store(&app, &path, &store)?;
    Ok(ProfileStoreReplaceResponse {
        revision: store.revision,
    })
}

// Argon2id (19 МиБ × 3) и файловый I/O. Синхронная Tauri-команда исполняется
// на главном потоке и морозила бы окно на каждом сохранении профиля.
#[tauri::command]
pub async fn profile_store_clear(
    app: AppHandle,
    expected_revision: Option<u64>,
) -> Result<ProfileStoreClearResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        profile_store_clear_blocking(app, expected_revision)
    })
    .await
    .map_err(|error| format!("profile_store_clear: {error}"))?
}

pub(crate) fn profile_store_clear_blocking(
    app: AppHandle,
    expected_revision: Option<u64>,
) -> Result<ProfileStoreClearResponse, String> {
    let path = store_path(&app)?;
    if let Some(expected) = expected_revision {
        let current_revision = load_store(&app, &path)?
            .as_ref()
            .map(|(value, _)| value.revision)
            .unwrap_or(0);
        if current_revision != expected {
            return Err("profile store revision conflict".into());
        }
    }
    let mut removed = 0;
    for candidate in [
        path.clone(),
        backup_path(&path),
        legacy_backup_path(&path),
        temporary_path(&path),
    ] {
        removed += remove_if_exists(&candidate)?;
    }
    removed += cleanup_temp_files(&path)?;
    Ok(ProfileStoreClearResponse { removed })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_store() -> ProfileStore {
        ProfileStore {
            schema_version: STORE_SCHEMA_VERSION,
            revision: 4,
            profiles: vec![serde_json::json!({"id": "p1", "name": "node"})],
            subscriptions: vec![serde_json::json!({"id": "s1", "profiles": []})],
            active: ActiveSelection {
                kind: "single".into(),
                profile_id: Some("p1".into()),
                subscription_id: Some("s1".into()),
            },
            proxy_selection: BTreeMap::new(),
        }
    }

    #[test]
    fn valid_store_roundtrips_and_rejects_dangling_active_ids() {
        let store = sample_store();
        let encoded = serde_json::to_vec(&store).unwrap();
        let decoded: ProfileStore = serde_json::from_slice(&encoded).unwrap();
        assert!(validate_store(&decoded).is_ok());
        let mut broken = decoded;
        broken.active.profile_id = Some("missing".into());
        assert!(validate_store(&broken).is_err());
    }

    #[test]
    fn duplicate_ids_and_invalid_kind_are_rejected() {
        let mut duplicate = sample_store();
        duplicate.profiles.push(serde_json::json!({"id": "p1"}));
        assert!(validate_store(&duplicate).is_err());
        let mut bad_kind = sample_store();
        bad_kind.active.kind = "other".into();
        assert!(validate_store(&bad_kind).is_err());
        let mut bad_selection = sample_store();
        bad_selection
            .proxy_selection
            .insert("single:1\n".into(), "node".into());
        assert!(validate_store(&bad_selection).is_err());
    }

    #[test]
    fn size_limit_is_enforced() {
        let mut store = sample_store();
        store.profiles.push(serde_json::json!({
            "id": "large",
            "value": "x".repeat(MAX_STORE_BYTES),
        }));
        assert!(serialized_store(&store).is_err());
    }
}
