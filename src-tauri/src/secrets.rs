// Ninety · политика хранения чувствительных данных.
//
// Установленная сборка использует DPAPI текущего Windows-пользователя. В
// Full Portable DPAPI непереносим, поэтому режим по умолчанию —
// NoPersistentSecrets: новые секреты не записываются без явного пароля.
// После задания пароля он живёт только в памяти процесса; envelope portable
// использует Argon2id + XChaCha20-Poly1305 и переносится между компьютерами.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use zeroize::Zeroizing;

pub const DPAPI_MAGIC: &[u8] = b"N90DPAPI1";
pub const PORTABLE_MAGIC: &[u8] = b"N90PORT1";
const PORTABLE_PLAINTEXT_CONFIRMATION: &[u8] = b"N90PLAIN1";
const PORTABLE_SALT_BYTES: usize = 16;
const PORTABLE_NONCE_BYTES: usize = 24;
const PORTABLE_KEY_BYTES: usize = 32;
const MIN_PASSPHRASE_CHARS: usize = 12;
const MAX_PASSPHRASE_CHARS: usize = 512;
const ARGON2_MEMORY_KIB: u32 = 19 * 1024;
const ARGON2_ITERATIONS: u32 = 3;

static PORTABLE_PASSPHRASE: OnceLock<Mutex<Option<Zeroizing<String>>>> = OnceLock::new();

fn passphrase_slot() -> &'static Mutex<Option<Zeroizing<String>>> {
    PORTABLE_PASSPHRASE.get_or_init(|| Mutex::new(None))
}

fn current_passphrase() -> Result<Option<Zeroizing<String>>, String> {
    let guard = passphrase_slot()
        .lock()
        .map_err(|_| "хранилище portable-пароля заблокировано".to_string())?;
    Ok(guard
        .as_ref()
        .map(|value| Zeroizing::new(value.as_str().to_owned())))
}

fn validate_passphrase(passphrase: &str) -> Result<(), String> {
    let chars = passphrase.chars().count();
    if !(MIN_PASSPHRASE_CHARS..=MAX_PASSPHRASE_CHARS).contains(&chars) {
        return Err(format!(
            "пароль portable должен содержать от {MIN_PASSPHRASE_CHARS} до {MAX_PASSPHRASE_CHARS} символов"
        ));
    }
    if passphrase.chars().any(char::is_control) {
        return Err("пароль portable не должен содержать управляющие символы".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PortableSecretMode {
    #[serde(rename = "dpapi")]
    Dpapi,
    NoPersistentSecrets,
    PassphraseEncrypted,
    PlaintextExplicitlyConfirmed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableSecretStatus {
    pub portable: bool,
    pub mode: PortableSecretMode,
    pub configured: bool,
    pub passphrase_configured: bool,
    pub plaintext_confirmed: bool,
    pub has_persisted_secrets: bool,
}

fn plaintext_confirmation_path() -> Result<PathBuf, String> {
    Ok(crate::app_paths::portable_root()?
        .join("config")
        .join("portable-secrets-plaintext.confirmed"))
}

fn plaintext_confirmed() -> bool {
    plaintext_confirmation_path()
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .is_some_and(|bytes| is_plaintext_confirmation(&bytes))
}

fn clear_plaintext_confirmation() -> Result<(), String> {
    let path = plaintext_confirmation_path()?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "не удалось отключить plaintext portable-режим: {error}"
        )),
    }
}

/// Все контейнеры, которые проходят через `seal_for_app`. Резервные копии тоже
/// в списке: файл, оставшийся под прежним ключом, — это данные, которые уже
/// нечем открыть.
const PORTABLE_SECRET_FILES: [&str; 9] = [
    "config/state-backup.json",
    "config/state-backup.json.bak",
    "config/state-backup.json.legacy.bak",
    "config/profile-store.v1",
    "config/profile-store.v1.bak",
    "config/profile-store.v1.legacy.bak",
    "config/warp.json",
    "config/warp.json.bak",
    "config/warp.json.legacy.bak",
];

fn portable_secret_files() -> Vec<PathBuf> {
    let Ok(root) = crate::app_paths::portable_root() else {
        return Vec::new();
    };
    PORTABLE_SECRET_FILES
        .iter()
        .map(|name| root.join(name))
        .filter(|path| path.is_file())
        .collect()
}

fn portable_has_persisted_secrets() -> bool {
    !portable_secret_files().is_empty()
}

/// Проверка пароля по уже существующему контейнеру. Без неё опечатка при вводе
/// молча заводила второй ключ: старые файлы переставали открываться, а новые
/// записи уходили под неверный пароль — восстановить данные было уже нечем.
/// Отсутствие envelope на диске — не ошибка: это первый запуск portable.
fn verify_portable_passphrase(passphrase: &str) -> Result<(), String> {
    for path in portable_secret_files() {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if !is_portable_envelope(&bytes) {
            continue;
        }
        return unseal_portable(&bytes, passphrase).map(|_| ());
    }
    Ok(())
}

/// Перешифровка всех контейнеров под новый пароль.
///
/// Сначала читаем и перешифровываем ВСЁ в память и только потом пишем: частично
/// сменённый ключ означал бы, что часть профилей открывается старым паролем,
/// часть новым, и ни один из них не открывает всё. Если запись всё же оборвётся
/// на середине, откатываем уже заменённые файлы к исходным байтам.
fn rekey_portable_secrets(current: &str, next: &str) -> Result<(), String> {
    let mut staged: Vec<(PathBuf, Vec<u8>, Vec<u8>)> = Vec::new();
    for path in portable_secret_files() {
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("не удалось прочитать {}: {error}", path.display()))?;
        let plain = if is_portable_envelope(&bytes) {
            Zeroizing::new(unseal_portable(&bytes, current)?)
        } else if is_plaintext_json(&bytes) {
            Zeroizing::new(bytes.clone())
        } else {
            // DPAPI-блоб рядом с portable-хранилищем не наш: чужой ключ мы не
            // перевыпускаем и файл не трогаем.
            continue;
        };
        staged.push((path, bytes, seal_portable(&plain, next)?));
    }

    let mut written: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for (path, previous, sealed) in staged {
        if let Err(error) =
            crate::atomic_file::write_bytes_replace(&path, &sealed, "portable secret rekey")
        {
            for (done, original) in written {
                let _ = crate::atomic_file::write_bytes_replace(
                    &done,
                    &original,
                    "portable secret rekey rollback",
                );
            }
            return Err(format!("смена пароля отменена: {error}"));
        }
        written.push((path, previous));
    }
    Ok(())
}

