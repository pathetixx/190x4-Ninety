mod app_paths;
mod atomic_file;
mod backup;
mod clash;
mod clash_stream;
mod discord_cache;
mod dnscheck;
mod dpi;
mod health;
mod killswitch;
mod netproc;
mod protected_browser;
mod quality;
mod scanner;
mod secrets;
mod subscription;
mod url_handler;
mod util;
mod vpn;
mod warp;
mod wifi;

#[cfg(not(target_os = "windows"))]
mod proxy_stub;
#[cfg(target_os = "windows")]
mod proxy_win;

#[cfg(not(target_os = "windows"))]
use proxy_stub as elevation;
#[cfg(target_os = "windows")]
use proxy_win as elevation;

use std::collections::HashMap;
use std::path::PathBuf;

use crate::util::MutexExt;
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

/// Full Portable определяется маркером рядом с Ninety.exe: writable-данные и
/// WebView-профиль уходят в NinetyData, а updater предлагает новый ZIP вместо
/// запуска NSIS и превращения распакованной копии в установленную.
#[tauri::command]
fn is_portable() -> bool {
    app_paths::is_portable()
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

/// Deep-link URL'ы, которые пришли argv при cold-start. Нужны для схем,
/// зарегистрированных вручную (vless://, tt://, naive+https://...): plugin
/// deep-link знает только статический ninety:// из tauri.conf.json.
#[tauri::command]
fn startup_deep_links() -> Vec<String> {
    url_handler::extract_deep_link_urls(std::env::args())
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
            vpn::force_cleanup(&app, &state);
        }
        if let Some(state) = app.try_state::<dpi::DpiState>() {
            dpi::force_cleanup(&state);
        }
        std::process::exit(0);
    }
    Ok(false)
}

fn always_admin_marker(app: &tauri::AppHandle) -> Option<PathBuf> {
    app_paths::config_dir(app)
        .ok()
        .map(|dir| dir.join("always-admin"))
}

/// True если включён режим «всегда запускать от администратора» (маркер-файл
/// в writable config dir). Читается на старте в setup() для авто-элевации.
#[tauri::command]
fn is_always_admin(app: tauri::AppHandle) -> bool {
    always_admin_marker(&app)
        .map(|p| p.exists())
        .unwrap_or(false)
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

/// True если автозапуск при входе в Windows включён (задача Планировщика).
#[tauri::command]
async fn autostart_is_enabled() -> Result<bool, String> {
    tokio::task::spawn_blocking(elevation::autostart_is_enabled)
        .await
        .map_err(|e| format!("проверка автозапуска прервана: {e}"))
}

/// Включает автозапуск через задачу Планировщика с правами администратора
/// (RunLevel=highest) — старт без UAC на каждый логин. Если процесс ещё не
/// elevated, поднимет права только ради создания задачи (один UAC).
#[tauri::command]
async fn autostart_enable() -> Result<(), String> {
    tokio::task::spawn_blocking(elevation::autostart_enable)
        .await
        .map_err(|e| format!("создание автозапуска прервано: {e}"))?
}

/// Выключает автозапуск (удаляет задачу Планировщика).
#[tauri::command]
async fn autostart_disable() -> Result<(), String> {
    tokio::task::spawn_blocking(elevation::autostart_disable)
        .await
        .map_err(|e| format!("отключение автозапуска прервано: {e}"))?
}

fn main_window_icon() -> Option<tauri::image::Image<'static>> {
    const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");
    tauri::image::Image::from_bytes(ICON).ok()
}

