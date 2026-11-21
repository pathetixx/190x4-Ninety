// Ninety · storage policy for sensitive data.
//
// The installed build uses DPAPI of the current Windows user. In
// Full Portable DPAPI isn't portable, so without a password profiles, the backup and WARP
// are written to NinetyData in plain text. The former "save nothing without a password"
// mode silently lost subscriptions on every restart: the user didn't know
// a password was needed at all. The optional password lives only in process memory;
// the envelope uses Argon2id + XChaCha20-Poly1305 and moves between PCs.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use zeroize::Zeroizing;

use crate::util::MutexExt;

pub const DPAPI_MAGIC: &[u8] = b"N90DPAPI1";
pub const PORTABLE_MAGIC: &[u8] = b"N90PORT1";
const PORTABLE_SALT_BYTES: usize = 16;
const PORTABLE_NONCE_BYTES: usize = 24;
const PORTABLE_KEY_BYTES: usize = 32;
const MIN_PASSPHRASE_CHARS: usize = 12;
const MAX_PASSPHRASE_CHARS: usize = 512;
const ARGON2_MEMORY_KIB: u32 = 19 * 1024;
const ARGON2_ITERATIONS: u32 = 3;

static PORTABLE_PASSPHRASE: OnceLock<Mutex<Option<Zeroizing<String>>>> = OnceLock::new();

// Reading and writing containers are serialized with changing and removing the password.
// Re-encryption reads all files, commits them under the new key and only then
// changes the key in memory. A concurrent write (the state backup is written on a timer and
// right after a selection change) without this lock either landed in the window before the commit and
// was lost, or fell under the old key after it — and on the next launch
// the new password no longer opened that file.
static SECRET_IO_LOCK: Mutex<()> = Mutex::new(());

/// Hold for the whole "read and decrypt" or "encrypt and
/// write" of a container. Lock order: first your own storage lock, then
/// this one; re-encryption itself takes only this one.
pub(crate) fn secret_io_guard() -> std::sync::MutexGuard<'static, ()> {
    SECRET_IO_LOCK.lock_recover()
}

fn passphrase_slot() -> &'static Mutex<Option<Zeroizing<String>>> {
    PORTABLE_PASSPHRASE.get_or_init(|| Mutex::new(None))
}

fn current_passphrase() -> Result<Option<Zeroizing<String>>, String> {
    let guard = passphrase_slot()
        .lock()
        .map_err(|_| "portable password store lock is poisoned".to_string())?;
    Ok(guard
        .as_ref()
        .map(|value| Zeroizing::new(value.as_str().to_owned())))
}

