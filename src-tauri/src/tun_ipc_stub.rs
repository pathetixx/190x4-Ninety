// Заглушка для non-Windows: проект Windows-only, но cargo check на Linux
// и любые linux-разработки не должны падать на отсутствующих типах.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SvcState {
    NotInstalled,
}

#[derive(Debug, Clone, Serialize)]
pub struct TunnelStatus {
    pub service: SvcState,
    pub singbox_running: bool,
    pub pid: Option<u32>,
}

const ERR: &str = "TUN mode supported only on Windows";

pub fn ensure_running() -> Result<(), String> {
    Err(ERR.into())
}

pub async fn ipc_start(_config_path: &str) -> Result<u32, String> {
    Err(ERR.into())
}

pub async fn ipc_stop() -> Result<(), String> {
    Err(ERR.into())
}

pub async fn ipc_status() -> Result<TunnelStatus, String> {
    Err(ERR.into())
}

#[tauri::command]
pub fn tunnel_service_status() -> Result<SvcState, String> {
    Err(ERR.into())
}

#[tauri::command]
pub async fn tunnel_service_install() -> Result<(), String> {
    Err(ERR.into())
}

#[tauri::command]
pub async fn tunnel_service_uninstall() -> Result<(), String> {
    Err(ERR.into())
}

#[tauri::command]
pub async fn tunnel_full_status() -> Result<TunnelStatus, String> {
    Err(ERR.into())
}
