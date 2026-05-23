pub const SERVICE_NAME: &str = "NinetyTunnelService";
pub const SERVICE_DISPLAY_NAME: &str = "Ninety Tunnel Service";
pub const SERVICE_DESCRIPTION: &str =
    "Управляет sing-box в TUN-режиме для клиента Ninety (190x4). Запускается по требованию.";

pub const PIPE_NAME: &str = r"\\.\pipe\ninety-tunnel";

pub const LOG_FILE_NAME: &str = "tunnel-svc.log";
pub const SINGBOX_LOG_FILE_NAME: &str = "singbox.log";
pub const SINGBOX_EXE_NAMES: &[&str] = &[
    "sing-box-x86_64-pc-windows-msvc.exe",
    "sing-box.exe",
];
