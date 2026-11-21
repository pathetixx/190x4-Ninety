// Ninety · in-app feedback.
//
// The message goes via POST to our own relay, which forwards it to
// Telegram. Calling the Telegram Bot API directly from the client is impossible in principle:
// the bot token would have to be baked into a public binary, and the very first reader
// of the sources would get full control over the bot.
//
// The device identifier isn't sent raw: the server needs it to enforce
// a per-device limit and ban a spammer precisely, but it must not be usable to link
// the user to their subscription. So the HWID is hashed here once more,
// with a SEPARATE domain: the feedback recipient and the subscription panel see
// different values, and they cannot be matched to each other.

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
/// The relay's response is a short status JSON. We read it with the same cap as
/// other external responses (util::read_response_capped): without it an erroneous
/// or spoofed host could return a body of any size.
const MAX_RELAY_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackInput {
    pub text: String,
    #[serde(default)]
    pub contact: String,
    /// Device HWID from the frontend state — only its hash goes out.
    #[serde(default)]
    pub device_seed: String,
    /// How long the window was open before sending: the server cuts off instant
    /// submissions as obviously non-human.
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

/// Truncate by CHARACTERS, not bytes: `String::truncate` at a byte index
/// panics in the middle of a multibyte character, and Cyrillic is normal here.
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

    let client = crate::util::direct_client_builder()
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
        // The server is the only authority on the limit: the client-side countdown lives in
        // localStorage and is removed by clearing data.
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
        // Cyrillic takes two bytes per character: truncating by bytes would break the string.
        assert_eq!(clip("  привет мир  ", 6), "привет");
        assert_eq!(clip("abc", 10), "abc");
    }
}
