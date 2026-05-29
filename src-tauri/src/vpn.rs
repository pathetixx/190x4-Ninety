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
    // Локальный child sing-box (sidecar) — для proxy-режима, запускается под
    // обычным юзером через tauri-plugin-shell.
    child: Mutex<Option<CommandChild>>,
    // xray-core sidecar (two-core): обслуживает xhttp-ноды. Всегда user-level
    // на 127.0.0.1, в т.ч. при TUN — sing-box из сервиса (LocalSystem) ходит
    // к нему через loopback socks-мост.
    xray_child: Mutex<Option<CommandChild>>,
    // TUN-режим: sing-box работает не у нас, а внутри NinetyTunnelService
    // под LocalSystem. Здесь — флаг, что мы инициировали TUN-сессию через IPC.
    tun_via_svc: Mutex<bool>,
    died: Arc<Mutex<Option<String>>>,
}

impl Default for SingboxState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            xray_child: Mutex::new(None),
            tun_via_svc: Mutex::new(false),
            died: Arc::new(Mutex::new(None)),
        }
    }
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

    let log_file = xray_log_path(app);
    tauri::async_runtime::spawn(async move {
        let mut writer = log_file.as_ref().and_then(|p| {
            std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
        });
        if let Some(w) = writer.as_mut() {
            let _ = writeln!(w, "\n=== xray start ===");
        }
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    if let Some(w) = writer.as_mut() {
                        let _ = writeln!(w, "{}", String::from_utf8_lossy(&line));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if let Some(w) = writer.as_mut() {
                        let _ = writeln!(w, "xray умер (код {:?})", payload.code);
                    }
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

// Резолв пути к логу с учётом режима. В TUN — лог пишет сервис рядом
// со своим exe, путь возвращается IPC-командой log_path. В proxy — пишет
// сам Tauri в app_log_dir.
async fn resolved_log_path(app: &AppHandle, state: &SingboxState) -> Result<PathBuf, String> {
    let tun = { *state.tun_via_svc.lock().unwrap() };
    if tun {
        #[cfg(target_os = "windows")]
        {
            let s = crate::tun_ipc::ipc_log_path().await?;
            return Ok(PathBuf::from(s));
        }
        #[cfg(not(target_os = "windows"))]
        return Err("TUN mode требует Windows".into());
    }
    log_path(app).ok_or_else(|| "log_dir недоступен".to_string())
}

#[tauri::command]
pub async fn singbox_log_path(
    app: AppHandle,
    state: State<'_, SingboxState>,
) -> Result<String, String> {
    let p = resolved_log_path(&app, &state).await?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn read_singbox_log(
    app: AppHandle,
    state: State<'_, SingboxState>,
    tail_bytes: Option<u64>,
) -> Result<String, String> {
    let path = resolved_log_path(&app, &state).await?;
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
pub async fn clear_singbox_log(
    app: AppHandle,
    state: State<'_, SingboxState>,
) -> Result<(), String> {
    let tun = { *state.tun_via_svc.lock().unwrap() };
    if tun {
        #[cfg(target_os = "windows")]
        {
            return crate::tun_ipc::ipc_clear_log().await;
        }
        #[cfg(not(target_os = "windows"))]
        return Err("TUN mode требует Windows".into());
    }
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
) -> Result<(), String> {
    {
        let child = state.child.lock().unwrap();
        let tun = state.tun_via_svc.lock().unwrap();
        if child.is_some() || *tun || state.xray_child.lock().unwrap().is_some() {
            return Err("sing-box уже запущен".into());
        }
        *state.died.lock().unwrap() = None;
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

    let path = config_path(&app)?;
    std::fs::write(&path, &config_json).map_err(|e| format!("write config: {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    if mode == "tun" {
        #[cfg(target_os = "windows")]
        {
            // ensure_running синхронна (SCM-операции блокирующие): при необходимости
            // показывает UAC для первичной установки сервиса; на повторных запусках —
            // просто SCM Start. UAC показывается ровно один раз за время жизни машины.
            // При любой ошибке гасим уже поднятый xray, чтобы не оставить sidecar.
            if let Err(e) = tokio::task::spawn_blocking(crate::tun_ipc::ensure_running)
                .await
                .map_err(|e| format!("ensure_running join: {e}"))
                .and_then(|r| r)
            {
                kill_xray(&state);
                return Err(e);
            }

            // Если в сервисе остался sing-box от прошлой сессии (Ninety закрылся
            // криво, сервис продолжил жить) — сначала чистим, чтобы start не упал
            // с "sing-box уже запущен".
            if let Ok(st) = crate::tun_ipc::ipc_status().await {
                if st.singbox_running {
                    let _ = crate::tun_ipc::ipc_stop().await;
                }
            }

            // Передаём JSON inline через IPC: сервис под LocalSystem пишет
            // конфиг сам у себя, не полагаясь на user-profile путь.
            if let Err(e) = crate::tun_ipc::ipc_start(&config_json).await {
                kill_xray(&state);
                return Err(e);
            }
            *state.tun_via_svc.lock().unwrap() = true;

            // Сервис отдаёт pid сразу, не дожидаясь парсинга конфига. Даём
            // sing-box ~900мс упасть на битом конфиге/биндинге и проверяем статус
            // через IPC — иначе вернули бы «успех» при неработающем туннеле.
            tokio::time::sleep(std::time::Duration::from_millis(900)).await;
            match crate::tun_ipc::ipc_status().await {
                Ok(st) if st.singbox_running => return Ok(()),
                Ok(_) => {
                    let tail = crate::tun_ipc::ipc_log_path()
                        .await
                        .ok()
                        .and_then(|p| std::fs::read_to_string(p).ok())
                        .map(|s| s.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
                        .unwrap_or_default();
                    let _ = crate::tun_ipc::ipc_stop().await;
                    *state.tun_via_svc.lock().unwrap() = false;
                    kill_xray(&state);
                    return Err(format!("sing-box не запустился в TUN-режиме (упал сразу).\n{tail}"));
                }
                Err(e) => {
                    // не смогли подтвердить статус — не рушим, флаг оставляем,
                    // фронт перепроверит через singbox_running/SCM
                    eprintln!("tun poststart status check: {e}");
                    return Ok(());
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        return Err("TUN mode требует Windows".into());
    }

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
        return Err(err);
    }

    Ok(())
}

fn kill_xray(state: &SingboxState) {
    if let Some(child) = state.xray_child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

#[tauri::command]
pub async fn stop_singbox(state: State<'_, SingboxState>) -> Result<(), String> {
    let taken = state.child.lock().unwrap().take();
    if let Some(child) = taken {
        let _ = child.kill();
    }
    kill_xray(&state);

    let was_tun = {
        let mut g = state.tun_via_svc.lock().unwrap();
        let v = *g;
        *g = false;
        v
    };
    if was_tun {
        #[cfg(target_os = "windows")]
        {
            crate::tun_ipc::ipc_stop().await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn singbox_running(state: State<'_, SingboxState>) -> bool {
    if state.child.lock().unwrap().is_some() {
        return true;
    }
    let tun = { *state.tun_via_svc.lock().unwrap() };
    if !tun {
        return false;
    }
    // tun_via_svc=true — это наш флаг. Доверять ему вслепую нельзя: сервис мог
    // вылететь из-под Ninety (crash, manual sc stop, обновление). Спрашиваем SCM
    // напрямую — sync, быстро, не лочит pipe.
    matches!(
        crate::tun_ipc::service_status(),
        Ok(crate::tun_ipc::SvcState::Running) | Ok(crate::tun_ipc::SvcState::StartPending)
    )
}

#[tauri::command]
pub async fn set_system_proxy(enable: bool, host_port: Option<String>) -> Result<(), String> {
    proxy::set_system_proxy(enable, host_port.as_deref())
}

pub fn force_cleanup(state: &SingboxState) {
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    kill_xray(state);
    let was_tun = {
        let mut g = state.tun_via_svc.lock().unwrap();
        let v = *g;
        *g = false;
        v
    };
    if was_tun {
        #[cfg(target_os = "windows")]
        {
            // Synchronous shutdown — приложение завершается, ждать
            // async-context некогда. Tokio block_on внутри tauri::async_runtime.
            let _ = tauri::async_runtime::block_on(crate::tun_ipc::ipc_stop());
        }
    }
    #[cfg(target_os = "windows")]
    let _ = proxy::set_system_proxy(false, None);
}