fn validate_passphrase(passphrase: &str) -> Result<(), String> {
    let chars = passphrase.chars().count();
    if !(MIN_PASSPHRASE_CHARS..=MAX_PASSPHRASE_CHARS).contains(&chars) {
        return Err(crate::util::i18n_error_with(
            "backend.secrets.passwordLength",
            &[
                ("min", &MIN_PASSPHRASE_CHARS.to_string()),
                ("max", &MAX_PASSPHRASE_CHARS.to_string()),
            ],
        ));
    }
    if passphrase.chars().any(char::is_control) {
        return Err(crate::util::i18n_error("backend.secrets.passwordChars"));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PortableSecretMode {
    #[serde(rename = "dpapi")]
    Dpapi,
    Plaintext,
    PassphraseEncrypted,
    /// There are encrypted files on disk, but no password in memory: nothing can be read or
    /// written until the user enters it.
    Locked,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableSecretStatus {
    pub portable: bool,
    pub mode: PortableSecretMode,
    pub passphrase_configured: bool,
    pub locked: bool,
}

/// All containers that go through `seal_for_app`. Backups are also
/// on the list: a file left under the previous key is data that can no longer
/// be opened.
const PORTABLE_SECRET_FILES: [&str; 10] = [
    "config/state-backup.json",
    "config/state-backup.json.bak",
    "config/state-backup.json.legacy.bak",
    "config/profile-store.v1",
    "config/profile-store.v1.bak",
    "config/profile-store.v1.legacy.bak",
    "config/warp.json",
    "config/warp.json.bak",
    "config/warp.json.legacy.bak",
    "config/lan-auth.json",
];

fn portable_secret_files() -> Vec<PathBuf> {
    let Ok(root) = crate::app_paths::portable_data_dir() else {
        return Vec::new();
    };
    PORTABLE_SECRET_FILES
        .iter()
        .map(|name| root.join(name))
        .filter(|path| path.is_file())
        .collect()
}

fn file_is_portable_envelope(path: &Path) -> bool {
    use std::io::Read;
    let mut prefix = [0u8; PORTABLE_MAGIC.len()];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut prefix))
        .is_ok_and(|()| prefix == PORTABLE_MAGIC)
}

/// At least one container is already encrypted with a password. Without the password in memory such a
/// portable is locked: writing plain text over it would wipe data that
/// can still be opened.
fn portable_envelopes_on_disk() -> bool {
    portable_secret_files()
        .iter()
        .any(|path| file_is_portable_envelope(path))
}

/// Checking the password against an already existing container. Without it a typo on entry
/// silently created a second key: old files stopped opening, while new
/// writes went under the wrong password — there was nothing left to recover the data with.
/// No envelope on disk is not an error: it's the first portable launch.
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

/// Transactional write of a prepared set of containers.
///
/// The caller must re-encrypt EVERYTHING into memory before the first call: a partially
/// changed key would mean some profiles open with the old password,
/// some with the new one, and neither opens everything. If the write still breaks off
/// midway, we roll the already replaced files back to their original bytes.
fn commit_portable_secrets(
    staged: Vec<(PathBuf, Vec<u8>, Vec<u8>)>,
    label: &str,
) -> Result<(), String> {
    let mut written: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for (path, previous, sealed) in staged {
        if let Err(error) = crate::atomic_file::write_bytes_replace(&path, &sealed, label) {
            for (done, original) in written {
                let _ = crate::atomic_file::write_bytes_replace(
                    &done,
                    &original,
                    "portable secret rollback",
                );
            }
            return Err(format!("{label} cancelled: {error}"));
        }
        written.push((path, previous));
    }
    Ok(())
}

/// Re-encrypting all containers under a new password.
fn rekey_portable_secrets(current: &str, next: &str) -> Result<(), String> {
    let mut staged: Vec<(PathBuf, Vec<u8>, Vec<u8>)> = Vec::new();
    for path in portable_secret_files() {
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        let plain = if is_portable_envelope(&bytes) {
            Zeroizing::new(unseal_portable(&bytes, current)?)
        } else if is_plaintext_json(&bytes) {
            Zeroizing::new(bytes.clone())
        } else {
            // A DPAPI blob next to the portable storage isn't ours: we don't reissue
            // someone else's key and don't touch the file.
            continue;
        };
        staged.push((path, bytes, seal_portable(&plain, next)?));
    }
    commit_portable_secrets(staged, "reissue portable secrets")
}

/// Sealing legacy plaintext when the password is enabled for the FIRST time.
///
/// Without this step "enable password" only changed the mode in the status: no envelope
/// appeared on disk, and node UUIDs/passwords, subscription addresses and the WARP private key
/// stayed in plain text until EACH file's next write. Some of them
/// are rewritten rarely or not at all (`warp.json.bak` is written
/// only by old builds, and `read_info` migrates only the first successfully read
/// candidate), so "I'll do it later, on write" doesn't work here.
///
/// Already existing envelopes are left alone: their key is verified separately
/// (`verify_portable_passphrase`), there is nothing to reissue.
fn seal_plaintext_portable_secrets(passphrase: &str) -> Result<(), String> {
    let mut staged: Vec<(PathBuf, Vec<u8>, Vec<u8>)> = Vec::new();
    for path in portable_secret_files() {
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        if !is_plaintext_json(&bytes) {
            continue;
        }
        let plain = Zeroizing::new(bytes.clone());
        staged.push((path, bytes, seal_portable(&plain, passphrase)?));
    }
    commit_portable_secrets(staged, "move portable secrets under a password")
}

/// Removing the password: all envelopes are decrypted back to plain text in a single
/// transaction. Simply forgetting the key isn't possible — the files would stay encrypted, and
/// on the next launch there would be nothing to open them with except the same password.
fn unseal_portable_secrets(current: &str) -> Result<(), String> {
    let mut staged: Vec<(PathBuf, Vec<u8>, Vec<u8>)> = Vec::new();
    for path in portable_secret_files() {
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        if !is_portable_envelope(&bytes) {
            continue;
        }
        let plain = unseal_portable(&bytes, current)?;
        staged.push((path, bytes, plain));
    }
    commit_portable_secrets(staged, "remove the portable password")
}

/// New writes are encrypted: DPAPI in the installed build, the password in portable.
/// Only then does it make sense to rewrite the found legacy plaintext — otherwise
/// the "migration" would shuffle the same bytes across the disk on every read.
pub fn encrypts_writes() -> bool {
    !crate::app_paths::is_portable() || current_passphrase().ok().flatten().is_some()
}

pub fn is_portable_envelope(bytes: &[u8]) -> bool {
    bytes.starts_with(PORTABLE_MAGIC)
}

/// The migration first saves an already sealed rollback copy, then
/// atomically replaces primary. The original plaintext is never copied into
/// the backup file: in the installed mode the backup is also DPAPI-sealed, and in
/// portable with a password — an encrypted envelope.
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
    let locked = portable && !passphrase_configured && portable_envelopes_on_disk();
    PortableSecretStatus {
        portable,
        mode: if !portable {
            PortableSecretMode::Dpapi
        } else if passphrase_configured {
            PortableSecretMode::PassphraseEncrypted
        } else if locked {
            PortableSecretMode::Locked
        } else {
            PortableSecretMode::Plaintext
        },
        passphrase_configured,
        locked,
    }
}

