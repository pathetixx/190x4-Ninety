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
    child: Mutex<Option<CommandChild>>,
    elevated: Mutex<bool>,
    died: Arc<Mutex<Option<String>>>,
}

impl Default for SingboxState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            elevated: Mutex::new(false),
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

#[cfg(target_os = "windows")]
fn resolve_singbox_exe() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or_else(|| "no parent dir".to_string())?;
    let candidates = [
        dir.join("sing-box-x86_64-pc-windows-msvc.exe"),
        dir.join("sing-box.exe"),
        dir.join("binaries").join("sing-box-x86_64-pc-windows-msvc.exe"),
        dir.join("binaries").join("sing-box.exe"),
    ];
    for c in &candidates {
        if c.exists() {
            return Ok(c.to_string_lossy().to_string());
        }
    }
    Err(format!(
        "sing-box.exe не найден рядом с {}",
        dir.display()
    ))
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
        let elevated = state.elevated.lock().unwrap();
        if child.is_some() || *elevated {
            return Err("sing-box уже запущен".into());
        }
        *state.died.lock().unwrap() = None;
    }

    let path = config_path(&app)?;
    std::fs::write(&path, config_json).map_err(|e| format!("write config: {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    if mode == "tun" {
        #[cfg(target_os = "windows")]
        {
            let exe = resolve_singbox_exe()?;
            proxy::run_elevated(&exe, &["run", "-c", &path_str])?;
            *state.elevated.lock().unwrap() = true;
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
                    if last_stderr.len() > 8 {
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
    let mut elevated = state.elevated.lock().unwrap();
    if *elevated {
        proxy::taskkill_singbox();
        *elevated = false;
    }
    Ok(())
}

#[tauri::command]
pub fn singbox_running(state: State<'_, SingboxState>) -> bool {
    state.child.lock().unwrap().is_some() || *state.elevated.lock().unwrap()
}

#[tauri::command]
pub async fn set_system_proxy(enable: bool, host_port: Option<String>) -> Result<(), String> {
    proxy::set_system_proxy(enable, host_port.as_deref())
}

pub fn force_cleanup(state: &SingboxState) {
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    let mut elevated = state.elevated.lock().unwrap();
    if *elevated {
        proxy::taskkill_singbox();
        *elevated = false;
    }
    #[cfg(target_os = "windows")]
    let _ = proxy::set_system_proxy(false, None);
}
