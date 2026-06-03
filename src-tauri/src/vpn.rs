use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[cfg(target_os = "windows")]
use crate::proxy_win as proxy;
#[cfg(not(target_os = "windows"))]
use crate::proxy_stub as proxy;

pub struct SingboxState {
    // Child sing-box (sidecar) для ВСЕХ режимов, включая TUN. В TUN-режиме
    // Ninety запущен elevated (Throne-style), поэтому sing-box-child наследует
    // админ-права и сам поднимает TUN-инбаунд — отдельной службы больше нет.
    child: Mutex<Option<CommandChild>>,
    // xray-core sidecar (two-core): обслуживает xhttp-ноды. Слушает 127.0.0.1;
    // sing-box ходит к нему через loopback socks-мост.
    xray_child: Mutex<Option<CommandChild>>,
    died: Arc<Mutex<Option<String>>>,
    // Причина смерти xray-sidecar (two-core). Ставится монитор-таском xray при
    // Terminated, сбрасывается при start_singbox. Нужен чтобы фронт мог отличить
    // «упал xhttp-мост» (авто-реконнект) от «упал sing-box» (туннель закрыт).
    xray_died: Arc<Mutex<Option<String>>>,
    // Sidecar-клиенты naive / trusttunnel_client (по одному процессу на ноду):
    // каждый поднимает локальный SOCKS5, sing-box ходит к ним loopback-мостом.
    // Список, т.к. этих протоколов в одном источнике может быть несколько.
    sidecars: Mutex<Vec<CommandChild>>,
    // Причина смерти любого sidecar-клиента (naive/TT) — как xray_died, для
    // авто-реконнекта фронтом (sidecar_status).
    sidecar_died: Arc<Mutex<Option<String>>>,
}

impl Default for SingboxState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            xray_child: Mutex::new(None),
            died: Arc::new(Mutex::new(None)),
            xray_died: Arc::new(Mutex::new(None)),
            sidecars: Mutex::new(Vec::new()),
            sidecar_died: Arc::new(Mutex::new(None)),
        }
    }
}

// Спецификация sidecar-клиента, приходит из фронта (buildConfig.sidecars).
#[derive(serde::Deserialize)]
struct SidecarSpec {
    kind: String, // "naive" | "trusttunnel"
    port: u16,
    config: String,
}

// Финальная обработка конфига перед запуском sing-box (в любом режиме):
//  - инжектим секрет clash-API (см. clash::clash_secret), чтобы 9090 не был
//    доступен любому локальному процессу без авторизации;
//  - принудительно держим external_controller на 127.0.0.1 (даже если фронт
//    зачем-то выставил 0.0.0.0) — управление ядром не должно торчать в сеть.
// При невалидном JSON возвращаем как есть: пусть sing-box сам ругнётся.
fn harden_config(raw: &str) -> String {
    let mut v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return raw.to_string(),
    };
    if let Some(api) = v
        .get_mut("experimental")
        .and_then(|e| e.get_mut("clash_api"))
        .and_then(|a| a.as_object_mut())
    {
        api.insert(
            "secret".into(),
            serde_json::Value::String(crate::clash::clash_secret().to_string()),
        );
        let port = api
            .get("external_controller")
            .and_then(|c| c.as_str())
            .and_then(|s| s.rsplit(':').next())
            .unwrap_or("9090")
            .to_string();
        api.insert(
            "external_controller".into(),
            serde_json::Value::String(format!("127.0.0.1:{port}")),
        );
    }
    serde_json::to_string(&v).unwrap_or_else(|_| raw.to_string())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("singbox-current.json"))
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("singbox.log"))
}

fn xray_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("xray-current.json"))
}

fn xray_log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("xray.log"))
}

