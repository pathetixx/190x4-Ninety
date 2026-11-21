// Ninety · Whether the system supports IPv6 at all.
//
// The TUN interface gets both an IPv4 and an IPv6 address: auto_route builds routes
// only for the families whose address is on the interface, and without an IPv6 address
// native IPv6 traffic bypasses the tunnel (see tunAddresses in the frontend).
//
// But on a machine where IPv6 is disabled in Windows itself, assigning this address
// fails ("configure tun interface: set ipv6 address: Element not found"), and
// the core dies entirely — TUN mode doesn't come up at all. Nothing is lost by
// skipping it: since the stack is off, there is no IPv6 traffic on such a machine, and
// nothing to protect. So we ask the system before building the config.
//
// We ask not "is there IPv6 connectivity" (that's a separate leak check in
// diagnose.rs — it needs the network and two seconds), but "is the stack bound to adapters".
//
// 🔴 Loopback must be excluded, otherwise the probe is useless. Windows keeps IPv6
// on loopback EVEN when the stack is off everywhere: DisabledComponents is documented
// as "disable IPv6 on all interfaces except loopback". Measured live —
// with the ms_tcpip6 binding removed, Ethernet's flag and address were cleared, while loopback
// kept ::1 and the enabled flag. Counting it, the probe would always answer "yes".
//
// There are two signs and we take both: the IP_ADAPTER_IPV6_ENABLED flag is Windows' direct
// answer, the presence of an IPv6 address confirms that the binding actually
// took place. On a live machine they change together, so the second sign
// is a safeguard, not a contradiction. Pseudo-adapters (WAN Miniport, disabled tunnels)
// don't get here at all: GetAdaptersAddresses without GAA_FLAG_INCLUDE_ALL_INTERFACES
// doesn't return them — also measured, not inferred from the documentation.
//
// The answer is deliberately ternary: None = "we don't know" (not a single adapter up,
// the machine is offline). Unknown must be treated as "IPv6 is present" — an error
// in that direction keeps today's behavior, while one in the other direction silently removes
// leak protection on a healthy machine.

/// `Some(true)` — IPv6 is bound to at least one working adapter,
/// `Some(false)` — there are adapters, but IPv6 is on none of them,
/// `None` — nothing to judge by.
#[tauri::command]
pub async fn system_ipv6_available() -> Result<Option<bool>, String> {
    #[cfg(windows)]
    {
        // spawn_blocking + catch_unwind following netproc: the Win32 snapshot doesn't
        // freeze the webview thread, and a panic inside doesn't cross the IPC boundary.
        // The command must always finish with Ok/Err, otherwise the promise doesn't settle
        // and the connection hangs.
        tauri::async_runtime::spawn_blocking(|| {
            std::panic::catch_unwind(windows_impl::probe)
                .unwrap_or_else(|_| Err("IPv6 probe panicked".into()))
        })
        .await
        .map_err(|_| "IPv6 probe did not run".to_string())?
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

#[cfg(windows)]
mod windows_impl {
    use windows::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_FRIENDLY_NAME, GAA_FLAG_SKIP_MULTICAST, IF_TYPE_SOFTWARE_LOOPBACK,
        IP_ADAPTER_ADDRESSES_LH, IP_ADAPTER_IPV6_ENABLED,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::Networking::WinSock::{AF_INET6, AF_UNSPEC};

    pub fn probe() -> Result<Option<bool>, String> {
        let buf = adapters()?;
        let mut seen_adapter = false;
        let mut ipv6_ready = false;

        // SAFETY: buf holds a valid GetAdaptersAddresses snapshot and lives until the end of
        // the function; the walk follows the Next chain to null, as Win32 intends.
        unsafe {
            let mut adapter = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
            while !adapter.is_null() {
                let entry = &*adapter;
                if entry.IfType != IF_TYPE_SOFTWARE_LOOPBACK && entry.OperStatus == IfOperStatusUp {
                    seen_adapter = true;
                    let flagged = entry.Anonymous2.Flags & IP_ADAPTER_IPV6_ENABLED != 0;
                    if flagged && has_ipv6_address(entry) {
                        ipv6_ready = true;
                        break;
                    }
                }
                adapter = entry.Next;
            }
        }

        // Not a single adapter up — nothing to judge by: the machine is offline, and
        // "no IPv6" here would mean not "the stack is off" but "there is no network".
        if !seen_adapter {
            return Ok(None);
        }
        Ok(Some(ipv6_ready))
    }

    /// SAFETY: `entry` is a live snapshot entry, the FirstUnicastAddress chain
    /// belongs to the same buffer.
    unsafe fn has_ipv6_address(entry: &IP_ADAPTER_ADDRESSES_LH) -> bool {
        let mut unicast = entry.FirstUnicastAddress;
        while !unicast.is_null() {
            let address = unsafe { &*unicast };
            let sockaddr = address.Address.lpSockaddr;
            if !sockaddr.is_null() && unsafe { (*sockaddr).sa_family } == AF_INET6 {
                return true;
            }
            unicast = address.Next;
        }
        false
    }

    fn adapters() -> Result<Vec<u8>, String> {
        // The adapter table may grow between measuring and reading (an interface
        // came up, a USB Ethernet was plugged in) — the same buffer growth loop as in
        // the netproc snapshots.
        let flags = GAA_FLAG_SKIP_ANYCAST
            | GAA_FLAG_SKIP_MULTICAST
            | GAA_FLAG_SKIP_DNS_SERVER
            | GAA_FLAG_SKIP_FRIENDLY_NAME;
        let mut size: u32 = 16 * 1024;
        for _ in 0..4 {
            let mut buf = vec![0u8; size as usize];
            // SAFETY: buf is allocated with size bytes, size is passed by pointer and
            // updated by the call; the pointer is valid for the whole call.
            let rc = unsafe {
                GetAdaptersAddresses(
                    AF_UNSPEC.0 as u32,
                    flags,
                    None,
                    Some(buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH),
                    &mut size,
                )
            };
            if rc == ERROR_SUCCESS.0 {
                return Ok(buf);
            }
            if rc == ERROR_BUFFER_OVERFLOW.0 {
                size = size.saturating_add(16 * 1024);
                continue;
            }
            return Err(format!("GetAdaptersAddresses: code {rc}"));
        }
        Err("the adapter table grows faster than it can be read".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    // The probe must ALWAYS answer, not fail: its result is read by the config
    // builder on the connect path, and a panic there would mean the connection doesn't
    // start at all. The concrete value depends on the machine, so we check
    // the contract, not the answer.
    #[test]
    fn probe_always_answers() {
        let result = super::windows_impl::probe();
        assert!(result.is_ok(), "probe returned an error: {result:?}");
        println!("system_ipv6_available -> {:?}", result.unwrap());
    }
}
