use std::ffi::OsString;
use std::time::{Duration, Instant};

use windows_service::service::{
    ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState, ServiceType,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::consts::{SERVICE_DESCRIPTION, SERVICE_DISPLAY_NAME, SERVICE_NAME};

fn open_mgr(access: ServiceManagerAccess) -> Result<ServiceManager, String> {
    ServiceManager::local_computer(None::<&str>, access)
        .map_err(|e| format!("ServiceManager open: {e}"))
}

pub fn install() -> Result<(), String> {
    let mgr = open_mgr(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;

    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;

    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::OnDemand,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe,
        launch_arguments: vec![OsString::from("run")],
        dependencies: vec![],
        // account_name=None → LocalSystem (admin), что и нужно для TUN
        account_name: None,
        account_password: None,
    };

    let service = mgr
        .create_service(&info, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)
        .map_err(|e| format!("create_service: {e}"))?;

    service
        .set_description(SERVICE_DESCRIPTION)
        .map_err(|e| format!("set_description: {e}"))?;

    // Старт службы сразу после установки — чтобы клиент мог подключиться
    // к pipe не дожидаясь повторного StartService из Tauri.
    service.start::<&str>(&[]).map_err(|e| format!("start: {e}"))?;
    Ok(())
}

pub fn uninstall() -> Result<(), String> {
    let mgr = open_mgr(ServiceManagerAccess::CONNECT)?;
    let service = match mgr.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        Ok(s) => s,
        Err(windows_service::Error::Winapi(e))
            if e.raw_os_error() == Some(1060) =>
        {
            // ERROR_SERVICE_DOES_NOT_EXIST — нечего удалять, идемпотентно
            return Ok(());
        }
        Err(e) => return Err(format!("open_service: {e}")),
    };

    let status = service
        .query_status()
        .map_err(|e| format!("query_status: {e}"))?;

    if status.current_state != ServiceState::Stopped {
        let _ = service.stop();
        wait_for_state(&service, ServiceState::Stopped, Duration::from_secs(15))?;
    }

    service.delete().map_err(|e| format!("delete: {e}"))?;
    Ok(())
}

pub fn status() -> Result<&'static str, String> {
    let mgr = open_mgr(ServiceManagerAccess::CONNECT)?;
    match mgr.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
        Ok(s) => {
            let st = s
                .query_status()
                .map_err(|e| format!("query_status: {e}"))?;
            Ok(state_name(st.current_state))
        }
        Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1060) => {
            Ok("NotInstalled")
        }
        Err(e) => Err(format!("open_service: {e}")),
    }
}

fn state_name(s: ServiceState) -> &'static str {
    match s {
        ServiceState::Stopped => "Stopped",
        ServiceState::StartPending => "StartPending",
        ServiceState::StopPending => "StopPending",
        ServiceState::Running => "Running",
        ServiceState::ContinuePending => "ContinuePending",
        ServiceState::PausePending => "PausePending",
        ServiceState::Paused => "Paused",
    }
}

fn wait_for_state(
    service: &windows_service::service::Service,
    target: ServiceState,
    timeout: Duration,
) -> Result<(), String> {
    let start = Instant::now();
    loop {
        let st = service
            .query_status()
            .map_err(|e| format!("query_status: {e}"))?;
        if st.current_state == target {
            return Ok(());
        }
        if start.elapsed() > timeout {
            return Err(format!(
                "timeout waiting for state {target:?} (current: {:?})",
                st.current_state
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}
