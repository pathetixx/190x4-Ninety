// Ninety · WFP kill switch (I.2) — ЭКСПЕРИМЕНТАЛЬНО, off-by-default.
//
// Назначение: при падении ядра (sing-box/xray) в режимах proxy/systemProxy трафик
// не должен утечь в открытую сеть. Ставим WFP-фильтры: БЛОКИРОВАТЬ весь исходящий
// на ALE_AUTH_CONNECT, кроме (а) loopback (приложения ходят в локальный mixed-proxy)
// и (б) движков Ninety по app-id — их сокеты к VPN-серверу. Движков несколько:
// внешний коннект делает не только sing-box.exe — при xhttp-нодах наружу ходит
// xray.exe, при naive/TT — naive.exe / trusttunnel_client.exe (sing-box идёт к ним
// loopback-мостом). Permit только sing-box глушил бы такие ноды намертво.
// Если ядро умирает — его permit становится бесполезным, block-all режет прямой
// выход → нет утечки. Для обычного TUN достаточно strict_route sing-box.
// Высокоуровневый строгий режим дополнительно передаёт имя TUN-интерфейса:
// тогда permit получает весь трафик, привязанный Windows к нему. Если интерфейс
// исчезнет, permit больше не совпадает, а block-all остаётся активен.
//
// Безопасность от «вечного лока»: открываем WFP-движок DYNAMIC-сессией — все объекты
// авто-снимаются при закрытии хэндла ИЛИ выходе процесса Ninety. То есть если аппа
// упадёт, фильтры исчезнут сами, сеть не останется заблокированной навсегда.
//
// ⚠️ ВНИМАНИЕ: сырой FWPM-FFI, локально НЕ компилировался (правило проекта — сборка
// только на CI). Первый CI-ран может потребовать фиксапов имён полей/констант
// windows-rs. Фича выключена по умолчанию (general.killSwitch /
// privacy.strictTunnel) — на обычных юзеров не влияет, пока не включат вручную.

use std::sync::Mutex;

use crate::util::MutexExt;

const ENGINE_NAMES: [&str; 8] = [
    "sing-box.exe",
    "sing-box-x86_64-pc-windows-msvc.exe",
    "xray.exe",
    "xray-x86_64-pc-windows-msvc.exe",
    "naive.exe",
    "naive-x86_64-pc-windows-msvc.exe",
    "trusttunnel_client.exe",
    "trusttunnel_client-x86_64-pc-windows-msvc.exe",
];

