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
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::vpn::ProbeProxyEndpoint;

const CF_API_BASE: &str = "https://api.cloudflareclient.com/v0a2158";
const CF_UA: &str = "okhttp/3.12.1";
const CF_CLIENT_VERSION: &str = "a-6.10-2158";
const MAX_CF_API_RESPONSE_BYTES: usize = 1024 * 1024;
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

// В установленной версии warp.json хранится versioned DPAPI-envelope (см.
// secrets.rs). Full Portable по умолчанию не записывает новый секрет; после
// явного пароля используется переносимый Argon2id/XChaCha envelope. Легаси
// plaintext читается для миграции, но не остаётся форматом новых записей.
fn read_info(app: &AppHandle) -> Option<WarpInfo> {
    let p = storage_path(app).ok()?;
    for candidate in [
        p.clone(),
        p.with_extension("json.bak"),
        p.with_extension("json.legacy.bak"),
    ] {
        let Ok(bytes) = std::fs::read(&candidate) else {
            continue;
        };
        let legacy_plaintext = crate::secrets::is_plaintext_json(&bytes);
        let Ok(plain) = crate::secrets::open_for_app(app, &bytes) else {
            continue;
        };
        let Ok(info) = serde_json::from_slice::<WarpInfo>(&plain) else {
            continue;
        };
        if legacy_plaintext && crate::secrets::can_persist_secrets() {
            match crate::secrets::seal_for_app(app, &plain) {
                Ok(sealed) => {
                    if let Err(error) = crate::secrets::migrate_legacy_blob(
                        &candidate,
                        &sealed,
                        "WARP legacy migration",
                    ) {
                        eprintln!("WARP legacy migration failed: {error}");
                    }
                }
                Err(error) => eprintln!("WARP legacy sealing failed: {error}"),
            }
        }
        return Some(info);
    }
    None
}

fn write_info(app: &AppHandle, info: &WarpInfo) -> Result<(), String> {
    let p = storage_path(app)?;
    let s = serde_json::to_string(info).map_err(|e| format!("serialize: {e}"))?;
    let sealed = crate::secrets::seal_for_app(app, s.as_bytes())?;
    crate::atomic_file::write_bytes_replace(&p, &sealed, "warp state")
}

