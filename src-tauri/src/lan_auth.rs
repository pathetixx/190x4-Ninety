// Ninety · логин и пароль для «Доступа из локальной сети».
//
// Пара живёт рядом с остальными секретами (DPAPI или пароль portable-хранилища,
// см. secrets.rs), а не в настройках WebView: localStorage лежит на диске
// открытым текстом. Фронт получает её только для показа в настройках, а в
// конфиг ядра её подставляет start_singbox (apply_to_config) — пара, пришедшая
// из конфига фронта, не принимается.

use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

const FILE_NAME: &str = "lan-auth.json";
// Тег входа для соседей с паролем (buildInbounds в singbox.js).
const LAN_INBOUND_TAG: &str = "mixed-lan";
const USERNAME_DEFAULT: &str = "ninety";
const MAX_CHARS: usize = 64;
const PASSWORD_CHARS: usize = 16;
// Без похожих символов (0/O, 1/l/I): пароль переписывают с экрана ПК в ТВ.
const PASSWORD_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct LanCredentials {
    pub username: String,
    pub password: String,
}

// Логин и пароль набирают руками на телефоне или в ТВ: только печатный ASCII
// без пробелов, а в логине ещё и без «:», который HTTP Basic считает
// разделителем логина и пароля.
fn sanitize_username(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(*c, '.' | '_' | '-'))
        .take(MAX_CHARS)
        .collect()
}

fn sanitize_password(value: &str) -> String {
    value
        .chars()
        .filter(char::is_ascii_graphic)
        .take(MAX_CHARS)
        .collect()
}

impl LanCredentials {
    fn is_valid(&self) -> bool {
        !self.username.is_empty()
            && self.username == sanitize_username(&self.username)
            && !self.password.is_empty()
            && self.password == sanitize_password(&self.password)
    }
}

fn generate_password(rng: &mut impl RngCore) -> String {
    // Хвост диапазона байта отбрасываем, иначе первые символы алфавита
    // выпадали бы чаще остальных.
    let limit = 256 - (256 % PASSWORD_ALPHABET.len());
    let mut out = String::with_capacity(PASSWORD_CHARS);
    while out.len() < PASSWORD_CHARS {
        let mut byte = [0u8; 1];
        rng.fill_bytes(&mut byte);
        let value = usize::from(byte[0]);
        if value < limit {
            out.push(char::from(
                PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.len()],
            ));
        }
    }
    out
}

/// Пустое после очистки поле — просьба придумать новое значение, а не снять
/// пароль: открыть вход без пароля можно только выключив сам пароль.
fn apply_update(
    current: Option<LanCredentials>,
    username: Option<&str>,
    password: Option<&str>,
    rng: &mut impl RngCore,
) -> LanCredentials {
    let current = current.filter(LanCredentials::is_valid);
    let username = username
        .map(sanitize_username)
        .or_else(|| current.as_ref().map(|c| c.username.clone()))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| USERNAME_DEFAULT.to_string());
    let password = password
        .map(sanitize_password)
        .or_else(|| current.as_ref().map(|c| c.password.clone()))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| generate_password(rng));
    LanCredentials { username, password }
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join(FILE_NAME))
}

fn read(app: &AppHandle) -> Result<Option<LanCredentials>, String> {
    let path = storage_path(app)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("чтение пароля для локальной сети: {e}")),
    };
    let plain = zeroize::Zeroizing::new(crate::secrets::open_for_app(app, &bytes)?);
    Ok(serde_json::from_slice::<LanCredentials>(&plain)
        .ok()
        .filter(LanCredentials::is_valid))
}

fn write(app: &AppHandle, credentials: &LanCredentials) -> Result<(), String> {
    let path = storage_path(app)?;
    let plain = zeroize::Zeroizing::new(
        serde_json::to_vec(credentials).map_err(|e| format!("serialize: {e}"))?,
    );
    let sealed = crate::secrets::seal_for_app(app, &plain)?;
    crate::atomic_file::write_bytes_replace(&path, &sealed, "LAN credentials")
}

fn update(
    app: &AppHandle,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<LanCredentials, String> {
    let _secrets = crate::secrets::secret_io_guard();
    let current = read(app)?;
    let next = apply_update(current.clone(), username, password, &mut OsRng);
    if current.as_ref() != Some(&next) {
        write(app, &next)?;
    }
    Ok(next)
}

/// Пара для показа в настройках. Если её ещё нет — заводит: включение пароля
/// сразу даёт рабочий логин и пароль.
#[tauri::command]
pub fn lan_auth_ensure(app: AppHandle) -> Result<LanCredentials, String> {
    update(&app, None, None)
}

/// Меняет логин и/или пароль. Пустое поле получает новое значение.
#[tauri::command]
pub fn lan_auth_update(
    app: AppHandle,
    username: Option<String>,
    password: Option<String>,
) -> Result<LanCredentials, String> {
    update(&app, username.as_deref(), password.as_deref())
}

/// Подставляет сохранённую пару во вход для соседей. Пары нет или хранилище
/// заперто — вход убирается: открыть его без пароля нельзя, а остальная сеть
/// (и сам VPN) от этого не страдает.
pub fn apply_to_config(app: &AppHandle, raw: &str) -> String {
    if !has_lan_inbound(raw) {
        return raw.to_string();
    }
    let credentials = {
        let _secrets = crate::secrets::secret_io_guard();
        read(app)
    };
    let credentials = match credentials {
        Ok(credentials) => credentials,
        Err(error) => {
            crate::vpn::append_runtime_diagnostic_at(
                app,
                crate::vpn::DiagnosticLevel::Warn,
                &format!("lan_auth_unavailable error={error}"),
            );
            None
        }
    };
    if credentials.is_none() {
        crate::vpn::append_runtime_diagnostic_at(
            app,
            crate::vpn::DiagnosticLevel::Warn,
            "lan_auth_missing lan_inbound=closed",
        );
    }
    inject_credentials(raw, credentials.as_ref())
}

fn is_lan_inbound(inbound: &serde_json::Value) -> bool {
    inbound.get("tag").and_then(|t| t.as_str()) == Some(LAN_INBOUND_TAG)
}

fn has_lan_inbound(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.get("inbounds")?.as_array().cloned())
        .is_some_and(|inbounds| inbounds.iter().any(is_lan_inbound))
}

