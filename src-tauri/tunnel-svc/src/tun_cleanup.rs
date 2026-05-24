// Очистка осиротевшего Wintun-адаптера `ninety-tun` на старте сервиса.
//
// Когда sing-box падает жёстко (kill -9, BSOD, watchdog), Wintun-адаптер
// остаётся зарегистрирован в Windows. При следующем старте sing-box пытается
// создать `ninety-tun` повторно и падает с "create wintun adapter: already
// exists" или "open handle". Hiddify решает это через WintunCloseAdapter из
// wintun.dll; мы — best-effort через pnputil (не требует bundling DLL).
//
// LocalSystem-сервис имеет admin-привилегии, поэтому pnputil /remove-device
// проходит. Get-NetAdapter — read-only, работает на Win10+ из коробки.

#[cfg(not(target_os = "windows"))]
pub fn cleanup_orphan_tun_adapter() {}

#[cfg(target_os = "windows")]
pub fn cleanup_orphan_tun_adapter() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    use crate::{lerr, linfo, lwarn};

    const ADAPTER_NAME: &str = "ninety-tun";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let ps_cmd = format!(
        "(Get-NetAdapter -Name '{ADAPTER_NAME}' -ErrorAction SilentlyContinue).PnPDeviceID"
    );
    let check = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let pnp_id = match check {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                linfo!("tun_cleanup: осиротевшего {ADAPTER_NAME} не найдено");
                return;
            }
            s
        }
        Ok(o) => {
            lwarn!(
                "tun_cleanup: Get-NetAdapter exit={:?}, stderr={}",
                o.status.code(),
                String::from_utf8_lossy(&o.stderr).trim()
            );
            return;
        }
        Err(e) => {
            lerr!("tun_cleanup: powershell не запустился: {e}");
            return;
        }
    };

    lwarn!("tun_cleanup: найден {ADAPTER_NAME} (PnP={pnp_id}), удаляю через pnputil");

    let rm = Command::new("pnputil")
        .args(["/remove-device", &pnp_id])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match rm {
        Ok(o) if o.status.success() => {
            linfo!("tun_cleanup: {ADAPTER_NAME} удалён, sing-box создаст свежий");
        }
        Ok(o) => {
            lwarn!(
                "tun_cleanup: pnputil exit={:?}, stdout={}, stderr={}",
                o.status.code(),
                String::from_utf8_lossy(&o.stdout).trim(),
                String::from_utf8_lossy(&o.stderr).trim()
            );
        }
        Err(e) => {
            lerr!("tun_cleanup: pnputil не запустился: {e}");
        }
    }
}