/// Keeps the password only in the current process's memory. In the release UI this
/// command is called after an explicit user action in Settings.
pub fn configure_portable_passphrase(passphrase: String) -> Result<(), String> {
    if !crate::app_paths::is_portable() {
        return Err(crate::util::i18n_error("backend.secrets.portableOnly"));
    }
    validate_passphrase(&passphrase)?;
    let _io = secret_io_guard();
    // Two different actions under one command. No key in memory — this is
    // unlocking the session: the password must open what's already on disk, and
    // legacy plaintext must go under this same key right now. A key exists —
    // this is a password change, and it must reissue ALL containers before
    // the old key is forgotten: otherwise profiles, the backup and WARP simply stop
    // opening, while the UI promises "Change password".
    match current_passphrase()? {
        None => {
            verify_portable_passphrase(&passphrase)?;
            seal_plaintext_portable_secrets(&passphrase)?;
        }
        Some(current) if current.as_str() == passphrase => {}
        Some(current) => rekey_portable_secrets(current.as_str(), &passphrase)?,
    }
    let mut guard = passphrase_slot()
        .lock()
        .map_err(|_| "portable password store lock is poisoned".to_string())?;
    *guard = Some(Zeroizing::new(passphrase));
    Ok(())
}

// A password change reissues all containers (Argon2id for each) — this is
// clearly not a job for the main thread.
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
    tauri::async_runtime::spawn_blocking(portable_secrets_clear_passphrase_blocking)
        .await
        .map_err(|error| format!("portable_secrets_clear_passphrase: {error}"))?
}

fn portable_secrets_clear_passphrase_blocking() -> Result<(), String> {
    if !crate::app_paths::is_portable() {
        return Err(crate::util::i18n_error("backend.secrets.portableOnly"));
    }
    let _io = secret_io_guard();
    match current_passphrase()? {
        Some(current) => unseal_portable_secrets(current.as_str())?,
        None if portable_envelopes_on_disk() => {
            return Err(crate::util::i18n_error("backend.secrets.enterCurrent"));
        }
        None => return Ok(()),
    }
    let mut guard = passphrase_slot()
        .lock()
        .map_err(|_| "portable password store lock is poisoned".to_string())?;
    *guard = None;
    Ok(())
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
    .map_err(|_| "could not configure Argon2id".to_string())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; PORTABLE_KEY_BYTES]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key[..])
        .map_err(|_| "could not derive the portable store key".to_string())?;
    Ok(key)
}

fn seal_portable(data: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; PORTABLE_SALT_BYTES];
    let mut nonce = [0u8; PORTABLE_NONCE_BYTES];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let key = derive_portable_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| "could not create the portable cipher".to_string())?;
    let nonce_arg = XNonce::try_from(&nonce[..])
        .map_err(|_| "could not prepare the portable cipher nonce".to_string())?;
    let encrypted = cipher
        .encrypt(
            &nonce_arg,
            Payload {
                msg: data,
                aad: PORTABLE_MAGIC,
            },
        )
        .map_err(|_| "could not encrypt the portable secret".to_string())?;

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
        return Err(crate::util::i18n_error("backend.secrets.unknownFormat"));
    }
    let salt_start = PORTABLE_MAGIC.len();
    let nonce_start = salt_start + PORTABLE_SALT_BYTES;
    let ciphertext_start = nonce_start + PORTABLE_NONCE_BYTES;
    let key = derive_portable_key(passphrase, &bytes[salt_start..nonce_start])?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| "could not create the portable cipher".to_string())?;
    let nonce_arg = XNonce::try_from(&bytes[nonce_start..ciphertext_start])
        .map_err(|_| crate::util::i18n_error("backend.secrets.unknownFormat"))?;
    cipher
        .decrypt(
            &nonce_arg,
            Payload {
                msg: &bytes[ciphertext_start..],
                aad: PORTABLE_MAGIC,
            },
        )
        .map_err(|_| crate::util::i18n_error("backend.secrets.wrongPassword"))
}

