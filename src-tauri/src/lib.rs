mod clash;
mod clash_stream;
mod dpi;
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
use proxy_win as elevation;
#[cfg(not(target_os = "windows"))]
use proxy_stub as elevation;

use std::path::PathBuf;

use tauri::{
    menu::{CheckMenuItem, IconMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
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

/// True если этот запуск должен авто-подключиться после bootstrap:
///  --autostarted — вход в Windows (окно в трее);
///  --elevated    — мы перезапустились от админа ради TUN (окно видимо).
/// Фронт в обоих случаях поднимает VPN активного источника.
#[tauri::command]
fn should_autoconnect() -> bool {
    std::env::args().any(|a| a == "--autostarted" || a == "--elevated")
}

/// True если текущий процесс имеет права администратора (elevated token).
/// TUN-режим (Throne-style) требует этого: sing-box-child наследует права и
/// сам поднимает TUN-интерфейс. Фронт проверяет перед включением TUN.
#[tauri::command]
fn is_elevated() -> bool {
    elevation::is_elevated()
}

/// Перезапускает Ninety от администратора (UAC) для TUN-режима. Передаёт
/// новому процессу --elevated (+ сохраняет --autostarted если был), чтобы тот
/// авто-подключился. Возврат:
///  Ok(true)  — elevated-инстанс стартовал, текущий процесс завершится сам;
///  Ok(false) — юзер отменил UAC, остаёмся в текущем (не-admin) процессе.
#[tauri::command]
fn relaunch_elevated(app: tauri::AppHandle) -> Result<bool, String> {
    let mut extra: Vec<&str> = vec!["--elevated"];
    let autostarted = std::env::args().any(|a| a == "--autostarted");
    if autostarted {
        extra.push("--autostarted");
    }
    let started = elevation::relaunch_self_elevated(&extra)?;
    if started {
        // Элевированный инстанс уже создан (юзер согласился в UAC). Текущий
        // (не-admin) процесс надо НЕМЕДЛЕННО убить, чтобы освободить лок
        // tauri-plugin-single-instance — иначе плагин завернёт новый инстанс
        // как дубль и тот сразу выйдет (как у Throne: relaunch → quit → release
        // QLocalServer). std::process::exit минует RunEvent::Exit, поэтому
        // синхронно чистим ядро и системный прокси здесь же.
        if let Some(state) = app.try_state::<SingboxState>() {
            vpn::force_cleanup(&state);
        }
        if let Some(state) = app.try_state::<dpi::DpiState>() {
            dpi::force_cleanup(&state);
        }
        std::process::exit(0);
    }
    Ok(false)
}

fn always_admin_marker(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("always-admin"))
}

/// True если включён режим «всегда запускать от администратора» (маркер-файл
/// в app_config_dir). Читается на старте в setup() для авто-элевации.
#[tauri::command]
fn is_always_admin(app: tauri::AppHandle) -> bool {
    always_admin_marker(&app).map(|p| p.exists()).unwrap_or(false)
}

/// Включает/выключает «всегда от администратора». При включении на следующих
/// стартах Ninety сам перезапустится с UAC (см. setup()).
#[tauri::command]
fn set_always_admin(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    let p = always_admin_marker(&app).ok_or("config dir недоступен")?;
    if enable {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&p, b"1").map_err(|e| format!("write marker: {e}"))?;
    } else if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("remove marker: {e}"))?;
    }
    Ok(())
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
    /// ISO-код страны (2 буквы, lower) для флага в трее. None → без иконки.
    #[serde(default)]
    iso: Option<String>,
}

/// Грузит флаг страны из ресурсов (flags/<iso>.png, растеризованы из SVG)
/// для IconMenuItem. Best-effort: нет файла/кода → None (пункт без иконки).
fn flag_icon(app: &tauri::AppHandle, iso: &Option<String>) -> Option<tauri::image::Image<'static>> {
    let iso = iso.as_ref()?;
    if iso.len() != 2 || !iso.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    // Флаги — read-only ресурсы рядом с бинарём (<resource_dir>/flags/<iso>.png),
    // как и движок DPI. resource_dir проверен в dpi.rs.
    let path = app.path().resource_dir().ok()?.join("flags").join(format!("{iso}.png"));
    tauri::image::Image::from_path(path).ok()
}

#[derive(serde::Deserialize, Default)]
struct TrayMenuPayload {
    #[serde(default)]
    connected: bool,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    servers: Vec<TraySrv>,
    #[serde(default, rename = "dpiActive")]
    dpi_active: bool,
    /// Версия доступного обновления, найденного фоновой проверкой пока окно в
    /// трее. Some → показываем выделенный пункт «Обновить до vX». None → нет.
    #[serde(default, rename = "updateVersion")]
    update_version: Option<String>,
}

