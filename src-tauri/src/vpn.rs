use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::util::MutexExt;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[cfg(target_os = "windows")]
use crate::proxy_win as proxy;
#[cfg(not(target_os = "windows"))]
use crate::proxy_stub as proxy;

/// Снимает ANSI-escape (цветовые SGR и прочие CSI) из строки лога движка.
/// sing-box/xray красят stderr даже в пайп — без этого в .log летят управляющие
/// коды (\x1b[36mINFO\x1b[0m). Чистим у источника: и файл, и in-memory буферы,
/// и death-сообщение получаются без мусора. На фронте есть дублирующий стрип.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            // CSI: ESC '[' … <буква-терминатор>. Прочие ESC-последовательности —
            // просто роняем сам ESC (в логах движков их практически нет).
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

// Спецификация монитор-таска движка (см. spawn_log_monitor). Три движка
// (sing-box / xray / naive|TT) читаются одинаково — writer + кольцо последних
// строк + флаг смерти; различаются лишь баннером, подписью краша и тем, кладём
// ли stdout в кольцо. Раньше этот блок был скопирован трижды.
struct MonitorSpec {
    start_banner: String,
    death_label: String,
    death_suffix: &'static str,
    prefix_stderr: bool, // sing-box метит stderr префиксом «STDERR: »
    ring_stdout: bool,   // класть ли stdout в кольцо диагностики (sing-box — нет)
}

impl MonitorSpec {
    // Мосты xray/naive/TT: и stdout, и stderr — диагностика краша, префикса нет.
    // Строки смерти/маркеры — английские: они уходят в лог-файлы (их шлют в
    // иссуи/саппорт при любом языке UI), юзерский тост локализуется фронтом.
    fn bridge(banner: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            start_banner: banner.into(),
            death_label: label.into(),
            death_suffix: "Last lines:",
            prefix_stderr: false,
            ring_stdout: true,
        }
    }
    // sing-box: stdout — обычный лог, кольцо копит только stderr (ошибки).
    fn core(banner: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            start_banner: banner.into(),
            death_label: label.into(),
            death_suffix: "Last errors:",
            prefix_stderr: true,
            ring_stdout: false,
        }
    }
}

// Кап размера одного лог-файла движка. Логи sing-box/xray при уровне info и
// активном трафике (особенно при DNS-retry-шторме: каждая неудачная резолюция —
// строка) разрастались до сотен МБ (наблюдали singbox.log на 518 МБ). Кап держит
// файл ограниченным: при переполнении обрезаем и продолжаем с маркером. Свежие
// строки для диагностики краша всё равно живут в in-memory кольце (died_flag).
const LOG_CAP_BYTES: u64 = 8 * 1024 * 1024;

// Запись строки в лог с учётом капа. Файл открыт в append-режиме, поэтому при
// переполнении достаточно set_len(0): следующая O_APPEND-запись уйдёт с позиции 0.
fn write_capped(writer: &mut std::fs::File, written: &mut u64, line: &str) {
    if *written > LOG_CAP_BYTES && writer.set_len(0).is_ok() {
        let marker = format!("[log truncated at {} MB cap]\n", LOG_CAP_BYTES / 1024 / 1024);
        let _ = writer.write_all(marker.as_bytes());
        *written = marker.len() as u64;
    }
    if writeln!(writer, "{line}").is_ok() {
        *written += line.len() as u64 + 1;
    }
}

