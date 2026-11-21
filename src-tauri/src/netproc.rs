// Ninety · List of processes with outbound network activity. For the routing
// rules UI (picking a process instead of typing the .exe name by hand). A snapshot of the Windows
// TCP/UDP owner tables (IPv4+IPv6) → PID → exe
// name (QueryFullProcessImageNameW). Does NOT depend on sing-box — works even without
// active rules.

use serde::Serialize;

#[derive(Serialize)]
pub struct NetProcess {
    pub name: String,
    pub pid: u32,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsTcpConnection {
    pub process: Option<String>,
    pub process_path: Option<String>,
    pub pid: u32,
    pub local_address: String,
    pub remote_address: String,
    pub state: String,
}

/// Unique processes (by exe name) with TCP connections or UDP endpoints.
/// On non-Windows returns an empty list (the command is still registered
/// so the frontend doesn't break in a dev environment).
///
/// async + spawn_blocking: the Win32 snapshot doesn't freeze the webview thread. catch_unwind:
/// any panic inside collect() (table growth, reading past the buffer end) yields
/// Err(String) rather than unwinding across the IPC boundary — otherwise the JS promise doesn't settle and
/// the picker spinner hangs forever. The command MUST always finish with Ok/Err.
#[tauri::command]
pub async fn list_network_processes() -> Result<Vec<NetProcess>, String> {
    #[cfg(windows)]
    {
        let joined = tauri::async_runtime::spawn_blocking(|| {
            std::panic::catch_unwind(windows_impl::collect)
                .unwrap_or_else(|_| Err("network process snapshot panicked".into()))
        })
        .await;
        match joined {
            Ok(inner) => inner,
            Err(e) => Err(format!("process snapshot task did not run: {e}")),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// Snapshot of active TCP rows, including SYN-SENT connections which never
/// reach Clash. This is intentionally a separate OS-only view; it is not
/// merged into the Clash connection table.
#[tauri::command]
pub async fn snapshot_network_tcp() -> Result<Vec<OsTcpConnection>, String> {
    #[cfg(windows)]
    {
        let joined = tauri::async_runtime::spawn_blocking(|| {
            std::panic::catch_unwind(windows_impl::collect_tcp)
                .unwrap_or_else(|_| Err("TCP connection snapshot panicked".into()))
        })
        .await;
        match joined {
            Ok(inner) => inner,
            Err(e) => Err(format!("TCP snapshot task did not run: {e}")),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[cfg(windows)]
pub(crate) use windows_impl::{process_path as process_image_path, running_pids};

/// How many TCP sockets the process holds (IPv4 + IPv6, excluding LISTEN). Needed by
/// the "connection storm" watchdog (#168): a core whose own connections
/// loop back into TUN racks up tens of thousands of sockets within a minute, while from the outside
/// only an endless "Checking" is visible. None — we don't know: not Windows, the snapshot
/// failed or crashed.
pub(crate) fn tcp_socket_count(pid: u32) -> Option<u32> {
    #[cfg(windows)]
    {
        std::panic::catch_unwind(|| windows_impl::tcp_count_for_pid(pid))
            .ok()?
            .ok()
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::{NetProcess, OsTcpConnection};
    use std::collections::BTreeMap;
    use std::net::{Ipv4Addr, Ipv6Addr};
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INSUFFICIENT_BUFFER};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCP6TABLE_OWNER_PID,
        MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, MIB_UDP6ROW_OWNER_PID,
        MIB_UDP6TABLE_OWNER_PID, MIB_UDPROW_OWNER_PID, MIB_UDPTABLE_OWNER_PID,
        TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
    };
    use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // MIB_TCP_STATE_ESTAB = 5 (Win32 ABI; dwState is u32). Established only —
    // live outbound connections, without LISTEN/listeners.
    const TCP_STATE_ESTAB: u32 = 5;

    pub fn collect() -> Result<Vec<NetProcess>, String> {
        let mut out: BTreeMap<String, NetProcess> = BTreeMap::new();
        for pid in network_pids()? {
            if pid == 0 {
                continue;
            }
            if let Some(path) = process_path(pid) {
                let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
                if name.is_empty() {
                    continue;
                }
                out.entry(name.to_lowercase())
                    .or_insert(NetProcess { name, pid, path });
            }
        }
        Ok(out.into_values().collect())
    }

    #[derive(Clone)]
    struct TcpRow {
        pid: u32,
        local_address: String,
        remote_address: String,
        state: &'static str,
    }

    pub fn collect_tcp() -> Result<Vec<OsTcpConnection>, String> {
        let mut rows = tcp_rows_v4()?;
        rows.extend(tcp_rows_v6()?);
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            // LISTEN is not an outgoing connection and CLOSED rows are not
            // useful to the monitor. Keep SYN-SENT so a dead local proxy is
            // visible as an OS-only connection.
            if row.pid == 0 || matches!(row.state, "LISTEN" | "CLOSED") {
                continue;
            }
            let process_path = process_path(row.pid);
            let process = process_path.as_ref().and_then(|path| {
                let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
                (!name.is_empty()).then(|| name.to_string())
            });
            out.push(OsTcpConnection {
                process,
                process_path,
                pid: row.pid,
                local_address: row.local_address,
                remote_address: row.remote_address,
                state: row.state.to_string(),
            });
        }
        out.sort_by(|a, b| {
            a.process
                .cmp(&b.process)
                .then_with(|| a.local_address.cmp(&b.local_address))
                .then_with(|| a.remote_address.cmp(&b.remote_address))
        });
        Ok(out)
    }

    // MIB_TCP_STATE_LISTEN: a listener is not a connection.
    const TCP_STATE_LISTEN: u32 = 2;

    // Snapshot of a family's TCP table in a buffer of u32 words (row alignment),
    // like the other snapshots. None — the table is empty.
    fn tcp_table(family: u32) -> Result<Option<Vec<u32>>, String> {
        unsafe {
            let mut size = 0u32;
            let _ = GetExtendedTcpTable(None, &mut size, false, family, TCP_TABLE_OWNER_PID_ALL, 0);
            if size == 0 {
                return Ok(None);
            }
            for _ in 0..3 {
                let words = (size as usize).div_ceil(4);
                let mut buf = vec![0u32; words];
                let mut avail = size;
                let rc = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut avail,
                    false,
                    family,
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                );
                if rc == ERROR_INSUFFICIENT_BUFFER.0 {
                    size = avail.max(size.saturating_add(4096));
                    continue;
                }
                if rc != 0 {
                    return Err(format!("GetExtendedTcpTable({family}): code {rc}"));
                }
                return Ok(Some(buf));
            }
            Err("the TCP table grows faster than it can be read".into())
        }
    }

    /// Snapshot rows, trimmed to the actually allocated buffer.
    ///
    /// SAFETY: `first` points to the first table row inside `buf`, and `buf`
    /// itself is a GetExtendedTcpTable snapshot for a table with `R` rows.
    unsafe fn table_rows<R>(buf: &[u32], entries: u32, first: *const R) -> &[R] {
        let header = (first as usize) - (buf.as_ptr() as usize);
        let cap = (buf.len() * 4).saturating_sub(header) / core::mem::size_of::<R>();
        unsafe { std::slice::from_raw_parts(first, (entries as usize).min(cap)) }
    }

    pub fn tcp_count_for_pid(pid: u32) -> Result<u32, String> {
        let mut count = 0usize;
        if let Some(buf) = tcp_table(AF_INET.0 as u32)? {
            // SAFETY: the buffer is a snapshot of a MIB_TCPTABLE_OWNER_PID table.
            let rows = unsafe {
                let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                table_rows(&buf, table.dwNumEntries, table.table.as_ptr())
            };
            count += rows
                .iter()
                .filter(|row| row.dwOwningPid == pid && row.dwState != TCP_STATE_LISTEN)
                .count();
        }
        if let Some(buf) = tcp_table(AF_INET6.0 as u32)? {
            // SAFETY: the buffer is a snapshot of a MIB_TCP6TABLE_OWNER_PID table.
            let rows = unsafe {
                let table = &*(buf.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
                table_rows(&buf, table.dwNumEntries, table.table.as_ptr())
            };
            count += rows
                .iter()
                .filter(|row| row.dwOwningPid == pid && row.dwState != TCP_STATE_LISTEN)
                .count();
        }
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    fn tcp_state(state: u32) -> &'static str {
        match state {
            1 => "CLOSED",
            2 => "LISTEN",
            3 => "SYN-SENT",
            4 => "SYN-RECEIVED",
            5 => "ESTABLISHED",
            6 => "FIN-WAIT-1",
            7 => "FIN-WAIT-2",
            8 => "CLOSE-WAIT",
            9 => "CLOSING",
            10 => "LAST-ACK",
            11 => "TIME-WAIT",
            12 => "DELETE-TCB",
            _ => "UNKNOWN",
        }
    }

    fn tcp_rows_v4() -> Result<Vec<TcpRow>, String> {
        unsafe {
            let mut size = 0u32;
            let _ = GetExtendedTcpTable(
                None,
                &mut size,
                false,
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if size == 0 {
                return Ok(Vec::new());
            }
            for _ in 0..3 {
                let words = (size as usize).div_ceil(4);
                let mut buf = vec![0u32; words];
                let mut avail = size;
                let rc = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut avail,
                    false,
                    AF_INET.0 as u32,
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                );
                if rc == ERROR_INSUFFICIENT_BUFFER.0 {
                    size = avail.max(size.saturating_add(4096));
                    continue;
                }
                if rc != 0 {
                    return Err(format!("GetExtendedTcpTable snapshot: code {rc}"));
                }
                let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                let alloc_bytes = words * 4;
                let header = (table.table.as_ptr() as usize) - (buf.as_ptr() as usize);
                let cap_rows = alloc_bytes.saturating_sub(header)
                    / core::mem::size_of::<MIB_TCPROW_OWNER_PID>();
                let rows = std::slice::from_raw_parts(
                    table.table.as_ptr(),
                    (table.dwNumEntries as usize).min(cap_rows),
                );
                return Ok(rows
                    .iter()
                    .map(|row| TcpRow {
                        pid: row.dwOwningPid,
                        local_address: format!(
                            "{}:{}",
                            Ipv4Addr::from(u32::from_be(row.dwLocalAddr)),
                            u16::from_be(row.dwLocalPort as u16)
                        ),
                        remote_address: format!(
                            "{}:{}",
                            Ipv4Addr::from(u32::from_be(row.dwRemoteAddr)),
                            u16::from_be(row.dwRemotePort as u16)
                        ),
                        state: tcp_state(row.dwState),
                    })
                    .collect());
            }
            Err("the TCP snapshot table grows faster than it can be read".into())
        }
    }

    fn tcp_rows_v6() -> Result<Vec<TcpRow>, String> {
        unsafe {
            let mut size = 0u32;
            let _ = GetExtendedTcpTable(
                None,
                &mut size,
                false,
                AF_INET6.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if size == 0 {
                return Ok(Vec::new());
            }
            for _ in 0..3 {
                let words = (size as usize).div_ceil(4);
                let mut buf = vec![0u32; words];
                let mut avail = size;
                let rc = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut avail,
                    false,
                    AF_INET6.0 as u32,
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                );
                if rc == ERROR_INSUFFICIENT_BUFFER.0 {
                    size = avail.max(size.saturating_add(4096));
                    continue;
                }
                if rc != 0 {
                    return Err(format!("GetExtendedTcpTable(v6) snapshot: code {rc}"));
                }
                let table = &*(buf.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
                let alloc_bytes = words * 4;
                let header = (table.table.as_ptr() as usize) - (buf.as_ptr() as usize);
                let cap_rows = alloc_bytes.saturating_sub(header)
                    / core::mem::size_of::<MIB_TCP6ROW_OWNER_PID>();
                let rows = std::slice::from_raw_parts(
                    table.table.as_ptr(),
                    (table.dwNumEntries as usize).min(cap_rows),
                );
                return Ok(rows
                    .iter()
                    .map(|row| TcpRow {
                        pid: row.dwOwningPid,
                        local_address: format!(
                            "[{}]:{}",
                            Ipv6Addr::from(row.ucLocalAddr),
                            u16::from_be(row.dwLocalPort as u16)
                        ),
                        remote_address: format!(
                            "[{}]:{}",
                            Ipv6Addr::from(row.ucRemoteAddr),
                            u16::from_be(row.dwRemotePort as u16)
                        ),
                        state: tcp_state(row.dwState),
                    })
                    .collect());
            }
            Err("the TCPv6 snapshot table grows faster than it can be read".into())
        }
    }

    fn network_pids() -> Result<Vec<u32>, String> {
        let mut pids = established_pids_v4()?;
        pids.extend(established_pids_v6()?);
        pids.extend(udp_pids_v4()?);
        pids.extend(udp_pids_v6()?);
        pids.sort_unstable();
        pids.dedup();
        Ok(pids)
    }

    fn established_pids_v4() -> Result<Vec<u32>, String> {
        unsafe {
            // 1st call: find out the size (returns ERROR_INSUFFICIENT_BUFFER — ignored).
            let mut size: u32 = 0;
            let _ = GetExtendedTcpTable(
                None,
                &mut size,
                false,
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if size == 0 {
                return Ok(Vec::new());
            }
            // The TCP table may grow between the probe and the read → the 2nd call returns
            // ERROR_INSUFFICIENT_BUFFER (122) and updates `avail` with the required size.
            // We reread the size and retry (up to 3 attempts) instead of failing.
            for _ in 0..3 {
                // The buffer is aligned to u32 (MIB_* structs require 4-byte
                // alignment; Vec<u8> doesn't guarantee it).
                let words = (size as usize).div_ceil(4);
                let mut buf = vec![0u32; words];
                let mut avail = size; // how many bytes we report to the API as available
                let rc = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut avail,
                    false,
                    AF_INET.0 as u32,
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                );
                if rc == ERROR_INSUFFICIENT_BUFFER.0 {
                    // avail now carries the required size — reallocate and retry.
                    size = avail.max(size.saturating_add(4096));
                    continue;
                }
                if rc != 0 {
                    return Err(format!("GetExtendedTcpTable: code {rc}"));
                }
                let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                // We don't trust dwNumEntries blindly: we limit it to the number of rows that actually
                // fit into the allocated buffer (protection against reading past the end).
                let alloc_bytes = words * 4;
                let header = (table.table.as_ptr() as usize) - (buf.as_ptr() as usize);
                let cap_rows = alloc_bytes.saturating_sub(header)
                    / core::mem::size_of::<MIB_TCPROW_OWNER_PID>();
                let n = (table.dwNumEntries as usize).min(cap_rows);
                let rows = std::slice::from_raw_parts(table.table.as_ptr(), n);
                let mut pids: Vec<u32> = rows
                    .iter()
                    .filter(|r| r.dwState == TCP_STATE_ESTAB)
                    .map(|r| r.dwOwningPid)
                    .collect();
                pids.sort_unstable();
                pids.dedup();
                return Ok(pids);
            }
            Err("the TCP connection table grows faster than it can be read".into())
        }
    }

    fn established_pids_v6() -> Result<Vec<u32>, String> {
        unsafe {
            let mut size = 0u32;
            let _ = GetExtendedTcpTable(
                None,
                &mut size,
                false,
                AF_INET6.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if size == 0 {
                return Ok(Vec::new());
            }
            for _ in 0..3 {
                let words = (size as usize).div_ceil(4);
                let mut buf = vec![0u32; words];
                let mut avail = size;
                let rc = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut avail,
                    false,
                    AF_INET6.0 as u32,
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                );
                if rc == ERROR_INSUFFICIENT_BUFFER.0 {
                    size = avail.max(size.saturating_add(4096));
                    continue;
                }
                if rc != 0 {
                    return Err(format!("GetExtendedTcpTable(v6): code {rc}"));
                }
                let table = &*(buf.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
                let alloc_bytes = words * 4;
                let header = (table.table.as_ptr() as usize) - (buf.as_ptr() as usize);
                let cap_rows = alloc_bytes.saturating_sub(header)
                    / core::mem::size_of::<MIB_TCP6ROW_OWNER_PID>();
                let rows = std::slice::from_raw_parts(
                    table.table.as_ptr(),
                    (table.dwNumEntries as usize).min(cap_rows),
                );
                return Ok(rows
                    .iter()
                    .filter(|r| r.dwState == TCP_STATE_ESTAB)
                    .map(|r| r.dwOwningPid)
                    .collect());
            }
            Err("the TCPv6 connection table grows faster than it can be read".into())
        }
    }

    fn udp_pids_v4() -> Result<Vec<u32>, String> {
        unsafe {
            let mut size = 0u32;
            let _ = GetExtendedUdpTable(
                None,
                &mut size,
                false,
                AF_INET.0 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );
            if size == 0 {
                return Ok(Vec::new());
            }
            for _ in 0..3 {
                let words = (size as usize).div_ceil(4);
                let mut buf = vec![0u32; words];
                let mut avail = size;
                let rc = GetExtendedUdpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut avail,
                    false,
                    AF_INET.0 as u32,
                    UDP_TABLE_OWNER_PID,
                    0,
                );
                if rc == ERROR_INSUFFICIENT_BUFFER.0 {
                    size = avail.max(size.saturating_add(4096));
                    continue;
                }
                if rc != 0 {
                    return Err(format!("GetExtendedUdpTable(v4): code {rc}"));
                }
                let table = &*(buf.as_ptr() as *const MIB_UDPTABLE_OWNER_PID);
                let alloc_bytes = words * 4;
                let header = (table.table.as_ptr() as usize) - (buf.as_ptr() as usize);
                let cap_rows = alloc_bytes.saturating_sub(header)
                    / core::mem::size_of::<MIB_UDPROW_OWNER_PID>();
                let rows = std::slice::from_raw_parts(
                    table.table.as_ptr(),
                    (table.dwNumEntries as usize).min(cap_rows),
                );
                return Ok(rows.iter().map(|r| r.dwOwningPid).collect());
            }
            Err("the UDPv4 endpoint table grows faster than it can be read".into())
        }
    }

    fn udp_pids_v6() -> Result<Vec<u32>, String> {
        unsafe {
            let mut size = 0u32;
            let _ = GetExtendedUdpTable(
                None,
                &mut size,
                false,
                AF_INET6.0 as u32,
                UDP_TABLE_OWNER_PID,
                0,
            );
            if size == 0 {
                return Ok(Vec::new());
            }
            for _ in 0..3 {
                let words = (size as usize).div_ceil(4);
                let mut buf = vec![0u32; words];
                let mut avail = size;
                let rc = GetExtendedUdpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut avail,
                    false,
                    AF_INET6.0 as u32,
                    UDP_TABLE_OWNER_PID,
                    0,
                );
                if rc == ERROR_INSUFFICIENT_BUFFER.0 {
                    size = avail.max(size.saturating_add(4096));
                    continue;
                }
                if rc != 0 {
                    return Err(format!("GetExtendedUdpTable(v6): code {rc}"));
                }
                let table = &*(buf.as_ptr() as *const MIB_UDP6TABLE_OWNER_PID);
                let alloc_bytes = words * 4;
                let header = (table.table.as_ptr() as usize) - (buf.as_ptr() as usize);
                let cap_rows = alloc_bytes.saturating_sub(header)
                    / core::mem::size_of::<MIB_UDP6ROW_OWNER_PID>();
                let rows = std::slice::from_raw_parts(
                    table.table.as_ptr(),
                    (table.dwNumEntries as usize).min(cap_rows),
                );
                return Ok(rows.iter().map(|r| r.dwOwningPid).collect());
            }
            Err("the UDPv6 endpoint table grows faster than it can be read".into())
        }
    }

    /// PIDs of all system processes. EnumProcesses doesn't report how many there
    /// actually are: a buffer filled to the end is the only sign that the PIDs didn't
    /// fit, and then the buffer grows.
    pub(crate) fn running_pids() -> Vec<u32> {
        use windows::Win32::System::ProcessStatus::EnumProcesses;
        const PID_BYTES: usize = std::mem::size_of::<u32>();
        let mut capacity = 1024usize;
        loop {
            let mut pids = vec![0u32; capacity];
            let bytes = (pids.len() * PID_BYTES) as u32;
            let mut needed = 0u32;
            if unsafe { EnumProcesses(pids.as_mut_ptr(), bytes, &mut needed) }.is_err() {
                return Vec::new();
            }
            if needed < bytes || capacity >= 65_536 {
                pids.truncate(needed as usize / PID_BYTES);
                return pids;
            }
            capacity *= 2;
        }
    }

    pub(crate) fn process_path(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut capacity = 260usize;
            let result = loop {
                let mut buf = vec![0u16; capacity];
                let mut len = buf.len() as u32;
                let res = QueryFullProcessImageNameW(
                    handle,
                    PROCESS_NAME_WIN32,
                    PWSTR(buf.as_mut_ptr()),
                    &mut len,
                );
                if res.is_ok() && len > 0 {
                    break Some(String::from_utf16_lossy(&buf[..len as usize]));
                }
                if GetLastError() != ERROR_INSUFFICIENT_BUFFER || capacity >= 32768 {
                    break None;
                }
                capacity = (capacity * 2).min(32768);
            };
            let _ = CloseHandle(handle);
            result
        }
    }
}
