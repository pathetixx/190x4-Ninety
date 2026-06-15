// Ninety · Список процессов с исходящей сетевой активностью. Для UI правил
// маршрутизации (выбор процесса вместо ручного ввода имени .exe). Снимок таблицы
// TCP-соединений Windows (GetExtendedTcpTable, AF_INET, established) → PID → имя
// exe (QueryFullProcessImageNameW). От sing-box НЕ зависит — работает даже без
// активных правил. IPv6 — follow-up (TCP6_TABLE), сейчас IPv4 покрывает выбор.

use serde::Serialize;

#[derive(Serialize)]
pub struct NetProcess {
    pub name: String,
    pub pid: u32,
    pub path: String,
}

/// Уникальные процессы (по имени exe) с установленными исходящими TCP-соединениями.
/// На не-Windows возвращает пустой список (команда всё равно зарегистрирована,
/// чтобы фронт не падал в dev-окружении).
#[tauri::command]
pub fn list_network_processes() -> Result<Vec<NetProcess>, String> {
    #[cfg(windows)]
    {
        windows_impl::collect()
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::NetProcess;
    use std::collections::BTreeMap;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, BOOL};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows::Win32::Networking::WinSock::AF_INET;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // MIB_TCP_STATE_ESTAB = 5 (ABI Win32; dwState — u32). Только established —
    // живые исходящие соединения, без LISTEN/слушателей.
    const TCP_STATE_ESTAB: u32 = 5;

    pub fn collect() -> Result<Vec<NetProcess>, String> {
        let mut out: BTreeMap<String, NetProcess> = BTreeMap::new();
        for pid in established_pids()? {
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

    fn established_pids() -> Result<Vec<u32>, String> {
        unsafe {
            // 1-й вызов: узнать размер (вернёт ERROR_INSUFFICIENT_BUFFER — игнор).
            let mut size: u32 = 0;
            let _ = GetExtendedTcpTable(
                None,
                &mut size,
                BOOL(0),
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if size == 0 {
                return Ok(Vec::new());
            }
            // Буфер выровнен под u32 (структуры MIB_* требуют 4-байтового
            // выравнивания; Vec<u8> его не гарантирует).
            let mut buf = vec![0u32; (size as usize + 3) / 4];
            let rc = GetExtendedTcpTable(
                Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                &mut size,
                BOOL(0),
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
            if rc != 0 {
                return Err(format!("GetExtendedTcpTable: код {rc}"));
            }
            let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
            let rows = std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize);
            let mut pids: Vec<u32> = rows
                .iter()
                .filter(|r| r.dwState == TCP_STATE_ESTAB)
                .map(|r| r.dwOwningPid)
                .collect();
            pids.sort_unstable();
            pids.dedup();
            Ok(pids)
        }
    }

    fn process_path(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), pid).ok()?;
            let mut buf = [0u16; 260];
            let mut len = buf.len() as u32;
            let res = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(handle);
            if res.is_err() || len == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
    }
}