// Монитор процесса-движка: льёт stdout/stderr в файл (если задан), копит
// последние строки в кольце на 40 и при Terminated выставляет died_flag с
// причиной. Один хелпер на все три движка.
fn spawn_log_monitor(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    log_file: Option<PathBuf>,
    died_flag: Arc<Mutex<Option<String>>>,
    spec: MonitorSpec,
) {
    tauri::async_runtime::spawn(async move {
        let mut writer = log_file.as_ref().and_then(|p| {
            // Раздутый с прошлой сессии файл начинаем заново — иначе кап стартовал
            // бы уже переполненным и первую же строку писал бы после обрезки.
            if std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) > LOG_CAP_BYTES {
                let _ = std::fs::write(p, b"");
            }
            std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
        });
        let mut written: u64 = writer
            .as_ref()
            .and_then(|w| w.metadata().ok())
            .map(|m| m.len())
            .unwrap_or(0);
        if let Some(w) = writer.as_mut() {
            write_capped(w, &mut written, &format!("\n{}", spec.start_banner));
        }
        // Кольцо последних строк для death-диагностики. VecDeque, а не Vec:
        // при переполнении срезаем голову за O(1) (pop_front) — Vec::remove(0)
        // сдвигал бы весь буфер на каждую строку сверх кэпа.
        let mut last: VecDeque<String> = VecDeque::with_capacity(40);
        let push = |last: &mut VecDeque<String>, text: String| {
            if last.len() == 40 {
                last.pop_front();
            }
            last.push_back(text);
        };
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                    if let Some(w) = writer.as_mut() {
                        write_capped(w, &mut written, &text);
                    }
                    if spec.ring_stdout {
                        push(&mut last, text);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                    if let Some(w) = writer.as_mut() {
                        if spec.prefix_stderr {
                            write_capped(w, &mut written, &format!("STDERR: {text}"));
                        } else {
                            write_capped(w, &mut written, &text);
                        }
                    }
                    push(&mut last, text);
                }
                CommandEvent::Terminated(payload) => {
                    let msg = format!(
                        "{} died (code {:?}). {}\n{}",
                        spec.death_label,
                        payload.code,
                        spec.death_suffix,
                        last.make_contiguous().join("\n")
                    );
                    if let Some(w) = writer.as_mut() {
                        write_capped(w, &mut written, &msg);
                    }
                    *died_flag.lock_recover() = Some(msg);
                    break;
                }
                _ => {}
            }
        }
    });
}

pub struct SingboxState {
    // Child sing-box (sidecar) для ВСЕХ режимов, включая TUN. В TUN-режиме
    // Ninety запущен elevated (Throne-style), поэтому sing-box-child наследует
    // админ-права и сам поднимает TUN-инбаунд — отдельной службы больше нет.
    child: Mutex<Option<CommandChild>>,
    // xray-core sidecar (two-core): обслуживает xhttp-ноды. Слушает 127.0.0.1;
    // sing-box ходит к нему через loopback socks-мост.
    xray_child: Mutex<Option<CommandChild>>,
    died: Arc<Mutex<Option<String>>>,
    // Причина смерти xray-sidecar (two-core). Ставится монитор-таском xray при
    // Terminated, сбрасывается при start_singbox. Нужен чтобы фронт мог отличить
    // «упал xhttp-мост» (авто-реконнект) от «упал sing-box» (туннель закрыт).
    xray_died: Arc<Mutex<Option<String>>>,
    // Sidecar-клиенты naive / trusttunnel_client (по одному процессу на ноду):
    // каждый поднимает локальный SOCKS5, sing-box ходит к ним loopback-мостом.
    // Список, т.к. этих протоколов в одном источнике может быть несколько.
    sidecars: Mutex<Vec<CommandChild>>,
    // Причина смерти любого sidecar-клиента (naive/TT) — как xray_died, для
    // авто-реконнекта фронтом (sidecar_status).
    sidecar_died: Arc<Mutex<Option<String>>>,
    // Sentinel «запуск идёт»: guard по child ловит только уже присвоенный хэндл,
    // а между проверкой и присвоением у start_singbox секунды await'ов (settle-
    // паузы мостов) — два конкурентных вызова спавнили бы два комплекта ядер,
    // дерущихся за порты.
    starting: AtomicBool,
}

impl Default for SingboxState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            xray_child: Mutex::new(None),
            died: Arc::new(Mutex::new(None)),
            xray_died: Arc::new(Mutex::new(None)),
            sidecars: Mutex::new(Vec::new()),
            sidecar_died: Arc::new(Mutex::new(None)),
            starting: AtomicBool::new(false),
        }
    }
}

// RAII-сброс sentinel'а starting: покрывает все ранние return'ы start_singbox.
struct StartingGuard<'a>(&'a AtomicBool);
impl Drop for StartingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

// Спецификация sidecar-клиента, приходит из фронта (buildConfig.sidecars).
#[derive(serde::Deserialize)]
struct SidecarSpec {
    kind: String, // "naive" | "trusttunnel"
    port: u16,
    config: String,
}