pub fn can_persist_secrets() -> bool {
    if !crate::app_paths::is_portable() {
        return true;
    }
    current_passphrase().ok().flatten().is_some() || plaintext_confirmed()
}

pub fn is_portable_envelope(bytes: &[u8]) -> bool {
    bytes.starts_with(PORTABLE_MAGIC)
}

fn is_plaintext_confirmation(bytes: &[u8]) -> bool {
    bytes == PORTABLE_PLAINTEXT_CONFIRMATION
}

/// Миграция сначала сохраняет уже запечатанную rollback-копию, затем
/// атомарно заменяет primary. Исходный plaintext никогда не копируется в
/// backup-файл: при установленном режиме backup также DPAPI-sealed, а в
/// portable — encrypted envelope либо сознательно подтверждённый plaintext.
pub fn migrate_legacy_blob(path: &Path, sealed: &[u8], label: &str) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "legacy secret path has no valid filename".to_string())?;
    let base_name = name.strip_suffix(".bak").unwrap_or(name);
    let rollback = path.with_file_name(format!("{base_name}.legacy.bak"));
    let replace_plaintext_rollback = std::fs::read(&rollback)
        .ok()
        .is_some_and(|bytes| is_plaintext_json(&bytes));
    if !rollback.exists() || replace_plaintext_rollback {
        crate::atomic_file::write_bytes_replace(
            &rollback,
            sealed,
            &format!("{label} rollback backup"),
        )?;
    }
    crate::atomic_file::write_bytes_replace(path, sealed, label)
}

