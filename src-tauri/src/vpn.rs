use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

use crate::runtime_ops::{
    DataplaneProbeCoordinator, DataplaneProbeKind, ProbeAcquireError, RuntimeOperationCoordinator,
    RuntimeOperationKind, RuntimeOperationToken,
};
use crate::util::MutexExt;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[cfg(not(target_os = "windows"))]
use crate::proxy_stub as proxy;
#[cfg(target_os = "windows")]
use crate::proxy_win as proxy;

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

struct MonitorGeneration {
    current: Arc<AtomicU64>,
    expected_exit: Arc<AtomicU64>,
    value: u64,
}

fn monitor_exit_expected(
    current_generation: u64,
    expected_exit_generation: u64,
    monitor_generation: u64,
) -> bool {
    expected_exit_generation == monitor_generation || current_generation != monitor_generation
}

// Кап размера одного лог-файла движка. Логи sing-box/xray при уровне info и
// активном трафике (особенно при DNS-retry-шторме: каждая неудачная резолюция —
// строка) разрастались до сотен МБ (наблюдали singbox.log на 518 МБ). Кап держит
// файл ограниченным: при переполнении обрезаем и продолжаем с маркером. Свежие
// строки для диагностики краша всё равно живут в in-memory кольце (died_flag).
const LOG_CAP_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_LOG_TAIL_BYTES: u64 = 128 * 1024;
const MAX_LOG_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SIDECAR_LOG_FILES: usize = 16;

// Запись строки в лог с учётом капа. Файл открыт в append-режиме, поэтому при
// переполнении достаточно set_len(0): следующая O_APPEND-запись уйдёт с позиции 0.
fn write_capped(writer: &mut std::fs::File, written: &mut u64, line: &str) {
    if *written > LOG_CAP_BYTES && writer.set_len(0).is_ok() {
        let marker = format!(
            "[log truncated at {} MB cap]\n",
            LOG_CAP_BYTES / 1024 / 1024
        );
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
    live_processes: Arc<AtomicU64>,
    process_exit_notify: Arc<Notify>,
    generation: MonitorGeneration,
    spec: MonitorSpec,
) {
    live_processes.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let mut writer = log_file.as_ref().and_then(|p| {
            // Раздутый с прошлой сессии файл начинаем заново — иначе кап стартовал
            // бы уже переполненным и первую же строку писал бы после обрезки.
            if std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) > LOG_CAP_BYTES {
                let _ = std::fs::write(p, b"");
            }
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
                .ok()
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
                    let current_generation = generation.current.load(Ordering::SeqCst);
                    let expected = monitor_exit_expected(
                        current_generation,
                        generation.expected_exit.load(Ordering::SeqCst),
                        generation.value,
                    );
                    let msg = if expected {
                        format!(
                            "{} stopped (code {:?}, generation {}).",
                            spec.death_label, payload.code, generation.value
                        )
                    } else {
                        format!(
                            "{} died (code {:?}, generation {}). {}\n{}",
                            spec.death_label,
                            payload.code,
                            generation.value,
                            spec.death_suffix,
                            last.make_contiguous().join("\n")
                        )
                    };
                    if let Some(w) = writer.as_mut() {
                        write_capped(w, &mut written, &msg);
                    }
                    // Terminated старого комплекта может прийти уже после
                    // быстрого stop и старта нового. Не позволяем запоздалому
                    // событию пометить новое ядро умершим.
                    if !expected && current_generation == generation.value {
                        *died_flag.lock_recover() = Some(msg);
                    }
                    live_processes.fetch_sub(1, Ordering::SeqCst);
                    process_exit_notify.notify_waiters();
                    break;
                }
                _ => {}
            }
        }
        // Без Terminated нет формального подтверждения завершения процесса
        // (например, wait() мог вернуть ошибку). Оставляем счётчик живым:
        // stop_singbox вернёт processesExited=false и UI уйдёт в cleanup_error,
        // а не объявит физически не подтверждённый child остановленным.
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
    stopping: AtomicBool,
    lifecycle_gate: Mutex<()>,
    // Stop-вызовы сериализуются: второй клик не должен одновременно забирать
    // уже вынутые child-хэндлы и объявлять runtime остановленным.
    stop_lock: tokio::sync::Mutex<()>,
    process_generation: Arc<AtomicU64>,
    // stop инкрементит поколение до kill: уже выполняющийся start после
    // ближайшего await не имеет права поднять новый child поверх disconnect.
    start_epoch: AtomicU64,
    runtime: Mutex<Option<RuntimeRecord>>,
    runtime_ports: Mutex<Vec<u16>>,
    // После неподтверждённого stop сохраняем identity процессов и порты.
    // Следующий stop повторяет очистку, а start не имеет права затереть runtime.
    pending_cleanup: Mutex<Option<PendingCleanup>>,
    live_processes: Arc<AtomicU64>,
    process_exit_notify: Arc<Notify>,
    expected_exit_generation: Arc<AtomicU64>,
    pub(crate) dataplane_probe: Arc<DataplaneProbeCoordinator>,
}

pub(crate) fn active_runtime_generation(state: &SingboxState) -> Result<u64, String> {
    let child_running = state.child.lock_recover().is_some();
    let generation = state
        .runtime
        .lock_recover()
        .as_ref()
        .map(|runtime| runtime.process_generation)
        .unwrap_or(0);
    if child_running && generation == 0 {
        return Err("running runtime has no published generation".into());
    }
    Ok(if child_running { generation } else { 0 })
}

#[derive(Clone)]
struct RuntimeRecord {
    process_generation: u64,
    source_fingerprint: Option<String>,
    config_hash: Option<String>,
    mode: String,
    strict_privacy: bool,
    pinned_node_tag: Option<String>,
    logs_disabled: bool,
    endpoints: RuntimeEndpoints,
    listener_ready: bool,
    clash_port: u16,
    clash_ready: bool,
}

/// Control and dataplane addresses are intentionally different types.  A
/// caller that has a ControlEndpoint cannot accidentally pass it to the HTTP
/// proxy builder, and vice versa.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlEndpoint {
    pub(crate) address: std::net::SocketAddr,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeProxyEndpoint {
    pub(crate) address: std::net::SocketAddr,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeEndpoints {
    pub(crate) control: ControlEndpoint,
    pub(crate) probe_proxy: Option<ProbeProxyEndpoint>,
}

#[derive(Clone)]
struct RuntimeLaunchSpec {
    config_json: String,
    mode: String,
    xray_json: Option<String>,
    sidecars_json: Option<String>,
    logs_disabled: bool,
    source_fingerprint: Option<String>,
    config_hash: Option<String>,
    strict_privacy: bool,
    pinned_node_tag: Option<String>,
}

#[derive(Clone, Default)]
struct PendingCleanup {
    processes: Vec<TrackedProcess>,
    ports: Vec<u16>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TrackedProcess {
    pid: u32,
    // Windows может переиспользовать PID после завершения процесса. Creation
    // time отличает исходный process object от нового процесса с тем же PID.
    creation_time: Option<u64>,
}

fn cleanup_targets(
    runtime_ports: &[u16],
    pending: PendingCleanup,
) -> (Vec<u16>, Vec<TrackedProcess>) {
    let mut ports = runtime_ports.to_vec();
    ports.extend(pending.ports);
    ports.sort_unstable();
    ports.dedup();
    let mut processes = pending.processes;
    processes.sort_unstable_by_key(|process| process.pid);
    processes.dedup_by_key(|process| process.pid);
    (ports, processes)
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
            stopping: AtomicBool::new(false),
            lifecycle_gate: Mutex::new(()),
            stop_lock: tokio::sync::Mutex::new(()),
            process_generation: Arc::new(AtomicU64::new(0)),
            start_epoch: AtomicU64::new(0),
            runtime: Mutex::new(None),
            runtime_ports: Mutex::new(Vec::new()),
            pending_cleanup: Mutex::new(None),
            live_processes: Arc::new(AtomicU64::new(0)),
            process_exit_notify: Arc::new(Notify::new()),
            expected_exit_generation: Arc::new(AtomicU64::new(0)),
            dataplane_probe: Arc::new(DataplaneProbeCoordinator::default()),
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

struct StoppingGuard<'a>(&'a AtomicBool);
impl Drop for StoppingGuard<'_> {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SidecarLogKind {
    Naive,
    TrustTunnel,
}

impl SidecarLogKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "naive" => Some(Self::Naive),
            "trusttunnel" => Some(Self::TrustTunnel),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Naive => "naive",
            Self::TrustTunnel => "trusttunnel",
        }
    }
}

fn sidecar_log_name(kind: SidecarLogKind, port: u16) -> String {
    format!("{}-{port}.log", kind.as_str())
}

fn sidecar_log_port(name: &str, kind: SidecarLogKind) -> Option<u16> {
    let port = name
        .strip_prefix(&format!("{}-", kind.as_str()))?
        .strip_suffix(".log")?;
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}

fn is_sidecar_log_name(name: &str, kind: SidecarLogKind) -> bool {
    name == format!("{}.log", kind.as_str()) || sidecar_log_port(name, kind).is_some()
}

fn sidecar_log_entries(dir: &std::path::Path, kind: SidecarLogKind) -> Vec<std::fs::DirEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            entry.file_type().map(|t| t.is_file()).unwrap_or(false)
                && is_sidecar_log_name(&entry.file_name().to_string_lossy(), kind)
        })
        .collect()
}

fn prune_sidecar_logs(dir: &std::path::Path, kind: SidecarLogKind, protected: &HashSet<String>) {
    let mut entries = sidecar_log_entries(dir, kind);
    if entries.len().saturating_add(protected.len()) <= MAX_SIDECAR_LOG_FILES {
        return;
    }
    entries.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    let keep_existing = MAX_SIDECAR_LOG_FILES.saturating_sub(protected.len());
    let removable = entries
        .iter()
        .filter(|entry| !protected.contains(&entry.file_name().to_string_lossy().into_owned()))
        .count()
        .saturating_sub(keep_existing);
    for entry in entries
        .into_iter()
        .filter(|entry| !protected.contains(&entry.file_name().to_string_lossy().into_owned()))
        .take(removable)
    {
        let _ = std::fs::remove_file(entry.path());
    }
}

// Финальная обработка конфига перед запуском sing-box (в любом режиме):
//  - инжектим секрет clash-API (см. clash::clash_secret), чтобы 9090 не был
//    доступен любому локальному процессу без авторизации;
//  - принудительно держим external_controller на 127.0.0.1 (даже если фронт
//    зачем-то выставил 0.0.0.0) — управление ядром не должно торчать в сеть.
// При невалидном JSON возвращаем как есть: пусть sing-box сам ругнётся.
fn harden_config(raw: &str, cache_path: Option<&Path>) -> String {
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
    if let Some(cache_path) = cache_path {
        if let Some(root) = v.as_object_mut() {
            let experimental = root
                .entry("experimental")
                .or_insert_with(|| serde_json::json!({}));
            if !experimental.is_object() {
                *experimental = serde_json::json!({});
            }
            let experimental = experimental
                .as_object_mut()
                .expect("experimental object was just initialized");
            let cache_file = experimental
                .entry("cache_file")
                .or_insert_with(|| serde_json::json!({}));
            if !cache_file.is_object() {
                *cache_file = serde_json::json!({});
            }
            cache_file
                .as_object_mut()
                .expect("cache_file object was just initialized")
                .insert(
                    "path".into(),
                    serde_json::Value::String(cache_path.to_string_lossy().into_owned()),
                );
        }
    }
    serde_json::to_string(&v).unwrap_or_else(|_| raw.to_string())
}

