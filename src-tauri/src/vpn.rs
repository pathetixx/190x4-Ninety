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
    // TUN-режим: sing-box работает не у нас, а внутри NinetyTunnelService
    // под LocalSystem. Здесь — флаг, что мы инициировали TUN-сессию через IPC.
    tun_via_svc: Mutex<bool>,
    died: Arc<Mutex<Option<String>>>,
}

impl Default for SingboxState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            tun_via_svc: Mutex::new(false),
            died: Arc::new(Mutex::new(None)),
        }
    }
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
) -> Result<(), String> {
    {
        let child = state.child.lock().unwrap();
        let tun = state.tun_via_svc.lock().unwrap();
        if child.is_some() || *tun {
            return Err("sing-box уже запущен".into());
        }
        *state.died.lock().unwrap() = None;
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
            tokio::task::spawn_blocking(crate::tun_ipc::ensure_running)
                .await
                .map_err(|e| format!("ensure_running join: {e}"))??;

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
            crate::tun_ipc::ipc_start(&config_json).await?;
            *state.tun_via_svc.lock().unwrap() = true;
            return Ok(());
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
        return Err(err);
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_singbox(state: State<'_, SingboxState>) -> Result<(), String> {
    let taken = state.child.lock().unwrap().take();
    if let Some(child) = taken {
        let _ = child.kill();
    }

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
