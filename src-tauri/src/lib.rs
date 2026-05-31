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
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, WindowEvent,
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

#[derive(serde::Deserialize, Default)]
struct TraySrv {
    id: String,
    label: String,
    #[serde(default)]
    selected: bool,
}

#[derive(serde::Deserialize, Default)]
struct TrayMenuPayload {
    #[serde(default)]
    connected: bool,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    servers: Vec<TraySrv>,
}

/// Собирает контекстное меню трея под текущее состояние: выбор режима
/// подключения (radio-чек) и список серверов активной подписки. Подменю
/// «Сервер» активно только при поднятом VPN — иначе серое (disabled).
fn build_tray_menu(
    app: &tauri::AppHandle,
    payload: &TrayMenuPayload,
) -> tauri::Result<Menu<tauri::Wry>> {
    let show_item = MenuItem::with_id(app, "show", "Показать Ninety", true, None::<&str>)?;

    // Режим подключения
    let m_proxy = CheckMenuItem::with_id(app, "mode:proxy", "Прокси", true, payload.mode == "proxy", None::<&str>)?;
    let m_sys = CheckMenuItem::with_id(app, "mode:systemProxy", "Системный прокси", true, payload.mode == "systemProxy", None::<&str>)?;
    let m_tun = CheckMenuItem::with_id(app, "mode:tun", "VPN · TUN", true, payload.mode == "tun", None::<&str>)?;
    let mode_sub = Submenu::with_items(app, "Режим подключения", true, &[&m_proxy, &m_sys, &m_tun])?;

    // Выбор сервера — активен только когда VPN поднят
    let srv_enabled = payload.connected && !payload.servers.is_empty();
    let server_sub = if payload.servers.is_empty() {
        let none = MenuItem::with_id(app, "srv:none", "Нет серверов", false, None::<&str>)?;
        Submenu::with_items(app, "Сервер", false, &[&none])?
    } else {
        let mut items: Vec<CheckMenuItem<tauri::Wry>> = Vec::with_capacity(payload.servers.len());
        for s in &payload.servers {
            items.push(CheckMenuItem::with_id(
                app,
                format!("srv:{}", s.id),
                &s.label,
                srv_enabled,
                s.selected,
                None::<&str>,
            )?);
        }
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
            items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
        Submenu::with_items(app, "Сервер", srv_enabled, &refs)?
    };

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[&show_item, &sep1, &mode_sub, &server_sub, &sep2, &quit_item],
    )
}

/// Фронтенд зовёт при каждом изменении состояния (connect/disconnect, смена
/// режима/подписки/эффективной ноды) — пересобираем меню трея под него.
#[tauri::command]
fn set_tray_menu(app: tauri::AppHandle, payload: TrayMenuPayload) -> Result<(), String> {
    let menu = build_tray_menu(&app, &payload).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
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

            let menu = build_tray_menu(app.handle(), &TrayMenuPayload::default())?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Ninety · 190x4")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "show" => show_main(app),
                        "quit" => app.exit(0),
                        "mode:proxy" => { let _ = app.emit("tray:set-mode", "proxy"); }
                        "mode:systemProxy" => { let _ = app.emit("tray:set-mode", "systemProxy"); }
                        "mode:tun" => { let _ = app.emit("tray:set-mode", "tun"); }
                        other if other.starts_with("srv:") => {
                            let tag = other.trim_start_matches("srv:");
                            if tag != "none" {
                                let _ = app.emit("tray:select-server", tag.to_string());
                            }
                        }
                        _ => {}
                    }
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
            set_tray_menu,
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
