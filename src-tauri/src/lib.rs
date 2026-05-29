mod clash;
mod clash_stream;
mod scanner;
mod subscription;
mod url_handler;
mod vpn;
mod warp;

#[cfg(target_os = "windows")]
mod proxy_win;
#[cfg(not(target_os = "windows"))]
mod proxy_stub;

#[cfg(target_os = "windows")]
mod tun_ipc;
#[cfg(not(target_os = "windows"))]
#[path = "tun_ipc_stub.rs"]
mod tun_ipc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

#[cfg(any(target_os = "windows", target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

use vpn::SingboxState;

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// True если процесс стартовал с флагом --autostarted (Windows login или
/// дев-симуляция). Используется фронтендом для авто-подключения после bootstrap.
#[tauri::command]
fn is_autostarted() -> bool {
    std::env::args().any(|a| a == "--autostarted")
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance ОБЯЗАН быть зарегистрирован первым: на second-launch
        // (юзер кликнул ninety://import/...) система запускает второй процесс;
        // single-instance перехватывает argv и пробрасывает в первый. Без
        // этого plugin deep-link создал бы новый window каждый раз.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Автозапуск при входе в Windows. С --minimized окно скрыто в трей
        // на старте — проверка флага startMinimized делается на JS-стороне
        // (если выключен — окно показывается сразу через .show()).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostarted"]),
        ))
        .manage(SingboxState::default())
        .manage(clash_stream::ClashStreamState::default())
        .setup(|app| {
            // Если запущен через автостарт (--autostarted) — прячем окно
            // в трей сразу. Юзер откроет из трея или через тулбар Windows.
            let argv: Vec<String> = std::env::args().collect();
            let autostarted = argv.iter().any(|a| a == "--autostarted");
            if autostarted {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            // Регистрация ninety:// в HKCR при первом запуске. На NSIS-инсталле
            // tauri-plugin-deep-link уже прописал ключи в installer; register_all
            // нужен для portable-сценария / dev-режима / повторной регистрации.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("deep-link register_all: {e}");
                }
            }

            let show_item = MenuItem::with_id(app, "show", "Показать Ninety", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Ninety · 190x4")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            is_autostarted,
            vpn::start_singbox,
            vpn::stop_singbox,
            vpn::singbox_running,
            vpn::xray_status,
            vpn::vpn_last_error,
            vpn::set_system_proxy,
            vpn::read_singbox_log,
            vpn::clear_singbox_log,
            vpn::singbox_log_path,
            vpn::open_log_dir,
            tun_ipc::tunnel_service_status,
            tun_ipc::tunnel_service_install,
            tun_ipc::tunnel_service_uninstall,
            tun_ipc::tunnel_full_status,
            tun_ipc::tunnel_service_restart,
            tun_ipc::tunnel_service_log_path,
            subscription::fetch_subscription,
            clash::clash_get_proxies,
            clash::clash_test_node,
            clash::clash_test_group,
            clash::clash_select_proxy,
            clash::fetch_public_ip,
            clash_stream::clash_traffic_start,
            clash_stream::clash_traffic_stop,
            url_handler::register_url_handler,
            url_handler::unregister_url_handler,
            url_handler::is_url_handler_registered,
            warp::warp_register,
            warp::warp_status,
            warp::warp_reset,
            scanner::warp_scan_endpoints,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SingboxState>() {
                    vpn::force_cleanup(&state);
                }
            }
        });
}
