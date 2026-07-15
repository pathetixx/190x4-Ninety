// WARP: регистрация WireGuard-устройства в Cloudflare API + опциональная
// активация WARP+ лицензии. Хранилище — writable config dir/warp.json.
//
// CF API эндпоинты (публично известны из bepass-org/warp-plus, MIT, и старого
// cloudflare/warp-tunnel-rs):
//   POST   https://api.cloudflareclient.com/v0a2158/reg
//   PATCH  https://api.cloudflareclient.com/v0a2158/reg/{id}/account   (для WARP+)
//   DELETE https://api.cloudflareclient.com/v0a2158/reg/{id}
//
// User-Agent имитирует мобильный клиент CF (иначе CF режет с 403).
// WG-пара генерируется локально через x25519-dalek; публичный ключ
// отправляется в CF, приватный остаётся у нас.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;
use x25519_dalek::{PublicKey, StaticSecret};

const CF_API_BASE: &str = "https://api.cloudflareclient.com/v0a2158";
const CF_UA: &str = "okhttp/3.12.1";
const CF_CLIENT_VERSION: &str = "a-6.10-2158";
static WARP_OPERATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WarpInfo {
    /// Top-level registration/device id used by /reg/{id} endpoints.
    #[serde(default)]
    pub registration_id: String,
    /// Cloudflare account id (metadata only; never use as registration id).
    pub account_id: String,
    pub access_token: String,
    pub private_key: String,
    pub peer_public_key: String,
    pub local_ipv4: String,
    pub local_ipv6: String,
    pub client_id: String,
    pub license: Option<String>,
    pub warp_plus: bool,
    pub account_type: String,
    pub registered_at: String,
}

#[derive(Debug, Deserialize)]
struct CfRegResp {
    id: String,
    token: String,
    account: CfAccount,
    config: CfConfig,
}

#[derive(Debug, Deserialize)]
struct CfAccount {
    id: String,
    #[serde(default)]
    warp_plus: bool,
    #[serde(default)]
    account_type: String,
    // прочие поля ответа CF (license и т.п.) не используем — serde их игнорит.
    // Лицензию в WarpInfo кладём введённую юзером (license_used), не account.license.
}

#[derive(Debug, Deserialize)]
struct CfConfig {
    peers: Vec<CfPeer>,
    interface: CfInterface,
    #[serde(default)]
    client_id: String,
}

#[derive(Debug, Deserialize)]
struct CfPeer {
    // из пира берём только публичный ключ; endpoint (host/v4/v6) из ответа
    // регистрации не используем — адрес выхода подбирает warp_scan_endpoints.
    public_key: String,
}

#[derive(Debug, Deserialize)]
struct CfInterface {
    addresses: CfAddresses,
}

#[derive(Debug, Deserialize)]
struct CfAddresses {
    #[serde(default)]
    v4: String,
    #[serde(default)]
    v6: String,
}

#[derive(Debug, Deserialize)]
struct CfPatchAccountResp {
    #[serde(default)]
    warp_plus: bool,
    #[serde(default)]
    account_type: String,
    #[serde(default)]
    license: String,
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("warp.json"))
}

// В установленной версии warp.json хранится DPAPI-блобом (см. secrets.rs).
// Full Portable хранит JSON рядом с переносимым WebView-профилем: DPAPI сделал
// бы его нечитаемым после переноса на другой ПК. Легаси plaintext читается как есть.
fn read_info(app: &AppHandle) -> Option<WarpInfo> {
    let p = storage_path(app).ok()?;
    let bytes = std::fs::read(&p).ok()?;
    if crate::secrets::is_plaintext_json(&bytes) {
        let info: WarpInfo = serde_json::from_slice(&bytes).ok()?;
        // Миграция установленной версии на DPAPI (best-effort). Portable
        // намеренно оставляет переносимый plaintext без бессмысленной перезаписи.
        #[cfg(target_os = "windows")]
        if !crate::app_paths::is_portable() {
            let _ = write_info(app, &info);
        }
        return Some(info);
    }
    let plain = crate::secrets::unseal(&bytes).ok()?;
    serde_json::from_slice(&plain).ok()
}

fn write_info(app: &AppHandle, info: &WarpInfo) -> Result<(), String> {
    let p = storage_path(app)?;
    let s = serde_json::to_string(info).map_err(|e| format!("serialize: {e}"))?;
    let sealed = crate::secrets::seal_for_app(app, s.as_bytes())?;
    crate::atomic_file::write_bytes_replace(&p, &sealed, "warp state")
}

fn delete_info(app: &AppHandle) -> Result<(), String> {
    let p = storage_path(app)?;
    for file in [
        p.clone(),
        p.with_extension("json.new"),
        p.with_extension("json.bak"),
    ] {
        if file.exists() {
            std::fs::remove_file(&file).map_err(|e| format!("remove {}: {e}", file.display()))?;
        }
    }
    Ok(())
}

