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

#[cfg(windows)]
mod windows_impl {
    use super::NetProcess;
    use std::collections::BTreeMap;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, BOOL, ERROR_INSUFFICIENT_BUFFER};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
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
            // Таблица TCP может вырасти между probe и чтением → 2-й вызов вернёт
            // ERROR_INSUFFICIENT_BUFFER (122) и обновит `avail` нужным размером.
            // Перечитываем размер и повторяем (до 3 попыток), а не падаем.
            for _ in 0..3 {
                // Буфер выровнен под u32 (структуры MIB_* требуют 4-байтового
                // выравнивания; Vec<u8> его не гарантирует).
                let words = (size as usize + 3) / 4;
                let mut buf = vec![0u32; words];
                let mut avail = size; // сколько байт сообщаем API как доступно
                let rc = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut avail,
                    BOOL(0),
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
                let cap_rows = alloc_bytes
                    .saturating_sub(header)
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