// Удаляем ВСЕ копии, а не до первой ошибки. Прежний вариант выходил на первом
// отказе (файл занят, права), и остальные — включая основной warp.json с
// приватным ключом — оставались на диске. Приложение продолжало их читать, то
// есть «Сбросить WARP» отчитывался об ошибке, а секрет никуда не девался.
fn delete_info(app: &AppHandle) -> Result<(), String> {
    let p = storage_path(app)?;
    let mut errors = Vec::new();
    for file in [
        p.clone(),
        p.with_extension("json.new"),
        p.with_extension("json.bak"),
        p.with_extension("json.legacy.bak"),
    ] {
        if !file.exists() {
            continue;
        }
        if let Err(e) = std::fs::remove_file(&file) {
            errors.push(format!("{}: {e}", file.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "не удалось удалить состояние WARP: {}",
            errors.join("; ")
        ))
    }
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

// Регистрация ходит в CF через поднятый туннель, а не напрямую: у части
// провайдеров api.cloudflareclient.com напрямую просто не отвечает (TCP
// открывается, запрос виснет до таймаута), и кнопка «Зарегистрировать» тогда
// не работает вообще. Явный proxy, а не системный: в режиме «Прокси» системных
// настроек нет, а полагаться на них — значит работать только в одном режиме
// из трёх.
fn http_client(via: Option<&ProbeProxyEndpoint>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(CF_UA)
        .timeout(std::time::Duration::from_secs(20));
    builder = match via {
        Some(endpoint) => builder.proxy(
            reqwest::Proxy::all(format!("http://{}", endpoint.address))
                .map_err(|e| format!("proxy: {e}"))?,
        ),
        // Без туннеля — строго напрямую. Системный прокси может указывать на наш
        // же инбаунд, которого сейчас нет, и тогда ошибка была бы про него.
        None => builder.no_proxy(),
    };
    builder.build().map_err(|e| format!("reqwest: {e}"))
}

// Локальный инбаунд работающего рантайма, если он есть.
fn tunnel_endpoint(app: &AppHandle) -> Option<ProbeProxyEndpoint> {
    let state = app.try_state::<crate::vpn::SingboxState>()?;
    crate::vpn::probe_endpoint_for_generation(&state, None)
        .ok()
        .map(|(_, endpoint)| endpoint)
}

fn parse_cf_response<T: DeserializeOwned>(label: &str, text: &str) -> Result<T, String> {
    // Ответ регистрации содержит access token и WireGuard-конфигурацию, PATCH
    // может содержать данные лицензии. Никогда не добавляем response body в IPC-
    // ошибку: её показывает WebView, и секреты попали бы в alert/скриншот.
    serde_json::from_str(text).map_err(|e| {
        // Даже Display у serde может включить ошибочное значение из JSON.
        // Наружу отдаём только позицию, полностью независимую от содержимого.
        format!(
            "{label} parse error at line {}, column {}",
            e.line(),
            e.column()
        )
    })
}

async fn cf_register(
    public_key_b64: &str,
    via: Option<&ProbeProxyEndpoint>,
) -> Result<CfRegResp, String> {
    let client = http_client(via)?;
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
    let text =
        crate::util::read_response_text_capped(resp, MAX_CF_API_RESPONSE_BYTES, "cf reg").await?;
    if !status.is_success() {
        return Err(format!("cf reg {status}"));
    }
    parse_cf_response("cf reg", &text)
}

async fn cf_patch_account(
    id: &str,
    token: &str,
    license: &str,
    via: Option<&ProbeProxyEndpoint>,
) -> Result<CfPatchAccountResp, String> {
    let client = http_client(via)?;
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
    let text =
        crate::util::read_response_text_capped(resp, MAX_CF_API_RESPONSE_BYTES, "cf patch").await?;
    if !status.is_success() {
        return Err(format!("cf patch {status}"));
    }
    parse_cf_response("cf patch", &text)
}

async fn cf_delete(id: &str, token: &str, via: Option<&ProbeProxyEndpoint>) -> Result<(), String> {
    let client = http_client(via)?;
    let resp = client
        .delete(format!("{CF_API_BASE}/reg/{id}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("CF-Client-Version", CF_CLIENT_VERSION)
        .send()
        .await
        .map_err(|e| format!("cf delete: {e}"))?;
    let status = resp.status();
    // 204 No Content / 200 ok / 404 (уже удалён) — всё считаем успехом
    if status.is_success() || status == 404 {
        return Ok(());
    }
    let _ = crate::util::read_response_text_capped(resp, MAX_CF_API_RESPONSE_BYTES, "cf delete")
        .await?;
    Err(format!("cf delete {status}"))
}

/// Регистрирует новое WARP-устройство. license=None — бесплатный WARP, при
/// наличии 26-символьного ключа — активирует WARP+. Если устройство уже было
/// зарегистрировано — старое удаляется только после commit новой регистрации.
#[tauri::command]
pub async fn warp_register(app: AppHandle, license: Option<String>) -> Result<WarpInfo, String> {
    let _operation = WARP_OPERATION_LOCK.lock().await;
    let via = tunnel_endpoint(&app);
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
    let reg = cf_register(&pub_b64, via.as_ref()).await?;
    if let Err(e) = validate_registration(&reg) {
        let _ = cf_delete(&reg.id, &reg.token, via.as_ref()).await;
        return Err(e);
    }

    // 4) Опциональная активация WARP+ (длина ключа уже провалидирована выше).
    let (warp_plus, account_type, license_used) = match &license {
        Some(l) => {
            let patch = match cf_patch_account(&reg.id, &reg.token, l, via.as_ref()).await {
                Ok(patch) => patch,
                Err(e) => {
                    let _ = cf_delete(&reg.id, &reg.token, via.as_ref()).await;
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
        let _ = cf_delete(&reg.id, &reg.token, via.as_ref()).await;
        return Err(e);
    }
    // Commit состоялся — только теперь старая registration больше не нужна.
    if let Some(old) = old.filter(|o| !o.registration_id.trim().is_empty()) {
        if let Err(e) = cf_delete(&old.registration_id, &old.access_token, via.as_ref()).await {
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
    let via = tunnel_endpoint(&app);
    if let Some(old) = read_info(&app) {
        if !old.registration_id.trim().is_empty() {
            let _ = cf_delete(&old.registration_id, &old.access_token, via.as_ref()).await;
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

    #[test]
    fn cloudflare_parse_errors_never_echo_response_secrets() {
        let secret = "access-token-that-must-not-leak";
        let body = format!(r#"{{"id":"registration-id","token":"{secret}"}}"#);
        let error = parse_cf_response::<CfRegResp>("cf reg", &body).unwrap_err();
        assert!(!error.contains(secret));
        assert!(!error.contains(&body));
    }
}