// Финальная обработка конфига перед запуском sing-box (в любом режиме):
//  - инжектим секрет clash-API (см. clash::clash_secret), чтобы 9090 не был
//    доступен любому локальному процессу без авторизации;
//  - принудительно держим external_controller на 127.0.0.1 (даже если фронт
//    зачем-то выставил 0.0.0.0) — управление ядром не должно торчать в сеть.
// При невалидном JSON возвращаем как есть: пусть sing-box сам ругнётся.
fn harden_config(raw: &str) -> String {
    let mut v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return raw.to_string(),
    };
    if let Some(api) = v
        .get_mut("experimental")
        .and_then(|e| e.get_mut("clash_api"))
        .and_then(|a| a.as_object_mut())
    {
        api.insert(
            "secret".into(),
            serde_json::Value::String(crate::clash::clash_secret().to_string()),
        );
        let port = api
            .get("external_controller")
            .and_then(|c| c.as_str())
            .and_then(|s| s.rsplit(':').next())
            .unwrap_or("9090")
            .to_string();
        api.insert(
            "external_controller".into(),
            serde_json::Value::String(format!("127.0.0.1:{port}")),
        );
    }
    serde_json::to_string(&v).unwrap_or_else(|_| raw.to_string())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("singbox-current.json"))
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("singbox.log"))
}

fn xray_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("xray-current.json"))
}

fn xray_log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("xray.log"))
}

// Поднимает xray-core sidecar для xhttp-нод (two-core). Всегда user-level,
// слушает 127.0.0.1; sing-box (свой child или сервис под LocalSystem) ходит
// к нему через loopback socks-мосты из конфига. Spawn до sing-box.
async fn spawn_xray(
    app: &AppHandle,
    state: &SingboxState,
    xray_json: &str,
    logs_disabled: bool,
) -> Result<(), String> {
    let path = xray_config_path(app)?;
    std::fs::write(&path, xray_json).map_err(|e| format!("write xray config: {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("xray")
        .map_err(|e| format!("xray sidecar lookup: {e}"))?;
    let (rx, child) = sidecar
        .args(["run", "-c", &path_str])
        .env("NO_COLOR", "1")
        .spawn()
        .map_err(|e| format!("spawn xray: {e}"))?;
    *state.xray_child.lock_recover() = Some(child);

    let died_flag = state.xray_died.clone();
    // logs_disabled (настройка «Полностью отключить логи») → не пишем файл лога;
    // in-memory last для диагностики краша (died_flag) сохраняем.
    let log_file = if logs_disabled { None } else { xray_log_path(app) };
    spawn_log_monitor(rx, log_file, died_flag, MonitorSpec::bridge("=== xray start ===", "xray"));

    // Дать xray подняться и забиндить socks-инбаунды до старта sing-box,
    // иначе первые urltest'ы xhttp-нод словят connection refused.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    // Fail-fast: умер в settle-паузе (битый конфиг, занятый порт) → фейлим старт
    // с причиной. Раньше старт «удавался», а health-watchdog через 5с находил
    // труп и уходил в реконнект — по кругу, потому что порт так и оставался занят.
    if let Some(err) = state.xray_died.lock_recover().take() {
        return Err(err);
    }
    Ok(())
}

// Поднимает sidecar-клиенты naive / trusttunnel_client (по одному на ноду).
// Каждый слушает локальный SOCKS5 (порт из spec), sing-box ходит к ним мостом.
// User-level (SOCKS-режим TT не требует админ-прав/TUN). Spawn до sing-box.
async fn spawn_sidecars(
    app: &AppHandle,
    state: &SingboxState,
    specs: &[SidecarSpec],
    logs_disabled: bool,
) -> Result<(), String> {
    let cfg_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("mkdir: {e}"))?;
    let log_dir = app.path().app_log_dir().ok();

    for spec in specs {
        // Имя бинаря (externalBin) + аргументы + расширение конфига по типу.
        let (bin, ext, file_arg) = match spec.kind.as_str() {
            "naive" => ("naive", "json", false),               // naive.exe <config.json>
            "trusttunnel" => ("trusttunnel_client", "toml", true), // --config <toml>
            other => return Err(format!("неизвестный sidecar: {other}")),
        };
        let cfg_path = cfg_dir.join(format!("{}-{}.{}", spec.kind, spec.port, ext));
        std::fs::write(&cfg_path, &spec.config)
            .map_err(|e| format!("write {} config: {e}", spec.kind))?;
        let cfg_str = cfg_path.to_string_lossy().to_string();

        let sidecar = app
            .shell()
            .sidecar(bin)
            .map_err(|e| format!("{bin} sidecar lookup: {e}"))?;
        let cmd = if file_arg {
            sidecar.args(["--config", &cfg_str])
        } else {
            sidecar.args([cfg_str.as_str()])
        };
        let (rx, child) = cmd
            .env("NO_COLOR", "1")
            .spawn()
            .map_err(|e| format!("spawn {bin}: {e}"))?;
        state.sidecars.lock_recover().push(child);

        let died_flag = state.sidecar_died.clone();
        let log_file = if logs_disabled {
            None
        } else {
            log_dir.as_ref().map(|d| d.join(format!("{}.log", spec.kind)))
        };
        let label = format!("{} :{}", spec.kind, spec.port);
        spawn_log_monitor(
            rx,
            log_file,
            died_flag,
            MonitorSpec::bridge(format!("=== {label} start ==="), label.clone()),
        );
    }

    if !specs.is_empty() {
        // Дать клиентам забиндить SOCKS до старта sing-box (handshake к endpoint'у
        // у TrustTunnel небыстрый), иначе первые urltest'ы словят refused.
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

        // Fail-fast: клиент умер в settle-паузе → фейлим старт с причиной
        // (см. spawn_xray — иначе health-watchdog зациклился бы на реконнектах).
        if let Some(err) = state.sidecar_died.lock_recover().take() {
            return Err(err);
        }
    }
    Ok(())
}

// Путь к логу sing-box. Лог во всех режимах пишет сам Tauri в app_log_dir
// (sing-box — наш child, его stdout/stderr льётся в файл монитор-таском).
fn resolved_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    log_path(app).ok_or_else(|| "log_dir недоступен".to_string())
}

