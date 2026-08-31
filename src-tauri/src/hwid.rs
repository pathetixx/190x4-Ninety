// Ninety · идентификатор устройства для подписочных панелей.
//
// Панели с лимитом устройств (стандарт заголовков Happ, реализованный в
// Remnawave) опознают устройство по заголовку `x-hwid`. Отдавать панели
// настоящий Windows MachineGuid нельзя: это глобальный идентификатор машины,
// общий для всех программ. Вместо него уходит односторонняя производная —
// она стабильна между переустановками Ninety, но исходное значение из неё
// не восстанавливается и с другими программами не совпадает.

use blake2::{Blake2s256, Digest};
use serde::Serialize;

const HWID_DOMAIN: &[u8] = b"ninety-hwid-v1:";
// Remnawave валидирует HWID как `^[a-zA-Z0-9=-]{10,64}$`, поэтому производная
// кодируется hex'ом (укладывается в разрешённый алфавит) и обрезается до 32
// символов: этого хватает для уникальности и не упирается в верхнюю границу.
const HWID_CHARS: usize = 32;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    /// `None`, когда стабильный машинный идентификатор недоступен. Тогда HWID
    /// заводит фронтенд — случайный и сохранённый в состоянии приложения.
    pub hwid: Option<String>,
    pub device_os: String,
    pub ver_os: String,
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

fn derive_hwid(seed: &str) -> String {
    let mut hasher = Blake2s256::new();
    hasher.update(HWID_DOMAIN);
    hasher.update(seed.as_bytes());
    let digest = hasher.finalize();
    hex_prefix(&digest, HWID_CHARS)
}

#[cfg(target_os = "windows")]
fn machine_seed() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    // KEY_WOW64_64KEY: под WOW64 перенаправление отдало бы другой раздел, и
    // HWID менялся бы вместе с разрядностью процесса.
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Cryptography",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .ok()?;
    let guid: String = key.get_value("MachineGuid").ok()?;
    let guid = guid.trim().to_ascii_lowercase();
    if guid.is_empty() {
        None
    } else {
        Some(guid)
    }
}

#[cfg(not(target_os = "windows"))]
fn machine_seed() -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn os_version() -> String {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        KEY_READ | KEY_WOW64_64KEY,
    ) else {
        return String::new();
    };
    let major: u32 = key.get_value("CurrentMajorVersionNumber").unwrap_or(0);
    let minor: u32 = key.get_value("CurrentMinorVersionNumber").unwrap_or(0);
    let build: String = key.get_value("CurrentBuild").unwrap_or_default();
    if major == 0 {
        return String::new();
    }
    let build = build.trim();
    if build.is_empty() {
        format!("{major}.{minor}")
    } else {
        format!("{major}.{minor}.{build}")
    }
}

#[cfg(not(target_os = "windows"))]
fn os_version() -> String {
    String::new()
}

#[tauri::command]
pub fn device_identity() -> DeviceIdentity {
    DeviceIdentity {
        hwid: machine_seed().as_deref().map(derive_hwid),
        device_os: "Windows".to_string(),
        ver_os: os_version(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_hwid_is_stable_and_panel_compatible() {
        let first = derive_hwid("6b9e0f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
        let second = derive_hwid("6b9e0f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
        assert_eq!(first, second);
        assert_eq!(first.len(), HWID_CHARS);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn derived_hwid_hides_the_machine_guid() {
        let guid = "6b9e0f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
        let derived = derive_hwid(guid);
        assert_ne!(derived, guid);
        assert!(!derived.contains("6b9e0f3a"));
        assert_ne!(derived, derive_hwid("6b9e0f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5c"));
    }

    #[test]
    fn hex_prefix_truncates_to_an_odd_length() {
        assert_eq!(hex_prefix(&[0x0a, 0xbc, 0xde], 5), "0abcd");
        assert_eq!(hex_prefix(&[0x0a], 8), "0a");
    }
}
