use std::ffi::c_void;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::broadcast;
use windows::core::PCSTR;
use windows::Win32::Foundation::{BOOL, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorA, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};

use crate::consts::PIPE_NAME;
use crate::singbox::Manager;
use crate::{lerr, linfo};

// SDDL DACL: GenericAll для Authenticated Users + LocalSystem.
// Без явного DACL пайп создаётся под LocalSystem с дефолтным DACL, в котором
// обычному юзеру (Medium IL) нет доступа → ERROR_ACCESS_DENIED при подключении
// клиента Tauri. AU=Authenticated Users (S-1-5-11), SY=LocalSystem.
const PIPE_SDDL: &[u8] = b"D:(A;;GA;;;AU)(A;;GA;;;SY)\0";

struct SecurityHandle {
    psd: PSECURITY_DESCRIPTOR,
}

impl Drop for SecurityHandle {
    fn drop(&mut self) {
        if !self.psd.0.is_null() {
            unsafe {
                let _ = LocalFree(HLOCAL(self.psd.0));
            }
        }
    }
}

unsafe fn build_security_attributes() -> Result<(SecurityHandle, SECURITY_ATTRIBUTES), String> {
    let mut psd = PSECURITY_DESCRIPTOR::default();
    ConvertStringSecurityDescriptorToSecurityDescriptorA(
        PCSTR(PIPE_SDDL.as_ptr()),
        SDDL_REVISION_1,
        &mut psd,
        None,
    )
    .map_err(|e| format!("SDDL→SD: {e}"))?;
    let handle = SecurityHandle { psd };
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: handle.psd.0,
        bInheritHandle: BOOL(0),
    };
    Ok((handle, sa))
}

unsafe fn create_pipe_instance(
    sa_ptr: *mut c_void,
    first: bool,
) -> std::io::Result<NamedPipeServer> {
    let mut opts = ServerOptions::new();
    if first {
        opts.first_pipe_instance(true);
    }
    opts.create_with_security_attributes_raw(PIPE_NAME, sa_ptr)
}

pub async fn run(manager: Arc<Manager>, mut shutdown: broadcast::Receiver<()>) {
    linfo!("IPC server: запуск на {}", PIPE_NAME);

    let (sd_handle, mut sa) = match unsafe { build_security_attributes() } {
        Ok(v) => v,
        Err(e) => {
            lerr!("ipc security_attributes: {e}");
            return;
        }
    };
    let sa_ptr = &mut sa as *mut SECURITY_ATTRIBUTES as *mut c_void;

    let mut server = match unsafe { create_pipe_instance(sa_ptr, true) } {
        Ok(s) => s,
        Err(e) => {
            lerr!("ipc create first instance: {e}");
            return;
        }
    };

    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                linfo!("IPC server: shutdown");
                break;
            }
            res = server.connect() => {
                if let Err(e) = res {
                    lerr!("ipc connect: {e}");
                    continue;
                }
                let conn = server;
                server = match unsafe { create_pipe_instance(sa_ptr, false) } {
                    Ok(s) => s,
                    Err(e) => {
                        lerr!("ipc create next instance: {e}");
                        break;
                    }
                };
                let mgr = manager.clone();
                tokio::spawn(async move {
                    handle_conn(conn, mgr).await;
                });
            }
        }
    }

    drop(sd_handle);
}

async fn handle_conn(conn: NamedPipeServer, manager: Arc<Manager>) {
    let (rx, mut tx) = tokio::io::split(conn);
    let mut reader = BufReader::new(rx);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: Request = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let _ =
                    write_response(&mut tx, &Response::err(&format!("bad json: {e}"))).await;
                continue;
            }
        };

        match req.cmd.as_str() {
            "ping" => {
                let _ =
                    write_response(&mut tx, &Response::ok(serde_json::json!("pong"))).await;
            }
            "status" => {
                let s = manager.status();
                let _ = write_response(
                    &mut tx,
                    &Response::ok(serde_json::to_value(s).unwrap_or_default()),
                )
                .await;
            }
            "start" => {
                let Some(cfg) = req.config_json else {
                    let _ =
                        write_response(&mut tx, &Response::err("config_json required")).await;
                    continue;
                };
                let r = match manager.start(&cfg) {
                    Ok(pid) => Response::ok(serde_json::json!({ "pid": pid })),
                    Err(e) => Response::err(&e),
                };
                let _ = write_response(&mut tx, &r).await;
            }
            "stop" => {
                let r = match manager.stop() {
                    Ok(()) => Response::ok(serde_json::Value::Null),
                    Err(e) => Response::err(&e),
                };
                let _ = write_response(&mut tx, &r).await;
            }
            "log_path" => {
                let p = manager.singbox_log_path();
                let _ = write_response(
                    &mut tx,
                    &Response::ok(serde_json::json!(p.to_string_lossy())),
                )
                .await;
            }
            "subscribe_logs" => {
                // ACK сразу, потом стрим в режиме push-only до разрыва
                let _ =
                    write_response(&mut tx, &Response::ok(serde_json::Value::Null)).await;
                let mut sub = manager.subscribe_logs();
                while let Ok(msg) = sub.recv().await {
                    let payload = format!(
                        "{}\n",
                        serde_json::json!({"type": "log", "line": msg })
                    );
                    if tx.write_all(payload.as_bytes()).await.is_err() {
                        return;
                    }
                }
                return;
            }
            other => {
                let _ = write_response(
                    &mut tx,
                    &Response::err(&format!("unknown cmd: {other}")),
                )
                .await;
            }
        }
    }
}

#[derive(serde::Deserialize)]
struct Request {
    cmd: String,
    #[serde(default)]
    config_json: Option<String>,
}

#[derive(serde::Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

impl Response {
    fn ok(data: serde_json::Value) -> Self {
        Self {
            ok: true,
            error: None,
            data: Some(data),
        }
    }
    fn err(msg: &str) -> Self {
        Self {
            ok: false,
            error: Some(msg.to_string()),
            data: None,
        }
    }
}

async fn write_response<W: tokio::io::AsyncWrite + Unpin>(
    tx: &mut W,
    r: &Response,
) -> std::io::Result<()> {
    let mut payload = serde_json::to_string(r).unwrap_or_else(|_| r#"{"ok":false}"#.into());
    payload.push('\n');
    tx.write_all(payload.as_bytes()).await?;
    tx.flush().await
}
