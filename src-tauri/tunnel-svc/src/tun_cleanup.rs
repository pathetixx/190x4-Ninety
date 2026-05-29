// Очистка осиротевшего Wintun-адаптера `ninety-tun` на старте сервиса.
//
// Уровни (по убыванию надёжности и наличия зависимостей):
//   1. pnputil /remove-device — best-effort через PnP-менеджер. Работает на 95%
//      случаев; не требует ничего кроме admin (есть у LocalSystem).
//   2. wintun.dll FFI (WintunOpenAdapter + WintunCloseAdapter) — точечное
//      закрытие handle адаптера через ту же DLL, которой sing-box его создавал.
//      Используется как fallback, если pnputil вернул успех, но Get-NetAdapter
//      всё ещё видит адаптер (stale-cases), или если pnputil упал.
//   3. netsh interface delete — последний резерв, иногда лечит «зависший»
//      адаптер когда первые два пути не помогли.
//
// wintun.dll не bundle'им жёстко; ищем по нескольким путям, чтобы работало
// и в dev (CWD), и в prod (рядом с exe), и при наличии глобально установленной
// (System32). Hiddify аналогично — у них wintun.dll лежит рядом с hiddify-cli.

#[cfg(not(target_os = "windows"))]
pub fn cleanup_orphan_tun_adapter() {}

#[cfg(target_os = "windows")]
pub fn cleanup_orphan_tun_adapter() {
    use crate::{lerr, linfo, lwarn};

    const ADAPTER_NAME: &str = "ninety-tun";

    if !adapter_exists(ADAPTER_NAME) {
        linfo!("tun_cleanup: осиротевшего {ADAPTER_NAME} не найдено");
        return;
    }

    lwarn!("tun_cleanup: найден {ADAPTER_NAME}, начинаю очистку");

    // Уровень 1: pnputil — самый надёжный, проходит на admin без зависимостей
    let pnputil_ok = match get_pnp_id(ADAPTER_NAME) {
        Some(id) => {
            let ok = pnputil_remove(&id);
            if ok {
                linfo!("tun_cleanup: pnputil OK");
            }
            ok
        }
        None => {
            lwarn!("tun_cleanup: PnPDeviceID не достался");
            false
        }
    };

    // Если pnputil сработал и адаптер реально исчез — выходим
    if pnputil_ok && !adapter_exists(ADAPTER_NAME) {
        linfo!("tun_cleanup: {ADAPTER_NAME} удалён, sing-box создаст свежий");
        return;
    }

    // Уровень 2: WintunCloseAdapter через DLL FFI
    match wintun_close(ADAPTER_NAME) {
        Ok(true) => linfo!("tun_cleanup: WintunCloseAdapter OK"),
        Ok(false) => lwarn!("tun_cleanup: wintun.dll не найдена, FFI пропущен"),
        Err(e) => lerr!("tun_cleanup: WintunCloseAdapter: {e}"),
    }

    if !adapter_exists(ADAPTER_NAME) {
        linfo!("tun_cleanup: {ADAPTER_NAME} удалён после FFI fallback");
        return;
    }

    // Уровень 3: netsh — последний резерв
    if netsh_delete(ADAPTER_NAME) && !adapter_exists(ADAPTER_NAME) {
        linfo!("tun_cleanup: {ADAPTER_NAME} удалён через netsh");
        return;
    }

    lerr!(
        "tun_cleanup: {ADAPTER_NAME} всё ещё существует после всех попыток. \
         Возможно, придётся перезагрузить Windows или удалить руками через Device Manager."
    );
}

// Полный путь к системной утилите. Сервис исполняется под LocalSystem, и звать
// бинари по голому имени — приглашение к PATH/CWD-hijack от SYSTEM. Резолвим в
// %SystemRoot%\System32 явно.
#[cfg(target_os = "windows")]
fn system32(prog: &str) -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    match prog {
        "powershell" => format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe"),
        other => format!(r"{root}\System32\{other}.exe"),
    }
}

#[cfg(target_os = "windows")]
fn run_silent(prog: &str, args: &[&str]) -> Option<std::process::Output> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new(system32(prog))
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
}