fn inject_credentials(raw: &str, credentials: Option<&LanCredentials>) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    let Some(inbounds) = value
        .get_mut("inbounds")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return raw.to_string();
    };
    match credentials.filter(|c| c.is_valid()) {
        Some(credentials) => {
            for inbound in inbounds
                .iter_mut()
                .filter(|inbound| is_lan_inbound(inbound))
            {
                if let Some(object) = inbound.as_object_mut() {
                    object.insert(
                        "users".into(),
                        serde_json::json!([{
                            "username": credentials.username,
                            "password": credentials.password,
                        }]),
                    );
                }
            }
        }
        None => inbounds.retain(|inbound| !is_lan_inbound(inbound)),
    }
    serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedBytes(Vec<u8>, usize);

    impl RngCore for FixedBytes {
        fn next_u32(&mut self) -> u32 {
            let mut bytes = [0u8; 4];
            self.fill_bytes(&mut bytes);
            u32::from_le_bytes(bytes)
        }

        fn next_u64(&mut self) -> u64 {
            let mut bytes = [0u8; 8];
            self.fill_bytes(&mut bytes);
            u64::from_le_bytes(bytes)
        }

        fn fill_bytes(&mut self, dest: &mut [u8]) {
            for byte in dest {
                *byte = self.0[self.1 % self.0.len()];
                self.1 += 1;
            }
        }

        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
            self.fill_bytes(dest);
            Ok(())
        }
    }

    fn pair(username: &str, password: &str) -> LanCredentials {
        LanCredentials {
            username: username.into(),
            password: password.into(),
        }
    }

    #[test]
    fn generated_password_skips_the_biased_tail_of_a_byte() {
        // 255 отбрасывается целиком, 0 даёт первый символ алфавита.
        let mut rng = FixedBytes(vec![255, 0], 0);
        assert_eq!(generate_password(&mut rng), "A".repeat(PASSWORD_CHARS));
        let random = generate_password(&mut OsRng);
        assert_eq!(random.len(), PASSWORD_CHARS);
        assert!(random.bytes().all(|b| PASSWORD_ALPHABET.contains(&b)));
    }

    #[test]
    fn updates_sanitise_and_never_leave_an_empty_field() {
        let mut rng = FixedBytes(vec![0], 0);
        let first = apply_update(None, None, None, &mut rng);
        assert_eq!(first, pair("ninety", &"A".repeat(PASSWORD_CHARS)));

        let typed = apply_update(
            Some(first.clone()),
            Some("us er:ы"),
            Some(" my pass:wörd\u{7}"),
            &mut rng,
        );
        assert_eq!(typed, pair("user", "mypass:wrd"));

        // Меняется только переданное поле.
        let kept = apply_update(Some(typed.clone()), None, Some("other"), &mut rng);
        assert_eq!(kept, pair("user", "other"));

        let refreshed = apply_update(Some(kept), Some(" "), Some(""), &mut rng);
        assert_eq!(refreshed.username, "ninety");
        assert_eq!(refreshed.password.len(), PASSWORD_CHARS);
    }

    #[test]
    fn stored_pair_replaces_whatever_the_frontend_put_into_the_lan_inbound() {
        let raw = r#"{"inbounds":[
            {"type":"mixed","tag":"mixed-in","listen":"127.0.0.1","listen_port":7890},
            {"type":"mixed","tag":"mixed-lan","listen":"0.0.0.0","listen_port":7891,
             "users":[{"username":"x","password":"y"}]}
        ]}"#;
        let out = inject_credentials(raw, Some(&pair("ninety", "Secret123")));
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            value["inbounds"][1]["users"],
            serde_json::json!([{ "username": "ninety", "password": "Secret123" }])
        );
        assert!(value["inbounds"][0].get("users").is_none());
    }

    // Имя сервера с той же строкой — не вход для соседей.
    #[test]
    fn lan_inbound_is_recognised_by_its_tag_only() {
        let named = r#"{"inbounds":[{"type":"mixed","tag":"mixed-in"}],
            "outbounds":[{"tag":"proxy","name":"mixed-lan"}]}"#;
        assert!(!has_lan_inbound(named));
        assert!(has_lan_inbound(r#"{"inbounds":[{"tag":"mixed-lan"}]}"#));
        assert!(!has_lan_inbound("not json"));
    }

    #[test]
    fn lan_inbound_is_dropped_without_a_valid_pair() {
        let raw = r#"{"inbounds":[
            {"type":"mixed","tag":"mixed-in","listen":"127.0.0.1","listen_port":7890},
            {"type":"mixed","tag":"mixed-lan","listen":"0.0.0.0","listen_port":7891}
        ]}"#;
        for credentials in [None, Some(pair("ninety", ""))] {
            let out = inject_credentials(raw, credentials.as_ref());
            let value: serde_json::Value = serde_json::from_str(&out).unwrap();
            let tags: Vec<_> = value["inbounds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|inbound| inbound["tag"].as_str().unwrap().to_string())
                .collect();
            assert_eq!(tags, ["mixed-in"]);
        }
    }
}
