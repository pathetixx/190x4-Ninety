use std::ffi::OsString;
use std::time::Duration;

use tokio::sync::broadcast;
use windows_service::define_windows_service;
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
    ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_dispatcher;

use crate::consts::SERVICE_NAME;
use crate::ipc;
use crate::singbox::Manager;
use crate::{lerr, linfo};

define_windows_service!(ffi_service_main, service_main);

pub fn run_as_service() -> Result<(), String> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .map_err(|e| format!("service_dispatcher::start: {e}"))?;
    Ok(())
}

fn service_main(_args: Vec<OsString>) {
    if let Err(e) = run_service() {
        lerr!("service crashed: {e}");
    }
}

fn run_service() -> Result<(), String> {
    let manager = Manager::new();
    let (shutdown_tx, _) = broadcast::channel::<()>(4);

    let shutdown_for_handler = shutdown_tx.clone();
    let manager_for_handler = manager.clone();
    let status_handle = service_control_handler::register(SERVICE_NAME, move |control| {
        match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                linfo!("получен {control:?}, останавливаемся");
                let _ = shutdown_for_handler.send(());
                manager_for_handler.force_cleanup();
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    })
    .map_err(|e| format!("register handler: {e}"))?;

    status_handle
        .set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Running,
            controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        })
        .map_err(|e| format!("set_service_status running: {e}"))?;

    linfo!("сервис стартовал");

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;

    let shutdown_rx = shutdown_tx.subscribe();
    let manager_for_rt = manager.clone();
    rt.block_on(async move {
        ipc::run(manager_for_rt, shutdown_rx).await;
    });

    let _ = status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    });

    linfo!("сервис остановлен");
    Ok(())
}