#[tauri::command]
pub fn portable_secrets_status() -> PortableSecretStatus {
    let portable = crate::app_paths::is_portable();
    let passphrase_configured = current_passphrase().ok().flatten().is_some();
    let plaintext_mode_confirmed = portable && plaintext_confirmed();
    PortableSecretStatus {
        portable,
        mode: if !portable {
            PortableSecretMode::Dpapi
        } else if passphrase_configured {
            PortableSecretMode::PassphraseEncrypted
        } else if plaintext_mode_confirmed {
            PortableSecretMode::PlaintextExplicitlyConfirmed
        } else {
            PortableSecretMode::NoPersistentSecrets
        },
        configured: passphrase_configured || plaintext_mode_confirmed,
        passphrase_configured,
        plaintext_confirmed: plaintext_mode_confirmed,
        has_persisted_secrets: portable && portable_has_persisted_secrets(),
    }
}

/// Сохраняет пароль только в памяти текущего процесса. В release UI эта
/// команда вызывается после явного действия пользователя из Settings.
pub fn configure_portable_passphrase(passphrase: String) -> Result<(), String> {
    if !crate::app_paths::is_portable() {
        return Err("пароль нужен только для portable-режима".into());
    }
    validate_passphrase(&passphrase)?;
    // Выбор шифрования отменяет ранее подтверждённый plaintext-режим. Если
    // marker не удаётся убрать, не меняем текущий режим и не создаём новый
    // секретный файл с неоднозначной политикой.
    clear_plaintext_confirmation()?;
    // Два разных действия под одной командой. Ключа в памяти нет — это
    // разблокировка сессии, и пароль обязан открыть то, что уже лежит на диске.
    // Ключ есть — это смена пароля, и она обязана перевыпустить ВСЕ контейнеры
    // до того, как старый ключ будет забыт: иначе профили, backup и WARP просто
    // перестают открываться, а UI при этом обещает «Сменить пароль».
    match current_passphrase()? {
        None => verify_portable_passphrase(&passphrase)?,
        Some(current) if current.as_str() == passphrase => {}
        Some(current) => rekey_portable_secrets(current.as_str(), &passphrase)?,
    }
    let mut guard = passphrase_slot()
        .lock()
        .map_err(|_| "хранилище portable-пароля заблокировано".to_string())?;
    *guard = Some(Zeroizing::new(passphrase));
    Ok(())
}

// Смена пароля перевыпускает все контейнеры (Argon2id на каждый) — это
// заведомо не работа для главного потока.
#[tauri::command]
pub async fn portable_secrets_set_passphrase(passphrase: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        portable_secrets_set_passphrase_blocking(passphrase)
    })
    .await
    .map_err(|error| format!("portable_secrets_set_passphrase: {error}"))?
}

fn portable_secrets_set_passphrase_blocking(passphrase: String) -> Result<(), String> {
    configure_portable_passphrase(passphrase)
}

#[tauri::command]
pub async fn portable_secrets_clear_passphrase() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || portable_secrets_clear_passphrase_blocking())
        .await
        .map_err(|error| format!("portable_secrets_clear_passphrase: {error}"))?
}

fn portable_secrets_clear_passphrase_blocking() -> Result<(), String> {
    if !crate::app_paths::is_portable() {
        return Err("пароль нужен только для portable-режима".into());
    }
    clear_plaintext_confirmation()?;
    let mut guard = passphrase_slot()
        .lock()
        .map_err(|_| "хранилище portable-пароля заблокировано".to_string())?;
    *guard = None;
    Ok(())
}

/// Разрешает portable plaintext только отдельным действием пользователя с
/// предупреждением в UI. Сам по себе legacy plaintext такой режим не включает.
#[tauri::command]
pub async fn portable_secrets_confirm_plaintext() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || portable_secrets_confirm_plaintext_blocking())
        .await
        .map_err(|error| format!("portable_secrets_confirm_plaintext: {error}"))?
}

fn portable_secrets_confirm_plaintext_blocking() -> Result<(), String> {
    if !crate::app_paths::is_portable() {
        return Err("plaintext-режим нужен только для portable-сборки".into());
    }
    if current_passphrase()?.is_some() {
        return Err(
            "сначала отключите passphrase, затем отдельно подтвердите plaintext-режим".into(),
        );
    }
    let path = plaintext_confirmation_path()?;
    crate::atomic_file::write_bytes_replace(
        &path,
        PORTABLE_PLAINTEXT_CONFIRMATION,
        "portable plaintext confirmation",
    )
}

