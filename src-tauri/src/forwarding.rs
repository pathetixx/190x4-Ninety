// Ninety · Пересылка IP на внешнем интерфейсе (issue #168).
//
// В TUN собственный трафик движков уходит правилом process_name → direct, а
// direct привязан к физическому адаптеру (auto_detect_interface, IP_UNICAST_IF).
// На машине, где Windows пересылает пакеты между интерфейсами (хвосты раздачи
// интернета с ПК, IPEnableRouter=1, Set-NetIPInterface -Forwarding Enabled),
// эта привязка не удерживает трафик: прямое соединение ядра снова попадает в
// TUN, ядро снова отправляет его напрямую — петля. Снаружи это выглядит как
// «Проверка» без конца, десятки тысяч сокетов sing-box и ни одного байта.
//
// Сами настройки не трогаем: пересылка бывает нужна осознанно (Hyper-V, WSL,
// раздача). Только читаем и говорим человеку, что именно мешает.
//
// Смотрим не на все интерфейсы, а на те, через которые идёт маршрут по
// умолчанию: именно к ним привязывается direct. Пересылка на внутреннем
// виртуальном свитче без выхода в интернет петлю не создаёт, и ругаться на неё
// значило бы пугать каждого владельца WSL. Службу SharedAccess тоже не
// проверяем: на Windows 11 она часто запущена сама по себе (мобильный
// хот-спот), а включённую раздачу выдаёт та же пересылка на интерфейсе.
//
// Ответ троичный, как у пробы IPv6: None — судить не по чему (снимок не
// снялся). Неизвестность не должна превращаться ни в тревогу, ни в «всё
// чисто» — фронт тогда просто молчит.

use serde::Serialize;

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardingStatus {
    /// IPEnableRouter=1 в реестре: пересылка вернётся после каждой перезагрузки,
    /// даже если выключить её на интерфейсе.
    pub router_enabled: bool,
    /// Внешние интерфейсы (с маршрутом по умолчанию), на которых пересылка
    /// включена прямо сейчас. Непустой список — это и есть проблема.
    pub interfaces: Vec<ForwardingInterface>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardingInterface {
    pub alias: String,
    /// "ipv4" | "ipv6" — команда исправления называет семейство явно.
    pub family: &'static str,
}

#[tauri::command]
pub async fn system_forwarding_status() -> Result<Option<ForwardingStatus>, String> {
    #[cfg(windows)]
    {
        // Тот же каркас, что у system_ipv6_available: Win32-снимок вне
        // webview-потока, паника не уходит через IPC-границу, промис settl-ится.
        tauri::async_runtime::spawn_blocking(|| {
            std::panic::catch_unwind(windows_impl::probe)
                .unwrap_or_else(|_| Err("проба пересылки упала".into()))
        })
        .await
        .map_err(|_| "проба пересылки не отработала".to_string())?
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

/// Интерфейс самого Ninety: его маршруты и флаги — не про систему.
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
        // SAFETY: table — выходной указатель; при успехе Windows кладёт туда
        // таблицу, которую освобождает FreeMibTable в MibTable::drop.
        let rc = unsafe { GetIpInterfaceTable(AF_UNSPEC, &mut table) };
        if rc != ERROR_SUCCESS || table.is_null() {
            return Err(format!("GetIpInterfaceTable: код {}", rc.0));
        }
        let _guard = MibTable(table as *const core::ffi::c_void);
        // SAFETY: таблица валидна до drop guard'а; NumEntries строк лежат подряд.
        let rows = unsafe {
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize)
        };
        for row in rows {
            if !row.ForwardingEnabled || !row.Connected {
                continue;
            }
            let family = row.Family.0;
            // SAFETY: NET_LUID_LH — объединение, Value покрывает его целиком.
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

    /// (LUID, семейство) интерфейсов, через которые идёт маршрут по умолчанию.
    fn default_route_interfaces() -> Result<HashSet<(u64, u16)>, String> {
        let mut table: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
        // SAFETY: как у GetIpInterfaceTable выше.
        let rc = unsafe { GetIpForwardTable2(AF_UNSPEC, &mut table) };
        if rc != ERROR_SUCCESS || table.is_null() {
            return Err(format!("GetIpForwardTable2: код {}", rc.0));
        }
        let _guard = MibTable(table as *const core::ffi::c_void);
        // SAFETY: таблица валидна до drop guard'а; NumEntries строк лежат подряд.
        let rows = unsafe {
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize)
        };
        let mut out = HashSet::new();
        for row in rows {
            if row.DestinationPrefix.PrefixLength != 0 {
                continue;
            }
            // SAFETY: SOCKADDR_INET — объединение, si_family общий для всех веток;
            // NET_LUID_LH — объединение, Value покрывает его целиком.
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
        // SAFETY: luid — живая запись снимка, buf передаётся срезом с длиной.
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
            // SAFETY: указатель получен от GetIp*Table* и освобождается ровно раз.
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

    // Проба обязана ВСЕГДА отвечать: её зовут на пути подключения и из
    // диагностики. Значение зависит от машины, поэтому проверяем контракт.
    #[cfg(windows)]
    #[test]
    fn probe_always_answers() {
        let result = super::windows_impl::probe();
        assert!(result.is_ok(), "проба вернула ошибку: {result:?}");
        println!("system_forwarding_status -> {:?}", result.unwrap());
    }
}