fn singbox_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::data_dir(app)?.join("singbox");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir singbox data: {e}"))?;
    Ok(dir.join("cache.db"))
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("singbox-current.json"))
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::app_paths::log_dir(app).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("singbox.log"))
}

// Короткие безопасные lifecycle-записи из health controller должны попадать в
// тот же журнал, который пользователь видит в UI. Здесь нет URL, IP, конфигов
// или имён нод — только поколение, состояние и фиксированный reason-code.
pub(crate) fn append_runtime_diagnostic(app: &AppHandle, line: &str) {
    let Some(path) = log_path(app) else {
        return;
    };
    let bounded: String = line
        .chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .take(512)
        .collect();
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{bounded}");
    }
}

fn xray_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("xray-current.json"))
}

fn xray_log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::app_paths::log_dir(app).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("xray.log"))
}

// При высокой загрузке Windows не гарантирует, что userspace datapath будет
// получать CPU вовремя. Поднимаем только критичные сетевые children до
// ABOVE_NORMAL: HIGH/REALTIME намеренно не используем, чтобы не превращать
// Ninety в источник starvation для всей системы.
// Поднимает xray-core sidecar для xhttp-нод (two-core). Всегда user-level,
// слушает 127.0.0.1; sing-box (свой child или сервис под LocalSystem) ходит
// к нему через loopback socks-мосты из конфига. Spawn до sing-box.
async fn spawn_xray(
    app: &AppHandle,
    state: &SingboxState,
    xray_json: &str,
    logs_disabled: bool,
    start_epoch: u64,
    process_generation: u64,
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
    let log_file = if logs_disabled {
        None
    } else {
        xray_log_path(app)
    };
    spawn_log_monitor(
        rx,
        log_file,
        died_flag,
        state.live_processes.clone(),
        state.process_exit_notify.clone(),
        MonitorGeneration {
            current: state.process_generation.clone(),
            expected_exit: state.expected_exit_generation.clone(),
            value: process_generation,
        },
        MonitorSpec::bridge(
            format!("=== xray start · generation {process_generation} ==="),
            "xray",
        ),
    );

    // Дать xray подняться и забиндить socks-инбаунды до старта sing-box,
    // иначе первые urltest'ы xhttp-нод словят connection refused.
    wait_start_delay(state, start_epoch, std::time::Duration::from_millis(400)).await?;

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
    start_epoch: u64,
    process_generation: u64,
) -> Result<(), String> {
    let cfg_dir = crate::app_paths::config_dir(app)?;
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("mkdir: {e}"))?;
    let log_dir = crate::app_paths::log_dir(app).ok();

    let mut planned_logs: HashSet<String> = HashSet::new();
    for spec in specs {
        let kind = SidecarLogKind::parse(&spec.kind)
            .ok_or_else(|| format!("неизвестный sidecar: {}", spec.kind))?;
        let name = sidecar_log_name(kind, spec.port);
        if !planned_logs.insert(name) {
            return Err(format!(
                "дублирующийся {} sidecar на порту {}",
                spec.kind, spec.port
            ));
        }
    }
    for kind in [SidecarLogKind::Naive, SidecarLogKind::TrustTunnel] {
        let protected: HashSet<String> = planned_logs
            .iter()
            .filter(|name| sidecar_log_port(name, kind).is_some())
            .cloned()
            .collect();
        if protected.len() > MAX_SIDECAR_LOG_FILES {
            return Err(format!(
                "слишком много {} sidecar: максимум {MAX_SIDECAR_LOG_FILES}",
                kind.as_str()
            ));
        }
        if let Some(dir) = log_dir.as_ref() {
            prune_sidecar_logs(dir, kind, &protected);
        }
    }

    for spec in specs {
        // Имя бинаря (externalBin) + аргументы + расширение конфига по типу.
        let (bin, ext, file_arg) = match spec.kind.as_str() {
            "naive" => ("naive", "json", false), // naive.exe <config.json>
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
            let kind = SidecarLogKind::parse(&spec.kind)
                .ok_or_else(|| format!("неизвестный sidecar: {}", spec.kind))?;
            log_dir
                .as_ref()
                .map(|d| d.join(sidecar_log_name(kind, spec.port)))
        };
        let label = format!("{} :{}", spec.kind, spec.port);
        spawn_log_monitor(
            rx,
            log_file,
            died_flag,
            state.live_processes.clone(),
            state.process_exit_notify.clone(),
            MonitorGeneration {
                current: state.process_generation.clone(),
                expected_exit: state.expected_exit_generation.clone(),
                value: process_generation,
            },
            MonitorSpec::bridge(
                format!("=== {label} start · generation {process_generation} ==="),
                label.clone(),
            ),
        );
    }

    if !specs.is_empty() {
        // Дать клиентам забиндить SOCKS до старта sing-box (handshake к endpoint'у
        // у TrustTunnel небыстрый), иначе первые urltest'ы словят refused.
        wait_start_delay(state, start_epoch, std::time::Duration::from_millis(1200)).await?;

        // Fail-fast: клиент умер в settle-паузе → фейлим старт с причиной
        // (см. spawn_xray — иначе health-watchdog зациклился бы на реконнектах).
        if let Some(err) = state.sidecar_died.lock_recover().take() {
            return Err(err);
        }
    }
    Ok(())
}

// Путь к логу sing-box. Лог во всех режимах пишет сам Tauri в writable log dir
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
fn normalized_log_tail_bytes(tail_bytes: Option<u64>) -> u64 {
    tail_bytes
        .unwrap_or(DEFAULT_LOG_TAIL_BYTES)
        .min(MAX_LOG_TAIL_BYTES)
}

pub(crate) fn read_tail(path: &std::path::Path, tail_bytes: Option<u64>) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let limit = normalized_log_tail_bytes(tail_bytes);
    if limit == 0 {
        return Ok(String::new());
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    let size = meta.len();
    if size <= limit {
        use std::io::Read;
        let f = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
        let mut bytes = Vec::with_capacity(size.min(limit) as usize);
        f.take(limit)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read_to_end: {e}"))?;
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    let start = size - limit;
    f.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek: {e}"))?;
    let mut buf = Vec::with_capacity(limit as usize);
    f.take(limit)
        .read_to_end(&mut buf)
        .map_err(|e| format!("read_to_end: {e}"))?;
    let utf8_skip = buf
        .iter()
        .take(3)
        .take_while(|b| (**b & 0b1100_0000) == 0b1000_0000)
        .count();
    let buf = &buf[utf8_skip..];
    let text = String::from_utf8_lossy(buf).to_string();
    let cut = text.find('\n').map(|i| i + 1).unwrap_or(0);
    Ok(format!(
        "…[{} bytes truncated above]…\n{}",
        start + utf8_skip as u64 + cut as u64,
        &text[cut..]
    ))
}

// Файлы лога по ключу источника. Для naive/TrustTunnel возвращается удобный
// агрегированный список отдельных процессов плюс legacy-файл старых версий.
fn component_log_files(dir: &std::path::Path, source: &str) -> Result<Vec<PathBuf>, String> {
    let single = match source {
        "singbox" => Some("singbox.log"),
        "xray" => Some("xray.log"),
        "dpi" => Some("dpi.log"),
        "naive" | "trusttunnel" => None,
        _ => return Err(format!("неизвестный источник лога: {source}")),
    };
    if let Some(name) = single {
        return Ok(vec![dir.join(name)]);
    }
    let kind = SidecarLogKind::parse(source)
        .ok_or_else(|| format!("неизвестный источник лога: {source}"))?;
    let mut entries = sidecar_log_entries(dir, kind);
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries.into_iter().map(|entry| entry.path()).collect())
}

fn read_log_files(paths: &[PathBuf], tail_bytes: Option<u64>) -> Result<String, String> {
    let limit = normalized_log_tail_bytes(tail_bytes);
    if limit == 0 || paths.is_empty() {
        return Ok(String::new());
    }
    let visible = paths.len().min(MAX_SIDECAR_LOG_FILES);
    let per_file = (limit / visible as u64).max(1);
    let mut chunks = Vec::new();
    for path in paths.iter().take(visible) {
        let text = read_tail(path, Some(per_file))?;
        if text.is_empty() {
            continue;
        }
        let label = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("sidecar.log");
        chunks.push(format!("=== {label} ===\n{text}"));
    }
    Ok(chunks.join("\n"))
}

