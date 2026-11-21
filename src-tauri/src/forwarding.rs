// Ninety · IP forwarding on the external interface (issue #168).
//
// In TUN the engines' own traffic goes out via a process_name → direct rule, and
// direct is bound to the physical adapter (auto_detect_interface, IP_UNICAST_IF).
// On a machine where Windows forwards packets between interfaces (leftovers of sharing
// the internet from the PC, IPEnableRouter=1, Set-NetIPInterface -Forwarding Enabled),
// this binding doesn't hold the traffic: the core's direct connection lands in
// TUN again, the core sends it direct again — a loop. From the outside it looks like
// endless "Checking", tens of thousands of sing-box sockets and not a single byte.
//
// We don't touch the settings themselves: forwarding is sometimes needed deliberately (Hyper-V, WSL,
// sharing). We only read them and tell the person exactly what is in the way.
//
// We look not at all interfaces but at those the default route
// goes through: that's what direct binds to. Forwarding on an internal
// virtual switch without internet access doesn't create a loop, and complaining about it
// would mean scaring every WSL owner. We don't check the SharedAccess service
// either: on Windows 11 it often runs on its own (mobile
// hotspot), and enabled sharing is revealed by the same forwarding on the interface.
//
// The answer is ternary, like the IPv6 probe: None — nothing to judge by (the snapshot
// failed). Unknown must not turn into either an alarm or "all
// clear" — the frontend then simply stays silent.

use serde::Serialize;

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardingStatus {
    /// IPEnableRouter=1 in the registry: forwarding comes back after every reboot,
    /// even if you turn it off on the interface.
    pub router_enabled: bool,
    /// External interfaces (with a default route) on which forwarding
    /// is enabled right now. A non-empty list is the problem.
    pub interfaces: Vec<ForwardingInterface>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardingInterface {
    pub alias: String,
    /// "ipv4" | "ipv6" — the fix command names the family explicitly.
    pub family: &'static str,
}

#[tauri::command]
pub async fn system_forwarding_status() -> Result<Option<ForwardingStatus>, String> {
    #[cfg(windows)]
    {
        // The same scaffolding as system_ipv6_available: a Win32 snapshot off
        // the webview thread, a panic doesn't cross the IPC boundary, the promise settles.
        tauri::async_runtime::spawn_blocking(|| {
            std::panic::catch_unwind(windows_impl::probe)
                .unwrap_or_else(|_| Err("forwarding probe panicked".into()))
        })
        .await
        .map_err(|_| "forwarding probe did not run".to_string())?
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

/// Ninety's own interface: its routes and flags aren't about the system.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_own_tun(alias: &str) -> bool {
    alias.eq_ignore_ascii_case("ninety-tun")
}

#[cfg(windows)]
mod windows_impl {
    use super::{is_own_tun, ForwardingInterface, ForwardingStatus};
    use std::collections::HashSet;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::NetworkManagement::IpHelper::{
        ConvertInterfaceLuidToAlias, FreeMibTable, GetIpForwardTable2, GetIpInterfaceTable,
        MIB_IPFORWARD_TABLE2, MIB_IPINTERFACE_TABLE,
    };
    use windows::Win32::NetworkManagement::Ndis::NET_LUID_LH;
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC};

    pub fn probe() -> Result<Option<ForwardingStatus>, String> {
        let upstream = default_route_interfaces()?;
        let mut interfaces = Vec::new();

        let mut table: *mut MIB_IPINTERFACE_TABLE = std::ptr::null_mut();
        // SAFETY: table is an output pointer; on success Windows puts into it
        // a table that FreeMibTable frees in MibTable::drop.
        let rc = unsafe { GetIpInterfaceTable(AF_UNSPEC, &mut table) };
        if rc != ERROR_SUCCESS || table.is_null() {
            return Err(format!("GetIpInterfaceTable: code {}", rc.0));
        }
        let _guard = MibTable(table as *const core::ffi::c_void);
        // SAFETY: the table is valid until the drop guard; NumEntries rows lie contiguously.
        let rows = unsafe {
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize)
        };
        for row in rows {
            if !row.ForwardingEnabled || !row.Connected {
                continue;
            }
            let family = row.Family.0;
            // SAFETY: NET_LUID_LH is a union, Value covers it entirely.
            let luid = unsafe { row.InterfaceLuid.Value };
            if !upstream.contains(&(luid, family)) {
                continue;
            }
            let alias = alias_of(&row.InterfaceLuid);
            if is_own_tun(&alias) {
                continue;
            }
            let family = if family == AF_INET6.0 { "ipv6" } else { "ipv4" };
            interfaces.push(ForwardingInterface { alias, family });
        }

        Ok(Some(ForwardingStatus {
            router_enabled: router_enabled(),
            interfaces,
        }))
    }

    /// (LUID, family) of the interfaces the default route goes through.
    fn default_route_interfaces() -> Result<HashSet<(u64, u16)>, String> {
        let mut table: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
        // SAFETY: as with GetIpInterfaceTable above.
        let rc = unsafe { GetIpForwardTable2(AF_UNSPEC, &mut table) };
        if rc != ERROR_SUCCESS || table.is_null() {
            return Err(format!("GetIpForwardTable2: code {}", rc.0));
        }
        let _guard = MibTable(table as *const core::ffi::c_void);
        // SAFETY: the table is valid until the drop guard; NumEntries rows lie contiguously.
        let rows = unsafe {
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize)
        };
        let mut out = HashSet::new();
        for row in rows {
            if row.DestinationPrefix.PrefixLength != 0 {
                continue;
            }
            // SAFETY: SOCKADDR_INET is a union, si_family is common to all variants;
            // NET_LUID_LH is a union, Value covers it entirely.
            let (family, luid) = unsafe {
                (
                    row.DestinationPrefix.Prefix.si_family.0,
                    row.InterfaceLuid.Value,
                )
            };
            if family == AF_INET.0 || family == AF_INET6.0 {
                out.insert((luid, family));
            }
        }
        Ok(out)
    }

    fn alias_of(luid: &NET_LUID_LH) -> String {
        // NDIS_IF_MAX_STRING_SIZE + 1.
        let mut buf = [0u16; 257];
        // SAFETY: luid is a live snapshot entry, buf is passed as a slice with its length.
        let rc = unsafe { ConvertInterfaceLuidToAlias(luid, &mut buf) };
        if rc != ERROR_SUCCESS {
            return String::new();
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }

    fn router_enabled() -> bool {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters")
            .and_then(|key| key.get_value::<u32, _>("IPEnableRouter"))
            .is_ok_and(|value| value != 0)
    }

    struct MibTable(*const core::ffi::c_void);

    impl Drop for MibTable {
        fn drop(&mut self) {
            // SAFETY: the pointer was obtained from GetIp*Table* and is freed exactly once.
            unsafe { FreeMibTable(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn own_tun_is_recognised_by_alias() {
        assert!(super::is_own_tun("ninety-tun"));
        assert!(super::is_own_tun("Ninety-TUN"));
        assert!(!super::is_own_tun("Ethernet"));
    }

    // The probe must ALWAYS answer: it is called on the connect path and from
    // diagnostics. The value depends on the machine, so we check the contract.
    #[cfg(windows)]
    #[test]
    fn probe_always_answers() {
        let result = super::windows_impl::probe();
        assert!(result.is_ok(), "проба вернула ошибку: {result:?}");
        println!("system_forwarding_status -> {:?}", result.unwrap());
    }
}