#[tauri::command]
pub async fn singbox_log_path(app: AppHandle) -> Result<String, String> {
    let p = resolved_log_path(&app)?;
    Ok(p.to_string_lossy().to_string())
}

// Читает хвост файла (последние tail_bytes), отрезая первую обрезанную строку.
// pub(crate): dpi.rs переиспользует для dpi.log вместо чтения файла целиком.
pub(crate) fn read_tail(path: &std::path::Path, tail_bytes: Option<u64>) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let limit = tail_bytes.unwrap_or(128 * 1024);
    let meta = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    let size = meta.len();
    if size <= limit {
        return std::fs::read_to_string(path).map_err(|e| format!("read: {e}"));
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    f.seek(SeekFrom::End(-(limit as i64))).map_err(|e| format!("seek: {e}"))?;
    let mut buf = Vec::with_capacity(limit as usize);
    f.read_to_end(&mut buf).map_err(|e| format!("read_to_end: {e}"))?;
    let text = String::from_utf8_lossy(&buf).to_string();
    let cut = text.find('\n').map(|i| i + 1).unwrap_or(0);
    Ok(format!("…[{} bytes truncated above]…\n{}", size - limit, &text[cut..]))
}

// Файл лога по ключу источника. Все компоненты пишут в app_log_dir.
fn component_log_file(app: &AppHandle, source: &str) -> Option<PathBuf> {
    let name = match source {
        "singbox" => "singbox.log",
        "xray" => "xray.log",
        "naive" => "naive.log",
        "trusttunnel" => "trusttunnel.log",
        "dpi" => "dpi.log",
        _ => return None,
    };
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(name))
}

#[tauri::command]
pub async fn read_singbox_log(
    app: AppHandle,
    tail_bytes: Option<u64>,
) -> Result<String, String> {
    read_tail(&resolved_log_path(&app)?, tail_bytes)
}

// Чтение лога любого компонента (singbox/xray/naive/trusttunnel/dpi).
#[tauri::command]
pub async fn read_log(
    app: AppHandle,
    source: String,
    tail_bytes: Option<u64>,
) -> Result<String, String> {
    let path = component_log_file(&app, &source)
        .ok_or_else(|| format!("неизвестный источник лога: {source}"))?;
    read_tail(&path, tail_bytes)
}

#[tauri::command]
pub async fn clear_singbox_log(app: AppHandle) -> Result<(), String> {
    let Some(path) = log_path(&app) else {
        return Err("log_dir недоступен".into());
    };
    if path.exists() {
        std::fs::write(&path, b"").map_err(|e| format!("truncate: {e}"))?;
    }
    Ok(())
}

