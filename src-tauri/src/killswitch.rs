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
// выход → нет утечки. В TUN-режим НЕ лезем: там утечки держит strict_route sing-box.
//
// Безопасность от «вечного лока»: открываем WFP-движок DYNAMIC-сессией — все объекты
// авто-снимаются при закрытии хэндла ИЛИ выходе процесса Ninety. То есть если аппа
// упадёт, фильтры исчезнут сами, сеть не останется заблокированной навсегда.
//
// ⚠️ ВНИМАНИЕ: сырой FWPM-FFI, локально НЕ компилировался (правило проекта — сборка
// только на CI). Первый CI-ран может потребовать фиксапов имён полей/констант
// windows-rs. Фича выключена по умолчанию (network.killSwitch) — на обычных юзеров
// не влияет, пока не включат вручную.

use std::sync::Mutex;

/// Хранит сырой FWPM engine handle (isize), пока kill switch активен. None = выключен.
/// HANDLE не Send/Sync — держим как isize, восстанавливаем при disarm.
#[derive(Default)]
pub struct KillSwitchState(pub Mutex<Option<isize>>);

/// Включить kill switch. Идемпотентно: если уже активен — no-op. Permit получают
/// все движки Ninety, найденные рядом с нашим бинарём (Tauri кладёт сайдкары туда
/// же): permit для не запущенного exe инертен, а вот пропущенный permit глушит
/// протокол намертво — поэтому не гадаем, какие ноды в активном конфиге.
#[tauri::command]
pub fn killswitch_arm(state: tauri::State<'_, KillSwitchState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let exes = engine_exe_paths()?;
        let handle = unsafe { win::arm(&exes)? };
        *guard = Some(handle);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("kill switch доступен только на Windows".into())
    }
}

/// Выключить kill switch (снять все фильтры). Идемпотентно.
#[tauri::command]
pub fn killswitch_disarm(state: tauri::State<'_, KillSwitchState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(h) = guard.take() {
        #[cfg(target_os = "windows")]
        unsafe {
            win::disarm(h);
        }
        #[cfg(not(target_os = "windows"))]
        let _ = h;
    }
    Ok(())
}

/// Активен ли kill switch (для синхронизации UI).
#[tauri::command]
pub fn killswitch_active(state: tauri::State<'_, KillSwitchState>) -> bool {
    state.0.lock().unwrap().is_some()
}

// Снять движок при выходе аппы (на случай, если фронт не успел) — фильтры и так
// уйдут с процессом (dynamic-session), но закрываем явно.
pub fn force_disarm(state: &KillSwitchState) {
    if let Some(_h) = state.0.lock().unwrap().take() {
        #[cfg(target_os = "windows")]
        unsafe {
            win::disarm(_h);
        }
    }
}

// Все движки, способные делать внешний коннект (см. externalBin в tauri.conf.json).
// Пропущенные на диске (например dev-запуск без сайдкаров) просто не попадают в
// permit; если не нашёлся НИ ОДИН — это ошибка: armed-блок без единого permit
// отрезал бы сеть целиком, включая сам туннель.
#[cfg(target_os = "windows")]
fn engine_exe_paths() -> Result<Vec<String>, String> {
    const ENGINES: [&str; 4] = ["sing-box.exe", "xray.exe", "naive.exe", "trusttunnel_client.exe"];
    let dir = std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?
        .parent()
        .ok_or("нет родительского каталога exe")?
        .to_path_buf();
    let exes: Vec<String> = ENGINES
        .iter()
        .map(|name| dir.join(name))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    if exes.is_empty() {
        return Err("движки не найдены рядом с Ninety — kill switch не включён".into());
    }
    Ok(exes)
}

#[cfg(target_os = "windows")]
mod win {
    use windows::core::{GUID, PCWSTR, PWSTR};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::NetworkManagement::WindowsFilteringPlatform::*;

    // Фиксированный sublayer GUID Ninety (уникальный).
    const SUBLAYER: GUID = GUID::from_u128(0x9011f2a3_5c7b_4e1d_8a2f_1b6c3d4e5f60);
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

    pub unsafe fn arm(exe_paths: &[String]) -> Result<isize, String> {
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

        let res = build_filters(engine, exe_paths);
        match res {
            Ok(()) => Ok(engine.0 as isize),
            Err(e) => {
                let _ = FwpmEngineClose0(engine);
                Err(e)
            }
        }
    }

    pub unsafe fn disarm(handle: isize) {
        // Закрытие хэндла dynamic-сессии снимает все наши фильтры/sublayer.
        let _ = FwpmEngineClose0(HANDLE(handle as *mut core::ffi::c_void));
    }

    unsafe fn build_filters(engine: HANDLE, exe_paths: &[String]) -> Result<(), String> {
        // sublayer
        let mut sname = wide("Ninety Kill Switch");
        let mut sub: FWPM_SUBLAYER0 = std::mem::zeroed();
        sub.subLayerKey = SUBLAYER;
        sub.displayData.name = PWSTR(sname.as_mut_ptr());
        sub.weight = 0x0100;
        let rc = FwpmSubLayerAdd0(engine, &sub, None);
        if rc != 0 {
            return Err(format!("FwpmSubLayerAdd0: {rc}"));
        }

        let layers = [FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6];

        // block-all (низкий вес)
        for layer in layers {
            add_filter(engine, &layer, FWP_ACTION_BLOCK, 0, &mut [])?;
        }
        // permit loopback (высокий вес)
        for layer in layers {
            let mut c = loopback_condition();
            add_filter(engine, &layer, FWP_ACTION_PERMIT, 15, std::slice::from_mut(&mut c))?;
        }
        // permit каждого движка по app-id (высокий вес): sing-box + мосты
        // xray/naive/trusttunnel_client — внешний коннект делает любой из них.
        for exe in exe_paths {
            let blob = app_id_blob(exe)?;
            for layer in layers {
                let mut c = appid_condition(blob);
                add_filter(engine, &layer, FWP_ACTION_PERMIT, 15, std::slice::from_mut(&mut c))?;
            }
            FwpmFreeMemory0(&mut (blob as *mut core::ffi::c_void));
        }
        Ok(())
    }

    unsafe fn add_filter(
        engine: HANDLE,
        layer: &GUID,
        action: FWP_ACTION_TYPE,
        weight: u8,
        conds: &mut [FWPM_FILTER_CONDITION0],
    ) -> Result<(), String> {
        let mut fname = wide("Ninety Kill Switch");
        let mut f: FWPM_FILTER0 = std::mem::zeroed();
        f.displayData.name = PWSTR(fname.as_mut_ptr());
        f.layerKey = *layer;
        f.subLayerKey = SUBLAYER;
        f.weight = val_u8(weight);
        f.action.r#type = action;
        if !conds.is_empty() {
            f.numFilterConditions = conds.len() as u32;
            f.filterCondition = conds.as_mut_ptr();
        }
        let rc = FwpmFilterAdd0(engine, &f, None, None);
        if rc != 0 {
            return Err(format!("FwpmFilterAdd0: {rc}"));
        }
        Ok(())
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
}
