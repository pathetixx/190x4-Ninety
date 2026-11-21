// Ninety · device identifier for subscription panels.
//
// Panels with a device limit (the Happ header standard, implemented in
// Remnawave) identify the device by the `x-hwid` header. We must not give the panel
// the real Windows MachineGuid: it is a global machine identifier,
// shared by all programs. Instead a one-way derivative is sent —
// it is stable across Ninety reinstalls, but the original value can't be
// recovered from it and it doesn't match other programs.

use blake2::{Blake2s256, Digest};
use serde::Serialize;

const HWID_DOMAIN: &[u8] = b"ninety-hwid-v1:";
const SCOPED_HWID_DOMAIN: &[u8] = b"ninety-hwid-scope-v1:";
// Remnawave validates the HWID as `^[a-zA-Z0-9=-]{10,64}$`, so the derivative
// is hex-encoded (fits the allowed alphabet) and truncated to 32
// characters: that's enough for uniqueness and stays below the upper bound.
const HWID_CHARS: usize = 32;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    /// `None` when a stable machine identifier is unavailable. Then the HWID
    /// is created by the frontend — random and stored in the app state.
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

/// HWID for a single subscription provider. A shared identifier, the same for
/// all panels, let two providers match that it is the same
/// device. Here each panel (by subscription host) gets its own value;
/// converting one into another without the base identifier is impossible, and the base itself
/// is sent as is only to subscriptions added before this scheme appeared.
pub(crate) fn scoped_hwid(base: &str, host: &str) -> String {
    let mut hasher = Blake2s256::new();
    hasher.update(SCOPED_HWID_DOMAIN);
    hasher.update(base.as_bytes());
    hasher.update(b"\n");
    hasher.update(host.to_ascii_lowercase().as_bytes());
    hex_prefix(&hasher.finalize(), HWID_CHARS)
}

#[cfg(target_os = "windows")]
fn machine_seed() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    // KEY_WOW64_64KEY: under WOW64 redirection would return a different key, and
    // the HWID would change with the process bitness.
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
pub(crate) fn os_version() -> String {
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
pub(crate) fn os_version() -> String {
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
    fn scoped_hwid_differs_per_provider_and_hides_the_base() {
        let base = "0123456789abcdef0123456789abcdef";
        let first = scoped_hwid(base, "panel.example");
        assert_eq!(first, scoped_hwid(base, "PANEL.example"));
        assert_eq!(first.len(), HWID_CHARS);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, base);
        assert_ne!(first, scoped_hwid(base, "other.example"));
        assert_ne!(
            first,
            scoped_hwid("fedcba9876543210fedcba9876543210", "panel.example")
        );
    }

    #[test]
    fn hex_prefix_truncates_to_an_odd_length() {
        assert_eq!(hex_prefix(&[0x0a, 0xbc, 0xde], 5), "0abcd");
        assert_eq!(hex_prefix(&[0x0a], 8), "0a");
    }
}