// Очистка лога любого компонента.
#[tauri::command]
pub async fn clear_log(app: AppHandle, source: String) -> Result<(), String> {
    let path = component_log_file(&app, &source)
        .ok_or_else(|| format!("неизвестный источник лога: {source}"))?;
    if path.exists() {
        std::fs::write(&path, b"").map_err(|e| format!("truncate: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| format!("app_log_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    #[cfg(target_os = "windows")]
    {
        // Абсолютный путь: explorer.exe лежит в %SystemRoot% (не в System32).
        // Не полагаемся на PATH — открытие логов может идти из elevated-процесса.
        let explorer = std::env::var("SystemRoot")
            .map(|r| format!(r"{r}\explorer.exe"))
            .unwrap_or_else(|_| r"C:\Windows\explorer.exe".into());
        std::process::Command::new(explorer)
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("open: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn start_singbox(
    app: AppHandle,
    state: State<'_, SingboxState>,
    config_json: String,
    mode: String,
    xray_json: Option<String>,
    sidecars_json: Option<String>,
    logs_disabled: Option<bool>,
) -> Result<(), String> {
    let logs_disabled = logs_disabled.unwrap_or(false);
    // Sentinel ДО guard-проверки: второй конкурентный вызов отсекается сразу,
    // даже пока первый висит в settle-паузах мостов (child ещё не присвоен).
    if state.starting.swap(true, Ordering::SeqCst) {
        return Err("запуск уже идёт".into());
    }
    let _starting = StartingGuard(&state.starting);
    {
        let child = state.child.lock_recover();
        if child.is_some() || state.xray_child.lock_recover().is_some() {
            return Err("sing-box уже запущен".into());
        }
        *state.died.lock_recover() = None;
        *state.xray_died.lock_recover() = None;
        *state.sidecar_died.lock_recover() = None;
    }

    // Захардениваем конфиг (секрет clash-API + loopback) до записи/отправки.
    let config_json = harden_config(&config_json);
    let sidecar_specs: Option<Vec<SidecarSpec>> = sidecars_json
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .map(|sj| serde_json::from_str(sj).map_err(|e| format!("sidecars json: {e}")))
        .transpose()?;

    // Two-core: если в конфиге есть xhttp-ноды, поднимаем xray ДО sing-box
    // (в любом режиме). При ошибке спавна — не стартуем VPN вовсе.
    if let Some(xj) = xray_json.as_ref().filter(|s| !s.trim().is_empty()) {
        if let Err(e) = spawn_xray(&app, &state, xj, logs_disabled).await {
            kill_xray(&state);
            return Err(e);
        }
    }

    // Sidecar-клиенты naive / trusttunnel (если такие ноды есть) — тоже ДО sing-box.
    if let Some(specs) = sidecar_specs.as_ref() {
        if let Err(e) = spawn_sidecars(&app, &state, specs, logs_disabled).await {
            kill_xray(&state);
            kill_sidecars(&state);
            return Err(e);
        }
    }

    // Режим (proxy/systemProxy/tun) больше не влияет на запуск ядра в Rust:
    // TUN-инбаунд уже зашит в config_json (buildInbound в singbox.js), а
    // system proxy выставляет фронт отдельной командой. В TUN Ninety обязан
    // быть elevated — это гарантирует JS (is_elevated/relaunch) до вызова.
    let _ = &mode;

    // Всё после поднятия мостов — через одну общую зачистку: ранний `?` здесь
    // оставлял бы xray/naive/TT сиротами при фейле записи конфига или спавна
    // sing-box (креды в их конфигах на диске, занятые порты, а guard
    // xray_child.is_some() блокировал бы следующий старт до явного stop).
    if let Err(e) = spawn_singbox_core(&app, &state, &config_json, logs_disabled).await {
        // kill по уже мёртвому child безвреден (Err игнорируем).
        if let Some(child) = state.child.lock_recover().take() {
            let _ = child.kill();
        }
        kill_xray(&state);
        kill_sidecars(&state);
        return Err(e);
    }

    Ok(())
}

// Запись конфига + спавн sing-box + fail-fast-окно. Вынесено из start_singbox,
// чтобы любой Err отсюда проходил у вызывающего через общую зачистку ядра и
// мостов — сама функция ничего не подчищает.
async fn spawn_singbox_core(
    app: &AppHandle,
    state: &SingboxState,
    config_json: &str,
    logs_disabled: bool,
) -> Result<(), String> {
    let path = config_path(app)?;
    std::fs::write(&path, config_json).map_err(|e| format!("write config: {e}"))?;
    let path_str = path.to_string_lossy().to_string();

    let sidecar = app
        .shell()
        .sidecar("sing-box")
        .map_err(|e| format!("sidecar lookup: {e}"))?;
    let (rx, child) = sidecar
        .args(["run", "-c", &path_str])
        .env("NO_COLOR", "1")
        .spawn()
        .map_err(|e| format!("spawn sing-box: {e}"))?;

    *state.child.lock_recover() = Some(child);

    let died_flag = state.died.clone();
    // sing-box при logs_disabled и так молчит (log.disabled в конфиге), но гасим
    // и файловый writer — единообразно с остальными движками.
    let log_file = if logs_disabled { None } else { log_path(app) };
    spawn_log_monitor(rx, log_file, died_flag, MonitorSpec::core("=== sing-box start ===", "sing-box"));

    // даём sing-box 800мс чтобы упасть с ошибкой парсинга / биндинга
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    if let Some(err) = state.died.lock_recover().take() {
        return Err(err);
    }
    // Мост мог умереть и в эти 800мс (после своей settle-паузы) — тоже fail-fast,
    // иначе health-watchdog найдёт труп через 5с и уйдёт в цикл реконнектов.
    let bridge_err = state
        .xray_died
        .lock_recover()
        .take()
        .or_else(|| state.sidecar_died.lock_recover().take());
    if let Some(err) = bridge_err {
        return Err(err);
    }
    Ok(())
}

fn kill_xray(state: &SingboxState) {
    if let Some(child) = state.xray_child.lock_recover().take() {
        let _ = child.kill();
    }
}

fn kill_sidecars(state: &SingboxState) {
    for child in state.sidecars.lock_recover().drain(..) {
        let _ = child.kill();
    }
}

// Стирает конфиги мостов (naive-*.json, trusttunnel-*.toml) из app_config_dir.
// В них лежат креды нод (user:pass) — не держим их на диске дольше сессии.
// singbox-current.json/xray-current.json НЕ трогаем: это норма клиентов, и
// они перезаписываются при следующем старте.
fn purge_bridge_configs(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if is_bridge_config_name(&name) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn is_bridge_config_name(name: &str) -> bool {
    (name.starts_with("naive-") && name.ends_with(".json"))
        || (name.starts_with("trusttunnel-") && name.ends_with(".toml"))
}

fn is_runtime_config_name(name: &str) -> bool {
    matches!(name, "singbox-current.json" | "xray-current.json") || is_bridge_config_name(name)
}

pub fn purge_stale_runtime_configs(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if is_runtime_config_name(&name) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// Стирает singbox-current.json / xray-current.json из app_config_dir. В них
// UUID/пароли нод и (при активном WARP) приватный WG-ключ — держать их на диске
// дольше сессии незачем: следующий старт всё равно перезапишет файлы заново.
fn purge_current_configs(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    for name in ["singbox-current.json", "xray-current.json"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

// Сбрасывает флаги смерти движков. Без этого причина прошлой смерти жила бы до
// следующего start_singbox (vpn_last_error/*_status отдавали бы устаревшее).
fn clear_death_flags(state: &SingboxState) {
    *state.died.lock_recover() = None;
    *state.xray_died.lock_recover() = None;
    *state.sidecar_died.lock_recover() = None;
}

#[tauri::command]
pub async fn stop_singbox(app: AppHandle, state: State<'_, SingboxState>) -> Result<(), String> {
    let taken = state.child.lock_recover().take();
    if let Some(child) = taken {
        // child.kill() гасит sing-box; wintun-адаптер (non-persistent) снимается
        // системой вместе со смертью процесса, державшего его — отдельная чистка
        // TUN-интерфейса не нужна.
        let _ = child.kill();
    }
    kill_xray(&state);
    kill_sidecars(&state);
    purge_bridge_configs(&app);
    purge_current_configs(&app);
    clear_death_flags(&state);
    Ok(())
}

// Внутренние вычисления статусов — переиспользуются одиночными командами и
// агрегатом health_snapshot (один IPC-роунд-трип для watchdog'а вместо четырёх).
fn compute_singbox_running(state: &SingboxState) -> bool {
    if state.child.lock_recover().is_some() {
        // Хэндл child не чистится при смерти процесса — монитор-таск лишь
        // выставляет died. Без этой проверки singbox_running возвращал бы true
        // вечно после краша ядра (UI держит «Защищено», прокси указывает на
        // мёртвый порт, трафик в чёрную дыру). Труп живым не считаем.
        return state.died.lock_recover().is_none();
    }
    false
}

fn compute_xray_status(state: &SingboxState) -> &'static str {
    if state.xray_child.lock_recover().is_none() {
        return "none";
    }
    if state.xray_died.lock_recover().is_some() {
        "died"
    } else {
        "alive"
    }
}

fn compute_sidecar_status(state: &SingboxState) -> &'static str {
    if state.sidecars.lock_recover().is_empty() {
        return "none";
    }
    if state.sidecar_died.lock_recover().is_some() {
        "died"
    } else {
        "alive"
    }
}

fn compute_last_error(state: &SingboxState) -> Option<String> {
    if let Some(e) = state.died.lock_recover().clone() {
        return Some(e);
    }
    if let Some(e) = state.xray_died.lock_recover().clone() {
        return Some(e);
    }
    state.sidecar_died.lock_recover().clone()
}

#[tauri::command]
pub fn singbox_running(state: State<'_, SingboxState>) -> bool {
    compute_singbox_running(&state)
}

// Агрегат статусов ядер за один вызов — watchdog фронта раньше дёргал
// singbox_running / xray_status / sidecar_status / vpn_last_error четырьмя
// отдельными invoke на каждом тике (раз в 5с всю сессию). last_error читаем
// всегда: фронт использует его только при singbox_running=false, но лишний
// clone дешевле второго round-trip'а.
#[derive(serde::Serialize)]
pub struct HealthSnapshot {
    pub singbox_running: bool,
    pub xray: &'static str,
    pub sidecar: &'static str,
    pub last_error: Option<String>,
}

#[tauri::command]
pub fn health_snapshot(state: State<'_, SingboxState>) -> HealthSnapshot {
    HealthSnapshot {
        singbox_running: compute_singbox_running(&state),
        xray: compute_xray_status(&state),
        sidecar: compute_sidecar_status(&state),
        last_error: compute_last_error(&state),
    }
}

#[tauri::command]
pub async fn set_system_proxy(
    enable: bool,
    host_port: Option<String>,
    bypass_lan: Option<bool>,
) -> Result<(), String> {
    proxy::set_system_proxy(enable, host_port.as_deref(), bypass_lan)
}

pub fn recover_stale_system_proxy() -> Result<(), String> {
    proxy::recover_stale_system_proxy()
}

// Статус xray-sidecar (two-core) для health-watchdog'а фронта:
//   "none"  — xray не спавнился (xhttp-нод в активном конфиге нет);
//   "alive" — поднят и не падал;
//   "died"  — был поднят, но процесс завершился (xhttp-мост мёртв).
// child-хэндл при смерти не чистится, поэтому различаем по флагу xray_died.
#[tauri::command]
pub fn xray_status(state: State<'_, SingboxState>) -> &'static str {
    compute_xray_status(&state)
}

// Статус sidecar-клиентов naive/TT для health-watchdog'а (аналог xray_status):
//   "none"  — sidecar'ов не поднимали (таких нод в конфиге нет);
//   "alive" — подняты и не падали;
//   "died"  — хотя бы один клиент завершился (мост мёртв → реконнект).
#[tauri::command]
pub fn sidecar_status(state: State<'_, SingboxState>) -> &'static str {
    compute_sidecar_status(&state)
}

// Последняя причина смерти ядра (sing-box приоритетнее xray/sidecar) — для тоста.
#[tauri::command]
pub fn vpn_last_error(state: State<'_, SingboxState>) -> Option<String> {
    compute_last_error(&state)
}

pub fn force_cleanup(app: &AppHandle, state: &SingboxState) {
    if let Some(child) = state.child.lock_recover().take() {
        let _ = child.kill();
    }
    kill_xray(state);
    kill_sidecars(state);
    purge_bridge_configs(app);
    purge_current_configs(app);
    clear_death_flags(state);
    #[cfg(target_os = "windows")]
    let _ = proxy::set_system_proxy(false, None, None);
}

// ── Планирование портов loopback-мостов ─────────────────────
// Статические базы (31100/31200/31300 в singbox.js) может занять чужой процесс —
// тогда мост умирал бы на bind'е. Фронт перед buildConfig присылает, сколько
// портов нужно каждому семейству; подбираем первый диапазон, где все порты
// свободны (bind-проба на 127.0.0.1). Диапазоны семейств не пересекаются.
// TOCTOU-окно (порт займут между пробой и spawn'ом) закрывает fail-fast в
// start_singbox — но проба убирает детерминированные конфликты.

#[derive(serde::Deserialize)]
pub struct BridgeNeeds {
    #[serde(default)]
    xray: u16,
    #[serde(default)]
    naive: u16,
    #[serde(default)]
    trusttunnel: u16,
}

#[derive(serde::Serialize)]
pub struct BridgePorts {
    xray: u16,
    naive: u16,
    trusttunnel: u16,
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

// Первая база >= start, дающая `count` подряд свободных портов вне занятых
// диапазонов. При count=0 порты не нужны — возвращаем дефолт без резервирования.
fn find_free_base(start: u16, count: u16, taken: &mut Vec<(u16, u16)>) -> Result<u16, String> {
    if count == 0 {
        return Ok(start);
    }
    let mut base = start;
    // Верхняя граница поиска с запасом; портов нужны единицы, не упрёмся.
    while u32::from(base) + u32::from(count) <= 65535 && base < start.saturating_add(2000) {
        let end = base + count;
        let overlaps = taken.iter().any(|&(s, e)| base < e && s < end);
        if !overlaps && (base..end).all(port_free) {
            taken.push((base, end));
            return Ok(base);
        }
        base += 1;
    }
    Err(format!("нет свободных портов для мостов (искали от {start})"))
}

#[tauri::command]
pub async fn plan_bridge_ports(needs: BridgeNeeds) -> Result<BridgePorts, String> {
    let mut taken: Vec<(u16, u16)> = Vec::new();
    let xray = find_free_base(31100, needs.xray, &mut taken)?;
    let naive = find_free_base(31200, needs.naive, &mut taken)?;
    let trusttunnel = find_free_base(31300, needs.trusttunnel, &mut taken)?;
    Ok(BridgePorts { xray, naive, trusttunnel })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_sgr() {
        assert_eq!(strip_ansi("\x1b[36mINFO\x1b[0m text"), "INFO text");
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi(""), "");
        // ESC без CSI просто выпадает
        assert_eq!(strip_ansi("a\x1bZb"), "aZb");
    }

    #[test]
    fn harden_config_injects_secret_and_loopback() {
        let raw = r#"{"experimental":{"clash_api":{"external_controller":"0.0.0.0:9090"}}}"#;
        let out = harden_config(raw);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let api = &v["experimental"]["clash_api"];
        assert_eq!(api["external_controller"], "127.0.0.1:9090");
        let secret = api["secret"].as_str().unwrap();
        assert_eq!(secret.len(), 32); // 16 байт hex
    }

    #[test]
    fn harden_config_passes_invalid_json_through() {
        assert_eq!(harden_config("not json"), "not json");
    }

    #[test]
    fn runtime_config_matcher_only_targets_ephemeral_files() {
        for name in [
            "singbox-current.json",
            "xray-current.json",
            "naive-31110.json",
            "trusttunnel-31120.toml",
        ] {
            assert!(is_runtime_config_name(name), "{name} должен чиститься");
        }
        for name in [
            "config.json",
            "warp.json",
            "singbox-current.json.bak",
            "naive-profile.txt",
            "trusttunnel-backup.toml.bak",
        ] {
            assert!(!is_runtime_config_name(name), "{name} нельзя чистить");
        }
    }

    #[test]
    fn find_free_base_skips_taken_ranges() {
        let mut taken = vec![(41100u16, 41102u16)];
        let base = find_free_base(41100, 2, &mut taken).unwrap();
        assert!(base >= 41102, "диапазон не должен пересечь занятый: {base}");
        // count=0 → дефолт без резервирования
        let before = taken.len();
        assert_eq!(find_free_base(41200, 0, &mut taken).unwrap(), 41200);
        assert_eq!(taken.len(), before);
    }

    #[test]
    fn find_free_base_skips_bound_port() {
        // Реально займём порт (первый свободный в тихом диапазоне) и убедимся,
        // что база сдвинулась за него.
        let mut held = None;
        for p in 42000u16..43000 {
            if let Ok(l) = std::net::TcpListener::bind(("127.0.0.1", p)) {
                held = Some((p, l));
                break;
            }
        }
        let (busy, _l) = held.expect("нет свободного порта в 42000..43000");
        let mut taken = Vec::new();
        let base = find_free_base(busy, 1, &mut taken).unwrap();
        assert!(base > busy, "base={base} должен быть за занятым {busy}");
    }
}
