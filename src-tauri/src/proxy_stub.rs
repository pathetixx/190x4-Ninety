pub fn set_system_proxy(_enable: bool, _host_port: Option<&str>) -> Result<(), String> {
    Err("system proxy supported only on Windows".into())
}