// Поднимает xray-core sidecar для xhttp-нод (two-core). Всегда user-level,
// слушает 127.0.0.1; sing-box (свой child или сервис под LocalSystem) ходит
// к нему через loopback socks-мосты из конфига. Spawn до sing-box.
async fn spawn_xray(
    app: &AppHandle,
    state: &SingboxState,
    xray_json: &str,
) -> Result<(), String> {
    let path = xray_config_path(app)?;
    std::fs::write(&path, xray_json).map_err(|e| format!("write xray config: {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("xray")
        .map_err(|e| format!("xray sidecar lookup: {e}"))?;
    let (mut rx, child) = sidecar
        .args(["run", "-c", &path_str])
        .spawn()
        .map_err(|e| format!("spawn xray: {e}"))?;
    *state.xray_child.lock().unwrap() = Some(child);

    let died_flag = state.xray_died.clone();
    let log_file = xray_log_path(app);
    tauri::async_runtime::spawn(async move {
        let mut writer = log_file.as_ref().and_then(|p| {
            std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
        });
        if let Some(w) = writer.as_mut() {
            let _ = writeln!(w, "\n=== xray start ===");
        }
        let mut last: Vec<String> = Vec::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line).to_string();
                    if let Some(w) = writer.as_mut() {
                        let _ = writeln!(w, "{text}");
                    }
                    last.push(text);
                    if last.len() > 40 {
                        last.remove(0);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let msg = format!(
                        "xray умер (код {:?}). Последние строки:\n{}",
                        payload.code,
                        last.join("\n")
                    );
                    if let Some(w) = writer.as_mut() {
                        let _ = writeln!(w, "{msg}");
                    }
                    *died_flag.lock().unwrap() = Some(msg);
                    break;
                }
                _ => {}
            }
        }
    });

    // Дать xray подняться и забиндить socks-инбаунды до старта sing-box,
    // иначе первые urltest'ы xhttp-нод словят connection refused.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    Ok(())
}

// Поднимает sidecar-клиенты naive / trusttunnel_client (по одному на ноду).
// Каждый слушает локальный SOCKS5 (порт из spec), sing-box ходит к ним мостом.
// User-level (SOCKS-режим TT не требует админ-прав/TUN). Spawn до sing-box.
async fn spawn_sidecars(
    app: &AppHandle,
    state: &SingboxState,
    specs: &[SidecarSpec],
) -> Result<(), String> {
    let cfg_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("mkdir: {e}"))?;
    let log_dir = app.path().app_log_dir().ok();

    for spec in specs {
        // Имя бинаря (externalBin) + аргументы + расширение конфига по типу.
        let (bin, ext, file_arg) = match spec.kind.as_str() {
            "naive" => ("naive", "json", false),               // naive.exe <config.json>
            "trusttunnel" => ("trusttunnel_client", "toml", true), // --config <toml>
            other => return Err(format!("неизвестный sidecar: {other}")),
        };
        let cfg_path = cfg_dir.join(format!("{}-{}.{}", spec.kind, spec.port, ext));
        std::fs::write(&cfg_path, &spec.config)
            .map_err(|e| format!("write {} config: {e}", spec.kind))?;
        let cfg_str = cfg_path.to_string_lossy().to_string();

        let sidecar = app
            .shell()
            .sidecar(bin)
            .map_err(|e| format!("{bin} sidecar lookup: {e}"))?;
        let cmd = if file_arg {
            sidecar.args(["--config", &cfg_str])
        } else {
            sidecar.args([cfg_str.as_str()])
        };
        let (mut rx, child) = cmd
            .spawn()
            .map_err(|e| format!("spawn {bin}: {e}"))?;
        state.sidecars.lock().unwrap().push(child);

        let died_flag = state.sidecar_died.clone();
        let log_file = log_dir.as_ref().map(|d| d.join(format!("{}.log", spec.kind)));
        let label = format!("{} :{}", spec.kind, spec.port);
        tauri::async_runtime::spawn(async move {
            let mut writer = log_file.as_ref().and_then(|p| {
                std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
            });
            if let Some(w) = writer.as_mut() {
                let _ = writeln!(w, "\n=== {label} start ===");
            }
            let mut last: Vec<String> = Vec::new();
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                        let text = String::from_utf8_lossy(&line).to_string();
                        if let Some(w) = writer.as_mut() {
                            let _ = writeln!(w, "{text}");
                        }
                        last.push(text);
                        if last.len() > 40 {
                            last.remove(0);
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        let msg = format!(
                            "{label} умер (код {:?}). Последние строки:\n{}",
                            payload.code,
                            last.join("\n")
                        );
                        if let Some(w) = writer.as_mut() {
                            let _ = writeln!(w, "{msg}");
                        }
                        *died_flag.lock().unwrap() = Some(msg);
                        break;
                    }
                    _ => {}
                }
            }
        });
    }

    if !specs.is_empty() {
        // Дать клиентам забиндить SOCKS до старта sing-box (handshake к endpoint'у
        // у TrustTunnel небыстрый), иначе первые urltest'ы словят refused.
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    }
    Ok(())
}

