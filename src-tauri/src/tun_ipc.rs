// Клиент tunnel-сервиса. Все TUN-операции с уровнем admin идут через
// именованный канал \\.\pipe\ninety-tunnel к ninety-tunnel-svc.exe,
// который запущен под LocalSystem как Windows Service NinetyTunnelService.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;
use windows_service::service::{ServiceAccess, ServiceState};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::proxy_win;

pub const SERVICE_NAME: &str = "NinetyTunnelService";
pub const PIPE_NAME: &str = r"\\.\pipe\ninety-tunnel";
const TUNNEL_SVC_EXE_NAMES: &[&str] = &[
    "ninety-tunnel-svc-x86_64-pc-windows-msvc.exe",
    "ninety-tunnel-svc.exe",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SvcState {
    NotInstalled,
    Stopped,
    StartPending,
    StopPending,
    Running,
    Paused,
    Other,
}

impl SvcState {
    fn from_service(s: ServiceState) -> Self {
        match s {
            ServiceState::Stopped => Self::Stopped,
            ServiceState::StartPending => Self::StartPending,
            ServiceState::StopPending => Self::StopPending,
            ServiceState::Running => Self::Running,
            ServiceState::Paused => Self::Paused,
            _ => Self::Other,
        }
    }
}

pub fn resolve_tunnel_svc_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current_exe parent".to_string())?;
    for name in TUNNEL_SVC_EXE_NAMES {
        let p = dir.join(name);
        if p.exists() {
            return Ok(p);
        }
    }
    Err(format!(
        "ninety-tunnel-svc не найден рядом с {} (искали: {})",
        dir.display(),
        TUNNEL_SVC_EXE_NAMES.join(", ")
    ))
}

pub fn service_status() -> Result<SvcState, String> {
    let mgr = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("ServiceManager open: {e}"))?;
    match mgr.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
        Ok(s) => {
            let st = s
                .query_status()
                .map_err(|e| format!("query_status: {e}"))?;
            Ok(SvcState::from_service(st.current_state))
        }
        Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1060) => {
            Ok(SvcState::NotInstalled)
        }
        Err(e) => Err(format!("open_service: {e}")),
    }
}

pub fn install_and_start() -> Result<(), String> {
    let exe = resolve_tunnel_svc_exe()?;
    let exe_str = exe.to_string_lossy().to_string();
    let code = proxy_win::run_elevated_wait(&exe_str, &["install"], 30_000)?;
    if code != 0 {
        return Err(format!(
            "ninety-tunnel-svc install завершился с кодом {code}"
        ));
    }
    // install сам делает service.start() внутри SCM; убеждаемся что не STOPPED
    wait_for_state(SvcState::Running, Duration::from_secs(10))?;
    Ok(())
}

pub fn start_existing() -> Result<(), String> {
    let mgr = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| format!("ServiceManager open: {e}"))?;
    let service = mgr
        .open_service(SERVICE_NAME, ServiceAccess::START | ServiceAccess::QUERY_STATUS)
        .map_err(|e| format!("open_service: {e}"))?;
    service.start::<&str>(&[]).map_err(|e| format!("start: {e}"))?;
    wait_for_state(SvcState::Running, Duration::from_secs(10))?;
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    let exe = resolve_tunnel_svc_exe()?;
    let exe_str = exe.to_string_lossy().to_string();
    let code = proxy_win::run_elevated_wait(&exe_str, &["uninstall"], 30_000)?;
    if code != 0 {
        return Err(format!(
            "ninety-tunnel-svc uninstall завершился с кодом {code}"
        ));
    }
    Ok(())
}