fn apply_main_window_icon(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Не используем default_window_icon(): Windows может отдать для него
        // закэшированный ресурс предыдущей версии. Встроенный PNG каждый раз
        // заново назначает WM_SETICON для thumbnail/hover окна.
        if let Some(icon) = main_window_icon() {
            let _ = w.set_icon(icon);
        }
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        apply_main_window_icon(app);
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
/// Кэшируем по ISO: меню трея пересобирается на каждое изменение состояния
/// (connect/смена ноды/DPI), а PNG-флаги неизменны — без кэша это лишний
/// дисковый I/O на каждую пересборку.
fn flag_icon(app: &tauri::AppHandle, iso: &Option<String>) -> Option<tauri::image::Image<'static>> {
    let iso = iso.as_ref()?;
    if iso.len() != 2 || !iso.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    static FLAG_CACHE: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, Option<tauri::image::Image<'static>>>>,
    > = std::sync::OnceLock::new();
    let cache = FLAG_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock_recover().get(iso).cloned() {
        return hit;
    }
    // Флаги — read-only ресурсы рядом с бинарём (<resource_dir>/flags/<iso>.png),
    // как и движок DPI. resource_dir проверен в dpi.rs.
    let img = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("flags").join(format!("{iso}.png")))
        .and_then(|p| tauri::image::Image::from_path(p).ok());
    cache.lock_recover().insert(iso.clone(), img.clone());
    img
}

/// Строки меню трея — приходят из фронта локализованными (язык интерфейса,
/// см. tray.* в i18n-каталогах). Default = русский фолбэк: он виден только
/// секунду-другую между созданием трея в setup() и первым set_tray_menu
/// из bootstrap'а фронта.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TrayLabels {
    show: String,
    connect: String,
    disconnect: String,
    mode_title: String,
    mode_proxy: String,
    mode_system: String,
    mode_tun: String,
    server: String,
    no_servers: String,
    dpi_title: String,
    dpi_status_on: String,
    dpi_status_off: String,
    dpi_enable: String,
    dpi_disable: String,
    quit: String,
    /// Шаблон с {ver} — «Обновить до v{ver}».
    update_to: String,
    tip_off: String,
    /// Шаблон с {mode} — «Ninety · {mode} · подключено».
    tip_connected: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            show: "Показать Ninety".into(),
            connect: "Подключиться".into(),
            disconnect: "Отключиться".into(),
            mode_title: "Режим подключения".into(),
            mode_proxy: "Прокси".into(),
            mode_system: "Системный прокси".into(),
            mode_tun: "VPN · TUN".into(),
            server: "Сервер".into(),
            no_servers: "Нет серверов".into(),
            dpi_title: "DPI-обход".into(),
            dpi_status_on: "Статус: активен".into(),
            dpi_status_off: "Статус: выключен".into(),
            dpi_enable: "Включить DPI-обход".into(),
            dpi_disable: "Выключить DPI-обход".into(),
            quit: "Выход".into(),
            update_to: "Обновить до v{ver}".into(),
            tip_off: "Ninety · отключено".into(),
            tip_connected: "Ninety · {mode} · подключено".into(),
        }
    }
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
    /// Пока OTA скачивается/устанавливается, сетевые действия в нативном меню
    /// блокируются: иначе пользователь может погасить proxy посреди download
    /// либо запустить reconnect одновременно с остановкой runtime.
    #[serde(default, rename = "updateBusy")]
    update_busy: bool,
    #[serde(default)]
    labels: TrayLabels,
}