// Путь к логу sing-box. Лог во всех режимах пишет сам Tauri в app_log_dir
// (sing-box — наш child, его stdout/stderr льётся в файл монитор-таском).
fn resolved_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    log_path(app).ok_or_else(|| "log_dir недоступен".to_string())
}

#[tauri::command]
pub async fn singbox_log_path(app: AppHandle) -> Result<String, String> {
    let p = resolved_log_path(&app)?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn read_singbox_log(
    app: AppHandle,
    tail_bytes: Option<u64>,
) -> Result<String, String> {
    let path = resolved_log_path(&app)?;
    if !path.exists() {
        return Ok(String::new());
    }
    let limit = tail_bytes.unwrap_or(128 * 1024);
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat: {e}"))?;
    let size = meta.len();
    if size <= limit {
        return std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"));
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&path).map_err(|e| format!("open: {e}"))?;
    f.seek(SeekFrom::End(-(limit as i64))).map_err(|e| format!("seek: {e}"))?;
    let mut buf = Vec::with_capacity(limit as usize);
    f.read_to_end(&mut buf).map_err(|e| format!("read_to_end: {e}"))?;
    let text = String::from_utf8_lossy(&buf).to_string();
    let cut = text.find('\n').map(|i| i + 1).unwrap_or(0);
    Ok(format!("…[обрезано {} байт сверху]…\n{}", size - limit, &text[cut..]))
}

#[tauri::command]
pub async fn clear_singbox_log(app: AppHandle) -> Result<(), String> {
    let Some(path) = log_path(&app) else {
        return Err("log_dir недоступен".into());
    };
    if path.exists() {
        std::fs::write(&path, b"").map_err(|e| format!("truncate: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| format!("app_log_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("open: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn start_singbox(
    app: AppHandle,
    state: State<'_, SingboxState>,
    config_json: String,
    mode: String,
    xray_json: Option<String>,
    sidecars_json: Option<String>,
) -> Result<(), String> {
    {
        let child = state.child.lock().unwrap();
        if child.is_some() || state.xray_child.lock().unwrap().is_some() {
            return Err("sing-box уже запущен".into());
        }
        *state.died.lock().unwrap() = None;
        *state.xray_died.lock().unwrap() = None;
        *state.sidecar_died.lock().unwrap() = None;
    }

    // Захардениваем конфиг (секрет clash-API + loopback) до записи/отправки.
    let config_json = harden_config(&config_json);

    // Two-core: если в конфиге есть xhttp-ноды, поднимаем xray ДО sing-box
    // (в любом режиме). При ошибке спавна — не стартуем VPN вовсе.
    if let Some(xj) = xray_json.as_ref().filter(|s| !s.trim().is_empty()) {
        if let Err(e) = spawn_xray(&app, &state, xj).await {
            kill_xray(&state);
            return Err(e);
        }
    }

    // Sidecar-клиенты naive / trusttunnel (если такие ноды есть) — тоже ДО sing-box.
    if let Some(sj) = sidecars_json.as_ref().filter(|s| !s.trim().is_empty()) {
        let specs: Vec<SidecarSpec> =
            serde_json::from_str(sj).map_err(|e| format!("sidecars json: {e}"))?;
        if let Err(e) = spawn_sidecars(&app, &state, &specs).await {
            kill_xray(&state);
            kill_sidecars(&state);
            return Err(e);
        }
    }

    let path = config_path(&app)?;
    std::fs::write(&path, &config_json).map_err(|e| format!("write config: {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    // Режим (proxy/systemProxy/tun) больше не влияет на запуск ядра в Rust:
    // TUN-инбаунд уже зашит в config_json (buildInbound в singbox.js), а
    // system proxy выставляет фронт отдельной командой. В TUN Ninety обязан
    // быть elevated — это гарантирует JS (is_elevated/relaunch) до вызова.
    let _ = &mode;

    let sidecar = app
        .shell()
        .sidecar("sing-box")
        .map_err(|e| format!("sidecar lookup: {e}"))?;
    let (mut rx, child) = sidecar
        .args(["run", "-c", &path_str])
        .spawn()
        .map_err(|e| format!("spawn sing-box: {e}"))?;

    *state.child.lock().unwrap() = Some(child);

    let died_flag = state.died.clone();
    let log_file = log_path(&app);
    tauri::async_runtime::spawn(async move {
        let mut writer = log_file.as_ref().and_then(|p| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
                .ok()
        });
        if let Some(w) = writer.as_mut() {
            let _ = writeln!(w, "\n=== sing-box start ===");
        }
        let mut last_stderr: Vec<String> = Vec::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line).to_string();
                    if let Some(w) = writer.as_mut() {
                        let _ = writeln!(w, "{text}");
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line).to_string();
                    if let Some(w) = writer.as_mut() {
                        let _ = writeln!(w, "STDERR: {text}");
                    }
                    last_stderr.push(text);
                    if last_stderr.len() > 40 {
                        last_stderr.remove(0);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let msg = format!(
                        "sing-box умер (код {:?}). Последние ошибки:\n{}",
                        payload.code,
                        last_stderr.join("\n")
                    );
                    if let Some(w) = writer.as_mut() {
                        let _ = writeln!(w, "{msg}");
                    }
                    *died_flag.lock().unwrap() = Some(msg);
                    break;
                }
                _ => {}
            }
        }
    });

    // даём sing-box 800мс чтобы упасть с ошибкой парсинга / биндинга
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    if let Some(err) = state.died.lock().unwrap().take() {
        *state.child.lock().unwrap() = None;
        kill_xray(&state);
        kill_sidecars(&state);
        return Err(err);
    }

    Ok(())
}

fn kill_xray(state: &SingboxState) {
    if let Some(child) = state.xray_child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

fn kill_sidecars(state: &SingboxState) {
    for child in state.sidecars.lock().unwrap().drain(..) {
        let _ = child.kill();
    }
}

#[tauri::command]
pub async fn stop_singbox(state: State<'_, SingboxState>) -> Result<(), String> {
    let taken = state.child.lock().unwrap().take();
    if let Some(child) = taken {
        // child.kill() гасит sing-box; wintun-адаптер (non-persistent) снимается
        // системой вместе со смертью процесса, державшего его — отдельная чистка
        // TUN-интерфейса не нужна.
        let _ = child.kill();
    }
    kill_xray(&state);
    kill_sidecars(&state);
    Ok(())
}

#[tauri::command]
pub fn singbox_running(state: State<'_, SingboxState>) -> bool {
    if state.child.lock().unwrap().is_some() {
        // Хэндл child не чистится при смерти процесса — монитор-таск лишь
        // выставляет died. Без этой проверки singbox_running возвращал бы true
        // вечно после краша ядра (UI держит «Защищено», прокси указывает на
        // мёртвый порт, трафик в чёрную дыру). Труп живым не считаем.
        return state.died.lock().unwrap().is_none();
    }
    false
}

#[tauri::command]
pub async fn set_system_proxy(enable: bool, host_port: Option<String>) -> Result<(), String> {
    proxy::set_system_proxy(enable, host_port.as_deref())
}

// Статус xray-sidecar (two-core) для health-watchdog'а фронта:
//   "none"  — xray не спавнился (xhttp-нод в активном конфиге нет);
//   "alive" — поднят и не падал;
//   "died"  — был поднят, но процесс завершился (xhttp-мост мёртв).
// child-хэндл при смерти не чистится, поэтому различаем по флагу xray_died.
#[tauri::command]
pub fn xray_status(state: State<'_, SingboxState>) -> &'static str {
    if state.xray_child.lock().unwrap().is_none() {
        return "none";
    }
    if state.xray_died.lock().unwrap().is_some() {
        "died"
    } else {
        "alive"
    }
}

// Статус sidecar-клиентов naive/TT для health-watchdog'а (аналог xray_status):
//   "none"  — sidecar'ов не поднимали (таких нод в конфиге нет);
//   "alive" — подняты и не падали;
//   "died"  — хотя бы один клиент завершился (мост мёртв → реконнект).
#[tauri::command]
pub fn sidecar_status(state: State<'_, SingboxState>) -> &'static str {
    if state.sidecars.lock().unwrap().is_empty() {
        return "none";
    }
    if state.sidecar_died.lock().unwrap().is_some() {
        "died"
    } else {
        "alive"
    }
}

// Последняя причина смерти ядра (sing-box приоритетнее xray/sidecar) — для тоста.
#[tauri::command]
pub fn vpn_last_error(state: State<'_, SingboxState>) -> Option<String> {
    if let Some(e) = state.died.lock().unwrap().clone() {
        return Some(e);
    }
    if let Some(e) = state.xray_died.lock().unwrap().clone() {
        return Some(e);
    }
    state.sidecar_died.lock().unwrap().clone()
}

pub fn force_cleanup(state: &SingboxState) {
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    kill_xray(state);
    kill_sidecars(state);
    #[cfg(target_os = "windows")]
    let _ = proxy::set_system_proxy(false, None);
}