pub fn seal_for_app(_app: &AppHandle, data: &[u8]) -> Result<Vec<u8>, String> {
    if crate::app_paths::is_portable() {
        if let Some(passphrase) = current_passphrase()? {
            return seal_portable(data, passphrase.as_str());
        }
        if portable_envelopes_on_disk() {
            return Err(crate::util::i18n_error("backend.secrets.lockedEnter"));
        }
        Ok(data.to_vec())
    } else {
        seal(data)
    }
}

/// Opens a new envelope, a legacy DPAPI blob or legacy plaintext JSON. JSON
/// is accepted only as a fully valid object, so that a random binary
/// file isn't taken for a secret.
pub fn open_for_app(_app: &AppHandle, bytes: &[u8]) -> Result<Vec<u8>, String> {
    if is_portable_envelope(bytes) {
        let passphrase = current_passphrase()?
            .ok_or_else(|| crate::util::i18n_error("backend.secrets.lockedSet"))?;
        return unseal_portable(bytes, passphrase.as_str());
    }
    if is_plaintext_json(bytes) {
        return Ok(bytes.to_vec());
    }
    unseal(bytes)
}

/// Legacy plaintext is recognized by `{`, but only after a full JSON check.
/// This keeps the migration of old `warp.json`/backup safe and deterministic.
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
        .ok_or_else(|| "DPAPI is unavailable in this build".into())
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
            .map_err(|_| "Windows could not encrypt the DPAPI secret".to_string())?;
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
            .map_err(|_| "could not open the DPAPI secret".to_string())?;
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

    fn scratch_dir(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ninety-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    // Enabling the password must seal legacy plaintext immediately, not
    // "sometime on the next write": some containers (warp.json.bak)
    // are never rewritten, and the node key would stay open on disk.
    #[test]
    fn enabling_a_passphrase_seals_legacy_plaintext_in_one_transaction() {
        let root = scratch_dir("secret-seal");
        let plain = root.join("warp.json.bak");
        let legacy = br#"{"private_key":"abc"}"#;
        std::fs::write(&plain, legacy).unwrap();

        let sealed = seal_portable(legacy, "correct horse battery staple").unwrap();
        let staged = vec![(plain.clone(), legacy.to_vec(), sealed)];
        commit_portable_secrets(staged, "test seal").unwrap();

        let stored = std::fs::read(&plain).unwrap();
        assert!(is_portable_envelope(&stored));
        assert!(!is_plaintext_json(&stored));
        assert_eq!(
            unseal_portable(&stored, "correct horse battery staple").unwrap(),
            legacy
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // A locked portable is detected by the file prefix: a short or
    // plaintext file must not lock writing.
    #[test]
    fn envelope_detection_reads_only_the_magic_prefix() {
        let root = scratch_dir("secret-prefix");
        let sealed = root.join("profile-store.v1");
        std::fs::write(
            &sealed,
            seal_portable(b"{}", "correct horse battery staple").unwrap(),
        )
        .unwrap();
        let plain = root.join("warp.json");
        std::fs::write(&plain, br#"{"private_key":"abc"}"#).unwrap();
        let short = root.join("state-backup.json");
        std::fs::write(&short, b"N90").unwrap();

        assert!(file_is_portable_envelope(&sealed));
        assert!(!file_is_portable_envelope(&plain));
        assert!(!file_is_portable_envelope(&short));
        assert!(!file_is_portable_envelope(&root.join("missing")));
        let _ = std::fs::remove_dir_all(&root);
    }

    // A partially applied key would mean some containers open with
    // the old password, some with the new one, and neither opens everything.
    #[test]
    fn a_failed_write_rolls_every_replaced_container_back() {
        let root = scratch_dir("secret-commit");
        let first = root.join("state-backup.json");
        let original = br#"{"a":1}"#;
        std::fs::write(&first, original).unwrap();
        // The second target is a DIRECTORY: writing to it will certainly fail,
        // and the commit must return the first file to its original bytes.
        let blocked = root.join("profile-store.v1");
        std::fs::create_dir_all(&blocked).unwrap();

        let staged = vec![
            (first.clone(), original.to_vec(), b"sealed-one".to_vec()),
            (blocked, Vec::new(), b"sealed-two".to_vec()),
        ];
        assert!(commit_portable_secrets(staged, "test commit").is_err());
        assert_eq!(std::fs::read(&first).unwrap(), original);
        let _ = std::fs::remove_dir_all(&root);
    }
}
