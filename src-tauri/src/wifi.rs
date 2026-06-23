// Ninety · определение текущей Wi-Fi сети (III.3 — авто-защита на чужих сетях).
// Тонкий слой: отдаём фронту SSID + защищена ли сеть. ПОЛИТИКУ (доверенные сети,
// авто-переключение в TUN) держит фронт — так в Rust минимум FFI, а решения и
// allowlist живут рядом с остальным UI-состоянием. Только чтение, без админ-прав.

use serde::Serialize;

#[derive(Serialize, Default, Clone)]
pub struct WifiInfo {
    pub connected: bool, // подключены к Wi-Fi прямо сейчас
    pub ssid: String,    // имя сети ("" если неизвестно/не Wi-Fi)
    pub secured: bool,   // true = шифрование включено (WPA/WEP); false = открытая
}

/// Текущая Wi-Fi сеть (для авто-защиты на чужих сетях). На не-Windows и при
/// отсутствии Wi-Fi-адаптера возвращает connected=false.
#[tauri::command]
pub fn current_wifi() -> WifiInfo {
    #[cfg(target_os = "windows")]
    {
        win::current().unwrap_or_default()
    }
    #[cfg(not(target_os = "windows"))]
    {
        WifiInfo::default()
    }
}

#[cfg(target_os = "windows")]
mod win {
    use super::WifiInfo;
    use windows::core::GUID;
    use windows::Win32::Foundation::{ERROR_SUCCESS, HANDLE};
    use windows::Win32::NetworkManagement::WiFi::*;

    pub fn current() -> Option<WifiInfo> {
        unsafe {
            let mut handle = HANDLE::default();
            let mut negotiated: u32 = 0;
            // Версия клиента 2 (Vista+). None preserved.
            if WlanOpenHandle(2, None, &mut negotiated, &mut handle) != ERROR_SUCCESS.0 {
                return None;
            }
            let result = enum_and_query(handle);
            let _ = WlanCloseHandle(handle, None);
            result
        }
    }

    unsafe fn enum_and_query(handle: HANDLE) -> Option<WifiInfo> {
        let mut list_ptr: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        if WlanEnumInterfaces(handle, None, &mut list_ptr) != ERROR_SUCCESS.0 || list_ptr.is_null() {
            return None;
        }
        let list = &*list_ptr;
        let items = std::slice::from_raw_parts(
            list.InterfaceInfo.as_ptr(),
            list.dwNumberOfItems as usize,
        );
        let mut out = None;
        for it in items {
            if it.isState == wlan_interface_state_connected {
                if let Some(info) = query_connection(handle, &it.InterfaceGuid) {
                    out = Some(info);
                    break;
                }
            }
        }
        WlanFreeMemory(list_ptr as *const core::ffi::c_void);
        out
    }

    unsafe fn query_connection(handle: HANDLE, guid: &GUID) -> Option<WifiInfo> {
        let mut size: u32 = 0;
        let mut data: *mut core::ffi::c_void = std::ptr::null_mut();
        let rc = WlanQueryInterface(
            handle,
            guid,
            wlan_intf_opcode_current_connection,
            None,
            &mut size,
            &mut data,
            None,
        );
        if rc != ERROR_SUCCESS.0 || data.is_null() {
            return None;
        }
        let attr = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
        let ssid = &attr.wlanAssociationAttributes.dot11Ssid;
        let len = (ssid.uSSIDLength as usize).min(ssid.ucSSID.len());
        let name = String::from_utf8_lossy(&ssid.ucSSID[..len]).to_string();
        // Открытая сеть = шифрование выключено ИЛИ auth = OPEN.
        let sec = &attr.wlanSecurityAttributes;
        let secured = sec.bSecurityEnabled.as_bool()
            && sec.dot11AuthAlgorithm != DOT11_AUTH_ALGO_80211_OPEN;
        WlanFreeMemory(data);
        Some(WifiInfo { connected: true, ssid: name, secured })
    }
}