/// Собирает контекстное меню трея под текущее состояние: выбор режима
/// подключения (radio-чек) и список серверов активной подписки. Подменю
/// «Сервер» активно только при поднятом VPN — иначе серое (disabled).
fn build_tray_menu(
    app: &tauri::AppHandle,
    payload: &TrayMenuPayload,
) -> tauri::Result<Menu<tauri::Wry>> {
    let show_item = MenuItem::with_id(app, "show", "Показать Ninety", true, None::<&str>)?;

    // Подключиться / Отключиться — по фактическому состоянию VPN
    let toggle_label = if payload.connected { "Отключиться" } else { "Подключиться" };
    let conn_item = MenuItem::with_id(app, "toggle-vpn", toggle_label, true, None::<&str>)?;

    // Режим подключения
    let m_proxy = CheckMenuItem::with_id(app, "mode:proxy", "Прокси", true, payload.mode == "proxy", None::<&str>)?;
    let m_sys = CheckMenuItem::with_id(app, "mode:systemProxy", "Системный прокси", true, payload.mode == "systemProxy", None::<&str>)?;
    let m_tun = CheckMenuItem::with_id(app, "mode:tun", "VPN · TUN", true, payload.mode == "tun", None::<&str>)?;
    let mode_sub = Submenu::with_items(app, "Режим подключения", true, &[&m_proxy, &m_sys, &m_tun])?;

    // Выбор сервера — активен только когда VPN поднят. Иконка — флаг страны
    // (IconMenuItem); выбранный сервер помечаем «●», т.к. у IconMenuItem нет
    // чек-состояния.
    let srv_enabled = payload.connected && !payload.servers.is_empty();
    let server_sub = if payload.servers.is_empty() {
        let none = MenuItem::with_id(app, "srv:none", "Нет серверов", false, None::<&str>)?;
        Submenu::with_items(app, "Сервер", false, &[&none])?
    } else {
        let mut items: Vec<IconMenuItem<tauri::Wry>> = Vec::with_capacity(payload.servers.len());
        for s in &payload.servers {
            let label = if s.selected { format!("●  {}", s.label) } else { format!("    {}", s.label) };
            let icon = flag_icon(app, &s.iso);
            items.push(IconMenuItem::with_id(
                app,
                format!("srv:{}", s.id),
                &label,
                srv_enabled,
                icon,
                None::<&str>,
            )?);
        }
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
            items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
        Submenu::with_items(app, "Сервер", srv_enabled, &refs)?
    };

    // DPI-обход — статус (disabled, информативный) + переключатель
    let dpi_status = MenuItem::with_id(
        app,
        "dpi:status",
        if payload.dpi_active { "Статус: активен" } else { "Статус: выключен" },
        false,
        None::<&str>,
    )?;
    let dpi_toggle = MenuItem::with_id(
        app,
        "dpi:toggle",
        if payload.dpi_active { "Выключить DPI-обход" } else { "Включить DPI-обход" },
        true,
        None::<&str>,
    )?;
    let dpi_sub = Submenu::with_items(app, "DPI-обход", true, &[&dpi_status, &dpi_toggle])?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;

    // Доступное обновление (нашлось пока окно в трее) — выделенный пункт сверху.
    // Клик показывает окно и открывает модалку установки.
    if let Some(ver) = &payload.update_version {
        let upd = MenuItem::with_id(
            app, "update:install", &format!("⤓  Обновить до v{ver}"), true, None::<&str>,
        )?;
        let sep0 = PredefinedMenuItem::separator(app)?;
        return Menu::with_items(
            app,
            &[&upd, &sep0, &show_item, &sep1, &conn_item, &mode_sub, &server_sub, &dpi_sub, &sep2, &quit_item],
        );
    }

    Menu::with_items(
        app,
        &[&show_item, &sep1, &conn_item, &mode_sub, &server_sub, &dpi_sub, &sep2, &quit_item],
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
        .manage(dpi::DpiState::default())
        .manage(clash_stream::ClashStreamState::default())
        .setup(|app| {
            let argv: Vec<String> = std::env::args().collect();
            let autostarted = argv.iter().any(|a| a == "--autostarted");

            // Throne-style «всегда от админа»: если маркер стоит и мы ещё не
            // elevated — перезапускаемся с UAC и выходим. Делаем ДО показа окна
            // (окно visible:false в конфиге), поэтому без мигания. Если юзер
            // отменит UAC — продолжаем как обычный процесс (TUN просто не
            // заработает, фронт попросит права при включении).
            #[cfg(target_os = "windows")]
            {
                let already_elevated = argv.iter().any(|a| a == "--elevated");
                if !already_elevated && !elevation::is_elevated() {
                    let want = always_admin_marker(app.handle())
                        .map(|p| p.exists())
                        .unwrap_or(false);
                    if want {
                        let mut extra: Vec<&str> = vec!["--elevated"];
                        if autostarted {
                            extra.push("--autostarted");
                        }
                        if elevation::relaunch_self_elevated(&extra).unwrap_or(false) {
                            // Освобождаем лок single-instance немедленно (ядро
                            // ещё не поднято на этом этапе — чистить нечего).
                            std::process::exit(0);
                        }
                    }
                }
            }

            // Окно по умолчанию скрыто (visible:false). Показываем сейчас, кроме
            // автозапуска при входе в Windows — там оставляем в трее.
            if let Some(w) = app.get_webview_window("main") {
                if autostarted {
                    let _ = w.hide();
                } else {
                    let _ = w.show();
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
                        "update:install" => { show_main(app); let _ = app.emit("tray:update", ()); }
                        "toggle-vpn" => { let _ = app.emit("tray:toggle-vpn", ()); }
                        "dpi:toggle" => { let _ = app.emit("tray:toggle-dpi", ()); }
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
            should_autoconnect,
            is_elevated,
            relaunch_elevated,
            is_always_admin,
            set_always_admin,
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
            dpi::dpi_strategies,
            dpi::dpi_domains_count,
            dpi::dpi_start,
            dpi::dpi_stop,
            dpi::dpi_running,
            dpi::dpi_set_node_exclude,
            dpi::dpi_versions,
            dpi::dpi_check_update,
            dpi::dpi_update_strategies,
            dpi::dpi_sync_channel,
            dpi::dpi_autotest,
            dpi::dpi_log_path,
            dpi::dpi_read_log,
            dpi::dpi_read_list,
            dpi::dpi_write_list,
            dpi::dpi_unload_driver,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SingboxState>() {
                    vpn::force_cleanup(&state);
                }
                if let Some(state) = app.try_state::<dpi::DpiState>() {
                    dpi::force_cleanup(&state);
                }
            }
        });
}
