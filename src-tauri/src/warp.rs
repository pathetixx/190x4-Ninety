// WARP: регистрация WireGuard-устройства в Cloudflare API + опциональная
// активация WARP+ лицензии. Хранилище — app_config_dir/warp.json.
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
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use x25519_dalek::{PublicKey, StaticSecret};

const CF_API_BASE: &str = "https://api.cloudflareclient.com/v0a2158";
const CF_UA: &str = "okhttp/3.12.1";
const CF_CLIENT_VERSION: &str = "a-6.10-2158";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WarpInfo {
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
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("warp.json"))
}

fn read_info(app: &AppHandle) -> Option<WarpInfo> {
    let p = storage_path(app).ok()?;
    let s = std::fs::read_to_string(&p).ok()?;
    serde_json::from_str(&s).ok()
}

fn write_info(app: &AppHandle, info: &WarpInfo) -> Result<(), String> {
    let p = storage_path(app)?;
    let s = serde_json::to_string_pretty(info).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&p, s).map_err(|e| format!("write {}: {}", p.display(), e))
}

fn delete_info(app: &AppHandle) -> Result<(), String> {
    let p = storage_path(app)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("remove {}: {}", p.display(), e))?;
    }
    Ok(())
}

fn gen_wg_keypair() -> (String, String) {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    (B64.encode(secret.to_bytes()), B64.encode(public.as_bytes()))
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
/// зарегистрировано — старое удаляется до перерегистрации.
#[tauri::command]
pub async fn warp_register(
    app: AppHandle,
    license: Option<String>,
) -> Result<WarpInfo, String> {
    // 1) Удалить старое устройство если было (best-effort)
    if let Some(old) = read_info(&app) {
        let _ = cf_delete(&old.account_id, &old.access_token).await;
    }

    // 2) Сгенерировать ключевую пару WG
    let (priv_b64, pub_b64) = gen_wg_keypair();

    // 3) POST /reg
    let reg = cf_register(&pub_b64).await?;

    // 4) Опциональная активация WARP+
    let (warp_plus, account_type, license_used) = match &license {
        Some(l) if l.len() == 26 => {
            let patch = cf_patch_account(&reg.id, &reg.token, l).await?;
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
        account_id: reg.account.id.clone(),
        access_token: reg.token.clone(),
        private_key: priv_b64,
        peer_public_key: reg
            .config
            .peers
            .first()
            .map(|p| p.public_key.clone())
            .unwrap_or_default(),
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

    write_info(&app, &info)?;
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
    if let Some(old) = read_info(&app) {
        let _ = cf_delete(&old.account_id, &old.access_token).await;
    }
    delete_info(&app)?;
    Ok(())
}
