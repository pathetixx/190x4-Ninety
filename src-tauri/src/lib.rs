mod clash;
mod clash_stream;
mod subscription;
mod vpn;

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

use vpn::SingboxState;

#[tauri::command]
fn ping() -> &'static str {
    "pong"
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
            vpn::start_singbox,
            vpn::stop_singbox,
            vpn::singbox_running,
            vpn::set_system_proxy,
            vpn::read_singbox_log,
            vpn::clear_singbox_log,
            vpn::singbox_log_path,
            vpn::open_log_dir,
            tun_ipc::tunnel_service_status,
            tun_ipc::tunnel_service_install,
            tun_ipc::tunnel_service_uninstall,
            tun_ipc::tunnel_full_status,
            subscription::fetch_subscription,
            clash::clash_get_proxies,
            clash::clash_test_node,
            clash::clash_test_group,
            clash::clash_select_proxy,
            clash::fetch_public_ip,
            clash_stream::clash_traffic_start,
            clash_stream::clash_traffic_stop,
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