/// Собирает контекстное меню трея под текущее состояние: выбор режима
/// подключения (radio-чек) и список серверов активной подписки. Подменю
/// «Сервер» активно только при поднятом VPN — иначе серое (disabled).
fn build_tray_menu(
    app: &tauri::AppHandle,
    payload: &TrayMenuPayload,
) -> tauri::Result<Menu<tauri::Wry>> {
    let l = &payload.labels;
    let show_item = MenuItem::with_id(app, "show", &l.show, true, None::<&str>)?;

    // Подключиться / Отключиться — по фактическому состоянию VPN
    let toggle_label = if payload.connected {
        &l.disconnect
    } else {
        &l.connect
    };
    let runtime_actions_enabled = !payload.update_busy;
    let conn_item = MenuItem::with_id(
        app,
        "toggle-vpn",
        toggle_label,
        runtime_actions_enabled,
        None::<&str>,
    )?;

    // Режим подключения
    let m_proxy = CheckMenuItem::with_id(
        app,
        "mode:proxy",
        &l.mode_proxy,
        runtime_actions_enabled,
        payload.mode == "proxy",
        None::<&str>,
    )?;
    let m_sys = CheckMenuItem::with_id(
        app,
        "mode:systemProxy",
        &l.mode_system,
        runtime_actions_enabled,
        payload.mode == "systemProxy",
        None::<&str>,
    )?;
    let m_tun = CheckMenuItem::with_id(
        app,
        "mode:tun",
        &l.mode_tun,
        runtime_actions_enabled,
        payload.mode == "tun",
        None::<&str>,
    )?;
    let mode_sub = Submenu::with_items(
        app,
        &l.mode_title,
        runtime_actions_enabled,
        &[&m_proxy, &m_sys, &m_tun],
    )?;

    // Выбор сервера — активен только когда VPN поднят. Иконка — флаг страны
    // (IconMenuItem); выбранный сервер помечаем «●», т.к. у IconMenuItem нет
    // чек-состояния.
    let srv_enabled = runtime_actions_enabled && payload.connected && !payload.servers.is_empty();
    let server_sub = if payload.servers.is_empty() {
        let none = MenuItem::with_id(app, "srv:none", &l.no_servers, false, None::<&str>)?;
        Submenu::with_items(app, &l.server, false, &[&none])?
    } else {
        let mut items: Vec<IconMenuItem<tauri::Wry>> = Vec::with_capacity(payload.servers.len());
        for s in &payload.servers {
            let label = if s.selected {
                format!("●  {}", s.label)
            } else {
                format!("    {}", s.label)
            };
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
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items
            .iter()
            .map(|i| i as &dyn IsMenuItem<tauri::Wry>)
            .collect();
        Submenu::with_items(app, &l.server, srv_enabled, &refs)?
    };

    // DPI-обход — статус (disabled, информативный) + переключатель
    let dpi_status = MenuItem::with_id(
        app,
        "dpi:status",
        if payload.dpi_active {
            &l.dpi_status_on
        } else {
            &l.dpi_status_off
        },
        false,
        None::<&str>,
    )?;
    let dpi_toggle = MenuItem::with_id(
        app,
        "dpi:toggle",
        if payload.dpi_active {
            &l.dpi_disable
        } else {
            &l.dpi_enable
        },
        runtime_actions_enabled,
        None::<&str>,
    )?;
    let dpi_sub = Submenu::with_items(
        app,
        &l.dpi_title,
        runtime_actions_enabled,
        &[&dpi_status, &dpi_toggle],
    )?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", &l.quit, true, None::<&str>)?;

    // Доступное обновление (нашлось пока окно в трее) — выделенный пункт сверху.
    // Клик показывает окно и открывает модалку установки.
    if let Some(ver) = &payload.update_version {
        let upd = MenuItem::with_id(
            app,
            "update:install",
            format!("⤓  {}", l.update_to.replace("{ver}", ver)),
            !payload.update_busy,
            None::<&str>,
        )?;
        let sep0 = PredefinedMenuItem::separator(app)?;
        return Menu::with_items(
            app,
            &[
                &upd,
                &sep0,
                &show_item,
                &sep1,
                &conn_item,
                &mode_sub,
                &server_sub,
                &dpi_sub,
                &sep2,
                &quit_item,
            ],
        );
    }

    Menu::with_items(
        app,
        &[
            &show_item,
            &sep1,
            &conn_item,
            &mode_sub,
            &server_sub,
            &dpi_sub,
            &sep2,
            &quit_item,
        ],
    )
}

/// Фронтенд зовёт при каждом изменении состояния (connect/disconnect, смена
/// режима/подписки/эффективной ноды) — пересобираем меню трея под него.
// Значок трея под состояние: off (отключено) / proxy / tun (synthwave-purple).
// Встроены в бинарь (include_bytes) — не зависят от resource_dir; 32px,
// Windows даунскейлит под нужный размер нотификейшн-зоны.
fn tray_state_icon(connected: bool, mode: &str) -> Option<tauri::image::Image<'static>> {
    const OFF: &[u8] = include_bytes!("../icons/tray/oni_off_32.png");
    const PROXY: &[u8] = include_bytes!("../icons/tray/oni_proxy_32.png");
    const TUN: &[u8] = include_bytes!("../icons/tray/oni_tun_32.png");
    let bytes = if !connected {
        OFF
    } else if mode == "tun" {
        TUN
    } else {
        PROXY
    };
    tauri::image::Image::from_bytes(bytes).ok()
}