fn clear_log_files(paths: &[PathBuf]) -> Result<(), String> {
    for path in paths {
        if path.exists() {
            std::fs::write(path, b"").map_err(|e| format!("truncate {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn read_singbox_log(app: AppHandle, tail_bytes: Option<u64>) -> Result<String, String> {
    read_tail(&resolved_log_path(&app)?, tail_bytes)
}

// Чтение лога любого компонента (singbox/xray/naive/trusttunnel/dpi).
#[tauri::command]
pub async fn read_log(
    app: AppHandle,
    source: String,
    tail_bytes: Option<u64>,
) -> Result<String, String> {
    let dir = crate::app_paths::log_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let paths = component_log_files(&dir, &source)?;
    read_log_files(&paths, tail_bytes)
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
    let dir = crate::app_paths::log_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let paths = component_log_files(&dir, &source)?;
    clear_log_files(&paths)
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let dir = crate::app_paths::log_dir(&app)?;
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    running: bool,
    starting: bool,
    process_generation: u64,
    source_fingerprint: Option<String>,
    config_hash: Option<String>,
    mode: Option<String>,
    strict_privacy: bool,
    pinned_node_tag: Option<String>,
    control_endpoint: Option<ControlEndpoint>,
    probe_proxy_endpoint: Option<ProbeProxyEndpoint>,
    listener_ready: bool,
    clash_port: u16,
    clash_ready: bool,
    proxy_enable: bool,
    proxy_server: Option<String>,
    notification_generation: u64,
    notification_applied_generation: u64,
    runtime_diagnostic: RuntimeDiagnostic,
    sidecars: serde_json::Value,
    system_proxy_ownership: &'static str,
    kill_switch_active: bool,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostic {
    pub mode: Option<String>,
    pub generation: u64,
    pub configured_endpoint: Option<String>,
    pub published_endpoint: Option<String>,
    pub listener_ready: bool,
    pub proxy_enable: bool,
    pub proxy_server: Option<String>,
    pub notification_generation: u64,
    pub notification_applied_generation: u64,
}

#[derive(Clone, Default)]
pub(crate) struct NativeRuntimeStatus {
    pub running: bool,
    pub xray_alive: bool,
    pub sidecars_alive: bool,
    pub clash_ready: bool,
    pub control_endpoint: Option<ControlEndpoint>,
    pub probe_proxy_endpoint: Option<ProbeProxyEndpoint>,
}

fn parse_endpoint_address(
    raw: &str,
    configured_port: Option<u16>,
    label: &str,
) -> Result<std::net::SocketAddr, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(format!("{label} address is empty"));
    }
    let address = if let Ok(address) = raw.parse::<std::net::SocketAddr>() {
        if let Some(port) = configured_port {
            if port == 0 || address.port() != port {
                return Err(format!("{label} address/port mismatch"));
            }
        }
        address
    } else {
        let ip = raw
            .parse::<std::net::IpAddr>()
            .map_err(|_| format!("{label} address is not a numeric IP address"))?;
        let port = configured_port.ok_or_else(|| format!("{label} port is missing"))?;
        if port == 0 {
            return Err(format!("{label} port must be non-zero"));
        }
        std::net::SocketAddr::new(ip, port)
    };
    if address.port() == 0 {
        return Err(format!("{label} port must be non-zero"));
    }
    Ok(address)
}

fn runtime_endpoints_from_value(value: &serde_json::Value) -> Result<RuntimeEndpoints, String> {
    let control_raw = value
        .pointer("/experimental/clash_api/external_controller")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Clash control endpoint is not configured".to_string())?;
    let control = parse_endpoint_address(control_raw, None, "Clash control endpoint")?;
    if !control.ip().is_loopback() {
        return Err("Clash control endpoint must be loopback".into());
    }

    let selected = value
        .get("inbounds")
        .and_then(|v| v.as_array())
        .and_then(|inbounds| {
            inbounds
                .iter()
                .find(|inbound| inbound.get("tag").and_then(|v| v.as_str()) == Some("probe-in"))
                .or_else(|| {
                    inbounds.iter().find(|inbound| {
                        inbound.get("tag").and_then(|v| v.as_str()) == Some("mixed-in")
                    })
                })
        });
    let probe_proxy = if let Some(inbound) = selected {
        if !matches!(
            inbound.get("type").and_then(|v| v.as_str()),
            Some("mixed") | Some("http")
        ) {
            return Err("probe inbound must use the mixed or http protocol".into());
        }
        let listen = inbound
            .get("listen")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "probe inbound listen address is missing".to_string())?;
        let listen_port = inbound
            .get("listen_port")
            .and_then(|v| v.as_u64())
            .and_then(|port| u16::try_from(port).ok())
            .ok_or_else(|| "probe inbound listen port is invalid".to_string())?;
        let address = parse_endpoint_address(listen, Some(listen_port), "probe endpoint")?;
        if !(address.ip().is_loopback() || address.ip().is_unspecified()) {
            return Err("probe endpoint must be loopback or unspecified".into());
        }
        let address = if address.ip().is_unspecified() {
            match address {
                std::net::SocketAddr::V4(_) => std::net::SocketAddr::new(
                    std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                    address.port(),
                ),
                std::net::SocketAddr::V6(_) => std::net::SocketAddr::new(
                    std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
                    address.port(),
                ),
            }
        } else {
            address
        };
        Some(ProbeProxyEndpoint { address })
    } else {
        None
    };

    Ok(RuntimeEndpoints {
        control: ControlEndpoint { address: control },
        probe_proxy,
    })
}

fn runtime_ports_from_value(
    value: &serde_json::Value,
    endpoints: &RuntimeEndpoints,
) -> Result<(u16, Vec<u16>), String> {
    let clash = endpoints.control.address.port();
    let mut ports = vec![clash];
    if let Some(inbounds) = value.get("inbounds").and_then(|v| v.as_array()) {
        for inbound in inbounds {
            if let Some(port) = inbound
                .get("listen_port")
                .and_then(|v| v.as_u64())
                .and_then(|p| u16::try_from(p).ok())
            {
                ports.push(port);
            }
        }
    }
    if let Some(outbounds) = value.get("outbounds").and_then(|v| v.as_array()) {
        for outbound in outbounds {
            if outbound.get("server").and_then(|v| v.as_str()) == Some("127.0.0.1") {
                if let Some(port) = outbound
                    .get("server_port")
                    .and_then(|v| v.as_u64())
                    .and_then(|p| u16::try_from(p).ok())
                {
                    ports.push(port);
                }
            }
        }
    }
    ports.sort_unstable();
    ports.dedup();
    Ok((clash, ports))
}

fn runtime_config_metadata_from_config(
    raw: &str,
) -> Result<(RuntimeEndpoints, u16, Vec<u16>), String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("config json: {e}"))?;
    let endpoints = runtime_endpoints_from_value(&value)?;
    let (clash_port, runtime_ports) = runtime_ports_from_value(&value, &endpoints)?;
    Ok((endpoints, clash_port, runtime_ports))
}

async fn wait_clash_ready(
    control: &ControlEndpoint,
    state: &SingboxState,
    start_epoch: u64,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        ensure_start_current(state, start_epoch)?;
        match crate::clash::clash_get_proxies_unchecked_endpoint(control).await {
            Ok(_) => return Ok(()),
            Err(e) if tokio::time::Instant::now() >= deadline => {
                return Err(format!(
                    "Clash control endpoint port={} is not ready: {e}",
                    control.address.port()
                ))
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(150)).await,
        }
    }
}

async fn local_probe_listener_ready(endpoint: &ProbeProxyEndpoint) -> bool {
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::net::TcpStream::connect(endpoint.address),
        )
        .await,
        Ok(Ok(_))
    )
}

async fn wait_probe_listener_ready(
    endpoint: Option<&ProbeProxyEndpoint>,
    state: &SingboxState,
    start_epoch: u64,
) -> Result<(), String> {
    let Some(endpoint) = endpoint else {
        return Ok(());
    };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        ensure_start_current(state, start_epoch)?;
        if local_probe_listener_ready(endpoint).await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "runtime probe endpoint {} has no live listener",
                endpoint.address
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

// После kill подтверждаем оба условия ОДНИМ коротким барьером. Раньше два
// независимых 5-секундных ожидания шли последовательно, а при отмене start в
// полёте stop вызывался дважды — защитные дедлайны складывались почти в 30 с.
#[cfg(target_os = "windows")]
fn process_creation_time(handle: windows::Win32::Foundation::HANDLE) -> Option<u64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetProcessTimes;

    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user).ok()?;
    }
    Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
}

#[cfg(target_os = "windows")]
fn track_process(pid: u32) -> TrackedProcess {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    let creation_time = unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
        .ok();
        handle.and_then(|handle| {
            let creation_time = process_creation_time(handle);
            let _ = CloseHandle(handle);
            creation_time
        })
    };
    TrackedProcess { pid, creation_time }
}

#[cfg(not(target_os = "windows"))]
fn track_process(pid: u32) -> TrackedProcess {
    TrackedProcess {
        pid,
        creation_time: None,
    }
}

#[cfg(target_os = "windows")]
fn process_has_exited(process: &TrackedProcess) -> bool {
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    unsafe {
        let access = if process.creation_time.is_some() {
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
        } else {
            PROCESS_SYNCHRONIZE
        };
        // ERROR_INVALID_PARAMETER означает, что исходный PID уже исчез. Другую
        // ошибку (например ACCESS_DENIED) нельзя выдавать за подтверждённый exit.
        let Ok(handle) = OpenProcess(access, false, process.pid) else {
            return GetLastError() == ERROR_INVALID_PARAMETER;
        };
        // Новый process object с тем же PID не является нашим runtime: исходный
        // процесс уже завершён, а новый нельзя ни ждать, ни тем более убивать.
        if let Some(expected) = process.creation_time {
            match process_creation_time(handle) {
                Some(actual) if actual != expected => {
                    let _ = CloseHandle(handle);
                    return true;
                }
                None => {
                    let _ = CloseHandle(handle);
                    return false;
                }
                Some(_) => {}
            }
        }
        let exited = WaitForSingleObject(handle, 0) == WAIT_OBJECT_0;
        let _ = CloseHandle(handle);
        exited
    }
}

#[cfg(target_os = "windows")]
fn terminate_tracked_process(process: &TrackedProcess) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE,
    };

    let Some(expected) = process.creation_time else {
        // Без устойчивой identity повторно завершать голый PID небезопасно.
        return;
    };
    unsafe {
        if let Ok(handle) = OpenProcess(
            PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            process.pid,
        ) {
            // Проверяем identity на том же handle, который передаём в
            // TerminateProcess: между проверкой и kill PID уже не переедет.
            if process_creation_time(handle) == Some(expected) {
                let _ = TerminateProcess(handle, 1);
            }
            let _ = CloseHandle(handle);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate_tracked_process(_process: &TrackedProcess) {}

#[cfg(not(target_os = "windows"))]
fn killed_processes_exited(state: &SingboxState, _processes: &[TrackedProcess]) -> bool {
    state.live_processes.load(Ordering::SeqCst) == 0
}

#[cfg(target_os = "windows")]
fn killed_processes_exited(_state: &SingboxState, processes: &[TrackedProcess]) -> bool {
    processes.iter().all(process_has_exited)
}

#[cfg(target_os = "windows")]
fn unresolved_processes(processes: &[TrackedProcess]) -> Vec<TrackedProcess> {
    processes
        .iter()
        .filter(|process| process.creation_time.is_some() && !process_has_exited(process))
        .cloned()
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn unresolved_processes(processes: &[TrackedProcess]) -> Vec<TrackedProcess> {
    processes.to_vec()
}

async fn wait_runtime_released(
    state: &SingboxState,
    ports: &[u16],
    killed_processes: &[TrackedProcess],
) -> (bool, Vec<u16>) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        // live_processes — это счётчик доставки CommandEvent::Terminated в
        // монитор логов, а не состояние ОС. Событие идёт за stdout/stderr и
        // может запоздать после успешного kill. На Windows ждём реальные PID.
        let processes_exited = killed_processes_exited(state, killed_processes);
        // Проверяем именно возможность следующего bind, а не connect. На
        // Windows connect к уже закрытому, но фильтруемому WFP/WinDivert порту
        // может ждать TCP retransmit 15–30 секунд и тем самым пробивать внешний
        // двухсекундный deadline. bind отвечает синхронно и мгновенно.
        let remaining_ports: Vec<u16> = ports
            .iter()
            .copied()
            .filter(|port| {
                std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, *port)).is_err()
            })
            .collect();
        if processes_exited && remaining_ports.is_empty() {
            return (true, Vec::new());
        }
        if tokio::time::Instant::now() >= deadline {
            return (processes_exited, remaining_ports);
        }
        let notified = state.process_exit_notify.notified();
        tokio::select! {
            _ = notified => {}
            _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => {}
        }
    }
}

fn runtime_snapshot_value(state: &SingboxState, kill_switch_active: bool) -> RuntimeSnapshot {
    let running = compute_singbox_running(state);
    let record = state.runtime.lock_recover().clone();
    let proxy_state = proxy::system_proxy_state();
    let (notification_generation, notification_applied_generation) =
        proxy::proxy_notification_generations();
    let generation = record.as_ref().map(|r| r.process_generation).unwrap_or(0);
    let mode = record.as_ref().map(|r| r.mode.clone());
    let configured_endpoint = record.as_ref().and_then(|r| {
        r.endpoints
            .probe_proxy
            .as_ref()
            .map(|endpoint| endpoint.address.to_string())
    });
    let listener_ready = running && record.as_ref().is_some_and(|r| r.listener_ready);
    let runtime_diagnostic = RuntimeDiagnostic {
        mode: mode.clone(),
        generation,
        configured_endpoint,
        published_endpoint: proxy_state.proxy_server.clone(),
        listener_ready,
        proxy_enable: proxy_state.proxy_enable,
        proxy_server: proxy_state.proxy_server.clone(),
        notification_generation,
        notification_applied_generation,
    };
    RuntimeSnapshot {
        running,
        starting: state.starting.load(Ordering::SeqCst),
        process_generation: generation,
        source_fingerprint: record.as_ref().and_then(|r| r.source_fingerprint.clone()),
        config_hash: record.as_ref().and_then(|r| r.config_hash.clone()),
        mode,
        strict_privacy: record.as_ref().is_some_and(|r| r.strict_privacy),
        pinned_node_tag: record.as_ref().and_then(|r| r.pinned_node_tag.clone()),
        control_endpoint: record.as_ref().map(|r| r.endpoints.control.clone()),
        probe_proxy_endpoint: record
            .as_ref()
            .and_then(|r| r.endpoints.probe_proxy.clone()),
        listener_ready,
        clash_port: record.as_ref().map(|r| r.clash_port).unwrap_or(0),
        clash_ready: running && record.as_ref().is_some_and(|r| r.clash_ready),
        proxy_enable: proxy_state.proxy_enable,
        proxy_server: proxy_state.proxy_server,
        notification_generation,
        notification_applied_generation,
        runtime_diagnostic,
        sidecars: serde_json::json!({ "xray": compute_xray_status(state), "clients": compute_sidecar_status(state) }),
        system_proxy_ownership: if proxy_state.owned {
            "owned"
        } else {
            "not_owned"
        },
        kill_switch_active,
    }
}