fn derive_portable_key(
    passphrase: &str,
    salt: &[u8],
) -> Result<Zeroizing<[u8; PORTABLE_KEY_BYTES]>, String> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        1,
        Some(PORTABLE_KEY_BYTES),
    )
    .map_err(|_| "не удалось настроить Argon2id".to_string())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; PORTABLE_KEY_BYTES]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key[..])
        .map_err(|_| "не удалось получить ключ portable-хранилища".to_string())?;
    Ok(key)
}

fn seal_portable(data: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; PORTABLE_SALT_BYTES];
    let mut nonce = [0u8; PORTABLE_NONCE_BYTES];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let key = derive_portable_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| "не удалось создать portable-шифр".to_string())?;
    let nonce_arg = XNonce::try_from(&nonce[..])
        .map_err(|_| "не удалось подготовить nonce portable-шифра".to_string())?;
    let encrypted = cipher
        .encrypt(
            &nonce_arg,
            Payload {
                msg: data,
                aad: PORTABLE_MAGIC,
            },
        )
        .map_err(|_| "не удалось зашифровать portable-секрет".to_string())?;

    let mut envelope = Vec::with_capacity(
        PORTABLE_MAGIC.len() + PORTABLE_SALT_BYTES + PORTABLE_NONCE_BYTES + encrypted.len(),
    );
    envelope.extend_from_slice(PORTABLE_MAGIC);
    envelope.extend_from_slice(&salt);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&encrypted);
    Ok(envelope)
}

fn unseal_portable(bytes: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    let header = PORTABLE_MAGIC.len() + PORTABLE_SALT_BYTES + PORTABLE_NONCE_BYTES;
    if !bytes.starts_with(PORTABLE_MAGIC) || bytes.len() < header + 16 {
        return Err("portable-секрет имеет неизвестный формат".into());
    }
    let salt_start = PORTABLE_MAGIC.len();
    let nonce_start = salt_start + PORTABLE_SALT_BYTES;
    let ciphertext_start = nonce_start + PORTABLE_NONCE_BYTES;
    let key = derive_portable_key(passphrase, &bytes[salt_start..nonce_start])?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| "не удалось создать portable-шифр".to_string())?;
    let nonce_arg = XNonce::try_from(&bytes[nonce_start..ciphertext_start])
        .map_err(|_| "portable-секрет имеет неизвестный формат".to_string())?;
    cipher
        .decrypt(
            &nonce_arg,
            Payload {
                msg: &bytes[ciphertext_start..],
                aad: PORTABLE_MAGIC,
            },
        )
        .map_err(|_| "неверный пароль portable-хранилища или повреждённый файл".into())
}

pub fn seal_for_app(_app: &AppHandle, data: &[u8]) -> Result<Vec<u8>, String> {
    if crate::app_paths::is_portable() {
        if let Some(passphrase) = current_passphrase()? {
            return seal_portable(data, passphrase.as_str());
        }
        if plaintext_confirmed() {
            return Ok(data.to_vec());
        }
        Err(
            "portable-хранилище выключено: задайте пароль или отдельно подтвердите plaintext-режим"
                .into(),
        )
    } else {
        seal(data)
    }
}

/// Открывает новый envelope, легаси DPAPI-блоб или легаси plaintext JSON. JSON
/// принимается только как полностью валидный объект, чтобы случайный бинарный
/// файл не был принят за секрет.
pub fn open_for_app(_app: &AppHandle, bytes: &[u8]) -> Result<Vec<u8>, String> {
    if is_portable_envelope(bytes) {
        let passphrase = current_passphrase()?
            .ok_or("portable-хранилище заперто: задайте пароль в настройках")?;
        return unseal_portable(bytes, passphrase.as_str());
    }
    if is_plaintext_json(bytes) {
        return Ok(bytes.to_vec());
    }
    unseal(bytes)
}

/// Легаси plaintext распознаём по `{`, но только после полной JSON-проверки.
/// Это оставляет миграцию старых `warp.json`/backup безопасной и детерминированной.
pub fn is_plaintext_json(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace())
        == Some(b'{')
        && serde_json::from_slice::<serde_json::Value>(bytes).is_ok()
}

#[cfg(target_os = "windows")]
pub fn seal(data: &[u8]) -> Result<Vec<u8>, String> {
    let protected = win::protect(data)?;
    let mut envelope = Vec::with_capacity(DPAPI_MAGIC.len() + protected.len());
    envelope.extend_from_slice(DPAPI_MAGIC);
    envelope.extend_from_slice(&protected);
    Ok(envelope)
}

