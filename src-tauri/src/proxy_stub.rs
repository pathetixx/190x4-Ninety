#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SystemProxyState {
    pub proxy_enable: bool,
    pub proxy_server: Option<String>,
    pub owned: bool,
}

pub fn set_system_proxy(
    _enable: bool,
    _host_port: Option<&str>,
    _bypass_lan: Option<bool>,
) -> Result<(), String> {
    Err("system proxy supported only on Windows".into())
}

pub fn recover_stale_system_proxy() -> Result<(), String> {
    Ok(())
}

pub fn system_proxy_owned() -> bool {
    false
}

pub fn system_proxy_state() -> SystemProxyState {
    SystemProxyState::default()
}

pub fn system_proxy_matches(_expected: &str) -> bool {
    false
}

pub fn proxy_notification_generations() -> (u64, u64) {
    (0, 0)
}

// Non-Windows: there's no concept of an elevated token/UAC. We assume the rights are sufficient
// (on Linux/macOS TUN is handled via capabilities/setuid outside the client's scope).
pub fn is_elevated() -> bool {
    true
}

pub fn relaunch_self_elevated(_extra_args: &[&str]) -> Result<bool, String> {
    Err("elevation supported only on Windows".into())
}

// Autostart via Task Scheduler is Windows-only.
pub fn autostart_is_enabled() -> bool {
    false
}

pub fn autostart_enable() -> Result<(), String> {
    Err("autostart supported only on Windows".into())
}

pub fn autostart_disable() -> Result<(), String> {
    Err("autostart supported only on Windows".into())
}

pub fn migrate_legacy_autostart() {}

pub fn autostart_refresh_path() {}