fn existing_engine_paths(dir: &std::path::Path) -> Vec<String> {
    ENGINE_NAMES
        .iter()
        .map(|name| dir.join(name))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

#[derive(Clone, Copy)]
struct KillSwitchLease {
    /// HANDLE не Send/Sync — храним числом и восстанавливаем только внутри
    /// Windows-реализации.
    handle: isize,
    /// У каждой dynamic-session собственный sublayer: это позволяет полностью
    /// собрать замену до закрытия старой сессии, без fail-open окна.
    sublayer: u128,
    /// Два критических block-all фильтра (IPv4/IPv6) для health-check.
    block_filters: [u64; 2],
    /// A transition lease is an additional, temporary fail-closed barrier. It
    /// must remain armed after a failed restart; only verified final runtime
    /// policy is allowed to release it.
    transition: bool,
}

/// Активные dynamic-session WFP. Обычно элемент один. Если Windows отказалась
/// закрыть предыдущую сессию после атомарной замены, сохраняем её handle для
/// повторного disarm вместо необратимой потери управления фильтрами.
#[derive(Default)]
pub struct KillSwitchState(Mutex<Vec<KillSwitchLease>>);

/// Включить или безопасно переармить kill switch. Новая WFP-сессия собирается
/// транзакционно до закрытия предыдущей. Permit получают все движки Ninety,
/// найденные рядом с нашим бинарём (Tauri кладёт сайдкары туда же): permit для
/// не запущенного exe инертен, а пропущенный permit глушит протокол намертво —
/// поэтому не гадаем, какие ноды в активном конфиге.
#[tauri::command]
pub fn killswitch_arm(
    state: tauri::State<'_, KillSwitchState>,
    allow_lan: Option<bool>,
    tun_interface: Option<String>,
    strict_tunnel: Option<bool>,
) -> Result<(), String> {
    // allow_lan=true (по умолчанию — привязан к route.bypassLan во фронте): наряду
    // с loopback пропускаем и приватные подсети, чтобы armed-блок не рвал принтеры/
    // NAS/локальные шары. DHCP пропускаем ВСЕГДА — иначе на renew lease рвётся вся
    // сеть «непонятно почему». В обычном TUN WFP не нужен; строгий TUN передаёт
    // strict_tunnel=true и всегда ставит фильтр.
    let allow_lan = allow_lan.unwrap_or(true);
    let mut guard = state.0.lock_recover();
    #[cfg(target_os = "windows")]
    {
        let strict_tunnel = strict_tunnel.unwrap_or(false);
        let exes = engine_exe_paths(!strict_tunnel)?;
        let tun_interface = tun_interface
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if strict_tunnel {
            if allow_lan {
                return Err("строгий kill switch запрещает LAN-исключения".into());
            }
            if tun_interface.is_some_and(|alias| !alias.eq_ignore_ascii_case("ninety-tun")) {
                return Err("неожиданное имя TUN-интерфейса для строгого режима".into());
            }
        } else if tun_interface.is_some() {
            return Err("TUN-интерфейс допустим только для строгого kill switch".into());
        }
        // Сначала целиком собираем новую dynamic-session. Если любой фильтр не
        // добавился, win::arm закроет только новую сессию, а старая продолжит
        // блокировать сеть. После успеха swap и закрытие старой уже безопасны.
        let mut lease = unsafe { win::arm(&exes, allow_lan, tun_interface)? };
        lease.transition = false;
        let previous: Vec<_> = guard.drain(..).collect();
        guard.push(lease);
        let mut close_errors = Vec::new();
        for previous in previous {
            if let Err(error) = unsafe { win::disarm(previous) } {
                guard.push(previous);
                close_errors.push(error);
            }
        }
        // Старый preconnect-фильтр рядом с новым connected-фильтром способен
        // продолжить блокировать TUN из-за одинакового веса sublayer. Не
        // подтверждаем readiness, пока предыдущая сессия реально не закрыта;
        // handle сохраняется, поэтому следующий rearm/disarm сможет повторить.
        if !close_errors.is_empty() {
            return Err(close_errors.join("; "));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (allow_lan, tun_interface, strict_tunnel);
        Err("kill switch доступен только на Windows".into())
    }
}

/// Выключить kill switch (снять все фильтры). Идемпотентно.
#[tauri::command]
pub fn killswitch_disarm(state: tauri::State<'_, KillSwitchState>) -> Result<(), String> {
    let mut guard = state.0.lock_recover();
    #[cfg(target_os = "windows")]
    {
        let leases: Vec<_> = guard.drain(..).collect();
        let mut errors = Vec::new();
        for lease in leases {
            if let Err(error) = unsafe { win::disarm(lease) } {
                guard.push(lease);
                errors.push(error);
            }
        }
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        guard.clear();
    }
    Ok(())
}

/// Активен ли kill switch (для синхронизации UI).
#[tauri::command]
pub fn killswitch_active(state: tauri::State<'_, KillSwitchState>) -> bool {
    is_active(&state)
}

pub fn is_active(state: &KillSwitchState) -> bool {
    let mut guard = state.0.lock_recover();
    if guard.is_empty() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        let leases: Vec<_> = guard.drain(..).collect();
        let mut any_alive = false;
        for lease in leases {
            if unsafe { win::session_alive(lease) } {
                any_alive = true;
                guard.push(lease);
            } else {
                // BFE restart/утрата dynamic objects не должны оставлять ложное
                // true в runtime_snapshot. Но при ошибке Close0 не теряем raw
                // handle: следующий health-check/disarm повторит cleanup.
                if unsafe { win::disarm(lease) }.is_err() {
                    guard.push(lease);
                }
            }
        }
        any_alive
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

// Снять движок при выходе аппы (на случай, если фронт не успел) — фильтры и так
// уйдут с процессом (dynamic-session), но закрываем явно.
pub fn force_disarm(state: &KillSwitchState) {
    let mut guard = state.0.lock_recover();
    for lease in guard.drain(..) {
        #[cfg(target_os = "windows")]
        let _ = unsafe { win::disarm(lease) };
        #[cfg(not(target_os = "windows"))]
        let _ = lease;
    }
}

// Все движки, способные делать внешний коннект (см. externalBin в tauri.conf.json).
// Пропущенные на диске (например dev-запуск без сайдкаров) просто не попадают в
// permit; если не нашёлся НИ ОДИН — это ошибка: armed-блок без единого permit
// отрезал бы сеть целиком, включая сам туннель.
#[cfg(target_os = "windows")]
fn engine_exe_paths(include_controller: bool) -> Result<Vec<String>, String> {
    // Tauri CLI resolves `externalBin: ["binaries/sing-box", ...]` to target-
    // suffixed files in dev/build (`sing-box-x86_64-pc-windows-msvc.exe`).
    // Keep the short names too: they make local/manual sidecar layouts harmless.
    let self_exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = self_exe
        .parent()
        .ok_or("нет родительского каталога exe")?
        .to_path_buf();
    let mut exes = existing_engine_paths(&dir);
    if exes.is_empty() {
        return Err("движки не найдены рядом с Ninety — kill switch не включён".into());
    }
    // Обычный kill switch пропускает и Ninety: в proxy/systemProxy его служебные
    // reqwest-запросы идут напрямую. Строгий TUN контроллер не разрешает —
    // updater/подписки/прочий fetch обязаны попасть в виртуальный интерфейс.
    if include_controller {
        exes.push(self_exe.to_string_lossy().to_string());
    }
    Ok(exes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_discovery_only_returns_known_existing_binaries() {
        let dir =
            std::env::temp_dir().join(format!("ninety-killswitch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sing-box.exe"), b"").unwrap();
        std::fs::write(dir.join("unrelated.exe"), b"").unwrap();
        let found = existing_engine_paths(&dir);
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("sing-box.exe"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(target_os = "windows")]
mod win {
    use rand_core::{OsRng, RngCore};
    use windows::core::{GUID, PCWSTR, PWSTR};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::NetworkManagement::IpHelper::ConvertInterfaceAliasToLuid;
    use windows::Win32::NetworkManagement::Ndis::NET_LUID_LH;
    use windows::Win32::NetworkManagement::WindowsFilteringPlatform::*;

    const AUTHN_DEFAULT: u32 = 0xFFFF_FFFF; // RPC_C_AUTHN_DEFAULT

    // FwpmEngineOpen0 нет в биндингах windows-rs 0.58 (её сигнатура тянет
    // SEC_WINNT_AUTH_IDENTITY_W, добавление фичи не помогло) — импортируем символ
    // напрямую из fwpuclnt.dll через raw-dylib (не зависит от механизма линковки
    // windows-rs). authidentity передаём null.
    #[link(name = "fwpuclnt", kind = "raw-dylib")]
    extern "system" {
        fn FwpmEngineOpen0(
            servername: *const u16,
            authnservice: u32,
            authidentity: *const core::ffi::c_void,
            session: *const FWPM_SESSION0,
            enginehandle: *mut HANDLE,
        ) -> u32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub unsafe fn arm(
        exe_paths: &[String],
        allow_lan: bool,
        tun_interface: Option<&str>,
    ) -> Result<super::KillSwitchLease, String> {
        let tun_luid = tun_interface
            .map(|alias| unsafe { interface_luid(alias) })
            .transpose()?;
        let sublayer_id = random_sublayer_id()?;
        let sublayer = GUID::from_u128(sublayer_id);
        let mut engine = HANDLE::default();
        let mut session: FWPM_SESSION0 = std::mem::zeroed();
        session.flags = FWPM_SESSION_FLAG_DYNAMIC;
        let rc = FwpmEngineOpen0(
            std::ptr::null(),
            AUTHN_DEFAULT,
            std::ptr::null(),
            &session,
            &mut engine,
        );
        if rc != 0 {
            return Err(format!("FwpmEngineOpen0: {rc}"));
        }

        let tx_rc = FwpmTransactionBegin0(engine, 0);
        if tx_rc != 0 {
            let _ = FwpmEngineClose0(engine);
            return Err(format!("FwpmTransactionBegin0: {tx_rc}"));
        }
        let res = build_filters(engine, &sublayer, exe_paths, allow_lan, tun_luid);
        match res {
            Ok(block_filters) => {
                let commit_rc = FwpmTransactionCommit0(engine);
                if commit_rc != 0 {
                    let _ = FwpmTransactionAbort0(engine);
                    let _ = FwpmEngineClose0(engine);
                    return Err(format!("FwpmTransactionCommit0: {commit_rc}"));
                }
                Ok(super::KillSwitchLease {
                    handle: engine.0 as isize,
                    sublayer: sublayer_id,
                    block_filters,
                    transition: false,
                })
            }
            Err(e) => {
                let _ = FwpmTransactionAbort0(engine);
                let _ = FwpmEngineClose0(engine);
                Err(e)
            }
        }
    }

    pub unsafe fn disarm(lease: super::KillSwitchLease) -> Result<(), String> {
        // Закрытие хэндла dynamic-сессии снимает все наши фильтры/sublayer.
        let rc = FwpmEngineClose0(HANDLE(lease.handle as *mut core::ffi::c_void));
        if rc == 0 {
            Ok(())
        } else {
            Err(format!("FwpmEngineClose0: {rc}"))
        }
    }

    pub unsafe fn session_alive(lease: super::KillSwitchLease) -> bool {
        let engine = HANDLE(lease.handle as *mut core::ffi::c_void);
        let sublayer = GUID::from_u128(lease.sublayer);
        let mut sublayer_ptr: *mut FWPM_SUBLAYER0 = std::ptr::null_mut();
        let sublayer_rc = FwpmSubLayerGetByKey0(engine, &sublayer, &mut sublayer_ptr);
        let sublayer_found = !sublayer_ptr.is_null();
        if !sublayer_ptr.is_null() {
            let mut memory = sublayer_ptr.cast::<core::ffi::c_void>();
            FwpmFreeMemory0(&mut memory);
        }
        if sublayer_rc != 0 || !sublayer_found {
            return false;
        }
        for filter_id in lease.block_filters {
            let mut filter_ptr: *mut FWPM_FILTER0 = std::ptr::null_mut();
            let rc = FwpmFilterGetById0(engine, filter_id, &mut filter_ptr);
            let filter_found = !filter_ptr.is_null();
            if !filter_ptr.is_null() {
                let mut memory = filter_ptr.cast::<core::ffi::c_void>();
                FwpmFreeMemory0(&mut memory);
            }
            if rc != 0 || !filter_found {
                return false;
            }
        }
        true
    }

    fn random_sublayer_id() -> Result<u128, String> {
        loop {
            let mut bytes = [0u8; 16];
            OsRng
                .try_fill_bytes(&mut bytes)
                .map_err(|e| format!("не удалось получить случайный GUID WFP: {e}"))?;
            let value = u128::from_be_bytes(bytes);
            if value != 0 {
                return Ok(value);
            }
        }
    }

    unsafe fn build_filters(
        engine: HANDLE,
        sublayer_key: &GUID,
        exe_paths: &[String],
        allow_lan: bool,
        tun_luid: Option<u64>,
    ) -> Result<[u64; 2], String> {
        // sublayer
        let mut sname = wide("Ninety Kill Switch");
        let mut sub: FWPM_SUBLAYER0 = std::mem::zeroed();
        sub.subLayerKey = *sublayer_key;
        sub.displayData.name = PWSTR(sname.as_mut_ptr());
        sub.weight = 0x0100;
        let rc = FwpmSubLayerAdd0(engine, &sub, None);
        if rc != 0 {
            return Err(format!("FwpmSubLayerAdd0: {rc}"));
        }

        let layers = [
            FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
        ];

        // block-all (низкий вес). IDs сохраняем и потом проверяем: живой engine
        // handle без этих фильтров не является активным kill switch.
        let block_filters = [
            add_filter(
                engine,
                sublayer_key,
                &layers[0],
                FWP_ACTION_BLOCK,
                0,
                &mut [],
            )?,
            add_filter(
                engine,
                sublayer_key,
                &layers[1],
                FWP_ACTION_BLOCK,
                0,
                &mut [],
            )?,
        ];
        // permit loopback (высокий вес)
        for layer in layers {
            let mut c = loopback_condition();
            add_filter(
                engine,
                sublayer_key,
                &layer,
                FWP_ACTION_PERMIT,
                15,
                std::slice::from_mut(&mut c),
            )?;
        }
        // Строгий TUN: пользовательский трафик разрешён только после того, как
        // Windows связала локальный маршрут с ninety-tun. Когда интерфейс исчезает,
        // permit перестаёт совпадать, а block-all продолжает держать сеть.
        if let Some(mut luid) = tun_luid {
            for layer in layers {
                let mut c = local_interface_condition(&mut luid);
                add_filter(
                    engine,
                    sublayer_key,
                    &layer,
                    FWP_ACTION_PERMIT,
                    15,
                    std::slice::from_mut(&mut c),
                )?;
            }
        }
        // permit DHCP (всегда): без него renew lease рвёт всю сеть. DHCPv4-клиент
        // держит локальный UDP-порт 68, DHCPv6 — 546. Ставим по matching-слою.
        {
            let mut c4 = [
                protocol_condition(17),
                local_port_condition(68),
                remote_port_condition(67),
            ];
            add_filter(
                engine,
                sublayer_key,
                &FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                FWP_ACTION_PERMIT,
                14,
                &mut c4,
            )?;
            let mut c6 = [
                protocol_condition(17),
                local_port_condition(546),
                remote_port_condition(547),
            ];
            add_filter(
                engine,
                sublayer_key,
                &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                FWP_ACTION_PERMIT,
                14,
                &mut c6,
            )?;
        }
        // permit LAN (по опции): приватные/link-local/broadcast/multicast подсети,
        // чтобы блок не резал принтеры, NAS и обнаружение устройств. bypassLan в
        // sing-box эти пакеты мимо ядра не спасает — они режутся block-all у WFP.
        if allow_lan {
            permit_lan(engine, sublayer_key)?;
        }
        // permit каждого движка по app-id (высокий вес): sing-box + мосты
        // xray/naive/trusttunnel_client — внешний коннект делает любой из них.
        for exe in exe_paths {
            let blob = app_id_blob(exe)?;
            let add_result = (|| {
                for layer in layers {
                    let mut c = appid_condition(blob);
                    add_filter(
                        engine,
                        sublayer_key,
                        &layer,
                        FWP_ACTION_PERMIT,
                        15,
                        std::slice::from_mut(&mut c),
                    )?;
                }
                Ok::<(), String>(())
            })();
            FwpmFreeMemory0(&mut (blob as *mut core::ffi::c_void));
            add_result?;
        }
        Ok(block_filters)
    }

    // Приватные диапазоны IPv4 (addr/mask в host-order) + IPv6 unique-local и
    // link-local. broadcast/multicast — для DHCP-offer, mDNS, SSDP-обнаружения.
    unsafe fn permit_lan(engine: HANDLE, sublayer_key: &GUID) -> Result<(), String> {
        const V4: &[(u32, u32)] = &[
            (0x0A00_0000, 0xFF00_0000), // 10.0.0.0/8
            (0xAC10_0000, 0xFFF0_0000), // 172.16.0.0/12
            (0xC0A8_0000, 0xFFFF_0000), // 192.168.0.0/16
            (0xA9FE_0000, 0xFFFF_0000), // 169.254.0.0/16 link-local
            (0xE000_0000, 0xF000_0000), // 224.0.0.0/4 multicast
            (0xFFFF_FFFF, 0xFFFF_FFFF), // 255.255.255.255 broadcast
        ];
        for &(addr, mask) in V4 {
            let am = FWP_V4_ADDR_AND_MASK { addr, mask };
            let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
            c.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
            c.matchType = FWP_MATCH_EQUAL;
            c.conditionValue.r#type = FWP_V4_ADDR_MASK;
            c.conditionValue.Anonymous.v4AddrMask = &am as *const _ as *mut FWP_V4_ADDR_AND_MASK;
            add_filter(
                engine,
                sublayer_key,
                &FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                FWP_ACTION_PERMIT,
                12,
                std::slice::from_mut(&mut c),
            )?;
        }
        // IPv6: fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast).
        const V6: &[([u8; 16], u8)] = &[
            ([0xFC, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 7),
            ([0xFE, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10),
            ([0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 8),
        ];
        for &(addr, prefix) in V6 {
            let am = FWP_V6_ADDR_AND_MASK {
                addr,
                prefixLength: prefix,
            };
            let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
            c.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
            c.matchType = FWP_MATCH_EQUAL;
            c.conditionValue.r#type = FWP_V6_ADDR_MASK;
            c.conditionValue.Anonymous.v6AddrMask = &am as *const _ as *mut FWP_V6_ADDR_AND_MASK;
            add_filter(
                engine,
                sublayer_key,
                &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                FWP_ACTION_PERMIT,
                12,
                std::slice::from_mut(&mut c),
            )?;
        }
        Ok(())
    }

    // Условие «локальный порт равен N» (для DHCP-permit).
    unsafe fn local_port_condition(port: u16) -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        c.fieldKey = FWPM_CONDITION_IP_LOCAL_PORT;
        c.matchType = FWP_MATCH_EQUAL;
        c.conditionValue.r#type = FWP_UINT16;
        c.conditionValue.Anonymous.uint16 = port;
        c
    }

    unsafe fn remote_port_condition(port: u16) -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        c.fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
        c.matchType = FWP_MATCH_EQUAL;
        c.conditionValue.r#type = FWP_UINT16;
        c.conditionValue.Anonymous.uint16 = port;
        c
    }

    unsafe fn protocol_condition(protocol: u8) -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        c.fieldKey = FWPM_CONDITION_IP_PROTOCOL;
        c.matchType = FWP_MATCH_EQUAL;
        c.conditionValue.r#type = FWP_UINT8;
        c.conditionValue.Anonymous.uint8 = protocol;
        c
    }

    unsafe fn local_interface_condition(luid: &mut u64) -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        // IP_LOCAL_INTERFACE официально доступен на ALE_AUTH_CONNECT. Runtime-
        // поле NEXTHOP_INTERFACE существует, но management filter condition для
        // этого слоя не поддерживается и FwpmFilterAdd0 отвергает такой фильтр.
        c.fieldKey = FWPM_CONDITION_IP_LOCAL_INTERFACE;
        c.matchType = FWP_MATCH_EQUAL;
        c.conditionValue.r#type = FWP_UINT64;
        c.conditionValue.Anonymous.uint64 = luid as *mut u64;
        c
    }

    unsafe fn add_filter(
        engine: HANDLE,
        sublayer_key: &GUID,
        layer: &GUID,
        action: FWP_ACTION_TYPE,
        weight: u8,
        conds: &mut [FWPM_FILTER_CONDITION0],
    ) -> Result<u64, String> {
        let mut fname = wide("Ninety Kill Switch");
        let mut f: FWPM_FILTER0 = std::mem::zeroed();
        f.displayData.name = PWSTR(fname.as_mut_ptr());
        f.layerKey = *layer;
        f.subLayerKey = *sublayer_key;
        f.weight = val_u8(weight);
        f.action.r#type = action;
        if !conds.is_empty() {
            f.numFilterConditions = conds.len() as u32;
            f.filterCondition = conds.as_mut_ptr();
        }
        let mut filter_id = 0u64;
        let rc = FwpmFilterAdd0(engine, &f, None, Some(&mut filter_id));
        if rc != 0 {
            return Err(format!("FwpmFilterAdd0: {rc}"));
        }
        if filter_id == 0 {
            return Err("FwpmFilterAdd0 не вернул id фильтра".into());
        }
        Ok(filter_id)
    }

    unsafe fn val_u8(v: u8) -> FWP_VALUE0 {
        let mut val: FWP_VALUE0 = std::mem::zeroed();
        val.r#type = FWP_UINT8;
        val.Anonymous.uint8 = v;
        val
    }

    unsafe fn loopback_condition() -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        c.fieldKey = FWPM_CONDITION_FLAGS;
        c.matchType = FWP_MATCH_FLAGS_ALL_SET;
        c.conditionValue.r#type = FWP_UINT32;
        c.conditionValue.Anonymous.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
        c
    }

    unsafe fn appid_condition(blob: *mut FWP_BYTE_BLOB) -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        c.fieldKey = FWPM_CONDITION_ALE_APP_ID;
        c.matchType = FWP_MATCH_EQUAL;
        c.conditionValue.r#type = FWP_BYTE_BLOB_TYPE;
        c.conditionValue.Anonymous.byteBlob = blob;
        c
    }

    unsafe fn app_id_blob(exe: &str) -> Result<*mut FWP_BYTE_BLOB, String> {
        let w = wide(exe);
        let mut blob: *mut FWP_BYTE_BLOB = std::ptr::null_mut();
        let rc = FwpmGetAppIdFromFileName0(PCWSTR(w.as_ptr()), &mut blob);
        if rc != 0 {
            return Err(format!("FwpmGetAppIdFromFileName0: {rc}"));
        }
        if blob.is_null() {
            return Err("app id blob пуст".into());
        }
        Ok(blob)
    }

    unsafe fn interface_luid(alias: &str) -> Result<u64, String> {
        let w = wide(alias);
        let mut luid: NET_LUID_LH = std::mem::zeroed();
        let rc = ConvertInterfaceAliasToLuid(PCWSTR(w.as_ptr()), &mut luid);
        if rc.0 != 0 {
            return Err(format!("ConvertInterfaceAliasToLuid({alias}): {}", rc.0));
        }
        Ok(luid.Value)
    }
}