#[cfg(target_os = "windows")]
pub fn unseal(data: &[u8]) -> Result<Vec<u8>, String> {
    let payload = data.strip_prefix(DPAPI_MAGIC).unwrap_or(data);
    win::unprotect(payload)
}

#[cfg(not(target_os = "windows"))]
pub fn seal(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut envelope = Vec::with_capacity(DPAPI_MAGIC.len() + data.len());
    envelope.extend_from_slice(DPAPI_MAGIC);
    envelope.extend_from_slice(data);
    Ok(envelope)
}

#[cfg(not(target_os = "windows"))]
pub fn unseal(data: &[u8]) -> Result<Vec<u8>, String> {
    data.strip_prefix(DPAPI_MAGIC)
        .map(ToOwned::to_owned)
        .ok_or_else(|| "DPAPI недоступен в этой сборке".into())
}

#[cfg(target_os = "windows")]
mod win {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
        v
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let mut out: CRYPT_INTEGER_BLOB = std::mem::zeroed();
            CryptProtectData(
                &blob(data),
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|_| "Windows не смогла зашифровать DPAPI-секрет".to_string())?;
            Ok(take(out))
        }
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let mut out: CRYPT_INTEGER_BLOB = std::mem::zeroed();
            CryptUnprotectData(
                &blob(data),
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|_| "не удалось открыть DPAPI-секрет".to_string())?;
            Ok(take(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_json_requires_complete_object() {
        assert!(is_plaintext_json(b"{\"a\":1}"));
        assert!(is_plaintext_json(b"  \n\t{}"));
        assert!(!is_plaintext_json(b"{\"a\":"));
        assert!(!is_plaintext_json(b"[]"));
        assert!(!is_plaintext_json(b"\x01\x00\x00\x00blob"));
    }

    #[test]
    fn portable_envelope_roundtrip_and_wrong_password_fail() {
        let secret = b"{\"private_key\":\"abc\"}";
        let sealed = seal_portable(secret, "correct horse battery staple").expect("seal");
        assert!(is_portable_envelope(&sealed));
        assert!(!is_plaintext_json(&sealed));
        assert_eq!(
            unseal_portable(&sealed, "correct horse battery staple").unwrap(),
            secret
        );
        assert!(unseal_portable(&sealed, "wrong horse battery staple").is_err());
    }

    #[test]
    fn dpapi_envelope_has_magic_and_roundtrips_in_dev() {
        let secret = b"{\"private_key\":\"abc\"}";
        let sealed = seal(secret).expect("seal");
        assert!(sealed.starts_with(DPAPI_MAGIC));
        assert!(!is_plaintext_json(&sealed));
        assert_eq!(unseal(&sealed).expect("unseal"), secret);
    }

    #[test]
    fn passphrase_policy_is_bounded() {
        assert!(validate_passphrase("short").is_err());
        assert!(validate_passphrase("long enough portable passphrase").is_ok());
        assert!(validate_passphrase("long enough\npassphrase").is_err());
    }

    #[test]
    fn plaintext_mode_requires_exact_confirmation_marker() {
        assert!(is_plaintext_confirmation(PORTABLE_PLAINTEXT_CONFIRMATION));
        assert!(!is_plaintext_confirmation(b"N90PLAIN1\n"));
        assert!(!is_plaintext_confirmation(b"plaintext"));
    }

    #[test]
    fn legacy_migration_keeps_an_encrypted_rollback_copy() {
        let root = std::env::temp_dir().join(format!(
            "ninety-secret-migration-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("state-backup.json");
        let legacy = br#"{"private_key":"abc"}"#;
        std::fs::write(&path, legacy).unwrap();
        let sealed = seal(legacy).unwrap();

        migrate_legacy_blob(&path, &sealed, "test migration").unwrap();
        let rollback = root.join("state-backup.json.legacy.bak");
        assert!(!is_plaintext_json(&std::fs::read(&path).unwrap()));
        assert!(!is_plaintext_json(&std::fs::read(&rollback).unwrap()));
        assert_eq!(unseal(&std::fs::read(&rollback).unwrap()).unwrap(), legacy);
        let _ = std::fs::remove_dir_all(&root);
    }
}
