// Ninety · обратная связь из приложения.
//
// Сообщение уходит POST'ом на собственный релей, а тот пересылает его в
// Telegram. Прямой вызов Telegram Bot API из клиента невозможен в принципе:
// токен бота пришлось бы вшить в общедоступный бинарь, и первый же читатель
// исходников получил бы полный контроль над ботом.
//
// Идентификатор устройства уходит не сырым: он нужен серверу, чтобы держать
// лимит на устройство и точечно банить спамера, но связывать по нему
// пользователя с его подпиской нельзя. Поэтому HWID хешируется здесь ещё раз,
// с ОТДЕЛЬНЫМ доменом: получатель обратной связи и панель подписки видят
// разные значения, и сопоставить их между собой нельзя.

use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const ENDPOINT: &str = "https://190x4.pw/api/ninety/feedback";
const FEEDBACK_ID_DOMAIN: &[u8] = b"ninety-feedback-v1:";
const ID_CHARS: usize = 32;
const TEXT_MIN: usize = 10;
const TEXT_MAX: usize = 2000;
const CONTACT_MAX: usize = 120;
const TIMEOUT: Duration = Duration::from_secs(25);
/// Ответ релея — короткий JSON статуса. Читаем его с тем же потолком, что и
/// остальные внешние ответы (util::read_response_capped): без него ошибочный
/// или подменённый хост мог бы отдать тело любого размера.
const MAX_RELAY_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackInput {
    pub text: String,
    #[serde(default)]
    pub contact: String,
    /// HWID устройства из состояния фронтенда — наружу уходит только его хеш.
    #[serde(default)]
    pub device_seed: String,
    /// Сколько окно было открыто до отправки: сервер отсекает мгновенные
    /// отправки как заведомо не-человеческие.
    #[serde(default)]
    pub form_age_ms: u64,
    #[serde(default)]
    pub lang: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackPayload<'a> {
    text: &'a str,
    contact: &'a str,
    device: String,
    form_age_ms: u64,
    lang: &'a str,
    version: String,
    os: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RelayReply {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    retry_after: Option<u64>,
}

fn hex_prefix(bytes: &[u8], chars: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(chars);
    for byte in bytes {
        if out.len() >= chars {
            break;
        }
        out.push(HEX[(byte >> 4) as usize] as char);
        if out.len() >= chars {
            break;
        }
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn feedback_id(seed: &str) -> String {
    let mut hasher = Blake2s256::new();
    hasher.update(FEEDBACK_ID_DOMAIN);
    hasher.update(seed.as_bytes());
    hex_prefix(&hasher.finalize(), ID_CHARS)
}

/// Обрезаем по СИМВОЛАМ, а не по байтам: `String::truncate` по индексу байта
/// паникует на середине многобайтового символа, а кириллица здесь норма.
fn clip(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect()
}

#[tauri::command]
pub async fn send_feedback(app: tauri::AppHandle, input: FeedbackInput) -> Result<(), String> {
    let text = clip(&input.text, TEXT_MAX);
    if text.chars().count() < TEXT_MIN {
        return Err("too_short".into());
    }
    if input.device_seed.trim().is_empty() {
        return Err("no_device".into());
    }

    let contact = clip(&input.contact, CONTACT_MAX);
    let lang = clip(&input.lang, 8);
    let payload = FeedbackPayload {
        text: &text,
        contact: &contact,
        device: feedback_id(input.device_seed.trim()),
        form_age_ms: input.form_age_ms,
        lang: &lang,
        version: tauri::Manager::package_info(&app).version.to_string(),
        os: crate::hwid::os_version(),
    };

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("Ninety/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("client: {e}"))?;

    let response = client
        .post(ENDPOINT)
        .json(&payload)
        .send()
        .await
        .map_err(|_| "network".to_string())?;

    let status = response.status();
    let body = crate::util::read_response_capped(response, MAX_RELAY_RESPONSE_BYTES, "feedback")
        .await
        .unwrap_or_default();
    let reply: RelayReply = serde_json::from_slice(&body).unwrap_or_default();
    if status.is_success() && reply.ok {
        return Ok(());
    }
    if status.as_u16() == 429 {
        // Сервер — единственный авторитет по лимиту: клиентский отсчёт живёт в
        // localStorage и снимается очисткой данных.
        return Err(format!(
            "rate_limited:{}",
            reply.retry_after.unwrap_or(21_600)
        ));
    }
    Err(reply
        .error
        .unwrap_or_else(|| format!("http_{}", status.as_u16())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_id_is_stable_hex_and_differs_from_raw_seed() {
        let id = feedback_id("seed-value");
        assert_eq!(id.len(), ID_CHARS);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(id, feedback_id("seed-value"));
        assert_ne!(id, feedback_id("seed-value2"));
        assert!(!id.contains("seed-value"));
    }

    #[test]
    fn clip_counts_characters_not_bytes() {
        // Кириллица по два байта: обрезка по байтам сломала бы строку.
        assert_eq!(clip("  привет мир  ", 6), "привет");
        assert_eq!(clip("abc", 10), "abc");
    }
}
