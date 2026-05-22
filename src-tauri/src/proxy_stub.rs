pub fn set_system_proxy(_enable: bool, _host_port: Option<&str>) -> Result<(), String> {
    Err("system proxy supported only on Windows".into())
}

pub fn run_elevated(_exe: &str, _args: &[&str]) -> Result<(), String> {
    Err("elevation supported only on Windows".into())
}

pub fn taskkill_singbox() {}