pub(crate) fn native_runtime_status(
    app: &AppHandle,
    expected_generation: u64,
) -> NativeRuntimeStatus {
    let Some(state) = app.try_state::<SingboxState>() else {
        return NativeRuntimeStatus::default();
    };
    let record = state.runtime.lock_recover().clone();
    let process_generation = record
        .as_ref()
        .map(|runtime| runtime.process_generation)
        .unwrap_or(0);
    let generation_matches = expected_generation == 0 || process_generation == expected_generation;
    NativeRuntimeStatus {
        running: generation_matches && compute_singbox_running(&state),
        xray_alive: if state.xray_child.lock_recover().is_none() {
            true
        } else {
            state.xray_died.lock_recover().is_none()
        },
        sidecars_alive: if state.sidecars.lock_recover().is_empty() {
            true
        } else {
            state.sidecar_died.lock_recover().is_none()
        },
        clash_ready: generation_matches
            && record.as_ref().is_some_and(|runtime| runtime.clash_ready),
        control_endpoint: if generation_matches {
            record
                .as_ref()
                .map(|runtime| runtime.endpoints.control.clone())
        } else {
            None
        },
        probe_proxy_endpoint: if generation_matches {
            record
                .as_ref()
                .and_then(|runtime| runtime.endpoints.probe_proxy.clone())
        } else {
            None
        },
    }
}

pub(crate) fn probe_endpoint_for_generation(
    state: &SingboxState,
    expected_generation: Option<u64>,
) -> Result<(u64, ProbeProxyEndpoint), &'static str> {
    let runtime = state.runtime.lock_recover();
    let runtime = runtime.as_ref().ok_or("runtime_unavailable")?;
    if let Some(expected_generation) = expected_generation.filter(|generation| *generation != 0) {
        if runtime.process_generation != expected_generation {
            return Err("stale_generation");
        }
    }
    let endpoint = runtime
        .endpoints
        .probe_proxy
        .clone()
        .ok_or("endpoint_unavailable")?;
    Ok((runtime.process_generation, endpoint))
}

async fn local_clash_listener_ready(control: &ControlEndpoint) -> bool {
    matches!(
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::net::TcpStream::connect(control.address),
        )
        .await,
        Ok(Ok(_))
    )
}

async fn validate_runtime_probe_endpoint(
    state: &SingboxState,
    expected_generation: Option<u64>,
    expected_endpoint: Option<&str>,
) -> Result<(u64, ProbeProxyEndpoint), String> {
    let (generation, endpoint) = probe_endpoint_for_generation(state, expected_generation)
        .map_err(|reason| format!("runtime probe endpoint is {reason}"))?;
    if let Some(expected_endpoint) = expected_endpoint {
        let expected = parse_endpoint_address(expected_endpoint, None, "published proxy endpoint")?;
        if expected != endpoint.address {
            return Err(format!(
                "stale proxy endpoint: expected {}, current generation {} owns {}",
                expected, generation, endpoint.address
            ));
        }
    }
    if !compute_singbox_running(state) {
        return Err(format!(
            "runtime generation {generation} is not running for {}",
            endpoint.address
        ));
    }
    if !state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| runtime.listener_ready)
    {
        return Err(format!(
            "runtime generation {generation} has not published listener readiness for {}",
            endpoint.address
        ));
    }
    if !local_probe_listener_ready(&endpoint).await {
        return Err(format!(
            "runtime generation {generation} has no live listener at {}",
            endpoint.address
        ));
    }
    Ok((generation, endpoint))
}

