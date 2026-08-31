mod app_paths;
mod atomic_file;
mod backup;
mod clash;
mod clash_stream;
mod discord_cache;
mod dnscheck;
mod dpi;
mod host_pressure;
mod hwid;
mod killswitch;
mod netproc;
mod profile_store;
mod protected_browser;
mod quality;
mod runtime_ops;
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

/// Включает автозапуск через задачу Планировщика. RunLevel=highest (старт от
/// администратора без UAC на каждый логин) выдаётся только установке в Program
/// Files: для Full Portable и per-user установки exe лежит в user-writable
/// каталоге, и там такая задача превратила бы подмену файла в тихое повышение
/// прав. Если процесс ещё не elevated, поднимет права только ради создания
/// задачи (один UAC).
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

/// CI smoke — сборочная проверка релизного артефакта, а не пользовательский
/// режим: она пишет и затем стирает боевой profile store, а в portable ещё и
/// перезаписывает state backup. Одного argv-флага для такого мало — случайный
/// `Ninety.exe --ci-smoke` (ярлык, .bat, чужая инструкция) уничтожил бы
/// единственную копию нод и подписок. Требуем явный opt-in переменной
/// окружения, который выставляет только scripts/release-smoke.ps1.
const CI_SMOKE_ENV: &str = "NINETY_CI_SMOKE";

fn ci_smoke_opt_in(has_flag: bool, env_value: Option<&str>) -> bool {
    has_flag && env_value == Some("1")
}

fn ci_smoke_requested(argv: &[String]) -> bool {
    let has_flag = argv.iter().any(|a| a == "--ci-smoke");
    let enabled = ci_smoke_opt_in(has_flag, std::env::var(CI_SMOKE_ENV).ok().as_deref());
    if has_flag && !enabled {
        eprintln!("--ci-smoke игнорируется: это сборочная проверка, она требует {CI_SMOKE_ENV}=1");
    }
    enabled
}

// Имена файлов, в которых лежит единственная копия профилей/подписок и ключей.
const CI_SMOKE_PROTECTED_FILES: &[&str] = &[
    "profile-store.v1",
    "profile-store.v1.bak",
    "profile-store.v1.legacy.bak",
    "state-backup.json",
    "state-backup.json.bak",
    "state-backup.json.legacy.bak",
];

/// Второй барьер: даже с opt-in smoke не трогает уже существующее состояние.
/// На чистом раннере его нет, поэтому проверка в CI выполняется полностью, а на
/// машине с данными деструктивная часть просто пропускается.
fn ci_smoke_state_is_empty_in(dir: &std::path::Path) -> bool {
    !CI_SMOKE_PROTECTED_FILES
        .iter()
        .any(|name| dir.join(name).exists())
}

