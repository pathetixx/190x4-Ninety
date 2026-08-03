// Ninety · Список процессов с исходящей сетевой активностью. Для UI правил
// маршрутизации (выбор процесса вместо ручного ввода имени .exe). Снимок таблицы
// TCP/UDP owner tables Windows (IPv4+IPv6) → PID → имя
// exe (QueryFullProcessImageNameW). От sing-box НЕ зависит — работает даже без
// активных правил.

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

/// Уникальные процессы (по имени exe) с TCP-соединениями или UDP endpoint'ами.
/// На не-Windows возвращает пустой список (команда всё равно зарегистрирована,
/// чтобы фронт не падал в dev-окружении).
///
/// async + spawn_blocking: Win32-снимок не морозит webview-поток. catch_unwind:
/// любая паника внутри collect() (рост таблицы, чтение за границей буфера) даёт
/// Err(String), а не unwind через IPC-границу — иначе JS-промис не settl-ится и
/// спиннер пикера висит вечно. Команда ОБЯЗАНА всегда завершаться Ok/Err.
#[tauri::command]
pub async fn list_network_processes() -> Result<Vec<NetProcess>, String> {
    #[cfg(windows)]
    {
        let joined = tauri::async_runtime::spawn_blocking(|| {
            std::panic::catch_unwind(windows_impl::collect)
                .unwrap_or_else(|_| Err("снимок сетевых процессов аварийно прерван".into()))
        })
        .await;
        match joined {
            Ok(inner) => inner,
            Err(e) => Err(format!("задача снимка процессов не выполнилась: {e}")),
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
                .unwrap_or_else(|_| Err("снимок TCP-соединений аварийно прерван".into()))
        })
        .await;
        match joined {
            Ok(inner) => inner,
            Err(e) => Err(format!("задача снимка TCP-соединений не выполнилась: {e}")),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
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

    // MIB_TCP_STATE_ESTAB = 5 (ABI Win32; dwState — u32). Только established —
    // живые исходящие соединения, без LISTEN/слушателей.
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
                    return Err(format!("GetExtendedTcpTable snapshot: код {rc}"));
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
            Err("таблица TCP snapshot растёт быстрее, чем читается".into())
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
                    return Err(format!("GetExtendedTcpTable(v6) snapshot: код {rc}"));
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
            Err("таблица TCPv6 snapshot растёт быстрее, чем читается".into())
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
            // 1-й вызов: узнать размер (вернёт ERROR_INSUFFICIENT_BUFFER — игнор).
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
            // Таблица TCP может вырасти между probe и чтением → 2-й вызов вернёт
            // ERROR_INSUFFICIENT_BUFFER (122) и обновит `avail` нужным размером.
            // Перечитываем размер и повторяем (до 3 попыток), а не падаем.
            for _ in 0..3 {
                // Буфер выровнен под u32 (структуры MIB_* требуют 4-байтового
                // выравнивания; Vec<u8> его не гарантирует).
                let words = (size as usize).div_ceil(4);
                let mut buf = vec![0u32; words];
                let mut avail = size; // сколько байт сообщаем API как доступно
                let rc = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut avail,
                    false,
                    AF_INET.0 as u32,
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                );
                if rc == ERROR_INSUFFICIENT_BUFFER.0 {
                    // avail теперь несёт требуемый размер — перевыделим и повторим.
                    size = avail.max(size.saturating_add(4096));
                    continue;
                }
                if rc != 0 {
                    return Err(format!("GetExtendedTcpTable: код {rc}"));
                }
                let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                // Не доверяем dwNumEntries слепо: ограничиваем числом строк, реально
                // помещающихся в выделенный буфер (защита от чтения за границей).
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
            Err("таблица TCP-соединений растёт быстрее, чем читается".into())
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
                    return Err(format!("GetExtendedTcpTable(v6): код {rc}"));
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
            Err("таблица TCPv6-соединений растёт быстрее, чем читается".into())
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
                    return Err(format!("GetExtendedUdpTable(v4): код {rc}"));
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
            Err("таблица UDPv4 endpoint'ов растёт быстрее, чем читается".into())
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
                    return Err(format!("GetExtendedUdpTable(v6): код {rc}"));
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
            Err("таблица UDPv6 endpoint'ов растёт быстрее, чем читается".into())
        }
    }

    fn process_path(pid: u32) -> Option<String> {
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