async fn enable_system_proxy_for_runtime(
    state: &SingboxState,
    host_port: &str,
    bypass_lan: Option<bool>,
    expected_generation: Option<u64>,
) -> Result<(), String> {
    let (_generation, endpoint) =
        validate_runtime_probe_endpoint(state, expected_generation, Some(host_port)).await?;
    let canonical_endpoint = endpoint.address.to_string();
    proxy::set_system_proxy(true, Some(&canonical_endpoint), bypass_lan)?;
    let proxy_state = proxy::system_proxy_state();
    if !proxy::system_proxy_matches(&canonical_endpoint)
        || !proxy_state.proxy_enable
        || !proxy_state.owned
        || proxy_state.proxy_server.as_deref() != Some(canonical_endpoint.as_str())
    {
        let _ = proxy::set_system_proxy(false, None, None);
        return Err(format!(
            "system proxy readback mismatch: enable={} server={:?}, expected {}",
            proxy_state.proxy_enable, proxy_state.proxy_server, canonical_endpoint
        ));
    }
    if !local_probe_listener_ready(&endpoint).await {
        let _ = proxy::set_system_proxy(false, None, None);
        return Err(format!(
            "probe listener disappeared after system proxy enable at {}",
            canonical_endpoint
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RuntimeDataplaneVerification {
    Ready,
    HardFailed { reason: String },
    Unverified { reason: String },
    Cancelled,
    Stale,
}

fn operation_is_current(app: &AppHandle, token: &RuntimeOperationToken) -> bool {
    app.try_state::<RuntimeOperationCoordinator>()
        .is_some_and(|coordinator| coordinator.authorize(token))
}

fn lifecycle_operation(
    app: &AppHandle,
    supplied: Option<RuntimeOperationToken>,
    fallback_kind: RuntimeOperationKind,
    generation: u64,
    source_fingerprint: Option<&str>,
) -> Result<(RuntimeOperationToken, bool), String> {
    let coordinator = app
        .try_state::<RuntimeOperationCoordinator>()
        .ok_or("runtime operation coordinator unavailable")?;
    match supplied {
        Some(token) if coordinator.authorize(&token) => Ok((token, false)),
        Some(_) => Err("stale or cancelled runtime operation token".into()),
        None => coordinator
            .begin(fallback_kind, generation, source_fingerprint)
            .map(|token| (token, true)),
    }
}

fn finish_implicit_operation(app: &AppHandle, token: &RuntimeOperationToken, implicit: bool) {
    if implicit {
        if let Some(coordinator) = app.try_state::<RuntimeOperationCoordinator>() {
            let _ = coordinator.complete(token);
        }
    }
}

fn runtime_identity_matches(
    state: &SingboxState,
    generation: u64,
    source_fingerprint: Option<&str>,
) -> bool {
    state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| {
            runtime.process_generation == generation
                && source_fingerprint
                    .is_none_or(|expected| runtime.source_fingerprint.as_deref() == Some(expected))
        })
}

fn verified_runtime_ready(app: &AppHandle) -> RuntimeDataplaneVerification {
    match release_transition_barrier(app) {
        Ok(()) => RuntimeDataplaneVerification::Ready,
        Err(_) => RuntimeDataplaneVerification::Unverified {
            reason: "transition_barrier_preserved".into(),
        },
    }
}

/// One-shot source-switch verifier.  It intentionally does not consult the
/// background watchdog state: a transaction proves *this* runtime generation or
/// returns a structured non-destructive verdict.
#[tauri::command]
pub async fn verify_runtime_dataplane(
    app: AppHandle,
    state: State<'_, SingboxState>,
    operation_token: RuntimeOperationToken,
    expected_generation: u64,
) -> Result<RuntimeDataplaneVerification, String> {
    Ok(verify_runtime_dataplane_inner(&app, &state, operation_token, expected_generation).await)
}

async fn verify_runtime_dataplane_inner(
    app: &AppHandle,
    state: &SingboxState,
    operation_token: RuntimeOperationToken,
    expected_generation: u64,
) -> RuntimeDataplaneVerification {
    let operation_id = operation_token.id;
    let operation_kind = operation_token.kind;
    let started = std::time::Instant::now();
    let verdict =
        verify_runtime_dataplane_unlogged(app, state, operation_token, expected_generation).await;
    log_runtime_verification(
        app,
        state,
        operation_id,
        operation_kind,
        expected_generation,
        &verdict,
        started.elapsed().as_millis() as u64,
    );
    verdict
}

fn log_runtime_verification(
    app: &AppHandle,
    state: &SingboxState,
    operation_id: u64,
    operation_kind: RuntimeOperationKind,
    expected_generation: u64,
    verdict: &RuntimeDataplaneVerification,
    duration_ms: u64,
) {
    if state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| runtime.logs_disabled)
    {
        return;
    }
    let (control_port, probe_port) = state
        .runtime
        .lock_recover()
        .as_ref()
        .map(|runtime| {
            (
                runtime.endpoints.control.address.port(),
                runtime
                    .endpoints
                    .probe_proxy
                    .as_ref()
                    .map(|endpoint| endpoint.address.port()),
            )
        })
        .unwrap_or((0, None));
    let (verdict_name, reason) = match verdict {
        RuntimeDataplaneVerification::Ready => ("ready", None),
        RuntimeDataplaneVerification::HardFailed { reason } => {
            ("hard_failed", Some(reason.as_str()))
        }
        RuntimeDataplaneVerification::Unverified { reason } => {
            ("unverified", Some(reason.as_str()))
        }
        RuntimeDataplaneVerification::Cancelled => ("cancelled", None),
        RuntimeDataplaneVerification::Stale => ("stale", None),
    };
    append_runtime_diagnostic(
        app,
        &format!(
            "source_verification operation_id={} kind={operation_kind:?} expected_generation={} control_role=clash_api control_port={} probe_role=dataplane_proxy probe_port={} verdict={} reason={} duration_ms={duration_ms}",
            operation_id,
            expected_generation,
            control_port,
            probe_port.map_or_else(|| "none".to_string(), |port| port.to_string()),
            verdict_name,
            reason.unwrap_or("none"),
        ),
    );
}

async fn verify_runtime_dataplane_unlogged(
    app: &AppHandle,
    state: &SingboxState,
    operation_token: RuntimeOperationToken,
    expected_generation: u64,
) -> RuntimeDataplaneVerification {
    let expected_source_fingerprint = operation_token.expected_source_fingerprint.as_deref();
    if !operation_is_current(app, &operation_token) {
        return RuntimeDataplaneVerification::Cancelled;
    }
    if !matches!(
        operation_token.kind,
        RuntimeOperationKind::SourceSwitch
            | RuntimeOperationKind::FrontendRecovery
            | RuntimeOperationKind::QualityRemediation
    ) {
        return RuntimeDataplaneVerification::Cancelled;
    }
    if operation_token.kind == RuntimeOperationKind::SourceSwitch
        && expected_source_fingerprint.is_none()
    {
        return RuntimeDataplaneVerification::Unverified {
            reason: "source_identity_unavailable".into(),
        };
    }
    if !runtime_identity_matches(state, expected_generation, expected_source_fingerprint) {
        return RuntimeDataplaneVerification::Stale;
    }

    let status = native_runtime_status(app, expected_generation);
    if !status.running {
        return RuntimeDataplaneVerification::HardFailed {
            reason: "process_dead".into(),
        };
    }
    if !status.xray_alive || !status.sidecars_alive {
        return RuntimeDataplaneVerification::HardFailed {
            reason: "required_sidecar_dead".into(),
        };
    }
    let local_ready = if status.clash_ready {
        match status.control_endpoint.as_ref() {
            Some(control) => local_clash_listener_ready(control).await,
            None => false,
        }
    } else {
        false
    };
    // The listener check is an await boundary.  Never classify a stale
    // generation as a hard failure after it completes.
    if !operation_is_current(app, &operation_token) {
        return RuntimeDataplaneVerification::Cancelled;
    }
    if !runtime_identity_matches(state, expected_generation, expected_source_fingerprint) {
        return RuntimeDataplaneVerification::Stale;
    }
    if !status.clash_ready || !local_ready {
        return RuntimeDataplaneVerification::HardFailed {
            reason: "local_control_unavailable".into(),
        };
    }
    if !operation_is_current(app, &operation_token) {
        return RuntimeDataplaneVerification::Cancelled;
    }
    if !runtime_identity_matches(state, expected_generation, expected_source_fingerprint) {
        return RuntimeDataplaneVerification::Stale;
    }

    let strict_privacy = state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| runtime.strict_privacy);
    if strict_privacy {
        let wfp_ready = app
            .try_state::<crate::killswitch::KillSwitchState>()
            .is_some_and(|kill_switch| crate::killswitch::is_active(&kill_switch));
        return if wfp_ready {
            verified_runtime_ready(app)
        } else {
            RuntimeDataplaneVerification::Unverified {
                reason: "wfp_policy_unconfirmed".into(),
            }
        };
    }

    let permit = match state
        .dataplane_probe
        .acquire(
            DataplaneProbeKind::SourceVerification,
            expected_generation,
            Some(std::time::Duration::from_secs(1)),
        )
        .await
    {
        Ok(permit) => permit,
        Err(ProbeAcquireError::Busy) => {
            return RuntimeDataplaneVerification::Unverified {
                reason: "probe_busy".into(),
            }
        }
        Err(ProbeAcquireError::StaleGeneration) => return RuntimeDataplaneVerification::Stale,
    };

    for round in 0..2 {
        if !operation_is_current(app, &operation_token) {
            return RuntimeDataplaneVerification::Cancelled;
        }
        if !state.dataplane_probe.is_current(&permit)
            || !runtime_identity_matches(state, expected_generation, expected_source_fingerprint)
        {
            return RuntimeDataplaneVerification::Stale;
        }
        let Some(probe_endpoint) = status.probe_proxy_endpoint.as_ref() else {
            return RuntimeDataplaneVerification::Unverified {
                reason: "endpoint_unavailable".into(),
            };
        };
        let result = crate::quality::probe_health_inner(Some(probe_endpoint)).await;
        // A probe may finish after a superseding source switch, generation
        // replacement, or pressure transition.  Its result is not allowed to
        // release a transition barrier for the newer runtime.
        if !operation_is_current(app, &operation_token) {
            return RuntimeDataplaneVerification::Cancelled;
        }
        if !state.dataplane_probe.is_current(&permit)
            || !runtime_identity_matches(state, expected_generation, expected_source_fingerprint)
        {
            return RuntimeDataplaneVerification::Stale;
        }
        match result {
            Ok(result) if result.ok => return verified_runtime_ready(app),
            Ok(_) if round == 0 => {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if !operation_is_current(app, &operation_token) {
                    return RuntimeDataplaneVerification::Cancelled;
                }
                if !state.dataplane_probe.is_current(&permit)
                    || !runtime_identity_matches(
                        state,
                        expected_generation,
                        expected_source_fingerprint,
                    )
                {
                    return RuntimeDataplaneVerification::Stale;
                }
            }
            Ok(_) => {
                return RuntimeDataplaneVerification::HardFailed {
                    reason: "external_route_failure".into(),
                }
            }
            Err(_) => {
                return RuntimeDataplaneVerification::Unverified {
                    reason: "monitor_error".into(),
                }
            }
        }
    }
    RuntimeDataplaneVerification::Unverified {
        reason: "verification_incomplete".into(),
    }
}

async fn start_singbox_inner(
    app: AppHandle,
    state: &SingboxState,
    spec: RuntimeLaunchSpec,
    operation_token: &RuntimeOperationToken,
) -> Result<RuntimeSnapshot, String> {
    let RuntimeLaunchSpec {
        config_json: raw_config_json,
        mode,
        xray_json,
        sidecars_json,
        logs_disabled,
        source_fingerprint,
        config_hash,
        strict_privacy,
        pinned_node_tag,
    } = spec;
    if !operation_is_current(&app, operation_token) {
        return Err("stale or cancelled runtime operation token".into());
    }
    let (start_epoch, process_generation) = {
        // Короткий синхронный gate делает старт/стоп линейными в точке смены
        // поколения; сам долгий запуск под ним не выполняется.
        let _gate = state.lifecycle_gate.lock_recover();
        if state.stopping.load(Ordering::SeqCst) {
            return Err("остановка ещё выполняется".into());
        }
        // Sentinel ДО child-проверки: второй конкурентный вызов отсекается,
        // пока первый ещё находится в await до публикации child.
        if state.starting.swap(true, Ordering::SeqCst) {
            return Err("запуск уже идёт".into());
        }
        if state.pending_cleanup.lock_recover().is_some() {
            state.starting.store(false, Ordering::SeqCst);
            return Err("предыдущий runtime ещё не очищен; повторите отключение".into());
        }
        let child = state.child.lock_recover();
        if child.is_some() || state.xray_child.lock_recover().is_some() {
            state.starting.store(false, Ordering::SeqCst);
            return Err("sing-box уже запущен".into());
        }
        let start_epoch = state.start_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        // Сначала меняем поколение, затем чистим death-флаги. Иначе запоздалый
        // Terminated старого runtime мог попасть в окно и отравить новую сессию.
        let process_generation = state.process_generation.fetch_add(1, Ordering::SeqCst) + 1;
        // `expected_exit_generation` относится только к уже остановленному
        // runtime. После нового start он не должен совпасть с новым generation:
        // иначе первый реальный crash после отменённого disconnect будет
        // ошибочно классифицирован как штатный stop.
        state.expected_exit_generation.store(0, Ordering::SeqCst);
        *state.died.lock_recover() = None;
        *state.xray_died.lock_recover() = None;
        *state.sidecar_died.lock_recover() = None;
        (start_epoch, process_generation)
    };
    let _starting = StartingGuard(&state.starting);
    // Захардениваем конфиг (секрет clash-API + loopback) до записи/отправки.
    let cache_path = singbox_cache_path(&app)?;
    let config_json = harden_config(&raw_config_json, Some(&cache_path));
    let (endpoints, clash_port, runtime_ports) = runtime_config_metadata_from_config(&config_json)?;
    if operation_token.kind == RuntimeOperationKind::SourceSwitch
        && (operation_token.expected_source_fingerprint.is_none()
            || operation_token.expected_source_fingerprint.as_deref()
                != source_fingerprint.as_deref())
    {
        return Err("source identity changed during source switch".into());
    }
    let probe_endpoint = endpoints.probe_proxy.clone();
    *state.runtime_ports.lock_recover() = runtime_ports;
    let sidecar_specs: Option<Vec<SidecarSpec>> = sidecars_json
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .map(|sj| serde_json::from_str(sj).map_err(|e| format!("sidecars json: {e}")))
        .transpose()?;

    // Two-core: если в конфиге есть xhttp-ноды, поднимаем xray ДО sing-box
    // (в любом режиме). При ошибке спавна — не стартуем VPN вовсе.
    if let Some(xj) = xray_json.as_ref().filter(|s| !s.trim().is_empty()) {
        if let Err(e) = spawn_xray(
            &app,
            state,
            xj,
            logs_disabled,
            start_epoch,
            process_generation,
        )
        .await
        {
            kill_xray(state);
            return Err(e);
        }
        ensure_start_current(state, start_epoch)?;
        ensure_operation_current(&app, state, operation_token)?;
    }

    // Sidecar-клиенты naive / trusttunnel (если такие ноды есть) — тоже ДО sing-box.
    if let Some(specs) = sidecar_specs.as_ref() {
        if let Err(e) = spawn_sidecars(
            &app,
            state,
            specs,
            logs_disabled,
            start_epoch,
            process_generation,
        )
        .await
        {
            kill_xray(state);
            kill_sidecars(state);
            return Err(e);
        }
        ensure_start_current(state, start_epoch)?;
        ensure_operation_current(&app, state, operation_token)?;
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
    if let Err(e) = spawn_singbox_core(
        &app,
        state,
        &config_json,
        logs_disabled,
        start_epoch,
        process_generation,
    )
    .await
    {
        // kill по уже мёртвому child безвреден (Err игнорируем).
        if let Some(child) = state.child.lock_recover().take() {
            let _ = child.kill();
        }
        kill_xray(state);
        kill_sidecars(state);
        return Err(e);
    }
    ensure_start_current(state, start_epoch)?;
    ensure_operation_current(&app, state, operation_token)?;

    if let Err(e) = wait_clash_ready(&endpoints.control, state, start_epoch).await {
        if let Some(child) = state.child.lock_recover().take() {
            let _ = child.kill();
        }
        kill_xray(state);
        kill_sidecars(state);
        *state.runtime_ports.lock_recover() = Vec::new();
        *state.runtime.lock_recover() = None;
        return Err(e);
    }
    // Clash control readiness is not sufficient for System Proxy/TUN. The
    // endpoint published to Windows and to the dataplane probe must be the
    // listener owned by this freshly spawned sing-box generation.
    if let Err(e) = wait_probe_listener_ready(probe_endpoint.as_ref(), state, start_epoch).await {
        if let Some(child) = state.child.lock_recover().take() {
            let _ = child.kill();
        }
        kill_xray(state);
        kill_sidecars(state);
        let _ = proxy::set_system_proxy(false, None, None);
        *state.runtime_ports.lock_recover() = Vec::new();
        *state.runtime.lock_recover() = None;
        return Err(e);
    }
    ensure_operation_current(&app, state, operation_token)?;
    *state.runtime.lock_recover() = Some(RuntimeRecord {
        process_generation,
        source_fingerprint: source_fingerprint.clone(),
        config_hash: config_hash.clone(),
        mode: mode.clone(),
        strict_privacy,
        pinned_node_tag: pinned_node_tag.clone(),
        logs_disabled,
        endpoints: endpoints.clone(),
        listener_ready: true,
        clash_port,
        clash_ready: true,
    });
    state.dataplane_probe.reset_generation(process_generation);
    Ok(runtime_snapshot_value(state, false))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri IPC: именованные поля сохраняют совместимый wire contract.
pub async fn start_singbox(
    app: AppHandle,
    state: State<'_, SingboxState>,
    config_json: String,
    mode: String,
    xray_json: Option<String>,
    sidecars_json: Option<String>,
    logs_disabled: Option<bool>,
    source_fingerprint: Option<String>,
    config_hash: Option<String>,
    strict_privacy: Option<bool>,
    pinned_node_tag: Option<String>,
    operation_token: Option<RuntimeOperationToken>,
) -> Result<RuntimeSnapshot, String> {
    let (operation_token, implicit) = lifecycle_operation(
        &app,
        operation_token,
        RuntimeOperationKind::UserConnect,
        0,
        source_fingerprint.as_deref(),
    )?;
    let result = start_singbox_inner(
        app.clone(),
        &state,
        RuntimeLaunchSpec {
            config_json,
            mode,
            xray_json,
            sidecars_json,
            logs_disabled: logs_disabled.unwrap_or(false),
            source_fingerprint,
            config_hash,
            strict_privacy: strict_privacy.unwrap_or(false),
            pinned_node_tag,
        },
        &operation_token,
    )
    .await;
    finish_implicit_operation(&app, &operation_token, implicit);
    result
}

// Запись конфига + спавн sing-box + fail-fast-окно. Вынесено из start_singbox,
// чтобы любой Err отсюда проходил у вызывающего через общую зачистку ядра и
// мостов — сама функция ничего не подчищает.
async fn spawn_singbox_core(
    app: &AppHandle,
    state: &SingboxState,
    config_json: &str,
    logs_disabled: bool,
    start_epoch: u64,
    process_generation: u64,
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
    spawn_log_monitor(
        rx,
        log_file,
        died_flag,
        state.live_processes.clone(),
        state.process_exit_notify.clone(),
        MonitorGeneration {
            current: state.process_generation.clone(),
            expected_exit: state.expected_exit_generation.clone(),
            value: process_generation,
        },
        MonitorSpec::core(
            format!("=== sing-box start · generation {process_generation} ==="),
            "sing-box",
        ),
    );

    // даём sing-box 800мс чтобы упасть с ошибкой парсинга / биндинга
    wait_start_delay(state, start_epoch, std::time::Duration::from_millis(800)).await?;
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

fn kill_xray(state: &SingboxState) -> bool {
    if let Some(child) = state.xray_child.lock_recover().take() {
        child.kill().is_ok()
    } else {
        true
    }
}

fn kill_sidecars(state: &SingboxState) -> bool {
    let mut ok = true;
    for child in state.sidecars.lock_recover().drain(..) {
        ok &= child.kill().is_ok();
    }
    ok
}

// Зачистка незавершённого запуска. Отмена по epoch и отмена по владению
// операцией — один и тот же исход: поднятый комплект больше никому не
// принадлежит. Оставлять его живым нельзя: guard `child.is_some()` заблокировал
// бы следующий старт, а compute_singbox_running продолжал бы отдавать
// running=true при пустом RuntimeRecord.
fn abort_started_runtime(state: &SingboxState) {
    if let Some(child) = state.child.lock_recover().take() {
        let _ = child.kill();
    }
    kill_xray(state);
    kill_sidecars(state);
    *state.runtime_ports.lock_recover() = Vec::new();
    *state.runtime.lock_recover() = None;
}

fn ensure_start_current(state: &SingboxState, epoch: u64) -> Result<(), String> {
    if state.start_epoch.load(Ordering::SeqCst) == epoch {
        return Ok(());
    }
    abort_started_runtime(state);
    Err("запуск отменён новым сетевым намерением".into())
}

// Отнятый/устаревший токен на любом шаге старта. В отличие от epoch-проверки
// координатор мог сменить владельца без нового start_epoch (latest-wins смена
// источника), поэтому чистить обязана именно эта ветка: у stop_singbox с тем же
// токеном владения уже нет, и он вернёт refused, не тронув процессы.
fn ensure_operation_current(
    app: &AppHandle,
    state: &SingboxState,
    token: &RuntimeOperationToken,
) -> Result<(), String> {
    if operation_is_current(app, token) {
        return Ok(());
    }
    abort_started_runtime(state);
    Err("stale or cancelled runtime operation token".into())
}

async fn wait_start_delay(
    state: &SingboxState,
    epoch: u64,
    duration: std::time::Duration,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + duration;
    loop {
        ensure_start_current(state, epoch)?;
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Ok(());
        }
        tokio::time::sleep(std::cmp::min(
            deadline - now,
            std::time::Duration::from_millis(25),
        ))
        .await;
    }
}

// Стирает конфиги мостов (naive-*.json, trusttunnel-*.toml) из writable config dir.
// В них лежат креды нод (user:pass) — не держим их на диске дольше сессии.
// singbox-current.json/xray-current.json НЕ трогаем: это норма клиентов, и
// они перезаписываются при следующем старте.
fn purge_bridge_configs(app: &AppHandle) {
    let Ok(dir) = crate::app_paths::config_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
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
    let Ok(dir) = crate::app_paths::config_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if is_runtime_config_name(&name) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// Стирает singbox-current.json / xray-current.json из writable config dir. В них
// UUID/пароли нод и (при активном WARP) приватный WG-ключ — держать их на диске
// дольше сессии незачем: следующий старт всё равно перезапишет файлы заново.
fn purge_current_configs(app: &AppHandle) {
    let Ok(dir) = crate::app_paths::config_dir(app) else {
        return;
    };
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResult {
    singbox: &'static str,
    xray: &'static str,
    sidecars: &'static str,
    ports_released: bool,
    remaining_ports: Vec<u16>,
    processes_exited: bool,
    pending_exit_events: u64,
    system_proxy: &'static str,
    timings: StopTimings,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StopTimings {
    kill_ms: u64,
    proxy_ms: u64,
    confirm_ms: u64,
    total_ms: u64,
}

async fn stop_singbox_inner(app: &AppHandle, state: &SingboxState) -> Result<StopResult, String> {
    let _stop = state.stop_lock.lock().await;
    state.dataplane_probe.invalidate();
    {
        let _gate = state.lifecycle_gate.lock_recover();
        state.stopping.store(true, Ordering::SeqCst);
        // Инвалидируем start ДО снятия child-хэндлов. Если IPC-start находится
        // в await, он увидит новое поколение и завершится без хвоста.
        state.start_epoch.fetch_add(1, Ordering::SeqCst);
    }
    let _stopping = StoppingGuard(&state.stopping);
    state.expected_exit_generation.store(
        state.process_generation.load(Ordering::SeqCst),
        Ordering::SeqCst,
    );
    let started_at = std::time::Instant::now();
    let pending = state
        .pending_cleanup
        .lock_recover()
        .clone()
        .unwrap_or_default();
    let runtime_ports = state.runtime_ports.lock_recover().clone();
    let (ports, mut killed_processes) = cleanup_targets(&runtime_ports, pending);
    // CommandChild уже потреблён прошлой попыткой. Повторный stop всё равно
    // должен физически добить оставшийся process object, но только если его
    // creation time всё ещё совпадает — голый PID Windows мог переиспользовать.
    for process in &killed_processes {
        terminate_tracked_process(process);
    }
    let taken = state.child.lock_recover().take();
    let had_singbox = taken.is_some();
    if let Some(child) = taken {
        // child.kill() гасит sing-box; wintun-адаптер (non-persistent) снимается
        // системой вместе со смертью процесса, державшего его — отдельная чистка
        // TUN-интерфейса не нужна.
        killed_processes.push(track_process(child.pid()));
        let _ = child.kill();
    }
    let xray_child = state.xray_child.lock_recover().take();
    let had_xray = xray_child.is_some();
    if let Some(child) = xray_child {
        killed_processes.push(track_process(child.pid()));
        let _ = child.kill();
    }
    let sidecar_children: Vec<_> = state.sidecars.lock_recover().drain(..).collect();
    let had_sidecars = !sidecar_children.is_empty();
    for child in sidecar_children {
        killed_processes.push(track_process(child.pid()));
        let _ = child.kill();
    }
    killed_processes.sort_unstable_by_key(|process| process.pid);
    killed_processes.dedup_by_key(|process| process.pid);
    let killed_at = std::time::Instant::now();
    let proxy_was_owned = proxy::system_proxy_owned();
    let proxy_ok = proxy::set_system_proxy(false, None, None).is_ok();
    let proxy_done_at = std::time::Instant::now();
    let (processes_exited, remaining_ports) =
        wait_runtime_released(state, &ports, &killed_processes).await;
    let ports_released = remaining_ports.is_empty();
    let confirmed_at = std::time::Instant::now();
    let proxy_confirmed = !proxy_was_owned || proxy_ok;
    let cleanup_confirmed = processes_exited && ports_released && proxy_confirmed;
    if cleanup_confirmed {
        purge_bridge_configs(app);
        purge_current_configs(app);
        clear_death_flags(state);
        *state.runtime.lock_recover() = None;
        *state.runtime_ports.lock_recover() = Vec::new();
        *state.pending_cleanup.lock_recover() = None;
    } else {
        *state.pending_cleanup.lock_recover() = Some(PendingCleanup {
            processes: unresolved_processes(&killed_processes),
            // Храним весь набор, а не только занятые порты: повторная проверка
            // должна подтверждать освобождение полного runtime-контракта.
            ports: ports.clone(),
        });
    }
    Ok(StopResult {
        singbox: if !had_singbox {
            "already_stopped"
        } else if processes_exited {
            "stopped"
        } else {
            "failed"
        },
        xray: if !had_xray {
            "already_stopped"
        } else if processes_exited {
            "stopped"
        } else {
            "failed"
        },
        sidecars: if !had_sidecars {
            "already_stopped"
        } else if processes_exited {
            "stopped"
        } else {
            "failed"
        },
        ports_released,
        remaining_ports,
        processes_exited,
        pending_exit_events: state.live_processes.load(Ordering::SeqCst),
        system_proxy: if !proxy_was_owned {
            "not_owned"
        } else if proxy_ok {
            "restored"
        } else {
            "failed"
        },
        timings: StopTimings {
            kill_ms: killed_at.duration_since(started_at).as_millis() as u64,
            proxy_ms: proxy_done_at.duration_since(killed_at).as_millis() as u64,
            confirm_ms: confirmed_at.duration_since(proxy_done_at).as_millis() as u64,
            total_ms: started_at.elapsed().as_millis() as u64,
        },
    })
}

#[tauri::command]
pub async fn stop_singbox(
    app: AppHandle,
    state: State<'_, SingboxState>,
    operation_token: Option<RuntimeOperationToken>,
) -> Result<StopResult, String> {
    // Manual disconnect owns the lifecycle token and performs one verified stop.
    let generation = state.process_generation.load(Ordering::SeqCst);
    // logs_disabled живёт в RuntimeRecord, а подтверждённый stop его обнуляет.
    // Читаем настройку до остановки, иначе итоговая запись ушла бы в файл даже
    // при полностью отключённых логах.
    let logs_disabled = state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| runtime.logs_disabled);
    // Отказ владения — тоже исход остановки, и на UI он выглядит ровно тем же
    // «очистка не подтверждена», что и незавершённый процесс. Без этих записей
    // в журнале оставалась дыра: неудачный stop не оставлял следа вообще, и
    // отличить отнятый токен от реальной проблемы очистки было нечем.
    let requested_kind = operation_token.as_ref().map(|token| token.kind);
    let (operation_token, implicit) = match lifecycle_operation(
        &app,
        operation_token,
        RuntimeOperationKind::UserDisconnect,
        generation,
        None,
    ) {
        Ok(value) => value,
        Err(error) => {
            log_stop_refusal(&app, logs_disabled, requested_kind, generation, &error);
            return Err(error);
        }
    };
    if !operation_is_current(&app, &operation_token) {
        let error = "stale or cancelled runtime operation token".to_string();
        log_stop_refusal(
            &app,
            logs_disabled,
            Some(operation_token.kind),
            generation,
            &error,
        );
        return Err(error);
    }
    if operation_token.kind.needs_transition_barrier() {
        match native_transition_barrier(&app) {
            Ok(barrier) => log_stop_diagnostic(
                &app,
                logs_disabled,
                &format!(
                    "runtime_stop_barrier kind={:?} generation={generation} state={}",
                    operation_token.kind,
                    if barrier { "armed" } else { "not_required" },
                ),
            ),
            Err(error) => {
                log_stop_diagnostic(
                    &app,
                    logs_disabled,
                    &format!(
                        "runtime_stop_barrier kind={:?} generation={generation} state=failed reason={error}",
                        operation_token.kind,
                    ),
                );
                return Err(error);
            }
        }
    }
    // Manual intent invalidates any start still crossing an await boundary.
    state.start_epoch.fetch_add(1, Ordering::SeqCst);
    if !operation_is_current(&app, &operation_token) {
        let error = "stale or cancelled runtime operation token".to_string();
        log_stop_refusal(
            &app,
            logs_disabled,
            Some(operation_token.kind),
            generation,
            &error,
        );
        return Err(error);
    }
    let result = stop_singbox_inner(&app, &state).await;
    log_stop_result(
        &app,
        logs_disabled,
        operation_token.kind,
        generation,
        &result,
    );
    finish_implicit_operation(&app, &operation_token, implicit);
    result
}

// Итог остановки уходил только в console.error WebView, недоступную пользователю:
// по сообщению «очистка не подтверждена» нельзя было отличить незавершённый
// процесс от занятого порта или от неснятого системного прокси. Пишем разбор в
// тот же singbox.log, который открывается во вкладке «Логи». Здесь нет URL, IP,
// имён нод и конфигов — только статусы компонентов, номера runtime-портов и
// тайминги стадий.
fn log_stop_diagnostic(app: &AppHandle, logs_disabled: bool, line: &str) {
    if logs_disabled {
        return;
    }
    append_runtime_diagnostic(app, line);
}

// Остановка, отклонённая координатором операций: сюда попадают отнятый/устаревший
// токен и занятый lifecycle. Формат совпадает с обычным runtime_stop, чтобы в
// журнале обе ветки читались одним грепом.
fn log_stop_refusal(
    app: &AppHandle,
    logs_disabled: bool,
    kind: Option<RuntimeOperationKind>,
    generation: u64,
    reason: &str,
) {
    let kind = match kind {
        Some(kind) => format!("{kind:?}"),
        None => "none".to_string(),
    };
    log_stop_diagnostic(
        app,
        logs_disabled,
        &format!("runtime_stop kind={kind} generation={generation} result=refused reason={reason}"),
    );
}

fn log_stop_result(
    app: &AppHandle,
    logs_disabled: bool,
    kind: RuntimeOperationKind,
    generation: u64,
    result: &Result<StopResult, String>,
) {
    if logs_disabled {
        return;
    }
    let line = match result {
        Ok(stop) => format!(
            "runtime_stop kind={kind:?} generation={generation} singbox={} xray={} sidecars={} \
             processes_exited={} ports_released={} remaining_ports={:?} pending_exit_events={} \
             system_proxy={} kill_ms={} proxy_ms={} confirm_ms={} total_ms={}",
            stop.singbox,
            stop.xray,
            stop.sidecars,
            stop.processes_exited,
            stop.ports_released,
            stop.remaining_ports,
            stop.pending_exit_events,
            stop.system_proxy,
            stop.timings.kill_ms,
            stop.timings.proxy_ms,
            stop.timings.confirm_ms,
            stop.timings.total_ms,
        ),
        Err(error) => {
            format!(
                "runtime_stop kind={kind:?} generation={generation} result=error reason={error}"
            )
        }
    };
    append_runtime_diagnostic(app, &line);
}

// Транзитный барьер имеет смысл ТОЛЬКО поверх уже действующей fail-closed
// политики: строгая приватность или армированный kill switch. Пользователю с
// выключенным Kill Switch он не даёт ничего, зато на каждой смене режима и на
// каждом восстановлении watchdog'а рубит все новые соединения приложений
// (block-all разрешает лишь loopback, DHCP и exe движков) — вопреки явно
// выключенной настройке. Барьер снимается только успешной верификацией нового
// runtime, которой на пути смены режима нет вовсе.
fn transition_barrier_required(strict_tunnel: bool, kill_switch_active: bool) -> bool {
    strict_tunnel || kill_switch_active
}

/// Возвращает true, если барьер армирован, false — если политика его не требует.
fn native_transition_barrier(app: &AppHandle) -> Result<bool, String> {
    let kill_switch = app
        .try_state::<crate::killswitch::KillSwitchState>()
        .ok_or("kill switch state unavailable for transition barrier")?;
    let strict_tunnel = app
        .try_state::<SingboxState>()
        .and_then(|state| {
            state
                .runtime
                .lock_recover()
                .as_ref()
                .map(|runtime| runtime.strict_privacy)
        })
        .unwrap_or(false);
    if !transition_barrier_required(strict_tunnel, crate::killswitch::is_active(&kill_switch)) {
        return Ok(false);
    }
    crate::killswitch::transition_arm(&kill_switch, strict_tunnel)?;
    if !crate::killswitch::transition_active(&kill_switch) {
        return Err("transition barrier was not confirmed active".into());
    }
    Ok(true)
}

pub(crate) fn release_transition_barrier(app: &AppHandle) -> Result<(), String> {
    let kill_switch = app
        .try_state::<crate::killswitch::KillSwitchState>()
        .ok_or("kill switch state unavailable for transition barrier")?;
    crate::killswitch::transition_release(&kill_switch)
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

pub(crate) fn protected_browser_tun_ready(state: &SingboxState) -> bool {
    if !compute_singbox_running(state) || state.starting.load(Ordering::SeqCst) {
        return false;
    }
    state
        .runtime
        .lock_recover()
        .as_ref()
        .is_some_and(|runtime| runtime.mode == "tun" && runtime.clash_ready)
}

#[tauri::command]
pub fn runtime_snapshot(
    state: State<'_, SingboxState>,
    kill_switch: State<'_, crate::killswitch::KillSwitchState>,
) -> RuntimeSnapshot {
    runtime_snapshot_value(&state, crate::killswitch::is_active(&kill_switch))
}

#[tauri::command]
pub fn runtime_diagnostic(
    state: State<'_, SingboxState>,
    kill_switch: State<'_, crate::killswitch::KillSwitchState>,
) -> RuntimeDiagnostic {
    runtime_snapshot_value(&state, crate::killswitch::is_active(&kill_switch)).runtime_diagnostic
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
    pub kill_switch_active: bool,
    pub runtime_operation: Option<crate::runtime_ops::RuntimeOperationSnapshot>,
}

#[tauri::command]
pub fn health_snapshot(
    state: State<'_, SingboxState>,
    kill_switch: State<'_, crate::killswitch::KillSwitchState>,
    coordinator: State<'_, RuntimeOperationCoordinator>,
) -> HealthSnapshot {
    HealthSnapshot {
        singbox_running: compute_singbox_running(&state),
        xray: compute_xray_status(&state),
        sidecar: compute_sidecar_status(&state),
        last_error: compute_last_error(&state),
        kill_switch_active: crate::killswitch::is_active(&kill_switch),
        runtime_operation: coordinator.snapshot(),
    }
}

fn validate_system_proxy_enable_request(
    host_port: &str,
    expected_generation: u64,
) -> Result<(), String> {
    if host_port.trim().is_empty() {
        return Err("system proxy enable requires the current probe endpoint".into());
    }
    if expected_generation == 0 {
        return Err("system proxy enable requires the current process generation".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn enable_system_proxy(
    app: AppHandle,
    state: State<'_, SingboxState>,
    host_port: String,
    bypass_lan: Option<bool>,
    expected_generation: u64,
) -> Result<(), String> {
    validate_system_proxy_enable_request(&host_port, expected_generation)?;
    if let Err(error) = enable_system_proxy_for_runtime(
        &state,
        host_port.trim(),
        bypass_lan,
        Some(expected_generation),
    )
    .await
    {
        let cleanup = stop_singbox_inner(&app, &state).await;
        return Err(match cleanup {
            Ok(_) => format!("{error}; runtime stopped after proxy readiness failure"),
            Err(cleanup_error) => format!(
                "{error}; runtime stop after proxy readiness failure failed: {cleanup_error}"
            ),
        });
    }
    Ok(())
}

#[tauri::command]
pub fn disable_system_proxy() -> Result<(), String> {
    proxy::set_system_proxy(false, None, None)
}

#[cfg(test)]
mod system_proxy_command_tests {
    use super::validate_system_proxy_enable_request;

    #[test]
    fn enable_contract_requires_endpoint_and_generation() {
        assert!(validate_system_proxy_enable_request("", 1).is_err());
        assert!(validate_system_proxy_enable_request("127.0.0.1:7890", 0).is_err());
        assert!(validate_system_proxy_enable_request("127.0.0.1:7890", 1).is_ok());
    }

    #[test]
    fn transition_barrier_follows_the_active_fail_closed_policy() {
        use super::transition_barrier_required;

        // Ни строгой приватности, ни армированного kill switch: блокировать сеть
        // на время замены runtime нельзя — пользователь fail-closed не просил.
        assert!(!transition_barrier_required(false, false));
        assert!(transition_barrier_required(false, true));
        assert!(transition_barrier_required(true, false));
        assert!(transition_barrier_required(true, true));
    }
}

#[tauri::command]
pub async fn verify_runtime_endpoint(
    state: State<'_, SingboxState>,
    kill_switch: State<'_, crate::killswitch::KillSwitchState>,
    expected_generation: Option<u64>,
    expected_endpoint: Option<String>,
) -> Result<RuntimeSnapshot, String> {
    validate_runtime_probe_endpoint(&state, expected_generation, expected_endpoint.as_deref())
        .await?;
    Ok(runtime_snapshot_value(
        &state,
        crate::killswitch::is_active(&kill_switch),
    ))
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
    state.expected_exit_generation.store(
        state.process_generation.load(Ordering::SeqCst),
        Ordering::SeqCst,
    );
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
    Err(format!(
        "нет свободных портов для мостов (искали от {start})"
    ))
}

#[tauri::command]
pub async fn plan_bridge_ports(needs: BridgeNeeds) -> Result<BridgePorts, String> {
    let mut taken: Vec<(u16, u16)> = Vec::new();
    let xray = find_free_base(31100, needs.xray, &mut taken)?;
    let naive = find_free_base(31200, needs.naive, &mut taken)?;
    let trusttunnel = find_free_base(31300, needs.trusttunnel, &mut taken)?;
    Ok(BridgePorts {
        xray,
        naive,
        trusttunnel,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("ninety-vpn-{label}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn strip_ansi_removes_sgr() {
        assert_eq!(strip_ansi("\x1b[36mINFO\x1b[0m text"), "INFO text");
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi(""), "");
        // ESC без CSI просто выпадает
        assert_eq!(strip_ansi("a\x1bZb"), "aZb");
    }

    #[test]
    fn monitor_exit_classifies_planned_stale_and_unexpected_generations() {
        assert!(monitor_exit_expected(7, 7, 7));
        assert!(monitor_exit_expected(8, 0, 7));
        assert!(!monitor_exit_expected(7, 0, 7));
        assert!(!monitor_exit_expected(8, 7, 8));
    }

    #[test]
    fn harden_config_injects_secret_and_loopback() {
        let raw = r#"{"experimental":{"clash_api":{"external_controller":"0.0.0.0:9090"}}}"#;
        let out = harden_config(raw, None);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let api = &v["experimental"]["clash_api"];
        assert_eq!(api["external_controller"], "127.0.0.1:9090");
        let secret = api["secret"].as_str().unwrap();
        assert_eq!(secret.len(), 32); // 16 байт hex
    }

    #[test]
    fn harden_config_pins_cache_path_outside_the_working_directory() {
        let raw = r#"{"experimental":{"cache_file":{"enabled":true,"store_rdrc":true}}}"#;
        let cache_path = Path::new(r"C:\Users\test\AppData\Local\Ninety\data\singbox\cache.db");
        let out = harden_config(raw, Some(cache_path));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["experimental"]["cache_file"]["path"],
            cache_path.to_string_lossy().as_ref()
        );
    }

    #[test]
    fn harden_config_passes_invalid_json_through() {
        assert_eq!(harden_config("not json", None), "not json");
    }

    #[test]
    fn runtime_endpoints_prioritize_probe_in_and_keep_dynamic_roles_separate() {
        let control = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap();
        let probe = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap();
        let raw = format!(
            r#"{{
                "experimental":{{"clash_api":{{"external_controller":"{control}"}}}},
                "inbounds":[
                    {{"type":"tun","tag":"tun-in"}},
                    {{"type":"mixed","tag":"mixed-in","listen":"127.0.0.1","listen_port":{}}},
                    {{"type":"mixed","tag":"probe-in","listen":"127.0.0.1","listen_port":{}}}
                ]
            }}"#,
            control.port(),
            probe.port()
        );
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let endpoints = runtime_endpoints_from_value(&value).unwrap();
        assert_eq!(endpoints.control.address, control);
        assert_eq!(
            endpoints.probe_proxy.unwrap().address,
            std::net::SocketAddr::new(
                std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                probe.port()
            )
        );
        assert_ne!(endpoints.control.address, probe);
    }

    #[test]
    fn runtime_endpoints_fallback_to_structurally_valid_mixed_in() {
        let raw = r#"{
            "experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}},
            "inbounds":[{"type":"mixed","tag":"mixed-in","listen":"127.0.0.1","listen_port":9898}]
        }"#;
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let endpoints = runtime_endpoints_from_value(&value).unwrap();
        assert_eq!(endpoints.control.address.port(), 9191);
        assert_eq!(endpoints.probe_proxy.unwrap().address.port(), 9898);
    }

    #[test]
    fn runtime_endpoints_do_not_fallback_to_control_or_unrelated_inbounds() {
        let raw = r#"{
            "experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}},
            "inbounds":[{"type":"mixed","tag":"other","listen":"127.0.0.1","listen_port":7777}]
        }"#;
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let endpoints = runtime_endpoints_from_value(&value).unwrap();
        assert_eq!(endpoints.control.address.port(), 9191);
        assert!(endpoints.probe_proxy.is_none());
    }

    #[test]
    fn runtime_endpoints_reject_non_local_or_wrong_probe_protocol() {
        let non_local = r#"{
            "experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}},
            "inbounds":[{"type":"mixed","tag":"probe-in","listen":"192.0.2.1","listen_port":9898}]
        }"#;
        let non_local_value: serde_json::Value = serde_json::from_str(non_local).unwrap();
        assert!(runtime_endpoints_from_value(&non_local_value).is_err());

        let wrong_protocol = r#"{
            "experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}},
            "inbounds":[{"type":"socks","tag":"probe-in","listen":"127.0.0.1","listen_port":9898}]
        }"#;
        let wrong_protocol_value: serde_json::Value = serde_json::from_str(wrong_protocol).unwrap();
        assert!(runtime_endpoints_from_value(&wrong_protocol_value).is_err());
    }

    #[tokio::test]
    async fn probe_listener_readiness_tracks_the_exact_runtime_endpoint() {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let endpoint = ProbeProxyEndpoint {
            address: listener.local_addr().unwrap(),
        };
        assert!(local_probe_listener_ready(&endpoint).await);
        drop(listener);
        assert!(!local_probe_listener_ready(&endpoint).await);
    }

    #[test]
    fn probe_endpoint_generation_rejects_stale_snapshots() {
        let state = SingboxState::default();
        let endpoint = ProbeProxyEndpoint {
            address: "127.0.0.1:2080".parse().unwrap(),
        };
        *state.runtime.lock_recover() = Some(RuntimeRecord {
            process_generation: 42,
            source_fingerprint: None,
            config_hash: None,
            mode: "systemProxy".into(),
            strict_privacy: false,
            pinned_node_tag: None,
            logs_disabled: false,
            endpoints: RuntimeEndpoints {
                control: ControlEndpoint {
                    address: "127.0.0.1:9090".parse().unwrap(),
                },
                probe_proxy: Some(endpoint),
            },
            listener_ready: true,
            clash_port: 9090,
            clash_ready: true,
        });
        assert_eq!(
            probe_endpoint_for_generation(&state, Some(42)).unwrap().0,
            42
        );
        assert_eq!(
            probe_endpoint_for_generation(&state, Some(41)).unwrap_err(),
            "stale_generation"
        );
    }

    #[test]
    fn log_tail_caps_untrusted_requests() {
        assert_eq!(normalized_log_tail_bytes(None), DEFAULT_LOG_TAIL_BYTES);
        assert_eq!(normalized_log_tail_bytes(Some(0)), 0);
        assert_eq!(
            normalized_log_tail_bytes(Some(u64::MAX)),
            MAX_LOG_TAIL_BYTES
        );
    }

    #[test]
    fn log_tail_handles_small_large_empty_and_missing_files() {
        let dir = test_dir("tail");
        let small = dir.join("small.log");
        std::fs::write(&small, b"alpha\nbeta\n").unwrap();
        assert_eq!(read_tail(&small, Some(128)).unwrap(), "alpha\nbeta\n");

        let large = dir.join("large.log");
        std::fs::write(&large, b"old line\nnew line one\nnew line two\n").unwrap();
        let tail = read_tail(&large, Some(20)).unwrap();
        assert!(tail.contains("bytes truncated above"));
        assert!(tail.ends_with("new line two\n"));

        let empty = dir.join("empty.log");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(read_tail(&empty, None).unwrap(), "");
        assert_eq!(read_tail(&dir.join("missing.log"), None).unwrap(), "");
        assert_eq!(read_tail(&small, Some(0)).unwrap(), "");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn log_tail_handles_no_newline_and_utf8_boundary() {
        let dir = test_dir("utf8");
        let plain = dir.join("plain.log");
        std::fs::write(&plain, b"abcdefghijklmnop").unwrap();
        let tail = read_tail(&plain, Some(5)).unwrap();
        assert!(tail.ends_with("lmnop"));

        let unicode = dir.join("unicode.log");
        std::fs::write(&unicode, "aaaa€tail".as_bytes()).unwrap();
        let tail = read_tail(&unicode, Some(6)).unwrap();
        assert!(tail.ends_with("tail"));
        assert!(!tail.contains('\u{fffd}'));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sidecar_log_names_are_unique_and_strict() {
        assert_eq!(
            sidecar_log_name(SidecarLogKind::Naive, 31201),
            "naive-31201.log"
        );
        assert_ne!(
            sidecar_log_name(SidecarLogKind::Naive, 31201),
            sidecar_log_name(SidecarLogKind::Naive, 31202)
        );
        assert_ne!(
            sidecar_log_name(SidecarLogKind::Naive, 31201),
            sidecar_log_name(SidecarLogKind::TrustTunnel, 31201)
        );
        assert_eq!(SidecarLogKind::parse("../naive"), None);
        assert_eq!(
            sidecar_log_port("naive-31201.log", SidecarLogKind::Naive),
            Some(31201)
        );
        assert_eq!(
            sidecar_log_port("naive-70000.log", SidecarLogKind::Naive),
            None
        );
        assert_eq!(
            sidecar_log_port("naive-../../secret.log", SidecarLogKind::Naive),
            None
        );
    }

    #[test]
    fn sidecar_log_listing_and_clear_are_component_scoped() {
        let dir = test_dir("sidecars");
        for name in [
            "naive.log",
            "naive-31201.log",
            "naive-31202.log",
            "trusttunnel-31301.log",
            "naive-invalid.log",
        ] {
            std::fs::write(dir.join(name), name.as_bytes()).unwrap();
        }
        let paths = component_log_files(&dir, "naive").unwrap();
        assert_eq!(paths.len(), 3);
        assert!(component_log_files(&dir, "../naive").is_err());
        clear_log_files(&paths).unwrap();
        assert!(paths
            .iter()
            .all(|path| std::fs::metadata(path).unwrap().len() == 0));
        assert!(
            std::fs::metadata(dir.join("trusttunnel-31301.log"))
                .unwrap()
                .len()
                > 0
        );
        assert!(
            std::fs::metadata(dir.join("naive-invalid.log"))
                .unwrap()
                .len()
                > 0
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stale_sidecar_log_count_is_bounded() {
        let dir = test_dir("prune");
        for port in 31000..31020 {
            std::fs::write(
                dir.join(sidecar_log_name(SidecarLogKind::Naive, port)),
                b"log",
            )
            .unwrap();
        }
        prune_sidecar_logs(&dir, SidecarLogKind::Naive, &HashSet::new());
        assert!(sidecar_log_entries(&dir, SidecarLogKind::Naive).len() <= MAX_SIDECAR_LOG_FILES);
        std::fs::remove_dir_all(dir).unwrap();
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

    #[test]
    fn runtime_ports_include_custom_clash_inbound_and_local_bridges() {
        let raw = r#"{
          "experimental":{"clash_api":{"external_controller":"127.0.0.1:9191"}},
          "inbounds":[{"listen_port":7899}],
          "outbounds":[
            {"server":"127.0.0.1","server_port":31100},
            {"server":"vpn.example","server_port":443}
          ]
        }"#;
        let value: serde_json::Value = serde_json::from_str(raw).unwrap();
        let endpoints = runtime_endpoints_from_value(&value).unwrap();
        let (clash, ports) = runtime_ports_from_value(&value, &endpoints).unwrap();
        assert_eq!(clash, 9191);
        assert_eq!(ports, vec![7899, 9191, 31100]);
    }

    #[test]
    fn stop_epoch_invalidates_an_in_flight_start() {
        let state = SingboxState::default();
        let epoch = state.start_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(ensure_start_current(&state, epoch).is_ok());
        state.start_epoch.fetch_add(1, Ordering::SeqCst);
        assert!(ensure_start_current(&state, epoch).is_err());
    }

    // Отмена владения операцией (latest-wins смена источника) обязана оставлять
    // ровно то же состояние, что и отмена по epoch: без этого stop_singbox с уже
    // отнятым токеном возвращает refused, а поднятый комплект остаётся жить.
    #[test]
    fn cancelled_start_clears_published_runtime_state() {
        let state = SingboxState::default();
        *state.runtime_ports.lock_recover() = vec![7890, 9090];
        *state.runtime.lock_recover() = Some(RuntimeRecord {
            process_generation: 5,
            source_fingerprint: Some("fingerprint".into()),
            config_hash: None,
            mode: "systemProxy".into(),
            strict_privacy: false,
            pinned_node_tag: None,
            logs_disabled: false,
            endpoints: RuntimeEndpoints {
                control: ControlEndpoint {
                    address: "127.0.0.1:9090".parse().unwrap(),
                },
                probe_proxy: None,
            },
            listener_ready: true,
            clash_port: 9090,
            clash_ready: true,
        });

        abort_started_runtime(&state);

        assert!(state.runtime.lock_recover().is_none());
        assert!(state.runtime_ports.lock_recover().is_empty());
        assert!(!compute_singbox_running(&state));
    }

    #[test]
    fn repeated_stop_keeps_and_deduplicates_pending_targets() {
        let pending = PendingCleanup {
            processes: vec![
                TrackedProcess {
                    pid: 20,
                    creation_time: Some(200),
                },
                TrackedProcess {
                    pid: 10,
                    creation_time: Some(100),
                },
                TrackedProcess {
                    pid: 20,
                    creation_time: Some(200),
                },
            ],
            ports: vec![9090, 31100],
        };
        let (ports, processes) = cleanup_targets(&[7890, 9090], pending);
        assert_eq!(ports, vec![7890, 9090, 31100]);
        assert_eq!(
            processes,
            vec![
                TrackedProcess {
                    pid: 10,
                    creation_time: Some(100),
                },
                TrackedProcess {
                    pid: 20,
                    creation_time: Some(200),
                },
            ]
        );
    }
}