fn gen_wg_keypair() -> (String, String) {
    let mut private = [0u8; 32];
    OsRng.fill_bytes(&mut private);
    let secret = StaticSecret::from(private);
    private.fill(0);
    let public = PublicKey::from(&secret);
    (B64.encode(secret.to_bytes()), B64.encode(public.as_bytes()))
}

fn validate_registration(reg: &CfRegResp) -> Result<(), String> {
    if reg.id.trim().is_empty() || reg.token.trim().is_empty() {
        return Err("cf reg: missing registration id or access token".into());
    }
    let peer = reg
        .config
        .peers
        .first()
        .map(|p| p.public_key.trim())
        .filter(|p| !p.is_empty())
        .ok_or("cf reg: missing peer public key")?;
    let peer_raw = B64
        .decode(peer)
        .map_err(|e| format!("cf reg: invalid peer key: {e}"))?;
    if peer_raw.len() != 32 {
        return Err(format!(
            "cf reg: peer key has {} bytes, expected 32",
            peer_raw.len()
        ));
    }
    if reg.config.interface.addresses.v4.trim().is_empty()
        && reg.config.interface.addresses.v6.trim().is_empty()
    {
        return Err("cf reg: missing interface addresses".into());
    }
    let client_id = B64
        .decode(reg.config.client_id.trim())
        .map_err(|e| format!("cf reg: invalid client id: {e}"))?;
    if client_id.len() < 3 {
        return Err(format!(
            "cf reg: client id has {} bytes, expected at least 3",
            client_id.len()
        ));
    }
    Ok(())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(CF_UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("reqwest: {e}"))
}

