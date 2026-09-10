// Ninety · Умеет ли система IPv6 вообще.
//
// TUN-интерфейс получает и IPv4-, и IPv6-адрес: auto_route строит маршруты
// только для тех семейств, чей адрес есть на интерфейсе, и без IPv6-адреса
// нативный IPv6-трафик уходит мимо туннеля (см. tunAddresses во фронте).
//
// Но на машине, где IPv6 отключён в самой Windows, назначение этого адреса
// падает («configure tun interface: set ipv6 address: Element not found»), и
// ядро умирает целиком — TUN-режим не поднимается вовсе. Терять при этом
// нечего: раз стек выключен, IPv6-трафика на такой машине не бывает, и
// защищать нечего. Поэтому спрашиваем систему до сборки конфига.
//
// Спрашиваем не «есть ли IPv6-связность» (это отдельная проверка утечек в
// diagnose.rs — ей нужна сеть и две секунды), а «привязан ли стек к адаптерам».
//
// 🔴 Loopback обязан быть исключён, иначе проба бесполезна. Windows держит IPv6
// на loopback ДАЖЕ когда стек выключен везде: DisabledComponents документирован
// как «отключить IPv6 на всех интерфейсах, кроме loopback». Замерено вживую —
// при снятой привязке ms_tcpip6 у Ethernet флаг и адрес обнулились, а loopback
// остался с ::1 и включённым флагом. Считая его, проба всегда отвечала бы «да».
//
// Признака два, и берём оба: флаг IP_ADAPTER_IPV6_ENABLED — прямой ответ
// Windows, наличие IPv6-адреса — подтверждение, что привязка действительно
// состоялась. На живой машине они меняются вместе, так что второй признак
// страхует, а не спорит. Псевдоадаптеры (WAN Miniport, отключённые туннели)
// сюда не попадают вовсе: GetAdaptersAddresses без GAA_FLAG_INCLUDE_ALL_INTERFACES
// их не возвращает — тоже замерено, а не выведено из документации.
//
// Ответ намеренно троичный: None = «не знаем» (ни одного поднятого адаптера,
// машина офлайн). Неизвестность обязана трактоваться как «IPv6 есть» — ошибка
// в эту сторону оставляет сегодняшнее поведение, а в обратную молча снимает
// защиту от утечки на здоровой машине.

/// `Some(true)` — IPv6 привязан хотя бы к одному рабочему адаптеру,
/// `Some(false)` — адаптеры есть, IPv6 нет ни на одном,
/// `None` — судить не по чему.
#[tauri::command]
pub async fn system_ipv6_available() -> Result<Option<bool>, String> {
    #[cfg(windows)]
    {
        // spawn_blocking + catch_unwind по образцу netproc: Win32-снимок не
        // морозит webview-поток, а паника внутри не уходит через IPC-границу.
        // Команда обязана всегда завершаться Ok/Err, иначе промис не settl-ится
        // и подключение висит.
        tauri::async_runtime::spawn_blocking(|| {
            std::panic::catch_unwind(windows_impl::probe)
                .unwrap_or_else(|_| Err("проба IPv6 упала".into()))
        })
        .await
        .map_err(|_| "проба IPv6 не отработала".to_string())?
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

        // SAFETY: buf держит валидный снимок GetAdaptersAddresses и жив до конца
        // функции; обход идёт по цепочке Next до нуля, как задумано Win32.
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

        // Ни одного поднятого адаптера — судить не по чему: машина офлайн, и
        // «IPv6 нет» здесь значило бы не «стек выключен», а «сети нет».
        if !seen_adapter {
            return Ok(None);
        }
        Ok(Some(ipv6_ready))
    }

    /// SAFETY: `entry` — живая запись из снимка, цепочка FirstUnicastAddress
    /// принадлежит тому же буферу.
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
        // Таблица адаптеров может подрасти между замером и чтением (подняли
        // интерфейс, воткнули USB-Ethernet) — тот же цикл роста буфера, что у
        // снимков netproc.
        let flags = GAA_FLAG_SKIP_ANYCAST
            | GAA_FLAG_SKIP_MULTICAST
            | GAA_FLAG_SKIP_DNS_SERVER
            | GAA_FLAG_SKIP_FRIENDLY_NAME;
        let mut size: u32 = 16 * 1024;
        for _ in 0..4 {
            let mut buf = vec![0u8; size as usize];
            // SAFETY: buf выделен на size байт, size передаётся по указателю и
            // обновляется вызовом; указатель валиден на всё время вызова.
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
            return Err(format!("GetAdaptersAddresses: код {rc}"));
        }
        Err("таблица адаптеров растёт быстрее, чем читается".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    // Проба обязана ВСЕГДА отвечать, а не падать: её результат читает сборщик
    // конфига на пути подключения, и паника там означала бы, что подключение не
    // стартует вовсе. Конкретное значение зависит от машины, поэтому проверяем
    // контракт, а не ответ.
    #[test]
    fn probe_always_answers() {
        let result = super::windows_impl::probe();
        assert!(result.is_ok(), "проба вернула ошибку: {result:?}");
        println!("system_ipv6_available -> {:?}", result.unwrap());
    }
}