fn wait_for_state(target: SvcState, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    loop {
        let s = service_status()?;
        if s == target {
            return Ok(());
        }
        if start.elapsed() > timeout {
            return Err(format!(
                "timeout ожидания state={target:?} (current={s:?})"
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

// Гарантирует что сервис установлен и в state=Running. Если NotInstalled —
// показывает UAC через runas. UAC показывается ОДИН РАЗ за время жизни Ninety
// на этой машине (последующие старты — без UAC, сервис стартует через SCM).
pub fn ensure_running() -> Result<(), String> {
    match service_status()? {
        SvcState::Running => Ok(()),
        SvcState::Stopped => start_existing(),
        SvcState::NotInstalled => install_and_start(),
        SvcState::StartPending => wait_for_state(SvcState::Running, Duration::from_secs(10)),
        SvcState::StopPending => {
            wait_for_state(SvcState::Stopped, Duration::from_secs(10))?;
            start_existing()
        }
        other => Err(format!("сервис в неподходящем состоянии: {other:?}")),
    }
}

// ---------- IPC client (one-shot per command) ----------

#[derive(Serialize)]
struct Request<'a> {
    cmd: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    config_json: Option<&'a str>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Response {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

async fn connect_pipe() -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match ClientOptions::new().open(PIPE_NAME) {
            Ok(c) => return Ok(c),
            Err(e) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(150)).await;
                // если pipe всё ещё busy/closed — продолжаем ждать
                let _ = e;
            }
            Err(e) => return Err(format!("open pipe: {e}")),
        }
    }
}

async fn call(req: Request<'_>) -> Result<Response, String> {
    let conn = connect_pipe().await?;
    let (rx, mut tx) = tokio::io::split(conn);
    let mut payload = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    payload.push('\n');
    tx.write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    tx.flush().await.map_err(|e| format!("flush: {e}"))?;

    let mut reader = BufReader::new(rx);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&line).map_err(|e| format!("bad response: {e} (line: {line})"))
}

pub async fn ipc_ping() -> Result<(), String> {
    let r = call(Request {
        cmd: "ping",
        config_json: None,
    })
    .await?;
    if r.ok {
        Ok(())
    } else {
        Err(r.error.unwrap_or_else(|| "ping failed".into()))
    }
}

pub async fn ipc_start(config_json: &str) -> Result<u32, String> {
    let r = call(Request {
        cmd: "start",
        config_json: Some(config_json),
    })
    .await?;
    if r.ok {
        let pid = r
            .data
            .as_ref()
            .and_then(|v| v.get("pid"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        Ok(pid)
    } else {
        Err(r.error.unwrap_or_else(|| "start failed".into()))
    }
}

pub async fn ipc_stop() -> Result<(), String> {
    let r = call(Request {
        cmd: "stop",
        config_json: None,
    })
    .await?;
    if r.ok {
        Ok(())
    } else {
        Err(r.error.unwrap_or_else(|| "stop failed".into()))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TunnelStatus {
    pub service: SvcState,
    pub singbox_running: bool,
    pub pid: Option<u32>,
}

pub async fn ipc_status() -> Result<TunnelStatus, String> {
    let svc = service_status()?;
    if svc != SvcState::Running {
        return Ok(TunnelStatus {
            service: svc,
            singbox_running: false,
            pid: None,
        });
    }
    let r = call(Request {
        cmd: "status",
        config_json: None,
    })
    .await?;
    if !r.ok {
        return Err(r.error.unwrap_or_else(|| "status failed".into()));
    }
    let data = r.data.unwrap_or(serde_json::Value::Null);
    let state = data.get("state").and_then(|v| v.as_str()).unwrap_or("");
    let pid = data.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32);
    Ok(TunnelStatus {
        service: svc,
        singbox_running: state == "running",
        pid,
    })
}

// ---------- Tauri commands (для JS UI: Settings → Tunnel Service) ----------

#[tauri::command]
pub fn tunnel_service_status() -> Result<SvcState, String> {
    service_status()
}

#[tauri::command]
pub async fn tunnel_service_install() -> Result<(), String> {
    tokio::task::spawn_blocking(install_and_start)
        .await
        .map_err(|e| format!("install join: {e}"))?
}

#[tauri::command]
pub async fn tunnel_service_uninstall() -> Result<(), String> {
    tokio::task::spawn_blocking(uninstall)
        .await
        .map_err(|e| format!("uninstall join: {e}"))?
}

#[tauri::command]
pub async fn tunnel_full_status() -> Result<TunnelStatus, String> {
    ipc_status().await
}