#[cfg(target_os = "windows")]
fn adapter_exists(name: &str) -> bool {
    let cmd = format!(
        "[bool](Get-NetAdapter -Name '{name}' -ErrorAction SilentlyContinue)"
    );
    run_silent(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &cmd],
    )
    .and_then(|o| {
        if !o.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&o.stdout);
        Some(s.trim().eq_ignore_ascii_case("True"))
    })
    .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn get_pnp_id(name: &str) -> Option<String> {
    let cmd = format!(
        "(Get-NetAdapter -Name '{name}' -ErrorAction SilentlyContinue).PnPDeviceID"
    );
    let out = run_silent(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &cmd],
    )?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(target_os = "windows")]
fn pnputil_remove(pnp_id: &str) -> bool {
    use crate::lwarn;
    let out = run_silent("pnputil", &["/remove-device", pnp_id]);
    match out {
        Some(o) if o.status.success() => true,
        Some(o) => {
            lwarn!(
                "tun_cleanup: pnputil exit={:?}, stderr={}",
                o.status.code(),
                String::from_utf8_lossy(&o.stderr).trim()
            );
            false
        }
        None => {
            lwarn!("tun_cleanup: pnputil не запустился");
            false
        }
    }
}

#[cfg(target_os = "windows")]
fn netsh_delete(name: &str) -> bool {
    // netsh ожидает имя без пробелов/спец. символов — у нас "ninety-tun" чистый
    let arg = format!("name={name}");
    run_silent("netsh", &["interface", "set", "interface", &arg, "admin=disable"]);
    let out = run_silent("netsh", &["interface", "delete", "interface", &arg]);
    out.map(|o| o.status.success()).unwrap_or(false)
}

// ── wintun.dll FFI ──────────────────────────────────────────────────────────
// Динамическая загрузка: dll может лежать рядом с exe (bundle), в текущей
// директории (dev), или в System32 (если у юзера стоит WireGuard/OpenVPN, они
// её ставят туда). Возвращаем Ok(false), если dll не найдена — это не ошибка,
// а отсутствие fallback'а.

#[cfg(target_os = "windows")]
fn wintun_close(name: &str) -> Result<bool, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;

    let dll_path = match find_wintun_dll() {
        Some(p) => p,
        None => return Ok(false),
    };

    // Преобразуем имя адаптера в UTF-16 + null-terminator (LPCWSTR)
    let wide_name: Vec<u16> = OsStr::new(name).encode_wide().chain(std::iter::once(0)).collect();

    unsafe {
        let lib = libloading::Library::new(&dll_path)
            .map_err(|e| format!("LoadLibrary {}: {e}", dll_path.display()))?;

        type WintunOpenAdapterFn =
            unsafe extern "system" fn(name: *const u16) -> *mut std::ffi::c_void;
        type WintunCloseAdapterFn = unsafe extern "system" fn(adapter: *mut std::ffi::c_void);

        let open: libloading::Symbol<WintunOpenAdapterFn> = lib
            .get(b"WintunOpenAdapter\0")
            .map_err(|e| format!("WintunOpenAdapter: {e}"))?;
        let close: libloading::Symbol<WintunCloseAdapterFn> = lib
            .get(b"WintunCloseAdapter\0")
            .map_err(|e| format!("WintunCloseAdapter: {e}"))?;

        let adapter = open(wide_name.as_ptr());
        if adapter.is_null() {
            // Адаптер уже исчез или handle недоступен — это нормально
            return Ok(true);
        }
        close(adapter);
    }

    // Lib дропается тут — UnloadLibrary; адаптер уже закрыт
    let _ = PathBuf::from(dll_path);
    Ok(true)
}

#[cfg(target_os = "windows")]
fn find_wintun_dll() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    let mut candidates: Vec<PathBuf> = Vec::new();
    // 1) Рядом с exe сервиса (production bundle, %ProgramFiles%\Ninety — admin-only)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("wintun.dll"));
        }
    }
    // CWD намеренно НЕ кандидат: сервис под LocalSystem, CWD=System32, грузить
    // DLL по CWD из привилегированного процесса — вектор DLL-hijack.
    // 2) System32 (если установлен Wintun глобально — например, WireGuard MSI)
    if let Some(sysroot) = std::env::var_os("SystemRoot") {
        let mut p = PathBuf::from(sysroot);
        p.push("System32");
        p.push("wintun.dll");
        candidates.push(p);
    }

    candidates.into_iter().find(|p| p.exists())
}