async fn cf_register(public_key_b64: &str) -> Result<CfRegResp, String> {
    let client = http_client()?;
    // install_id и fcm_token — псевдо-id мобильного устройства; CF не валидирует
    // их строго, но проверяет факт наличия и UA.
    let install_id = format!("ninety-{}", chrono::Utc::now().timestamp_millis());
    let body = serde_json::json!({
        "install_id": install_id,
        "fcm_token": "",
        "tos": chrono::Utc::now().to_rfc3339(),
        "key": public_key_b64,
        "type": "Android",
        "model": "Ninety/190x4",
        "locale": "en_US",
        "warp_enabled": true,
    });
    let resp = client
        .post(format!("{CF_API_BASE}/reg"))
        .header("CF-Client-Version", CF_CLIENT_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("cf reg: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("cf reg {}: {}", status, text));
    }
    serde_json::from_str::<CfRegResp>(&text).map_err(|e| format!("cf reg parse: {e} (body={text})"))
}

async fn cf_patch_account(
    id: &str,
    token: &str,
    license: &str,
) -> Result<CfPatchAccountResp, String> {
    let client = http_client()?;
    let body = serde_json::json!({ "license": license });
    let resp = client
        .patch(format!("{CF_API_BASE}/reg/{id}/account"))
        .header("Authorization", format!("Bearer {token}"))
        .header("CF-Client-Version", CF_CLIENT_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("cf patch: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("cf patch {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|e| format!("cf patch parse: {e} (body={text})"))
}

async fn cf_delete(id: &str, token: &str) -> Result<(), String> {
    let client = http_client()?;
    let resp = client
        .delete(format!("{CF_API_BASE}/reg/{id}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("CF-Client-Version", CF_CLIENT_VERSION)
        .send()
        .await
        .map_err(|e| format!("cf delete: {e}"))?;
    // 204 No Content / 200 ok / 404 (уже удалён) — всё считаем успехом
    if resp.status().is_success() || resp.status() == 404 {
        return Ok(());
    }
    Err(format!(
        "cf delete {}: {}",
        resp.status(),
        resp.text().await.unwrap_or_default()
    ))
}

/// Регистрирует новое WARP-устройство. license=None — бесплатный WARP, при
/// наличии 26-символьного ключа — активирует WARP+. Если устройство уже было
/// зарегистрировано — старое удаляется только после commit новой регистрации.
#[tauri::command]
pub async fn warp_register(app: AppHandle, license: Option<String>) -> Result<WarpInfo, String> {
    let _operation = WARP_OPERATION_LOCK.lock().await;
    // Ключ WARP+ — ровно 26 символов. Раньше ключ иной длины молча уходил в
    // ветку бесплатного WARP (юзер думал, что активировал WARP+) — теперь это
    // честная ошибка ДО регистрации. UI дублирует проверку локализованно.
    let license = license
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty());
    if let Some(l) = license.as_deref() {
        if l.len() != 26 {
            return Err(format!(
                "WARP+ license key must be 26 characters (got {})",
                l.len()
            ));
        }
    }

    // Старую регистрацию держим рабочей до атомарного commit новой.
    let old = read_info(&app);

    // 2) Сгенерировать ключевую пару WG
    let (priv_b64, pub_b64) = gen_wg_keypair();

    // 3) POST /reg
    let reg = cf_register(&pub_b64).await?;
    if let Err(e) = validate_registration(&reg) {
        let _ = cf_delete(&reg.id, &reg.token).await;
        return Err(e);
    }

    // 4) Опциональная активация WARP+ (длина ключа уже провалидирована выше).
    let (warp_plus, account_type, license_used) = match &license {
        Some(l) => {
            let patch = match cf_patch_account(&reg.id, &reg.token, l).await {
                Ok(patch) => patch,
                Err(e) => {
                    let _ = cf_delete(&reg.id, &reg.token).await;
                    return Err(e);
                }
            };
            (
                patch.warp_plus || reg.account.warp_plus,
                if !patch.account_type.is_empty() {
                    patch.account_type
                } else {
                    reg.account.account_type.clone()
                },
                if patch.license.is_empty() {
                    l.clone()
                } else {
                    patch.license
                },
            )
        }
        _ => (
            reg.account.warp_plus,
            reg.account.account_type.clone(),
            String::new(),
        ),
    };

    let info = WarpInfo {
        registration_id: reg.id.clone(),
        account_id: reg.account.id.clone(),
        access_token: reg.token.clone(),
        private_key: priv_b64,
        peer_public_key: reg.config.peers[0].public_key.clone(),
        local_ipv4: reg.config.interface.addresses.v4.clone(),
        local_ipv6: reg.config.interface.addresses.v6.clone(),
        client_id: reg.config.client_id.clone(),
        license: if license_used.is_empty() {
            None
        } else {
            Some(license_used)
        },
        warp_plus,
        account_type,
        registered_at: chrono::Utc::now().to_rfc3339(),
    };

    if let Err(e) = write_info(&app, &info) {
        let _ = cf_delete(&reg.id, &reg.token).await;
        return Err(e);
    }
    // Commit состоялся — только теперь старая registration больше не нужна.
    if let Some(old) = old.filter(|o| !o.registration_id.trim().is_empty()) {
        if let Err(e) = cf_delete(&old.registration_id, &old.access_token).await {
            eprintln!("WARP old registration cleanup failed: {e}");
        }
    }
    Ok(info)
}

/// Возвращает текущую сохранённую WARP-регистрацию, либо null.
#[tauri::command]
pub fn warp_status(app: AppHandle) -> Result<Option<WarpInfo>, String> {
    Ok(read_info(&app))
}

/// Удаляет WARP-устройство на стороне CF и стирает локальный warp.json.
/// CF-delete best-effort: ошибки сети не блокируют локальную очистку,
/// иначе юзер не сможет «сбросить» когда нет интернета.
#[tauri::command]
pub async fn warp_reset(app: AppHandle) -> Result<(), String> {
    let _operation = WARP_OPERATION_LOCK.lock().await;
    if let Some(old) = read_info(&app) {
        if !old.registration_id.trim().is_empty() {
            let _ = cf_delete(&old.registration_id, &old.access_token).await;
        }
    }
    delete_info(&app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_registration() -> CfRegResp {
        CfRegResp {
            id: "registration-id".into(),
            token: "token".into(),
            account: CfAccount {
                id: "account-id".into(),
                warp_plus: false,
                account_type: "free".into(),
            },
            config: CfConfig {
                peers: vec![CfPeer {
                    public_key: B64.encode([7u8; 32]),
                }],
                interface: CfInterface {
                    addresses: CfAddresses {
                        v4: "172.16.0.2".into(),
                        v6: String::new(),
                    },
                },
                client_id: B64.encode([1u8, 2, 3]),
            },
        }
    }

    #[test]
    fn registration_validation_requires_wireguard_material() {
        let mut reg = valid_registration();
        assert!(validate_registration(&reg).is_ok());
        reg.config.peers.clear();
        assert!(validate_registration(&reg)
            .unwrap_err()
            .contains("peer public key"));
    }

    #[test]
    fn legacy_warp_info_migrates_with_empty_registration_id() {
        let json = r#"{
          "account_id":"legacy-account","access_token":"token","private_key":"private",
          "peer_public_key":"peer","local_ipv4":"172.16.0.2","local_ipv6":"",
          "client_id":"AQID","license":null,"warp_plus":false,
          "account_type":"free","registered_at":"2026-01-01T00:00:00Z"
        }"#;
        let info: WarpInfo = serde_json::from_str(json).unwrap();
        assert!(info.registration_id.is_empty());
        assert_eq!(info.account_id, "legacy-account");
    }
}