// Tooltip трея — даёт точный режим (иконка только сигналит статус/тип).
// Строки локализованы фронтом; имя режима — тот же лейбл, что в меню.
fn tray_tooltip(labels: &TrayLabels, connected: bool, mode: &str) -> String {
    if !connected {
        return labels.tip_off.clone();
    }
    let m = match mode {
        "tun" => &labels.mode_tun,
        "systemProxy" => &labels.mode_system,
        _ => &labels.mode_proxy,
    };
    labels.tip_connected.replace("{mode}", m)
}

#[tauri::command]
fn set_tray_menu(app: tauri::AppHandle, payload: TrayMenuPayload) -> Result<(), String> {
    let menu = build_tray_menu(&app, &payload).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        if let Some(icon) = tray_state_icon(payload.connected, &payload.mode) {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(tray_tooltip(
            &payload.labels,
            payload.connected,
            &payload.mode,
        )));
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let portable = app_paths::is_portable();
    let mut context = tauri::generate_context!();
    if portable {
        // Absolute WebView2 data directory задаётся только через builder.
        // Запрещаем Tauri автоматически создавать окно из tauri.conf и
        // создаём его в setup() с NinetyData/webview.
        if let Some(window) = context.config_mut().app.windows.first_mut() {
            window.create = false;
        }
    }

    tauri::Builder::default()
        // single-instance ОБЯЗАН быть зарегистрирован первым: на second-launch
        // (юзер кликнул ninety://import/...) система запускает второй процесс;
        // single-instance перехватывает argv и пробрасывает в первый. Без
        // этого plugin deep-link создал бы новый window каждый раз.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let urls = url_handler::extract_deep_link_urls(argv);
            if !urls.is_empty() {
                let _ = app.emit("deep-link:open", urls);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Автозапуск при входе в Windows реализован через задачу Планировщика
        // (см. autostart_enable/proxy_win). Прежний tauri-plugin-autostart писал
        // Run-ключ реестра → не-elevated старт → relaunch с UAC на каждый логин;
        // от него отказались, миграция в setup() (migrate_legacy_autostart).
        .manage(SingboxState::default())
        .manage(dpi::DpiState::default())
        .manage(clash_stream::ClashStreamState::default())
        .manage(killswitch::KillSwitchState::default())
        .manage(scanner::WarpScanState::default())
        .setup(move |app| {
            if portable {
                app_paths::ensure_portable_layout()?;
                let config = app
                    .config()
                    .app
                    .windows
                    .first()
                    .cloned()
                    .ok_or("конфигурация главного окна отсутствует")?;
                tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                    .data_directory(app_paths::webview_dir()?)
                    .build()?;
            }

            let argv: Vec<String> = std::env::args().collect();
            let autostarted = argv.iter().any(|a| a == "--autostarted");
            let ci_smoke = argv.iter().any(|a| a == "--ci-smoke");
            vpn::purge_stale_runtime_configs(app.handle());
            if let Err(e) = vpn::recover_stale_system_proxy() {
                eprintln!("stale system proxy recovery: {e}");
            }

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
                apply_main_window_icon(app.handle());
                if autostarted || ci_smoke {
                    let _ = w.hide();
                } else {
                    let _ = w.show();
                }
            }

            // schtasks /query и /create могут холодно стартовать сотни миллисекунд.
            // Они не нужны для создания WebView/tray и поэтому выполняются после
            // показа окна на отдельном named thread. Сетевой runtime и proxy recovery
            // остаются в синхронном fail-safe critical path выше.
            #[cfg(target_os = "windows")]
            {
                let migrate_installed = !portable;
                let _ = std::thread::Builder::new()
                    .name("ninety-startup-maintenance".into())
                    .spawn(move || {
                        if migrate_installed {
                            elevation::migrate_legacy_autostart();
                        }
                        elevation::autostart_refresh_path();
                    });
            }

            // Регистрация ninety:// в HKCR при первом запуске. На NSIS-инсталле
            // tauri-plugin-deep-link уже прописал ключи в installer; register_all
            // нужен для dev-режима / повторной регистрации установленной версии.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                // Full Portable не пишет в реестр при обычном запуске. Ручные
                // обработчики VPN-ссылок остаются opt-in через Настройки.
                if !portable {
                    if let Err(e) = app.deep_link().register_all() {
                        eprintln!("deep-link register_all: {e}");
                    }
                }
            }

            let init_payload = TrayMenuPayload::default();
            let menu = build_tray_menu(app.handle(), &init_payload)?;

            // Старт всегда в состоянии «отключено» — серый значок; фронт после
            // загрузки/автоконнекта пришлёт set_tray_menu с актуальным режимом
            // и локализованными строками (до этого — русский фолбэк labels).
            let init_icon = tray_state_icon(false, "")
                .unwrap_or_else(|| app.default_window_icon().unwrap().clone());
            let _tray = TrayIconBuilder::with_id("main")
                .icon(init_icon)
                .tooltip(tray_tooltip(&init_payload.labels, false, ""))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "show" => show_main(app),
                        "quit" => app.exit(0),
                        "update:install" => {
                            show_main(app);
                            let _ = app.emit("tray:update", ());
                        }
                        "toggle-vpn" => {
                            let _ = app.emit("tray:toggle-vpn", ());
                        }
                        "dpi:toggle" => {
                            let _ = app.emit("tray:toggle-dpi", ());
                        }
                        "mode:proxy" => {
                            let _ = app.emit("tray:set-mode", "proxy");
                        }
                        "mode:systemProxy" => {
                            let _ = app.emit("tray:set-mode", "systemProxy");
                        }
                        "mode:tun" => {
                            let _ = app.emit("tray:set-mode", "tun");
                        }
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

            // Квалификационный smoke в Windows CI: приложение проходит полный
            // setup (включая backend-команды и tray), проверяет безопасный ping
            // и само штатно завершает event loop. Никаких VPN/DPI-соединений.
            if ci_smoke {
                if ping() != "pong" {
                    return Err("backend ping failed during CI smoke".into());
                }
                if portable {
                    for name in ["config", "data", "logs", "webview"] {
                        if !app_paths::portable_root()?.join(name).is_dir() {
                            return Err(format!("portable directory missing: {name}").into());
                        }
                    }
                    // Реальная запись через production-path helper: ловит и
                    // случайный AppData, и DPAPI, который сделал бы Full
                    // Portable нечитаемым после переноса на другой ПК.
                    let smoke_snapshot = serde_json::json!({
                        "__schemaVersion": 2,
                        "ninety.options.v1": "{}",
                        "ninety.profiles.v1": "[]",
                        "ninety.subscriptions.v1": "[]"
                    });
                    backup::state_backup_save(app.handle().clone(), smoke_snapshot.to_string())?;
                    let snapshot = std::fs::read(
                        app_paths::portable_root()?
                            .join("config")
                            .join("state-backup.json"),
                    )?;
                    if !secrets::is_plaintext_json(&snapshot) {
                        return Err("portable state backup is not transferable".into());
                    }
                }
                let handle = app.handle().clone();
                // Do not depend on the shared async runtime being scheduled
                // while WebView2/Defender finishes first-launch work on a fresh
                // Windows runner. This watchdog exists only for --ci-smoke.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    handle.exit(0);
                });
            }

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
            is_portable,
            is_autostarted,
            should_autoconnect,
            startup_deep_links,
            is_elevated,
            relaunch_elevated,
            protected_browser::protected_browser_status,
            protected_browser::protected_browser_launch,
            protected_browser::protected_browser_open_download,
            is_always_admin,
            set_always_admin,
            autostart_is_enabled,
            autostart_enable,
            autostart_disable,
            set_tray_menu,
            vpn::start_singbox,
            vpn::stop_singbox,
            vpn::plan_bridge_ports,
            vpn::singbox_running,
            vpn::runtime_snapshot,
            vpn::health_snapshot,
            vpn::xray_status,
            vpn::sidecar_status,
            vpn::vpn_last_error,
            vpn::set_system_proxy,
            vpn::read_singbox_log,
            vpn::clear_singbox_log,
            vpn::read_log,
            vpn::clear_log,
            vpn::singbox_log_path,
            vpn::open_log_dir,
            subscription::fetch_subscription,
            clash::clash_get_proxies,
            clash::clash_get_connections,
            clash::clash_traffic_total,
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
            scanner::warp_scan_cancel,
            quality::probe_quality,
            dnscheck::dns_probe,
            dpi::dpi_strategies,
            dpi::dpi_domains_count,
            dpi::dpi_fake_payloads,
            dpi::dpi_set_active_fake,
            dpi::dpi_start,
            dpi::dpi_stop,
            dpi::dpi_running,
            dpi::dpi_set_node_exclude,
            dpi::dpi_set_active_vpn_endpoint,
            dpi::dpi_versions,
            dpi::dpi_check_update,
            dpi::dpi_sync_channel,
            dpi::dpi_autotest,
            dpi::dpi_log_path,
            dpi::dpi_read_log,
            dpi::dpi_read_list,
            dpi::dpi_write_list,
            dpi::dpi_unload_driver,
            dpi::dpi_hosts_status,
            dpi::dpi_hosts_apply,
            dpi::dpi_hosts_clear,
            dpi::dpi_ipset_count,
            dpi::dpi_update_ipset,
            discord_cache::discord_cache_clear,
            netproc::list_network_processes,
            wifi::current_wifi,
            killswitch::killswitch_arm,
            killswitch::killswitch_disarm,
            killswitch::killswitch_active,
            backup::state_backup_save,
            backup::state_backup_load,
            backup::state_backup_clear,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // setup() выполняется до полного создания нативного event loop.
            // Повтор на Ready гарантирует, что Windows получит новую small/big
            // icon уже после всех внутренних настроек окна Tauri/WebView2.
            if matches!(&event, RunEvent::Ready) {
                apply_main_window_icon(app);
            }
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SingboxState>() {
                    vpn::force_cleanup(app, &state);
                }
                if let Some(state) = app.try_state::<dpi::DpiState>() {
                    // cleanup_on_exit убивает winws и снимает kernel-драйвер
                    // WinDivert/Monkey, НО пропускает sc.exe при выключении ОС
                    // (там sc.exe падает 0xc0000142, а драйвер выгрузит перезагрузка)
                    // и когда DPI в этой сессии не поднимался. Лок .sys для
                    // переустановки без ребута снимает явная dpi_unload_driver (OTA).
                    dpi::cleanup_on_exit(&state);
                }
                if let Some(state) = app.try_state::<killswitch::KillSwitchState>() {
                    killswitch::force_disarm(&state);
                }
            }
        });
}