fn ci_smoke_state_is_empty(app: &tauri::AppHandle) -> bool {
    match app_paths::config_dir(app) {
        Ok(dir) => ci_smoke_state_is_empty_in(&dir),
        // Каталог не определился — считаем состояние непустым: пропустить
        // проверку безопаснее, чем писать неизвестно куда.
        Err(_) => false,
    }
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

/// Страна и её ноды. Внутри группы флаг у каждой строки не рисуем: он один и
/// тот же на всю страну, а иконка — самая дорогая часть пункта меню.
#[derive(serde::Deserialize, Default)]
struct TrayServerGroup {
    #[serde(default)]
    label: String,
    #[serde(default)]
    items: Vec<TraySrv>,
}

/// Раскладка подменю «Сервер», посчитанная фронтом (tray-servers.js).
/// `flat` не пуст только на маленькой подписке — там группировать нечего.
#[derive(serde::Deserialize, Default)]
struct TrayServers {
    #[serde(default)]
    current: Option<TraySrv>,
    #[serde(default)]
    flat: Vec<TraySrv>,
    #[serde(default)]
    favourites: Vec<TraySrv>,
    #[serde(default)]
    fast: Vec<TraySrv>,
    #[serde(default)]
    groups: Vec<TrayServerGroup>,
    #[serde(default)]
    total: u32,
}

impl TrayServers {
    fn is_empty(&self) -> bool {
        self.total == 0
    }
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
    favourites: String,
    fast: String,
    all_servers: String,
    /// Шаблон с {n} — «…и ещё {n} на экране Серверы».
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
    /// Шаблон с {ver}. Вторая строка подсказки, когда найден апдейт: в трее это
    /// единственный признак, который не зависит от OS-уведомлений (те на
    /// Windows молча теряются, если у сборки нет ярлыка с AppUserModelID).
    tip_update: String,
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
            favourites: "Избранные".into(),
            fast: "Быстрые".into(),
            all_servers: "Все серверы…".into(),
            dpi_title: "DPI-обход".into(),
            dpi_status_on: "Статус: активен".into(),
            dpi_status_off: "Статус: выключен".into(),
            dpi_enable: "Включить DPI-обход".into(),
            dpi_disable: "Выключить DPI-обход".into(),
            quit: "Выход".into(),
            update_to: "Обновить до v{ver}".into(),
            tip_off: "Ninety · отключено".into(),
            tip_connected: "Ninety · {mode} · подключено".into(),
            tip_update: "Доступно обновление v{ver}".into(),
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
    servers: TrayServers,
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

/// Строка сервера с флагом страны. Текущий помечается «●»: у IconMenuItem нет
/// чек-состояния, а отступ у остальных держит подписи на одной вертикали.
fn server_item(
    app: &tauri::AppHandle,
    srv: &TraySrv,
    enabled: bool,
    with_icon: bool,
) -> tauri::Result<IconMenuItem<tauri::Wry>> {
    let label = if srv.selected {
        format!("●  {}", srv.label)
    } else {
        format!("    {}", srv.label)
    };
    let icon = if with_icon {
        flag_icon(app, &srv.iso)
    } else {
        None
    };
    IconMenuItem::with_id(
        app,
        format!("srv:{}", srv.id),
        &label,
        enabled,
        icon,
        None::<&str>,
    )
}

/// Подменю с готовым списком нод — «Избранные», «Быстрые» и каждая страна.
/// Флаги рисуются только там, где страны разные: внутри страны иконка у каждой
/// строки одинаковая, а иконка — самая дорогая часть пункта меню.
fn server_group_submenu(
    app: &tauri::AppHandle,
    title: &str,
    items: &[TraySrv],
    enabled: bool,
    with_icons: bool,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let entries: Vec<IconMenuItem<tauri::Wry>> = items
        .iter()
        .map(|srv| server_item(app, srv, enabled, with_icons))
        .collect::<tauri::Result<_>>()?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = entries
        .iter()
        .map(|i| i as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    Submenu::with_items(app, format!("{title}  ·  {}", items.len()), enabled, &refs)
}

/// Подменю «Сервер». На подписке в сотни нод плоский список нечитаем и дорог,
/// поэтому большой список приходит от фронта уже разложенным: текущая нода,
/// избранные, самые быстрые, затем страны. Последняя строка ведёт на экран
/// «Серверы» — там поиск и полный список, которого в меню быть не может.
fn build_server_submenu(
    app: &tauri::AppHandle,
    payload: &TrayMenuPayload,
    enabled: bool,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let l = &payload.labels;
    let servers = &payload.servers;
    if servers.is_empty() {
        let none = MenuItem::with_id(app, "srv:none", &l.no_servers, false, None::<&str>)?;
        return Submenu::with_items(app, &l.server, false, &[&none]);
    }

    // Владельцы пунктов живут до конца сборки: Submenu::with_items берёт ссылки.
    let mut flat: Vec<IconMenuItem<tauri::Wry>> = Vec::new();
    let mut current: Option<IconMenuItem<tauri::Wry>> = None;
    let mut shortcuts: Vec<Submenu<tauri::Wry>> = Vec::new();
    let mut countries: Vec<Submenu<tauri::Wry>> = Vec::new();
    let mut separators: Vec<PredefinedMenuItem<tauri::Wry>> = Vec::new();

    if !servers.flat.is_empty() {
        for srv in &servers.flat {
            flat.push(server_item(app, srv, enabled, true)?);
        }
    } else {
        if let Some(srv) = servers.current.as_ref() {
            current = Some(server_item(app, srv, enabled, true)?);
        }
        if !servers.favourites.is_empty() {
            shortcuts.push(server_group_submenu(
                app,
                &l.favourites,
                &servers.favourites,
                enabled,
                true,
            )?);
        }
        if !servers.fast.is_empty() {
            shortcuts.push(server_group_submenu(
                app,
                &l.fast,
                &servers.fast,
                enabled,
                true,
            )?);
        }
        for group in &servers.groups {
            countries.push(server_group_submenu(
                app,
                &group.label,
                &group.items,
                enabled,
                false,
            )?);
        }
        // Разделителей ровно столько, сколько понадобится ниже.
        for _ in 0..3 {
            separators.push(PredefinedMenuItem::separator(app)?);
        }
    }

    let all = MenuItem::with_id(
        app,
        "srv:all",
        format!("{}  ·  {}", l.all_servers, servers.total),
        true,
        None::<&str>,
    )?;

    let mut refs: Vec<&dyn IsMenuItem<tauri::Wry>> = Vec::new();
    if !flat.is_empty() {
        for item in &flat {
            refs.push(item as &dyn IsMenuItem<tauri::Wry>);
        }
    } else {
        let mut separators = separators.iter();
        if let Some(item) = current.as_ref() {
            refs.push(item as &dyn IsMenuItem<tauri::Wry>);
            if let Some(sep) = separators.next() {
                refs.push(sep as &dyn IsMenuItem<tauri::Wry>);
            }
        }
        if !shortcuts.is_empty() {
            for item in &shortcuts {
                refs.push(item as &dyn IsMenuItem<tauri::Wry>);
            }
            if let Some(sep) = separators.next() {
                refs.push(sep as &dyn IsMenuItem<tauri::Wry>);
            }
        }
        for item in &countries {
            refs.push(item as &dyn IsMenuItem<tauri::Wry>);
        }
        if let Some(sep) = separators.next() {
            refs.push(sep as &dyn IsMenuItem<tauri::Wry>);
        }
    }
    refs.push(&all as &dyn IsMenuItem<tauri::Wry>);
    Submenu::with_items(app, &l.server, enabled, &refs)
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

    // Выбор сервера — активен только когда VPN поднят. Раскладку считает фронт
    // (tray-servers.js): маленькая подписка приходит плоским списком, большая —
    // текущим сервером, быстрыми входами и странами.
    let srv_enabled = runtime_actions_enabled && payload.connected && !payload.servers.is_empty();
    let server_sub = build_server_submenu(app, payload, srv_enabled)?;

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

// Метка «есть обновление» поверх значка трея. Пункт меню и подсказка видны
// только после наведения/ПКМ, поэтому свёрнутое в трей приложение молчало о
// найденной версии до тех пор, пока пользователь сам не полез в меню. Метку
// рисуем в рантайме поверх декодированного RGBA — держать в бинаре вторую
// тройку PNG ради одного кружка незачем.
const BADGE_FILL: [f32; 3] = [255.0, 77.0, 109.0]; // неоновый акцент
const BADGE_RING: [f32; 3] = [10.0, 8.0, 12.0]; // тёмная обводка под любой значок

/// Рисует кружок-метку в правом нижнем углу RGBA-буфера (straight alpha,
/// source-over). Субпиксельная выборка обязательна: на 32px без сглаживания
/// метка выглядит рваным квадратом.
fn paint_update_badge(rgba: &mut [u8], width: u32, height: u32) {
    let (w, h) = (width as i64, height as i64);
    if w < 8 || h < 8 || rgba.len() < (w * h * 4) as usize {
        return;
    }
    let side = w.min(h) as f32;
    let r_out = side * 0.21;
    let r_in = (r_out - (side * 0.06).max(1.0)).max(1.0);
    let cx = w as f32 - r_out - side * 0.02;
    let cy = h as f32 - r_out - side * 0.02;
    const SUB: i64 = 4;
    let x0 = ((cx - r_out).floor() as i64).max(0);
    let x1 = ((cx + r_out).ceil() as i64).min(w - 1);
    let y0 = ((cy - r_out).floor() as i64).max(0);
    let y1 = ((cy + r_out).ceil() as i64).min(h - 1);
    for py in y0..=y1 {
        for px in x0..=x1 {
            let (mut fill_cov, mut ring_cov) = (0.0f32, 0.0f32);
            for sy in 0..SUB {
                for sx in 0..SUB {
                    let dx = px as f32 + (sx as f32 + 0.5) / SUB as f32 - cx;
                    let dy = py as f32 + (sy as f32 + 0.5) / SUB as f32 - cy;
                    let d = (dx * dx + dy * dy).sqrt();
                    if d <= r_in {
                        fill_cov += 1.0;
                    } else if d <= r_out {
                        ring_cov += 1.0;
                    }
                }
            }
            let total = (SUB * SUB) as f32;
            let (fill_cov, ring_cov) = (fill_cov / total, ring_cov / total);
            let src_a = fill_cov + ring_cov;
            if src_a <= 0.0 {
                continue;
            }
            let idx = ((py * w + px) * 4) as usize;
            let dst_a = rgba[idx + 3] as f32 / 255.0;
            let out_a = src_a + dst_a * (1.0 - src_a);
            for (offset, (fill, ring)) in BADGE_FILL.iter().zip(BADGE_RING.iter()).enumerate() {
                let src = (fill * fill_cov + ring * ring_cov) / src_a;
                let dst = rgba[idx + offset] as f32;
                let out = (src * src_a + dst * dst_a * (1.0 - src_a)) / out_a;
                rgba[idx + offset] = out.round().clamp(0.0, 255.0) as u8;
            }
            rgba[idx + 3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
}

/// Значок трея под состояние + метка отложенного обновления.
fn tray_icon(
    connected: bool,
    mode: &str,
    update_pending: bool,
) -> Option<tauri::image::Image<'static>> {
    let icon = tray_state_icon(connected, mode)?;
    if !update_pending {
        return Some(icon);
    }
    let (w, h) = (icon.width(), icon.height());
    let mut rgba = icon.rgba().to_vec();
    paint_update_badge(&mut rgba, w, h);
    Some(tauri::image::Image::new_owned(rgba, w, h))
}

// Tooltip трея — даёт точный режим (иконка только сигналит статус/тип).
// Строки локализованы фронтом; имя режима — тот же лейбл, что в меню.
fn tray_tooltip(
    labels: &TrayLabels,
    connected: bool,
    mode: &str,
    update_version: Option<&str>,
) -> String {
    let state = if connected {
        let m = match mode {
            "tun" => &labels.mode_tun,
            "systemProxy" => &labels.mode_system,
            _ => &labels.mode_proxy,
        };
        labels.tip_connected.replace("{mode}", m)
    } else {
        labels.tip_off.clone()
    };
    match update_version {
        Some(ver) => format!("{state}\n{}", labels.tip_update.replace("{ver}", ver)),
        None => state,
    }
}

/// Windows не сообщает, когда меню трея закрылось, но состояние «сейчас
/// показывается меню» видно у GUI-потока переднего плана.
fn menu_flags_indicate_open(flags: u32) -> bool {
    // GUI_INMENUMODE | GUI_POPUPMENUMODE
    flags & (0x0000_0004 | 0x0000_0010) != 0
}

/// Пока меню показано, подменять его у значка нельзя: замена рушит уже
/// открытый popup, и пользователь видит, как меню схлопывается сразу после
/// правого клика. Такую пересборку откладываем до закрытия меню.
#[cfg(target_os = "windows")]
fn menu_mode_active() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetGUIThreadInfo, GUITHREADINFO};
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    // idThread = 0 — поток окна переднего плана, а меню трея показывается
    // именно им.
    unsafe { GetGUIThreadInfo(0, &mut info).is_ok() && menu_flags_indicate_open(info.flags.0) }
}

#[cfg(not(target_os = "windows"))]
fn menu_mode_active() -> bool {
    false
}

/// `applied = false` — значок и подсказка обновлены, а меню осталось прежним,
/// потому что пользователь держит его открытым. Фронт повторит попытку.
#[derive(serde::Serialize)]
struct TrayMenuOutcome {
    applied: bool,
}

#[tauri::command]
fn set_tray_menu(
    app: tauri::AppHandle,
    payload: TrayMenuPayload,
) -> Result<TrayMenuOutcome, String> {
    let Some(tray) = app.tray_by_id("main") else {
        return Ok(TrayMenuOutcome { applied: true });
    };
    // Значок и подсказка ставятся ПЕРВЫМИ и независимо от меню. Они дёшевы и
    // собраться не могут разве что при битом ресурсе, а меню на большой
    // подписке — сотни пунктов, каждый со своей иконкой флага. Раньше меню
    // строилось первым и любая его ошибка выходила из функции раньше, чем
    // обновлялся значок: трей оставался в стартовом «отключено» при поднятом
    // VPN, и починить это мог только перезапуск приложения.
    if let Some(icon) = tray_icon(
        payload.connected,
        &payload.mode,
        payload.update_version.is_some(),
    ) {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = tray.set_tooltip(Some(tray_tooltip(
        &payload.labels,
        payload.connected,
        &payload.mode,
        payload.update_version.as_deref(),
    )));
    // Проверка идёт после значка и подсказки: они меняются независимо от меню
    // и открытому popup не мешают.
    if menu_mode_active() {
        return Ok(TrayMenuOutcome { applied: false });
    }
    let menu = match build_tray_menu(&app, &payload) {
        Ok(menu) => menu,
        Err(e) => {
            // Значок и подсказка уже применены, а вот меню осталось прежним.
            // Фронт эту ошибку кладёт в консоль вебвью, куда пользователь не
            // заглянет; пишем в тот же журнал, что читает экран «Логи», чтобы
            // в следующий раз причина была на виду, а не выводилась из симптома.
            crate::vpn::append_runtime_diagnostic_at(
                &app,
                crate::vpn::DiagnosticLevel::Warn,
                &format!(
                    "tray_menu_rebuild_failed servers={} error={e}",
                    payload.servers.total
                ),
            );
            return Err(e.to_string());
        }
    };
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(TrayMenuOutcome { applied: true })
}

/// Последний рубеж перед аварийным завершением. Штатная очистка висит на
/// `RunEvent::Exit`, но паника до event loop не доходит: паникующий поток не
/// обязан быть тем, который крутит event loop, и раскрутка до Tauri может не
/// добраться вовсе. Итог один — в реестре остаётся `ProxyEnable=1` на мёртвый
/// loopback-порт, и у пользователя пропадает интернет во всём, что читает
/// WinINet. Hook выполняется ДО раскрутки/abort, поэтому снять прокси можно
/// только здесь.
///
/// Внутри — только запись в реестр: без тяжёлых аллокаций, без await и без
/// обращения к Tauri state (его в этот момент может уже не быть).
fn install_failsafe_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        #[cfg(target_os = "windows")]
        if let Err(error) = elevation::set_system_proxy(false, None, None) {
            eprintln!("panic cleanup: system proxy not restored: {error}");
        }
        default_hook(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_failsafe_panic_hook();
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
        .manage(host_pressure::HostPressureState::default())
        .manage(clash_stream::ClashStreamState::default())
        .manage(killswitch::KillSwitchState::default())
        .manage(runtime_ops::RuntimeOperationCoordinator::default())
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
            let ci_smoke = ci_smoke_requested(&argv);
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

            // Сэмплер давления хоста поднимаем сразу и на всё время жизни
            // процесса: ему нужна предыдущая выборка CPU-счётчиков, чтобы
            // посчитать первую дельту, а к моменту подключения ответ на вопрос
            // «виноват ли хост» должен быть уже готов. Прав на runtime у него
            // нет — только цифры для движка качества.
            host_pressure::start(
                app.state::<host_pressure::HostPressureState>()
                    .inner()
                    .clone(),
            );

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
            let init_icon = match tray_state_icon(false, "") {
                Some(icon) => icon,
                // default_window_icon() пуст в headless-конфигурациях; трей без
                // значка Windows не создаёт, но паниковать в setup() нельзя —
                // приложение обязано дойти до окна и сказать об этом словами.
                None => app
                    .default_window_icon()
                    .cloned()
                    .ok_or("tray icon is unavailable")?,
            };
            let _tray = TrayIconBuilder::with_id("main")
                .icon(init_icon)
                .tooltip(tray_tooltip(&init_payload.labels, false, "", None))
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
                        // Полный список серверов живёт на своём экране: в меню
                        // он не помещается и там нет поиска.
                        "srv:all" => {
                            show_main(app);
                            let _ = app.emit("tray:open-servers", ());
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
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => show_main(tray.app_handle()),
                    // Пользователь потянулся к значку — единственный момент,
                    // когда точно известно, что он сейчас смотрит на трей.
                    // Свёрнутое окно узнаёт о новой версии только по
                    // расписанию, поэтому здесь просим фронт дочекать OTA:
                    // меню собирается заново на set_tray_menu, и к следующему
                    // открытию пункт «Обновить» уже на месте.
                    TrayIconEvent::Enter { .. }
                    | TrayIconEvent::Click {
                        button: MouseButton::Right,
                        ..
                    } => {
                        let _ = tray.app_handle().emit("tray:activity", ());
                    }
                    _ => {}
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
                }
                // Ниже — единственная часть smoke, которая пишет в боевое
                // состояние. На машине с уже существующими профилями её
                // пропускаем целиком: проверка сборки не стоит данных.
                let state_is_empty = ci_smoke_state_is_empty(app.handle());
                if !state_is_empty {
                    eprintln!("CI smoke: пропускаю проверку хранилища — в конфиге уже есть данные");
                }
                if state_is_empty && portable {
                    // The portable profile store must use the same explicit
                    // in-memory passphrase policy as state-backup.
                    secrets::configure_portable_passphrase(
                        "ci-smoke-only-passphrase-2026".to_string(),
                    )?;
                }
                if state_is_empty {
                    let profile_store_before =
                        profile_store::profile_store_load_blocking(app.handle().clone())?;
                    let smoke_store = profile_store::ProfileStore {
                        schema_version: 1,
                        revision: profile_store_before.revision,
                        profiles: vec![serde_json::json!({
                            "id": "ci-smoke-profile",
                            "proto": "vless",
                            "host": "smoke.invalid"
                        })],
                        subscriptions: vec![],
                        active: profile_store::ActiveSelection {
                            kind: "single".into(),
                            profile_id: Some("ci-smoke-profile".into()),
                            subscription_id: None,
                        },
                        proxy_selection: std::collections::BTreeMap::from([(
                            "single:ci-smoke-profile".into(),
                            "node-smoke".into(),
                        )]),
                    };
                    let _ = profile_store::profile_store_replace_blocking(
                        app.handle().clone(),
                        profile_store_before.revision,
                        smoke_store,
                    )?;
                    let profile_store_after =
                        profile_store::profile_store_load_blocking(app.handle().clone())?;
                    if profile_store_after.store.is_none()
                        || profile_store_after.revision <= profile_store_before.revision
                    {
                        return Err("profile store roundtrip failed during CI smoke".into());
                    }
                    profile_store::profile_store_clear_blocking(app.handle().clone(), None)?;
                    if portable {
                        // Реальная запись через production-path helper: ловит и
                        // случайный AppData, и DPAPI, который сделал бы Full
                        // Portable нечитаемым после переноса на другой ПК.
                        let smoke_snapshot = serde_json::json!({
                            "__schemaVersion": 2,
                            "ninety.options.v1": "{}",
                            "ninety.profiles.v1": "[]",
                            "ninety.subscriptions.v1": "[]"
                        });
                        // CI smoke intentionally exercises the portable encrypted
                        // path with an ephemeral in-memory passphrase. Production
                        // portable runs start in NoPersistentSecrets until the
                        // user explicitly configures one from Settings.
                        // Синхронный вариант: setup() не является async-контекстом.
                        backup::state_backup_save_blocking(
                            app.handle().clone(),
                            smoke_snapshot.to_string(),
                        )?;
                        let snapshot = std::fs::read(
                            app_paths::portable_root()?
                                .join("config")
                                .join("state-backup.json"),
                        )?;
                        if !secrets::is_portable_envelope(&snapshot) {
                            return Err("portable state backup is not encrypted envelope".into());
                        }
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
            secrets::portable_secrets_status,
            secrets::portable_secrets_set_passphrase,
            secrets::portable_secrets_clear_passphrase,
            secrets::portable_secrets_confirm_plaintext,
            profile_store::profile_store_status,
            profile_store::profile_store_load,
            profile_store::profile_store_replace,
            profile_store::profile_store_clear,
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
            vpn::verify_runtime_dataplane,
            runtime_ops::begin_frontend_runtime_operation,
            runtime_ops::begin_source_switch_operation,
            runtime_ops::record_frontend_runtime_event,
            runtime_ops::complete_frontend_runtime_operation,
            runtime_ops::cancel_frontend_runtime_operation,
            runtime_ops::runtime_operation_snapshot,
            vpn::plan_bridge_ports,
            vpn::singbox_running,
            vpn::runtime_snapshot,
            vpn::runtime_diagnostic,
            vpn::verify_runtime_endpoint,
            vpn::health_snapshot,
            vpn::xray_status,
            vpn::sidecar_status,
            vpn::vpn_last_error,
            vpn::enable_system_proxy,
            vpn::disable_system_proxy,
            vpn::read_singbox_log,
            vpn::clear_singbox_log,
            vpn::read_log,
            vpn::clear_log,
            vpn::singbox_log_path,
            vpn::open_log_dir,
            subscription::fetch_subscription,
            hwid::device_identity,
            clash::clash_get_proxies,
            clash::clash_get_connections,
            clash::clash_traffic_total,
            clash::clash_test_node,
            clash::clash_test_group,
            clash::clash_select_proxy,
            clash::clash_close_proxy_connections,
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
            netproc::snapshot_network_tcp,
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

#[cfg(test)]
mod tests {
    use super::*;

    // Меню трея нельзя подменять, пока оно открыто: замена рушит показанный
    // popup. Признак «сейчас показывается меню» — эти два бита GUITHREADINFO.
    #[test]
    fn open_menu_is_recognised_by_gui_thread_flags() {
        const GUI_INMENUMODE: u32 = 0x0000_0004;
        const GUI_POPUPMENUMODE: u32 = 0x0000_0010;
        const GUI_CARETBLINKING: u32 = 0x0000_0001;
        assert!(menu_flags_indicate_open(GUI_INMENUMODE));
        assert!(menu_flags_indicate_open(GUI_POPUPMENUMODE));
        assert!(menu_flags_indicate_open(
            GUI_POPUPMENUMODE | GUI_CARETBLINKING
        ));
        assert!(!menu_flags_indicate_open(0));
        assert!(!menu_flags_indicate_open(GUI_CARETBLINKING));
    }

    // Подсказка трея — единственный признак апдейта, который не зависит от
    // OS-уведомлений: на Windows тост молча теряется, если у сборки нет ярлыка
    // с AppUserModelID (портативная копия), и тогда в трее не остаётся ничего.
    #[test]
    fn tooltip_shows_the_pending_update_in_both_states() {
        let labels = TrayLabels::default();
        let idle = tray_tooltip(&labels, false, "proxy", Some("0.2.57"));
        assert!(idle.starts_with(&labels.tip_off));
        assert!(idle.contains("0.2.57"));

        let connected = tray_tooltip(&labels, true, "tun", Some("0.2.57"));
        assert!(connected.contains(&labels.mode_tun));
        assert!(connected.contains("0.2.57"));
    }

    // Подсказка уходит в NOTIFYICONDATAW.szTip: 128 UTF-16 единиц вместе с нулём,
    // хвост Windows срезает молча — и первым теряется номер версии во второй
    // строке. Эти лейблы — фолбэк на случай, когда фронт ещё не прислал свои;
    // тот же предел по всем 15 каталогам проверяет tests/i18n.test.mjs.
    #[test]
    fn tooltip_fits_the_windows_tray_tip_buffer() {
        let labels = TrayLabels::default();
        for mode in ["proxy", "systemProxy", "tun"] {
            let tip = tray_tooltip(&labels, true, mode, Some("99.99.999"));
            let units = tip.encode_utf16().count();
            assert!(units <= 127, "{mode}: {units} UTF-16 единиц — {tip}");
        }
    }

    // Метка апдейта обязана быть видна на самом значке: подсказку и меню
    // пользователь открывает сам, а свёрнутое приложение должно сигналить о
    // новой версии без единого клика.
    #[test]
    fn update_badge_marks_only_the_corner_of_the_icon() {
        let (w, h) = (32u32, 32u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        paint_update_badge(&mut rgba, w, h);

        let px = |x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            (rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])
        };
        // Центр метки — непрозрачный акцент, левый верхний угол не тронут.
        let (r, _, _, a) = px(25, 25);
        assert_eq!(a, 255);
        assert!(r > 200, "ожидали акцентный кружок, получили r={r}");
        assert_eq!(px(0, 0), (0, 0, 0, 0));
        assert_eq!(px(2, 20), (0, 0, 0, 0));
    }

    // Значок без апдейта менять нельзя: иначе метка «залипнет» после установки.
    #[test]
    fn tray_icon_is_badged_only_when_an_update_is_pending() {
        let plain = tray_icon(false, "", false).expect("значок трея встроен в бинарь");
        let badged = tray_icon(false, "", true).expect("значок трея встроен в бинарь");
        assert_eq!(plain.width(), badged.width());
        assert_ne!(plain.rgba(), badged.rgba());
        assert_eq!(plain.rgba(), tray_state_icon(false, "").unwrap().rgba());
    }

    // Буфер меньше метки (или битые размеры) не должен паниковать по индексу.
    #[test]
    fn update_badge_ignores_degenerate_buffers() {
        let mut tiny = vec![0u8; 4 * 4 * 4];
        paint_update_badge(&mut tiny, 4, 4);
        assert!(tiny.iter().all(|b| *b == 0));

        let mut truncated = vec![0u8; 8];
        paint_update_badge(&mut truncated, 32, 32);
        assert!(truncated.iter().all(|b| *b == 0));
    }

    // Один argv-флаг не должен запускать сборочную проверку: она стирает
    // profile store и перезаписывает state backup, а флаг легко попадает в
    // ярлык или .bat.
    #[test]
    fn ci_smoke_needs_both_the_flag_and_the_explicit_environment_opt_in() {
        assert!(ci_smoke_opt_in(true, Some("1")));
        assert!(!ci_smoke_opt_in(true, None));
        assert!(!ci_smoke_opt_in(true, Some("0")));
        assert!(!ci_smoke_opt_in(true, Some("true")));
        assert!(!ci_smoke_opt_in(false, Some("1")));
    }

    #[test]
    fn ci_smoke_never_touches_an_existing_store() {
        let dir = std::env::temp_dir().join(format!(
            "ninety-ci-smoke-guard-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(ci_smoke_state_is_empty_in(&dir));
        for name in CI_SMOKE_PROTECTED_FILES {
            std::fs::write(dir.join(name), b"user data").unwrap();
            assert!(!ci_smoke_state_is_empty_in(&dir), "{name} не защищён");
            std::fs::remove_file(dir.join(name)).unwrap();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tooltip_without_update_keeps_the_plain_state_line() {
        let labels = TrayLabels::default();
        assert_eq!(tray_tooltip(&labels, false, "proxy", None), labels.tip_off);
        assert_eq!(
            tray_tooltip(&labels, true, "systemProxy", None),
            labels.tip_connected.replace("{mode}", &labels.mode_system)
        );
    }
}
