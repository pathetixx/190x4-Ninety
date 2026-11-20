// Ninety · DPI-обход (winws engine). Запуск/останов движка winws (zapret),
// управление стратегиями и списками. winws грузит kernel-драйвер WinDivert →
// требует админ-прав: фронт перед стартом гарантирует элевацию (та же инфра,
// что у TUN: is_elevated/relaunch_elevated), winws стартует как наш child и
// наследует права. Бинари движка — read-only в resource_dir (install dir),
// списки — writable-копия в app_data (для exclude VPN-нод и режима ipset).
//
// Точки интеграции backend↔frontend: dpi_start/stop/running, dpi_strategies,
// dpi_domains_count, dpi_set_active_vpn_endpoint (главный риск из спайка — нода
// VPN в exclude, иначе winws корёжит зашифрованный VLESS).

use std::net::IpAddr;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::atomic_file::{copy_replace, overwrite_in_place, write_bytes_replace, write_replace};
use crate::util::MutexExt;
use reqwest::Response;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct DpiState {
    // Child winws.exe. None — не запущен. Хэндл мутабелен для try_wait/kill.
    child: Mutex<Option<Child>>,
    // Короткие start/autotest операции сериализуются и получают generation.
    // stop увеличивает generation: старый async-код после любого await видит
    // отмену и не может оживить процесс или перетереть состояние новой сессии.
    control: Mutex<DpiControl>,
    // operation в control обнуляется сразу при cancel, но async start/autotest
    // ещё может завершать текущий await. Этот флаг живёт до Drop guard'а и не
    // позволяет stop/unload вернуть успех раньше фактического завершения таска.
    operation_active: AtomicBool,
    // Грузился ли kernel-драйвер WinDivert в этой сессии (winws хоть раз стартовал).
    // Гейт для sc-выгрузки при выходе: если DPI не включали, snимать службы нечего —
    // а безусловный `sc.exe` на каждый выход давал окно ошибки 0xc0000142 при
    // выключении ПК (sc.exe не поднимается в сворачивающейся сессии). Сбрасывается
    // после фактической выгрузки службы (full_unload).
    driver_loaded: AtomicBool,
    // Службы, чей ImagePath был проверен как принадлежащий каталогу Ninety.
    // Никогда не останавливаем глобальные WinDivert/WinDivert14 вслепую.
    owned_services: Mutex<Vec<String>>,
    // Мутации подписанного DPI-набора, локальных списков и ACTIVE_*.bin должны
    // быть линейными: sync переносит их в новое поколение перед commit pointer.
    data: tokio::sync::Mutex<()>,
    // Сеанс winws, поднятый dpi_start: id = generation его операции. 0 — штатного
    // сеанса нет (остановлен, перезапускается или идёт автоподбор). Меняется
    // только под локом child: выход процесса при живом сеансе — падение и
    // событие dpi:exited, а плановая остановка сначала обнуляет сеанс.
    runtime_session: AtomicU64,
    // Счётчик запросов исключения VPN-нод. DNS ждём вне лока данных, поэтому
    // запрос, обогнанный более новым, свой результат не пишет.
    endpoint_seq: AtomicU64,
}

#[derive(Default)]
struct DpiControl {
    generation: u64,
    operation: Option<&'static str>,
}

const CHILD_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const DRIVER_UNLOAD_TIMEOUT: Duration = Duration::from_secs(3);

fn terminate_child_bounded(child: &mut Child, label: &str) -> Result<(), String> {
    let kill_error = child.kill().err();
    let deadline = Instant::now() + CHILD_STOP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => return Err(format!("{label} did not exit within 2 seconds")),
            Err(e) => return Err(format!("could not confirm that {label} stopped: {e}")),
        }
        if let Some(e) = kill_error.as_ref() {
            // Ошибка kill допустима только если try_wait выше уже подтвердил,
            // что процесс успел завершиться самостоятельно.
            if Instant::now() >= deadline {
                return Err(format!("could not stop {label}: {e}"));
            }
        }
    }
}

fn stop_managed_child(state: &DpiState, label: &str) -> Result<(), String> {
    // Сеанс обнуляем под тем же локом, под которым забираем хэндл: сторож
    // выхода либо успел увидеть падение раньше (и тогда хэндла уже нет), либо
    // увидит нулевой сеанс и плановую остановку падением не назовёт.
    let taken = {
        let mut guard = state.child.lock_recover();
        state.runtime_session.store(0, Ordering::SeqCst);
        guard.take()
    };
    let Some(mut child) = taken else {
        return Ok(());
    };
    match terminate_child_bounded(&mut child, label) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Не теряем handle: повторная команда должна реально повторить
            // остановку, а не принять None за подтверждённый успех.
            *state.child.lock_recover() = Some(child);
            Err(e)
        }
    }
}

fn stop_dpi_runtime(state: &DpiState, label: &str) -> Result<(), String> {
    let cancelled = cancel_dpi_operation(state);
    stop_managed_child(state, label)?;
    // sync_channel процессов не порождает — он переносит файлы поколения, и на
    // медленном диске это заметно дольше двух секунд. Ожидание такой операции
    // превращало обычное отключение обхода в ошибку «отменяемая операция не
    // завершилась», хотя winws к этому моменту уже физически остановлен.
    if !operation_can_spawn(cancelled) {
        return Ok(());
    }
    let deadline = Instant::now() + CHILD_STOP_TIMEOUT;
    while state.operation_active.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return Err(format!(
                "{label}: the cancelled operation did not finish within 2 seconds"
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // Операция могла успеть spawn'ить child между первым take и проверкой
    // generation. После Drop guard'а делаем финальный подтверждённый stop.
    stop_managed_child(state, label)
}

fn begin_dpi_operation(state: &DpiState, name: &'static str) -> Result<u64, String> {
    if state.operation_active.swap(true, Ordering::SeqCst) {
        return Err(crate::util::i18n_error("backend.dpi.busy"));
    }
    let mut control = state.control.lock_recover();
    if control.operation.is_some() {
        state.operation_active.store(false, Ordering::SeqCst);
        return Err(crate::util::i18n_error("backend.dpi.busy"));
    }
    control.generation = control.generation.wrapping_add(1);
    control.operation = Some(name);
    Ok(control.generation)
}

fn dpi_operation_current(state: &DpiState, generation: u64) -> bool {
    let control = state.control.lock_recover();
    control.generation == generation && control.operation.is_some()
}

async fn wait_dpi_cancelled(state: &DpiState, generation: u64) {
    while dpi_operation_current(state, generation) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn dpi_sleep_or_cancel(
    state: &DpiState,
    generation: u64,
    duration: Duration,
) -> Result<(), String> {
    tokio::select! {
        _ = tokio::time::sleep(duration) => Ok(()),
        _ = wait_dpi_cancelled(state, generation) => Err(crate::util::i18n_error("backend.dpi.cancelled")),
    }
}

fn cancel_dpi_operation(state: &DpiState) -> Option<&'static str> {
    let mut control = state.control.lock_recover();
    control.generation = control.generation.wrapping_add(1);
    control.operation.take()
}

// Операции, которые сами поднимают winws. Только их stop обязан дожидаться:
// такая операция может спавнить процесс уже после того, как stop забрал хэндл,
// и без ожидания остановка вернула бы успех на живом процессе.
fn operation_can_spawn(name: Option<&str>) -> bool {
    matches!(name, Some("start") | Some("autotest"))
}

struct DpiOperationGuard<'a> {
    state: &'a DpiState,
    generation: u64,
}

impl Drop for DpiOperationGuard<'_> {
    fn drop(&mut self) {
        let mut control = self.state.control.lock_recover();
        if control.generation == self.generation {
            control.operation = None;
        }
        self.state.operation_active.store(false, Ordering::SeqCst);
    }
}

// ── Сторож выхода winws ─────────────────────────────────────────────
// Раньше падение winws посреди сессии не замечал никто: фронт продолжал
// показывать «Работает», пока пользователь сам не открывал раздел. Сторож
// только сообщает факт — что показать и надо ли поднимать движок снова,
// решает фронт.
const DPI_EXITED_EVENT: &str = "dpi:exited";
const DPI_EXIT_POLL: Duration = Duration::from_millis(500);

#[derive(Serialize, Clone, Debug)]
struct DpiExitedEvent {
    // generation операции dpi_start, поднявшей упавший сеанс.
    generation: u64,
    code: Option<i32>,
    // i18n-токен для баннера ошибки.
    message: String,
}

fn dpi_exited_event(generation: u64, code: Option<i32>) -> DpiExitedEvent {
    let code_text = code.map_or_else(|| "?".to_string(), |code| code.to_string());
    DpiExitedEvent {
        generation,
        code,
        message: crate::util::i18n_error_with(
            "backend.dpi.exitedUnexpectedly",
            &[("code", &code_text)],
        ),
    }
}

// Забрать хэндл winws, если штатный сеанс умер сам. expected=Some(id) — сторож
// конкретного сеанса: чужой (более новый) сеанс он не трогает. None — любой
// текущий сеанс (dpi_running тоже может первым наткнуться на труп).
fn reap_unexpected_exit(state: &DpiState, expected: Option<u64>) -> Option<DpiExitedEvent> {
    let mut guard = state.child.lock_recover();
    let session = state.runtime_session.load(Ordering::SeqCst);
    if session == 0 || expected.is_some_and(|id| id != session) {
        return None;
    }
    let status = match guard.as_mut()?.try_wait() {
        Ok(Some(status)) => status,
        _ => return None,
    };
    *guard = None;
    state.runtime_session.store(0, Ordering::SeqCst);
    Some(dpi_exited_event(session, status.code()))
}

fn spawn_dpi_exit_watcher(app: AppHandle, session: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(DPI_EXIT_POLL).await;
            let exited = {
                let state = app.state::<DpiState>();
                if state.runtime_session.load(Ordering::SeqCst) != session {
                    return; // плановая остановка или новый сеанс — не наш случай
                }
                reap_unexpected_exit(&state, Some(session))
            };
            if let Some(event) = exited {
                let _ = app.emit(DPI_EXITED_EVENT, event);
                return;
            }
        }
    });
}

#[derive(Deserialize, Serialize)]
struct Strategy {
    id: String,
    #[serde(default)]
    name: String,
    // Описание для UI; в winws не уходит.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    desc: String,
    #[serde(default)]
    experimental: bool,
    args: Vec<String>,
}

// Канал данных стратегий: подписанный prerelease-ассет, который вручную
// публикует reviewed workflow dpi-channel.yml из зафиксированного релиза Flowseal.
// Ninety тянет его на лету,
// проверяет minisign-подпись и применяет — БЕЗ обновления приложения. Возит только
// данные (strategies.json + списки + .bin), движок едет через OTA (см. engine-watch).
const CHANNEL_BASE: &str =
    "https://github.com/pathetixx/190x4-Ninety/releases/download/dpi-channel";
const MAX_CHANNEL_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHANNEL_SIGNATURE_BYTES: u64 = 64 * 1024;
const MAX_CHANNEL_TEXT_BYTES: u64 = 256 * 1024;
const MAX_CHANNEL_ENTRIES: usize = 2048;
const MAX_CHANNEL_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CHANNEL_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;
static TEMP_FILE_SEQ: AtomicU64 = AtomicU64::new(0);
const CHANNEL_POINTER_FILE: &str = "channel-current";
const CHANNEL_GENERATIONS_DIR: &str = "channel-generations";
const CHANNEL_LIST_FILES: [&str; 4] = [
    "list-general.txt",
    "list-google.txt",
    "list-exclude.txt",
    "ipset-exclude.txt",
];
const LOCAL_LIST_FILES: [&str; 9] = [
    "list-general-user.txt",
    "list-exclude-user.txt",
    "ipset-exclude-user.txt",
    "active-vpn-domain.txt",
    "active-vpn-ip.txt",
    "ipset-all.txt",
    IPSET_BASE_FILE,
    "ipset-game.txt",
    // Автосписок — результат обучения на живом трафике, а не часть канала:
    // без переноса каждое обновление стратегий обнуляло бы его, и заблокированные
    // сайты снова открывались бы с третьего раза.
    AUTO_HOSTLIST_FILE,
];
const IPSET_SERVICE_FILE: &str = "ipset-service.txt";
const IPSET_BASE_FILE: &str = "ipset-all.base.txt";
const CHANNEL_SERVICE_FILES: [&str; 2] = ["hosts", IPSET_SERVICE_FILE];
// Подписанный бандл и его подпись лежат в поколении рядом с распакованными
// файлами. Каталог данных доступен на запись обычному пользователю, поэтому
// service-файлы (hosts уходит в системный файл из elevated-процесса) читаются
// не с диска на веру, а из бандла после проверки подписи.
const GENERATION_BUNDLE_FILE: &str = "bundle.zip";
const GENERATION_SIGNATURE_FILE: &str = "bundle.zip.sig";

struct StagingDirGuard {
    path: PathBuf,
    keep: bool,
}

impl Drop for StagingDirGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
// Dedicated ключ канала DPI. Новые bundle подписываются только им.
// base64 от файла minisign-pubkey; он намеренно НЕ совпадает с OTA updater key.
const CHANNEL_DEDICATED_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ4NDI2MThEQTc1QTVBMEYKUldRUFdscW5qV0ZDMklsd25RR2JhQlZLTWt3dmQ2L3gvSWozdTV4My9xS3Fhcy84MElXZ1h4LzYK";
// Переходное доверие: уже опубликованный dpi-channel подписан legacy OTA key.
// Удалять только отдельным релизом после ручной ротации канала, см.
// docs/DPI_CHANNEL_KEY_ROTATION.md.
const CHANNEL_LEGACY_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc1N0I1RTAwMEQ3MUQ3OUUKUldTZTEzRU5BRjU3ZGN3TkZoK28yeFRVa2tLdlhxNy8zUXo1aUdXN1lOSUE3MzZLUmVCRnFYamsK";

// ── Пути ────────────────────────────────────────────────────────────
// Каталог движка в ресурсах (read-only): <resource_dir>/dpi.
fn res_dpi(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?
        .join("dpi");
    Ok(dir)
}
// monkey=true → каталог bin-monkey: тот же winws.exe + cygwin1.dll, но WinDivert.dll
// с пропатченными широкими строками (служба WinDivert→Monkey, файл драйвера
// WinDivert64.sys→Monkey64.sys; имя устройства \\.\WinDivert сохранено — его
// создаёт сам .sys в DriverEntry, Monkey64.sys байт-идентичен WinDivert64.sys).
// Драйвер грузится по той же подписи Microsoft/WDF, но в SCM и на диске значится
// как «Monkey» → имя WinDivert не светится в списке служб/файлов. На функционал
// обхода не влияет.
fn bin_dir(app: &AppHandle, monkey: bool) -> Result<PathBuf, String> {
    Ok(res_dpi(app)?.join(if monkey { "bin-monkey" } else { "bin" }))
}
fn res_lists(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(res_dpi(app)?.join("lists"))
}

fn valid_channel_generation_name(name: &str) -> bool {
    name.starts_with("gen-")
        && name.len() <= 128
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn validate_channel_generation(path: &Path) -> Result<(), String> {
    let required_files = [
        path.join("strategies.json"),
        path.join("version.txt"),
        path.join("lists").join(CHANNEL_LIST_FILES[0]),
        path.join("lists").join(CHANNEL_LIST_FILES[1]),
        path.join("lists").join(CHANNEL_LIST_FILES[2]),
        path.join("lists").join(CHANNEL_LIST_FILES[3]),
        path.join("service").join(CHANNEL_SERVICE_FILES[0]),
        path.join("service").join(CHANNEL_SERVICE_FILES[1]),
    ];
    for file in required_files {
        let metadata = std::fs::symlink_metadata(&file).map_err(|e| {
            format!(
                "DPI channel generation incomplete ({}): {e}",
                file.display()
            )
        })?;
        if !metadata.file_type().is_file() {
            return Err(format!(
                "DPI channel generation contains a non-file: {}",
                file.display()
            ));
        }
    }
    let bin = path.join("bin-data");
    let metadata = std::fs::symlink_metadata(&bin)
        .map_err(|e| format!("DPI channel generation has no bin-data: {e}"))?;
    if !metadata.file_type().is_dir() {
        return Err("DPI channel generation bin-data is not a directory".into());
    }
    Ok(())
}

struct ChannelResolution {
    // Поколение, которым реально пользуемся: то, что в pointer, либо самое
    // свежее целое из сохранённых. None — встроенные ресурсы.
    active: Option<PathBuf>,
    // pointer есть, но указывает на испорченное/исчезнувшее поколение.
    pointer_broken: bool,
}

// Диагностику испорченного поколения пишем один раз на одно и то же сообщение:
// резолв зовётся из каждой DPI-команды, и лог иначе зарос бы одной строкой.
static LAST_CHANNEL_DIAGNOSTIC: Mutex<String> = Mutex::new(String::new());

fn report_channel_diagnostic(message: &str) {
    let mut last = LAST_CHANNEL_DIAGNOSTIC.lock_recover();
    if *last != message {
        eprintln!("{message}");
        *last = message.to_string();
    }
}

// Ключ свежести поколения: gen-<nanos>-<pid>-<seq>. Битое имя — в самый низ.
fn channel_generation_age_key(name: &str) -> (u128, u64) {
    let mut parts = name.split('-').skip(1);
    let nanos = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let seq = parts.nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    (nanos, seq)
}

// Самое свежее целое поколение, кроме испорченного `skip`. Предыдущее
// поколение cleanup сохраняет как раз на такой случай.
fn newest_valid_channel_generation(generations: &Path, skip: Option<&str>) -> Option<PathBuf> {
    let entries = std::fs::read_dir(generations).ok()?;
    let mut best: Option<((u128, u64), String)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_channel_generation_name(&name) || skip == Some(name.as_str()) {
            continue;
        }
        if validate_channel_generation(&entry.path()).is_err() {
            continue;
        }
        let key = channel_generation_age_key(&name);
        if best
            .as_ref()
            .is_none_or(|(best_key, best_name)| (key, &name) > (*best_key, best_name))
        {
            best = Some((key, name));
        }
    }
    best.map(|(_, name)| generations.join(name))
}

// Испорченное активное поколение больше не роняет весь раздел DPI (включая
// «Обновить», которое его и чинит): откатываемся на предыдущее целое
// поколение или на встроенные ресурсы и запоминаем, что нужна синхронизация.
fn resolve_channel_generation(dpi_data: &Path) -> ChannelResolution {
    let pointer = dpi_data.join(CHANNEL_POINTER_FILE);
    let generations = dpi_data.join(CHANNEL_GENERATIONS_DIR);
    let (problem, skip) = match std::fs::read_to_string(&pointer) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ChannelResolution {
                active: None,
                pointer_broken: false,
            }
        }
        Err(e) => (format!("read DPI channel pointer: {e}"), None),
        Ok(raw) => {
            let name = raw.trim().to_string();
            if !valid_channel_generation_name(&name) {
                ("DPI channel pointer is invalid".to_string(), None)
            } else {
                match validate_channel_generation(&generations.join(&name)) {
                    Ok(()) => {
                        return ChannelResolution {
                            active: Some(generations.join(name)),
                            pointer_broken: false,
                        }
                    }
                    Err(error) => (error, Some(name)),
                }
            }
        }
    };
    let fallback = newest_valid_channel_generation(&generations, skip.as_deref());
    report_channel_diagnostic(&format!(
        "{problem}; falling back to {}",
        fallback.as_ref().map_or_else(
            || "the bundled DPI set".to_string(),
            |path| path.display().to_string()
        )
    ));
    ChannelResolution {
        active: fallback,
        pointer_broken: true,
    }
}

fn active_channel_generation_from_dpi(dpi_data: &Path) -> Option<PathBuf> {
    resolve_channel_generation(dpi_data).active
}

fn active_channel_generation(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let dpi_data = crate::app_paths::data_dir(app)?.join("dpi");
    Ok(active_channel_generation_from_dpi(&dpi_data))
}

fn channel_generation_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("gen-{nanos}-{}-{seq}", std::process::id())
}

#[cfg(target_os = "windows")]
fn finalize_channel_generation(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|e| format!("finalize DPI channel generation: {e}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn finalize_channel_generation(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| format!("finalize DPI channel generation: {e}"))
}

// ── Собственные добавки Ninety к спискам ────────────────────────────
// Канал (dpi-channel.yml) копирует списки Flowseal как есть, поэтому добавки
// Ninety не живут в базовых файлах: после «Обновить» они бы пропадали. Они
// хранятся здесь и накладываются поверх любого базового набора — встроенного
// и канального — при каждой записи, без дублей.
// Vivox (голос Unity, AS35028): 85.236.104.0/23 в /21 не входит.
const NINETY_GENERAL_ADDITIONS: [&str; 1] = ["vivox.com"];
const NINETY_IPSET_ADDITIONS: [&str; 2] = ["85.236.96.0/21", "85.236.104.0/23"];
// Маркер версии встроенных базовых списков в legacy-каталоге (без канала).
const BUNDLED_LISTS_MARKER: &str = ".bundled-lists-version";

// Текст списка с добавками в конце. None — все добавки уже есть (сравнение
// без регистра, комментарии и пустые строки не в счёт).
fn with_list_additions(text: &str, additions: &[&str]) -> Option<String> {
    let present: std::collections::HashSet<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("//"))
        .map(str::to_ascii_lowercase)
        .collect();
    let mut seen = std::collections::HashSet::new();
    let missing: Vec<&str> = additions
        .iter()
        .copied()
        .filter(|entry| {
            let key = entry.to_ascii_lowercase();
            !present.contains(&key) && seen.insert(key)
        })
        .collect();
    if missing.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(text.len() + missing.len() * 24);
    out.push_str(text);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for entry in missing {
        out.push_str(entry);
        out.push('\n');
    }
    Some(out)
}

fn apply_list_additions(path: &Path, additions: &[&str], label: &str) -> Result<(), String> {
    let text = read_list_text(path)?;
    if let Some(updated) = with_list_additions(&text, additions) {
        write_replace(path, &updated, label)?;
    }
    Ok(())
}

// Версия встроенных списков: меняется с каждой версией приложения и набора.
fn bundled_lists_stamp(app: &AppHandle) -> String {
    format!(
        "{}+{}",
        app.package_info().version,
        bundled_strategies_version()
    )
}

// Базовые списки legacy-каталога (установка без канала) — копия ресурсов
// приложения. Раньше их копировали только при отсутствии файла, и у старых
// установок они навсегда оставались от первой установки. Теперь при смене
// версии приложения/набора базовые файлы переписываются из ресурсов.
// Пользовательские (*-user.txt), сессионные и автосписок здесь не трогаются,
// writable-база ipset (её двигает «Обновить список») — тоже.
fn refresh_bundled_base_lists(dst: &Path, src: &Path, stamp: &str) -> Result<(), String> {
    let marker = dst.join(BUNDLED_LISTS_MARKER);
    let current = std::fs::read_to_string(&marker).unwrap_or_default();
    let refresh = current.trim() != stamp;
    for name in CHANNEL_LIST_FILES {
        let to = dst.join(name);
        if !refresh && to.exists() {
            continue;
        }
        let from = src.join(name);
        if from.is_file() {
            copy_replace(&from, &to, &format!("bundled list {name}"))?;
        } else if !to.exists() {
            write_replace(&to, "", &format!("empty list {name}"))?;
        }
    }
    if refresh {
        write_replace(&marker, &format!("{stamp}\n"), "bundled lists version")?;
    }
    Ok(())
}

// Засеять writable-списки. В поколении канала базовые списки принадлежат
// каналу (досоздаём только пропавшие), в legacy-каталоге — ресурсам
// приложения и обновляются вместе с ним. Добавки Ninety накладываются поверх
// в обоих случаях, user-списки создаём пустыми. ipset-all.txt пишется
// отдельно по режиму.
fn ensure_lists(app: &AppHandle) -> Result<PathBuf, String> {
    let generation = active_channel_generation(app)?;
    let dst = match &generation {
        Some(generation) => generation.join("lists"),
        None => crate::app_paths::data_dir(app)?.join("dpi").join("lists"),
    };
    std::fs::create_dir_all(&dst).map_err(|e| format!("mkdir lists: {e}"))?;
    let src = res_lists(app)?;
    if generation.is_some() {
        for name in CHANNEL_LIST_FILES {
            let to = dst.join(name);
            if !to.exists() {
                let from = src.join(name);
                if from.is_file() {
                    copy_replace(&from, &to, &format!("seed {name}"))?;
                } else {
                    write_replace(&to, "", &format!("touch {name}"))?;
                }
            }
        }
    } else {
        refresh_bundled_base_lists(&dst, &src, &bundled_lists_stamp(app))?;
    }
    apply_list_additions(
        &dst.join("list-general.txt"),
        &NINETY_GENERAL_ADDITIONS,
        "Ninety list additions",
    )?;
    for name in [
        "list-general-user.txt",
        "list-exclude-user.txt",
        "ipset-exclude-user.txt",
        // Пустой всегда: снимает ipset-гейт с секций Game Filter, не завися от
        // режима IPset (write_ipset_mode пишет только ipset-all.txt).
        "ipset-game.txt",
        // Автосписок заблокированных доменов. Ведёт его сам winws в режиме
        // «Только заблокированные»; нам достаточно, чтобы файл существовал —
        // winws открывает его на чтение при старте, до первой записи.
        AUTO_HOSTLIST_FILE,
        "active-vpn-domain.txt",
        "active-vpn-ip.txt",
    ] {
        let to = dst.join(name);
        if !to.exists() {
            std::fs::write(&to, b"").map_err(|e| format!("touch {name}: {e}"))?;
        }
    }
    Ok(dst)
}

// Writable-каталог .bin-пейлоадов: bin-data активного поколения либо legacy
// <app_data>/dpi/bin-data. Движок (winws.exe + драйвер) остаётся read-only в
// ресурсе. winws читает .bin по абсолютному пути (%BIN%), независимо от cwd.
fn bindata_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match active_channel_generation(app)? {
        Some(generation) => generation.join("bin-data"),
        None => crate::app_paths::data_dir(app)?
            .join("dpi")
            .join("bin-data"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir bin-data: {e}"))?;
    Ok(dir)
}

// Поддерживать writable bin-data в рабочем состоянии. Без channel-overlay
// встроенный набор приложения является источником истины: это важно при
// обновлении Ninety с Flowseal <1.10, где bin-data уже не пуст, но ACTIVE_*.bin
// ещё отсутствуют. При наличии overlay его подписанный набор является
// единственным источником истины: удалённые каналом файлы не воскрешаем из app.
// Исключение — поколение, чьи стратегии не подтверждены подписью: тогда
// работают встроенные стратегии, и недостающие им .bin досоздаются из ресурса
// (существующие файлы поколения и выбор UDP fake не трогаем).
fn ensure_bindata(app: &AppHandle, active: &ActiveStrategies) -> Result<PathBuf, String> {
    let dst = bindata_dir(app)?;
    if active.channel.is_none() && active_channel_generation(app)?.is_some() {
        copy_missing_bundled_bins(app, &dst, &active.strategies)?;
    } else {
        sync_bundled_bindata(app, &dst)?;
    }
    let _ = reapply_fake_selection(app, &dst)?;
    Ok(dst)
}

fn copy_missing_bundled_bins(
    app: &AppHandle,
    dst: &Path,
    strategies: &[Strategy],
) -> Result<(), String> {
    let src = bin_dir(app, false)?;
    for name in referenced_bins(strategies) {
        if !valid_bin_filename(&name) || dst.join(&name).is_file() {
            continue;
        }
        let from = src.join(&name);
        if from.is_file() {
            copy_replace(&from, &dst.join(&name), &format!("bundled bin {name}"))?;
        }
    }
    Ok(())
}

const ACTIVE_DISCORD_FAKE: &str = "ACTIVE_DISCORD_UDP.bin";
const ACTIVE_GAME_FAKE: &str = "ACTIVE_GAME_UDP.bin";
const MAX_DPI_PAYLOAD_BYTES: u64 = 1024 * 1024;

#[derive(Default, Deserialize, Serialize)]
struct FakeSelection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    discord: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    game: Option<String>,
}

fn fake_selection_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(match active_channel_generation(app)? {
        Some(generation) => generation.join("fake-selection.json"),
        None => crate::app_paths::data_dir(app)?
            .join("dpi")
            .join("fake-selection.json"),
    })
}

fn valid_fake_filename(name: &str) -> bool {
    valid_bin_filename(name) && !name.to_ascii_lowercase().starts_with("active_")
}

fn valid_bin_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !name.is_empty()
        && name.len() <= 128
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && lower.ends_with(".bin")
}

fn fake_target(kind: &str) -> Result<&'static str, String> {
    match kind {
        "discord" => Ok(ACTIVE_DISCORD_FAKE),
        "game" => Ok(ACTIVE_GAME_FAKE),
        _ => Err("unknown UDP fake type".into()),
    }
}

fn fake_options(dir: &Path) -> Result<Vec<String>, String> {
    let mut options = Vec::new();
    let rd = std::fs::read_dir(dir).map_err(|e| format!("read bin-data: {e}"))?;
    for item in rd {
        let entry = item.map_err(|e| format!("read bin-data entry: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("fake file type: {e}"))?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_fake_filename(&name) {
            continue;
        }
        let size = entry
            .metadata()
            .map_err(|e| format!("fake metadata: {e}"))?
            .len();
        if (1..=MAX_DPI_PAYLOAD_BYTES).contains(&size) {
            options.push(name);
        }
    }
    options.sort_by_key(|name| name.to_ascii_lowercase());
    Ok(options)
}

fn load_fake_selection(app: &AppHandle) -> FakeSelection {
    let Ok(path) = fake_selection_path(app) else {
        return FakeSelection::default();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return FakeSelection::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_fake_selection(app: &AppHandle, selection: &FakeSelection) -> Result<(), String> {
    let path = fake_selection_path(app)?;
    save_fake_selection_at(&path, selection)
}

fn save_fake_selection_at(path: &Path, selection: &FakeSelection) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(selection)
        .map_err(|e| format!("serialize fake selection: {e}"))?;
    write_replace(path, &format!("{raw}\n"), "fake selection")
}

fn files_equal(left: &Path, right: &Path) -> bool {
    let Ok(left_meta) = std::fs::metadata(left) else {
        return false;
    };
    let Ok(right_meta) = std::fs::metadata(right) else {
        return false;
    };
    if !left_meta.is_file()
        || !right_meta.is_file()
        || left_meta.len() == 0
        || left_meta.len() != right_meta.len()
        || left_meta.len() > MAX_DPI_PAYLOAD_BYTES
    {
        return false;
    }
    match (std::fs::read(left), std::fs::read(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn sync_bundled_bindata(app: &AppHandle, dst: &Path) -> Result<(), String> {
    let src = bin_dir(app, false)?;
    if active_channel_generation(app)?.is_some() {
        return Ok(());
    }
    // Legacy-оверлей <data>/dpi/strategies.json больше не читается (см.
    // load_strategies), поэтому без поколения встроенный набор .bin
    // авторитетен всегда — он идёт в паре со встроенными стратегиями.
    let mut bundled = std::collections::HashSet::new();
    let rd = std::fs::read_dir(&src).map_err(|e| format!("read bundled bin: {e}"))?;
    for item in rd {
        let entry = item.map_err(|e| format!("read bundled bin entry: {e}"))?;
        if !entry
            .file_type()
            .map_err(|e| format!("bundled bin file type: {e}"))?
            .is_file()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_bin_filename(&name) {
            continue;
        }
        bundled.insert(name.clone());
        let from = entry.path();
        let to = dst.join(&name);
        if !to.exists() || !files_equal(&from, &to) {
            copy_replace(&from, &to, &format!("bundled bin {name}"))?;
        }
    }

    // Без channel-overlay удаляем только устаревшие валидные .bin из нашего
    // управляемого каталога. Так исчезнувший upstream-кандидат не остаётся
    // доступным под старым именем после обновления приложения.
    let rd = std::fs::read_dir(dst).map_err(|e| format!("read bin-data: {e}"))?;
    for item in rd {
        let entry = item.map_err(|e| format!("read bin-data entry: {e}"))?;
        if !entry
            .file_type()
            .map_err(|e| format!("bin-data file type: {e}"))?
            .is_file()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if valid_bin_filename(&name) && !bundled.contains(&name) {
            std::fs::remove_file(entry.path())
                .map_err(|e| format!("remove stale bin {name}: {e}"))?;
        }
    }
    Ok(())
}

fn current_fake_name(
    dir: &Path,
    active_name: &str,
    options: &[String],
    preferred: Option<&str>,
) -> Option<String> {
    let active = dir.join(active_name);
    if let Some(name) = preferred.filter(|name| valid_fake_filename(name)) {
        if files_equal(&active, &dir.join(name)) {
            return Some(name.to_string());
        }
    }
    options
        .iter()
        .find(|name| files_equal(&active, &dir.join(name)))
        .cloned()
}

fn apply_fake_file(dir: &Path, kind: &str, file: &str) -> Result<(), String> {
    if !valid_fake_filename(file) {
        return Err("invalid fake file name".into());
    }
    let source = dir.join(file);
    let meta =
        std::fs::symlink_metadata(&source).map_err(|e| format!("fake '{file}' not found: {e}"))?;
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > MAX_DPI_PAYLOAD_BYTES {
        return Err("fake file is empty, too large or not a regular file".into());
    }
    let target = dir.join(fake_target(kind)?);
    copy_replace(&source, &target, &format!("{kind} UDP fake"))
}

fn fake_source_usable(dir: &Path, file: &str) -> bool {
    if !valid_fake_filename(file) {
        return false;
    }
    std::fs::symlink_metadata(dir.join(file))
        .map(|meta| meta.file_type().is_file() && (1..=MAX_DPI_PAYLOAD_BYTES).contains(&meta.len()))
        .unwrap_or(false)
}

// После обновления канала upstream ACTIVE_*.bin заменяются дефолтами. Явный
// выбор пользователя хранится отдельно и накладывается поверх свежего набора.
// Если выбранный upstream-файл исчез, сбрасываем только этот слот на новый
// дефолт — весь sync из-за устаревшего выбора не блокируем.
fn reapply_fake_selection_with_inventory(
    app: &AppHandle,
    dir: &Path,
    inventory: Option<&std::collections::HashSet<String>>,
) -> Result<Vec<String>, String> {
    let mut selection = load_fake_selection(app);
    let reset = reapply_fake_selection_value(dir, inventory, &mut selection)?;
    if !reset.is_empty() {
        save_fake_selection(app, &selection)?;
    }
    Ok(reset)
}

fn reapply_fake_selection_value(
    dir: &Path,
    inventory: Option<&std::collections::HashSet<String>>,
    selection: &mut FakeSelection,
) -> Result<Vec<String>, String> {
    let mut reset = Vec::new();
    for kind in ["discord", "game"] {
        let selected = match kind {
            "discord" => selection.discord.clone(),
            _ => selection.game.clone(),
        };
        let Some(file) = selected else {
            continue;
        };
        if inventory.is_some_and(|files| !files.contains(&file)) || !fake_source_usable(dir, &file)
        {
            match kind {
                "discord" => selection.discord = None,
                _ => selection.game = None,
            }
            reset.push(kind.to_string());
            continue;
        }
        // Ошибка записи ACTIVE_* — реальный сбой I/O, а не устаревший выбор:
        // не скрываем её сбросом маркера и не продолжаем с частично применённым sync.
        apply_fake_file(dir, kind, &file)?;
    }
    Ok(reset)
}

fn reapply_fake_selection(app: &AppHandle, dir: &Path) -> Result<Vec<String>, String> {
    reapply_fake_selection_with_inventory(app, dir, None)
}

// ── Стратегии: источник и allowlist аргументов ─────────────────────
// Аргументы стратегии уходят в winws, который работает с правами
// администратора, а каталог данных доступен на запись обычному пользователю.
// Поэтому strategies.json с диска на веру больше не читается нигде:
//   - канальная стратегия — только из подписанного bundle.zip активного
//     поколения (подпись проверяется при каждом чтении);
//   - встроенная — из самого исполняемого файла (include_str!), той же сборки,
//     что ресурсные .bin и списки;
//   - legacy-оверлей <data>/dpi/strategies.json игнорируется.
// Вторая линия — allowlist флагов, зеркало gen_strategies.py::validate_arg.
const BUNDLED_STRATEGIES_JSON: &str = include_str!("../dpi/strategies.json");
const BUNDLED_STRATEGIES_VERSION: &str = include_str!("../dpi/version.txt");
const MAX_STRATEGIES: usize = 64;
const MAX_STRATEGY_ARGS: usize = 512;
const MAX_STRATEGY_ARG_LEN: usize = 4096;

fn bundled_strategies_version() -> String {
    let version = BUNDLED_STRATEGIES_VERSION.trim();
    if version.is_empty() {
        "—".into()
    } else {
        version.to_string()
    }
}

const DESYNC_VALUES: [&str; 9] = [
    "fake",
    "fake,fakedsplit",
    "fake,hostfakesplit",
    "fake,multidisorder",
    "fake,multisplit",
    "hostfakesplit",
    "multisplit",
    "syndata",
    "syndata,multidisorder",
];
const FOOLING_VALUES: [&str; 3] = ["badseq", "ts", "ts,md5sig"];
const L7_VALUES: [&str; 3] = ["quic", "discord,stun", "discord,stun,unknown"];
const BIN_FLAGS: [&str; 6] = [
    "--dpi-desync-fake-discord",
    "--dpi-desync-fake-http",
    "--dpi-desync-fake-quic",
    "--dpi-desync-fake-stun",
    "--dpi-desync-fake-unknown-udp",
    "--dpi-desync-split-seqovl-pattern",
];

// Файловые флаги списков: только наши имена под %LISTS%. Служебные
// --hostlist-auto* и исключение активной ноды добавляет само приложение после
// проверки, стратегия задать их не может.
fn allowed_list_values(flag: &str) -> Option<&'static [&'static str]> {
    match flag {
        "--hostlist" => Some(&[
            "%LISTS%list-general.txt",
            "%LISTS%list-general-user.txt",
            "%LISTS%list-google.txt",
        ]),
        "--hostlist-exclude" => Some(&["%LISTS%list-exclude.txt", "%LISTS%list-exclude-user.txt"]),
        "--ipset" => Some(&["%LISTS%ipset-all.txt"]),
        "--ipset-exclude" => Some(&["%LISTS%ipset-exclude.txt", "%LISTS%ipset-exclude-user.txt"]),
        _ => None,
    }
}

fn bounded_int(value: &str, low: u64, high: u64) -> bool {
    !value.is_empty()
        && value.len() <= 19
        && value.bytes().all(|b| b.is_ascii_digit())
        && value
            .parse::<u64>()
            .is_ok_and(|n| (low..=high).contains(&n))
}

// %BIN%имя.bin: только символы [A-Za-z0-9._-], без «..» и разделителей пути.
fn safe_bin_value(value: &str) -> bool {
    let Some(name) = value.strip_prefix("%BIN%") else {
        return false;
    };
    name.len() > ".bin".len()
        && name.ends_with(".bin")
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn safe_hex_value(value: &str) -> bool {
    value.strip_prefix("0x").is_some_and(|hex| {
        (2..=4096).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

// SAFE_DOMAIN из генератора: метки [A-Za-z0-9-] до 63 символов без дефиса по
// краям, минимум две метки, последняя — 2..63 латинских букв.
fn safe_strategy_domain(value: &str) -> bool {
    let labels: Vec<&str> = value.split('.').collect();
    let Some((tld, rest)) = labels.split_last() else {
        return false;
    };
    !rest.is_empty()
        && (2..=63).contains(&tld.len())
        && tld.bytes().all(|b| b.is_ascii_alphabetic())
        && rest.iter().all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn valid_port_list(value: &str, placeholder: &str) -> bool {
    value.split(',').all(|part| {
        if part == placeholder {
            return true;
        }
        let (start, end) = part.split_once('-').unwrap_or((part, part));
        let port = |raw: &str| -> Option<u32> {
            if raw.is_empty() || raw.len() > 5 || !raw.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            raw.parse().ok()
        };
        match (port(start), port(end)) {
            (Some(start), Some(end)) => (1..=end).contains(&start) && end <= 65535,
            _ => false,
        }
    })
}

// \d{1,5}(,(midsld|sniext+\d{1,5}))?
fn valid_split_pos(value: &str) -> bool {
    let short_number =
        |raw: &str| (1..=5).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_digit());
    let (position, marker) = match value.split_once(',') {
        Some((position, marker)) => (position, Some(marker)),
        None => (value, None),
    };
    short_number(position)
        && match marker {
            None => true,
            Some("midsld") => true,
            Some(marker) => marker.strip_prefix("sniext+").is_some_and(short_number),
        }
}

/// Проверить один аргумент стратегии до подстановки плейсхолдеров. Зеркало
/// gen_strategies.py::validate_arg: генератор канала уже фильтрует им вывод, а
/// клиент повторяет проверку, потому что между подписью и winws лежит диск.
fn validate_strategy_arg(arg: &str) -> Result<(), String> {
    let reject =
        || -> Result<(), String> { Err(format!("unsafe or unknown winws argument: {arg:?}")) };
    if arg.len() > MAX_STRATEGY_ARG_LEN || arg.contains(['\0', '\r', '\n']) {
        return reject();
    }
    let (flag, value) = match arg.split_once('=') {
        Some((flag, value)) => (flag, Some(value)),
        None => (arg, None),
    };
    let Some(value) = value else {
        // Без значения допустим только разделитель секций.
        return if flag == "--new" { Ok(()) } else { reject() };
    };
    let ok = match flag {
        "--dpi-desync" => DESYNC_VALUES.contains(&value),
        "--dpi-desync-any-protocol" => value == "1",
        "--dpi-desync-badseq-increment" => bounded_int(value, 0, 2_147_483_647),
        "--dpi-desync-cutoff" => value.strip_prefix('n').is_some_and(|n| {
            (1..=2).contains(&n.len())
                && n.bytes().all(|b| b.is_ascii_digit())
                && !n.starts_with('0')
        }),
        flag if BIN_FLAGS.contains(&flag) => safe_bin_value(value),
        "--dpi-desync-fake-tls" => value == "!" || safe_bin_value(value) || safe_hex_value(value),
        "--dpi-desync-fake-unknown" => safe_bin_value(value) || safe_hex_value(value),
        "--dpi-desync-fakedsplit-pattern" => safe_hex_value(value),
        "--dpi-desync-fooling" => FOOLING_VALUES.contains(&value),
        "--dpi-desync-repeats" => bounded_int(value, 1, 1000),
        "--dpi-desync-split-seqovl" => bounded_int(value, 0, 65535),
        "--dpi-desync-split-pos" => valid_split_pos(value),
        "--dpi-desync-fake-tls-mod" => {
            value == "none"
                || value
                    .strip_prefix("rnd,dupsid,sni=")
                    .is_some_and(safe_strategy_domain)
        }
        "--dpi-desync-hostfakesplit-mod" => value.strip_prefix("host=").is_some_and(|rest| {
            safe_strategy_domain(rest.strip_suffix(",altorder=1").unwrap_or(rest))
        }),
        "--filter-l3" => value == "ipv4",
        "--filter-l7" => L7_VALUES.contains(&value),
        "--filter-tcp" | "--wf-tcp" => valid_port_list(value, "%GameFilterTCP%"),
        "--filter-udp" | "--wf-udp" => valid_port_list(value, "%GameFilterUDP%"),
        "--hostlist-domains" | "--hostlist-exclude-domains" => {
            value.split(',').all(safe_strategy_domain)
        }
        "--ip-id" => value == "zero",
        flag => allowed_list_values(flag).is_some_and(|allowed| allowed.contains(&value)),
    };
    if ok {
        Ok(())
    } else {
        reject()
    }
}

fn validate_strategy_args(args: &[String]) -> Result<(), String> {
    if args.is_empty() || args.len() > MAX_STRATEGY_ARGS {
        return Err(format!("invalid winws argument count: {}", args.len()));
    }
    args.iter().try_for_each(|arg| validate_strategy_arg(arg))
}

// Разобрать strategies.json и оставить только стратегии, целиком прошедшие
// allowlist. Стратегия с запрещённым аргументом не исправляется и не
// обрезается — она выпадает вся: частичный argv winws — другой профиль.
fn parse_checked_strategies(raw: &str) -> Result<Vec<Strategy>, String> {
    let parsed: Vec<Strategy> =
        serde_json::from_str(raw).map_err(|e| format!("parse strategies.json: {e}"))?;
    if parsed.len() > MAX_STRATEGIES {
        return Err(format!("too many strategies: {}", parsed.len()));
    }
    let mut checked = Vec::with_capacity(parsed.len());
    for strategy in parsed {
        match validate_strategy_args(&strategy.args) {
            Ok(()) => checked.push(strategy),
            Err(error) => eprintln!("DPI strategy {} rejected: {error}", strategy.id),
        }
    }
    if checked.is_empty() {
        return Err("no strategy passed the winws argument allowlist".into());
    }
    Ok(checked)
}

struct ActiveStrategies {
    strategies: Vec<Strategy>,
    // Версия именно того набора, из которого взяты стратегии.
    version: String,
    // Поколение, чей подписанный бандл дал стратегии; None — встроенный набор.
    channel: Option<PathBuf>,
    // Активное поколение повреждено или не может доказать подписью свои
    // стратегии: работаем на встроенном наборе и предлагаем пересинхронизацию
    // даже при той же версии канала.
    needs_resync: bool,
}

// Стратегии и версия из подписанного бандла поколения (одна проверка подписи).
fn signed_generation_strategies(generation: &Path) -> Result<(Vec<Strategy>, String), String> {
    let entries = read_signed_bundle_entries(
        generation,
        &[Path::new("strategies.json"), Path::new("version.txt")],
    )?;
    let strategies = parse_checked_strategies(&entries[0])?;
    let version = entries[1].trim().to_string();
    if !valid_channel_version(&version) {
        return Err("signed DPI bundle has an invalid version".into());
    }
    Ok((strategies, version))
}

fn load_strategies_from(dpi_data: &Path) -> Result<ActiveStrategies, String> {
    let resolution = resolve_channel_generation(dpi_data);
    let mut needs_resync = resolution.pointer_broken;
    if let Some(generation) = resolution.active {
        match signed_generation_strategies(&generation) {
            Ok((strategies, version)) => {
                return Ok(ActiveStrategies {
                    strategies,
                    version,
                    channel: Some(generation),
                    needs_resync,
                })
            }
            Err(error) => {
                report_channel_diagnostic(&format!(
                    "DPI channel generation {} has no verifiable strategies, using the bundled set: {error}",
                    generation.display()
                ));
                needs_resync = true;
            }
        }
    }
    Ok(ActiveStrategies {
        strategies: parse_checked_strategies(BUNDLED_STRATEGIES_JSON)?,
        version: bundled_strategies_version(),
        channel: None,
        needs_resync,
    })
}

fn load_strategies(app: &AppHandle) -> Result<ActiveStrategies, String> {
    load_strategies_from(&crate::app_paths::data_dir(app)?.join("dpi"))
}

// Режим ipset → содержимое ipset-all.txt (как в service.bat Flowseal):
//   any    — пустой файл (обход по совпадению домена, рекомендуется);
//   loaded — полный набор IP из ресурсного ipset-all.base.txt;
//   off    — заглушка (одна несуществующая подсеть, фильтр фактически выключен).
fn write_ipset_mode(app: &AppHandle, lists: &Path, mode: &str) -> Result<(), String> {
    let target = lists.join("ipset-all.txt");
    match mode {
        "loaded" => {
            // writable-копия base (после dpi_update_ipset) приоритетнее ресурсной —
            // так обновлённый список IP применяется без переустановки приложения.
            let wbase = lists.join(IPSET_BASE_FILE);
            let base = if wbase.exists() {
                wbase
            } else {
                res_lists(app)?.join(IPSET_BASE_FILE)
            };
            // База приходит и из канала (как есть у Flowseal), поэтому добавки
            // Ninety накладываются на итоговый файл, который читает winws.
            let text = std::fs::read_to_string(&base)
                .map_err(|e| format!("read ipset base ({}): {e}", base.display()))?;
            match with_list_additions(&text, &NINETY_IPSET_ADDITIONS) {
                Some(updated) => write_replace(&target, &updated, "ipset loaded")?,
                None => write_replace(&target, &text, "ipset loaded")?,
            }
        }
        "off" => {
            write_replace(&target, "203.0.113.113/32\n", "ipset off")?;
        }
        // "any" и "auto": пустой ipset = «не фильтровать по IP». В «auto» секции
        // дополнительно перегейчиваются на autohostlist (gate_by_autohostlist),
        // и собственного IP-фильтра у них уже нет.
        _ => {
            write_replace(&target, "", "ipset any")?;
        }
    }
    Ok(())
}

// Лог winws (stdout+stderr) — критичен для диагностики мгновенных падений.
fn dpi_log_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::app_paths::log_dir(app).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("dpi.log"))
}

// Отдельный файл для прогонов авто-подбора. В dpi.log писать нельзя: подбор
// глушит движок, а восстановление его после прогона зовёт dpi_start, который
// открывает dpi.log с обнулением — диагностика прогона стиралась ровно в тот
// момент, когда она понадобилась. «Открыть логи» открывает каталог, так что
// второй файл виден рядом.
fn dpi_autotest_log_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::app_paths::log_dir(app).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("dpi-autotest.log"))
}

// Лог решений autohostlist: winws пишет туда, почему домен попал в автосписок
// (счётчик фейлов, протокол, клиент). Без него ответить постфактум «за что
// сайту достался обход» нечем. Подчиняется общему «отключить логи».
fn auto_hostlist_log_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::app_paths::log_dir(app).ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("dpi-autohostlist.log"))
}

// winws дописывает решения autohostlist в конец файла и сам его не обрезает, а
// в режиме «Только заблокированные» строка появляется на каждый подозрительный
// обрыв. Перед стартом держим файл в пределах капа и сохраняем свежий хвост:
// история «за что сайту достался обход» нужна, но не за месяцы.
const AUTO_HOSTLIST_LOG_KEEP_BYTES: u64 = 1024 * 1024;

fn trim_auto_hostlist_log(path: &Path) {
    let oversized = std::fs::metadata(path).is_ok_and(|meta| meta.len() > DPI_LOG_CAP_BYTES);
    if !oversized {
        return;
    }
    let tail = crate::vpn::read_tail(path, Some(AUTO_HOSTLIST_LOG_KEEP_BYTES)).unwrap_or_default();
    let _ = std::fs::write(path, tail);
}

// Срезать verbatim-префикс Windows (`\\?\C:\…` → `C:\…`, `\\?\UNC\srv\…` →
// `\\srv\…`). resource_dir()/canonicalize на Windows возвращают такой путь;
// CreateProcess его глотает, но сам winws открывает .bin своим парсером, который
// `\\?\` не понимает → «could not read …». Срезаем для строк, уходящих в args.
fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p.to_string()
    }
}

// Подстановка плейсхолдеров батника на абсолютные пути/порты.
fn subst(arg: &str, bin: &str, lists: &str, g_tcp: &str, g_udp: &str) -> String {
    let binp = format!("{bin}{MAIN_SEPARATOR}");
    let listp = format!("{lists}{MAIN_SEPARATOR}");
    arg.replace("%BIN%", &binp)
        .replace("%LISTS%", &listp)
        .replace("%GameFilterTCP%", g_tcp)
        .replace("%GameFilterUDP%", g_udp)
        .replace("%GameFilter%", g_tcp)
}

// [0] — исключение по домену, [1] — по IP. Раздаются по секциям по-разному, см.
// spread_exclusion_across_sections.
fn active_vpn_exclusion_args(lists: &Path) -> [String; 2] {
    let active_domain = lists.join("active-vpn-domain.txt");
    let active_ip = lists.join("active-vpn-ip.txt");
    [
        format!(
            "--hostlist-exclude={}",
            strip_verbatim(&active_domain.to_string_lossy())
        ),
        format!(
            "--ipset-exclude={}",
            strip_verbatim(&active_ip.to_string_lossy())
        ),
    ]
}

// Аргумент, создающий в профиле winws коллекцию хостлистов. Именно наличие
// коллекции (а не её содержимое) включает в движке требование известного хоста —
// см. spread_exclusion_across_sections.
fn is_hostlist_arg(arg: &str) -> bool {
    matches!(
        arg.split('=').next().unwrap_or(arg),
        "--hostlist"
            | "--hostlist-domains"
            | "--hostlist-exclude"
            | "--hostlist-exclude-domains"
            | "--hostlist-auto"
    )
}

/// Раздать исключение активного VPN endpoint по секциям стратегии.
///
/// В синтаксисе winws `--new` открывает новую секцию, и фильтры действуют только
/// внутри своей: исключение в хвосте строки покрывало ровно последнюю секцию, а
/// VLESS к серверу идёт по TCP:443, то есть по чужой.
///
/// НО раздавать `--hostlist-exclude` во все секции подряд нельзя. В zapret
/// (`nfq/desync.c`, `dp_match`) профиль с непустой коллекцией хостлистов не
/// матчится вовсе, если хост неизвестен:
///
/// ```text
/// if (!dp->hostlist_auto && !hostname && !bHostlistsEmpty) return false;
/// ```
///
/// У голосового Discord (`--filter-l7=discord,stun`) и у секций Game Filter
/// (`--dpi-desync-any-protocol=1`) хоста нет по определению — Flowseal поэтому и
/// оставил их без хостлистов. Наш аргумент делал коллекцию непустой, профиль
/// переставал матчиться, десинк голосового UDP не применялся вообще, и пинг в
/// голосовом канале улетал в потолок. Пустой файл коллекцию не наполняет
/// (`hostlist_collection_is_empty` смотрит на загруженный пул), поэтому баг ловил
/// только тех, у кого адрес ноды — домен.
///
/// Итог: `--ipset-exclude` уходит в каждую секцию (проверка ipset на хост не
/// смотрит), `--hostlist-exclude` — только туда, где хостлист уже есть и хост
/// заведомо нужен. Оба файла остаются в argv всегда, даже пустыми: winws
/// перечитывает их по mtime, и смена ноды применяется без перезапуска движка.
fn spread_exclusion_across_sections(args: Vec<String>, exclusion: &[String; 2]) -> Vec<String> {
    let [hostlist_exclude, ipset_exclude] = exclusion;
    let sections = args.iter().filter(|a| a.as_str() == "--new").count() + 1;
    let mut out = Vec::with_capacity(args.len() + sections * exclusion.len());
    let mut section: Vec<String> = Vec::new();
    let flush = |section: &mut Vec<String>, out: &mut Vec<String>| {
        let hostname_aware = section.iter().any(|a| is_hostlist_arg(a.as_str()));
        out.append(section);
        if hostname_aware {
            out.push(hostlist_exclude.clone());
        }
        out.push(ipset_exclude.clone());
    };
    for arg in args {
        if arg == "--new" {
            flush(&mut section, &mut out);
            out.push(arg);
        } else {
            section.push(arg);
        }
    }
    flush(&mut section, &mut out);
    out
}

/// Игровой фильтр не должен зависеть от переключателя IPset.
///
/// Секции Game Filter гейтились общим `ipset-all.txt`, а его содержимое диктует
/// режим IPset: в «off» туда пишется заведомо несуществующий 203.0.113.113/32,
/// и десинк игрового трафика не применялся ни к одному пакету — тумблер
/// «Игровой фильтр» молча не делал ничего. В «loaded» результат тот же по сути:
/// список заблокированных IP не содержит игровых серверов (Photon, Vivox), под
/// которые фильтр и включают, так что совпадений снова нет.
///
/// Поэтому игровым секциям выдаём собственный ipset-game.txt, всегда пустой:
/// пустая коллекция ipset у winws означает «не фильтровать по IP», а не «не
/// совпало» (ровно на этом же свойстве держится режим IPset=Any). Исключения
/// (`--ipset-exclude`, в том числе активная нода VPN) добавляются отдельно в
/// spread_exclusion_across_sections и здесь не трогаются — нода остаётся
/// защищённой.
///
/// Секция считается игровой по совпадению `--filter-tcp/udp` с диапазоном,
/// который подставил game_filter. Зовётся только при включённом фильтре: при
/// «off» диапазон вырождается в порт-заглушку 12, и подменять там нечего.
fn ungate_game_ipset(args: Vec<String>, lists: &Path, g_tcp: &str, g_udp: &str) -> Vec<String> {
    let gated = format!(
        "--ipset={}",
        strip_verbatim(&lists.join("ipset-all.txt").to_string_lossy())
    );
    let ungated = format!(
        "--ipset={}",
        strip_verbatim(&lists.join("ipset-game.txt").to_string_lossy())
    );
    let markers = [
        format!("--filter-tcp={g_tcp}"),
        format!("--filter-udp={g_udp}"),
    ];

    let mut out = Vec::with_capacity(args.len());
    let mut section: Vec<String> = Vec::new();
    let flush = |section: &mut Vec<String>, out: &mut Vec<String>| {
        let is_game = section.iter().any(|a| markers.contains(a));
        for arg in section.drain(..) {
            if is_game && arg == gated {
                out.push(ungated.clone());
            } else {
                out.push(arg);
            }
        }
    };
    for arg in args {
        if arg == "--new" {
            flush(&mut section, &mut out);
            out.push(arg);
        } else {
            section.push(arg);
        }
    }
    flush(&mut section, &mut out);
    out
}

// Автосписок заблокированных доменов: winws ведёт его сам в режиме «Только
// заблокированные». Имя файла знают и ensure_lists (создаёт пустым), и команды
// просмотра/очистки, поэтому литерал один на всех.
const AUTO_HOSTLIST_FILE: &str = "list-auto.txt";
// Пороги детекта. Совпадают с дефолтами zapret (3 события за 60 с, 3
// ретрансмиссии), но передаются явно: число видно пользователю в подсказке UI,
// и молчаливая смена дефолта в движке не должна её обесценивать.
const AUTO_FAIL_THRESHOLD: u32 = 3;
const AUTO_RETRANS_THRESHOLD: u32 = 3;

/// Режим «Только заблокированные»: перегейчиваем стратегию на автосписок winws.
///
/// В режиме «Всем сайтам» секции с `--ipset=ipset-all.txt` разгейчены пустым
/// ipset (пустая коллекция = «не фильтровать по IP»), и десинк летит в любой
/// домен, кроме исключений. Сайтам, которые не заблокированы, это вредит:
/// fake-пакет доходит до сервера, и если тот не отбрасывает его по выбранному
/// `--dpi-desync-fooling`, он принимает фейк вместо настоящего ClientHello —
/// сайт перестаёт открываться, пока домен не внесут в исключения руками.
///
/// `--hostlist-auto` переворачивает логику: домен, которого нет ни в одном
/// списке, идёт БЕЗ обхода, а winws смотрит на ответ (ретрансмиссии первого
/// запроса с хостом, RST, HTTP-редирект на чужой домен второго уровня) и
/// заносит в файл только то, что ведёт себя как заблокированное. Профиль с
/// autohostlist выигрывает по l3/l4/l7-фильтру всегда, но десинк применяется
/// лишь к хостам из файла — см. nfq/desync.c, ветку «not applying tampering to
/// this request» (одинаковую для TCP и QUIC).
///
/// Игровые секции (`--dpi-desync-any-protocol=1`) не трогаем: хоста в их
/// трафике нет по определению, autohostlist там не даёт ничего и только заменил
/// бы понятный IP-гейт на профиль, который выигрывает всегда.
fn gate_by_autohostlist(args: Vec<String>, lists: &Path) -> Vec<String> {
    let gated = format!(
        "--ipset={}",
        strip_verbatim(&lists.join("ipset-all.txt").to_string_lossy())
    );
    let auto = format!(
        "--hostlist-auto={}",
        strip_verbatim(&lists.join(AUTO_HOSTLIST_FILE).to_string_lossy())
    );

    let mut out = Vec::with_capacity(args.len());
    let mut section: Vec<String> = Vec::new();
    let flush = |section: &mut Vec<String>, out: &mut Vec<String>| {
        let any_protocol = section
            .iter()
            .any(|a| a.as_str() == "--dpi-desync-any-protocol=1");
        for arg in section.drain(..) {
            if !any_protocol && arg == gated {
                out.push(auto.clone());
                out.push(format!(
                    "--hostlist-auto-fail-threshold={AUTO_FAIL_THRESHOLD}"
                ));
                out.push(format!(
                    "--hostlist-auto-retrans-threshold={AUTO_RETRANS_THRESHOLD}"
                ));
            } else {
                out.push(arg);
            }
        }
    };
    for arg in args {
        if arg == "--new" {
            flush(&mut section, &mut out);
            out.push(arg);
        } else {
            section.push(arg);
        }
    }
    flush(&mut section, &mut out);
    out
}

// Домены автосписка для UI: свежие сверху, дубли и комментарии отброшены.
// Файл ведёт winws (дописывает в конец), мы его только читаем и переписываем.
fn auto_domains_from(txt: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in txt.lines().rev() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with("//") {
            continue;
        }
        if !out.iter().any(|d| d.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    }
    out
}

// Абсолютный путь к утилите в System32. Не полагаемся ни на PATH, ни на
// %SystemRoot%: DPI-команды исполняются в elevated-процессе, а обе величины
// пользователь может переопределить без прав администратора (PATH-hijack,
// HKCU\Environment). Каталог спрашиваем у самой Windows.
#[cfg(target_os = "windows")]
fn system32(exe: &str) -> String {
    crate::util::system_directory()
        .join(exe)
        .to_string_lossy()
        .into_owned()
}
// Лежит ли путь ВНУТРИ каталога, а не просто начинается с той же строки.
//
// Голое `starts_with` по строке границу каталога не проверяет: для корня
// `...\Ninety\dpi` под него подходил и `...\Ninety\dpi-backup\winws.exe`, то
// есть чужой процесс из соседнего каталога уезжал в `taskkill /F` — ровно то,
// от чего kill_stray_winws обещает защищать. Тот же барьер стоит в
// proxy_win::autostart_uses_highest_run_level.
//
// Обе строки приходят уже приведёнными к нижнему регистру (пути Windows
// регистронезависимы). Резать по `root.len()` безопасно: успешный
// `starts_with` гарантирует, что это граница символа.
#[cfg(target_os = "windows")]
fn path_is_inside(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches(['\\', '/']);
    !root.is_empty() && path.starts_with(root) && path[root.len()..].starts_with(['\\', '/'])
}

// Снять winws.exe-СИРОТУ ОТ ДРУГОГО ИНСТАНСА Ninety. Возвращает true, если хоть
// один был убит. Вызывается из dpi_start перед спавном своего winws: к той точке
// наш child уже не жив (дедуп вернул бы «уже запущен»), значит живой winws из
// нашего каталога движка — сирота от второго инстанса Ninety (элевация поднимает
// ВТОРОЙ процесс со своим DpiState; дедуп видит только свой child). Без этого два
// winws дерутся за один kernel-драйвер WinDivert и движок падает «драйвер занят».
//
// Фильтруем по пути образа: убиваем ТОЛЬКО winws внутри нашего res_dpi. Прежний
// `taskkill /IM winws.exe` глушил ВСЕ процессы с этим именем — включая отдельный
// zapret/аналог, запущенный юзером независимо от Ninety.
#[cfg(target_os = "windows")]
fn kill_stray_winws(dpi_root: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Процессы перечисляем напрямую: EnumProcesses + путь образа. Прежний
    // PowerShell с CIM-запросом стартовал по секунде-две на каждый запуск
    // обхода, а при подвисшем WMI ждал без всякого таймаута.
    // res_dpi может прийти в verbatim-форме — срезаем для префиксного сравнения.
    let root = strip_verbatim(&dpi_root.to_string_lossy()).to_lowercase();
    let mut killed = false;
    for pid in crate::netproc::running_pids() {
        let Some(path) = crate::netproc::process_image_path(pid) else {
            continue;
        };
        let path = path.to_lowercase();
        let is_winws = Path::new(&path)
            .file_name()
            .is_some_and(|name| name == "winws.exe");
        // Не наш каталог движка → чужой winws, не трогаем.
        if !is_winws || !path_is_inside(&path, &root) {
            continue;
        }
        let ok = std::process::Command::new(system32("taskkill.exe"))
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        killed |= ok;
    }
    killed
}
#[cfg(not(target_os = "windows"))]
fn kill_stray_winws(_dpi_root: &Path) -> bool {
    false
}

// ── Команды ─────────────────────────────────────────────────────────

/// Список стратегий для UI (JSON-массив). Тот же проверенный путь, что у
/// запуска: подписанный бандл поколения или встроенный набор, после allowlist.
#[tauri::command]
pub fn dpi_strategies(app: AppHandle) -> Result<String, String> {
    let active = load_strategies(&app)?;
    serde_json::to_string(&active.strategies).map_err(|e| format!("serialize strategies: {e}"))
}

/// Сколько доменов в активных списках (для карточки «Списки доменов»).
#[tauri::command]
pub fn dpi_domains_count(app: AppHandle) -> Result<usize, String> {
    let lists = ensure_lists(&app)?;
    let mut n = 0usize;
    for name in [
        "list-general.txt",
        "list-general-user.txt",
        "list-google.txt",
    ] {
        if let Ok(txt) = std::fs::read_to_string(lists.join(name)) {
            n += txt
                .lines()
                .filter(|l| {
                    let t = l.trim();
                    !t.is_empty() && !t.starts_with('#') && !t.starts_with("//")
                })
                .count();
        }
    }
    Ok(n)
}

/// Доступные `.bin` для двух активных UDP-слотов из Flowseal 1.10+.
/// Возвращаем только обычные файлы из writable bin-data; пути фронт не задаёт.
#[tauri::command]
pub async fn dpi_fake_payloads(
    app: AppHandle,
    state: State<'_, DpiState>,
) -> Result<serde_json::Value, String> {
    let _data = state.data.lock().await;
    let active = load_strategies(&app)?;
    let dir = ensure_bindata(&app, &active)?;
    let options = fake_options(&dir)?;
    let selection = load_fake_selection(&app);
    let referenced = referenced_bins(&active.strategies);
    let discord_supported =
        referenced.contains(ACTIVE_DISCORD_FAKE) && dir.join(ACTIVE_DISCORD_FAKE).is_file();
    let game_supported =
        referenced.contains(ACTIVE_GAME_FAKE) && dir.join(ACTIVE_GAME_FAKE).is_file();
    let discord = current_fake_name(
        &dir,
        ACTIVE_DISCORD_FAKE,
        &options,
        selection.discord.as_deref(),
    );
    let game = current_fake_name(&dir, ACTIVE_GAME_FAKE, &options, selection.game.as_deref());
    Ok(serde_json::json!({
        "options": options,
        "discord": discord,
        "game": game,
        "discord_supported": discord_supported,
        "game_supported": game_supported,
    }))
}

/// Атомарно заменить ACTIVE_DISCORD_UDP.bin или ACTIVE_GAME_UDP.bin выбранным
/// файлом из текущего подписанного набора и сохранить выбор поверх будущих sync.
#[tauri::command]
pub async fn dpi_set_active_fake(
    app: AppHandle,
    state: State<'_, DpiState>,
    kind: String,
    file: String,
) -> Result<serde_json::Value, String> {
    let _data = state.data.lock().await;
    let active = load_strategies(&app)?;
    let dir = ensure_bindata(&app, &active)?;
    let options = fake_options(&dir)?;
    if !options.contains(&file) {
        return Err("fake file is not in the current signed set".into());
    }
    let target = dir.join(fake_target(&kind)?);
    let previous = match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_file() && meta.len() <= MAX_DPI_PAYLOAD_BYTES => Some(
            std::fs::read(&target)
                .map_err(|e| format!("could not save the current UDP fake: {e}"))?,
        ),
        Ok(_) => return Err("current ACTIVE file is unsafe or too large".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("could not save the current UDP fake: {e}")),
    };
    apply_fake_file(&dir, &kind, &file)?;
    let mut selection = load_fake_selection(&app);
    match kind.as_str() {
        "discord" => selection.discord = Some(file.clone()),
        "game" => selection.game = Some(file.clone()),
        _ => return Err("unknown UDP fake type".into()),
    }
    if let Err(marker_error) = save_fake_selection(&app, &selection) {
        let rollback = match previous {
            Some(bytes) => write_bytes_replace(&target, &bytes, "rollback UDP fake"),
            None => match std::fs::remove_file(&target) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("remove rollback UDP fake: {e}")),
            },
        };
        return match rollback {
            Ok(()) => Err(marker_error),
            Err(rollback_error) => Err(format!(
                "{marker_error}; rolling back the ACTIVE file also failed: {rollback_error}"
            )),
        };
    }
    Ok(serde_json::json!({ "kind": kind, "file": file }))
}

const DPI_LOG_CAP_BYTES: u64 = 8 * 1024 * 1024;

struct DpiLogWriter {
    path: PathBuf,
    file: std::fs::File,
    written: u64,
}

impl DpiLogWriter {
    fn append(&mut self, bytes: &[u8]) {
        use std::io::Write;
        // Обрезка — через отдельный хэндл: append-хэндл на Windows обрезать
        // файл не может (см. util::truncate_log_file).
        if self.written.saturating_add(bytes.len() as u64) > DPI_LOG_CAP_BYTES
            && crate::util::truncate_log_file(&self.path)
        {
            let marker = b"[dpi log truncated at 8 MB cap]\n";
            let _ = self.file.write_all(marker);
            self.written = marker.len() as u64;
        }
        if self.file.write_all(bytes).is_ok() {
            self.written = self.written.saturating_add(bytes.len() as u64);
        }
    }
}

fn prepare_dpi_log(path: &Path) -> Option<Arc<Mutex<DpiLogWriter>>> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .truncate(false)
        .open(path)
        .ok()?;
    // Новая сессия — новый диагностический лог. Прежний `set_len(0)` на
    // append-хэндле на Windows не срабатывал, и dpi.log копил все сессии.
    let _ = crate::util::truncate_log_file(path);
    Some(Arc::new(Mutex::new(DpiLogWriter {
        path: path.to_path_buf(),
        file,
        written: 0,
    })))
}

fn spawn_dpi_log_pipe<R: std::io::Read + Send + 'static>(
    mut reader: R,
    writer: Arc<Mutex<DpiLogWriter>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => writer.lock_recover().append(&buf[..n]),
            }
        }
    });
}

#[cfg(target_os = "windows")]
fn remember_owned_driver_services(state: &DpiState, bin: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let sc = system32("sc.exe");
    let owned_root = strip_verbatim(&bin.to_string_lossy()).to_lowercase();
    let mut owned = state.owned_services.lock_recover();
    for svc in ["WinDivert", "WinDivert14", "Monkey"] {
        let Ok(mut child) = std::process::Command::new(&sc)
            .args(["qc", svc])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        else {
            continue;
        };
        let deadline = Instant::now() + CHILD_STOP_TIMEOUT;
        let completed = loop {
            match child.try_wait() {
                Ok(Some(_)) => break true,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                _ => break false,
            }
        };
        if !completed {
            let _ = child.kill();
            continue;
        }
        let Ok(out) = child.wait_with_output() else {
            continue;
        };
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
        .replace(r"\??\", "")
        .to_lowercase();
        if out.status.success() && text.contains(&owned_root) && !owned.iter().any(|x| x == svc) {
            owned.push(svc.to_string());
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn remember_owned_driver_services(_state: &DpiState, _bin: &Path) {}

/// Запуск winws с выбранной стратегией. game_filter: "off"|"tcpudp";
/// ipset — область применения обхода: "any" (все домены) | "auto" (только те,
/// что winws сам определил как заблокированные) | "loaded" (IP из ipset-all) |
/// "off" (только домены из списков). Должен вызываться из elevated-процесса.
/// Возвращает id сеанса (generation): им помечено событие dpi:exited, если
/// этот winws позже упадёт сам.
#[tauri::command]
pub async fn dpi_start(
    app: AppHandle,
    state: State<'_, DpiState>,
    strategy_id: String,
    game_filter: String,
    ipset: String,
    monkey: bool,
    logs_disabled: Option<bool>,
) -> Result<u64, String> {
    let logs_disabled = logs_disabled.unwrap_or(false);
    let generation = begin_dpi_operation(&state, "start")?;
    let _operation = DpiOperationGuard {
        state: &state,
        generation,
    };
    // Уже запущен? Чистим труп / отказываем.
    {
        let mut guard = state.child.lock_recover();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    // умер — перезапустим; о прежнем сеансе уже не сообщаем
                    *guard = None;
                    state.runtime_session.store(0, Ordering::SeqCst);
                }
                Ok(None) => return Err(crate::util::i18n_error("backend.dpi.alreadyRunning")),
                Err(_) => return Err(crate::util::i18n_error("backend.dpi.alreadyRunning")),
            }
        }
    }

    // Лок сериализует мутации DPI-набора, и его может держать долгая
    // sync_channel. Ждём его отменяемо: иначе stop, пришедший в этот момент,
    // упирался бы в start, который ещё даже не начал проверять отмену.
    let _data = tokio::select! {
        guard = state.data.lock() => guard,
        _ = wait_dpi_cancelled(&state, generation) => return Err(crate::util::i18n_error("backend.dpi.cancelled")),
    };
    let active = load_strategies(&app)?;
    let strat = active
        .strategies
        .iter()
        .find(|s| s.id == strategy_id)
        .ok_or_else(|| {
            crate::util::i18n_error_with("backend.dpi.strategyNotFound", &[("id", &strategy_id)])
        })?;
    // Вторая линия прямо перед подстановкой: в winws уходят только аргументы,
    // прошедшие allowlist, какой бы путь ни привёл сюда стратегию.
    validate_strategy_args(&strat.args)?;

    let bin = bin_dir(&app, monkey)?;
    let exe = bin.join("winws.exe");
    if !exe.exists() {
        return Err(crate::util::i18n_error_with(
            "backend.dpi.winwsMissing",
            &[("path", &exe.display().to_string())],
        ));
    }
    let lists = ensure_lists(&app)?;
    write_ipset_mode(&app, &lists, &ipset)?;

    let (g_tcp, g_udp) = match game_filter.as_str() {
        "tcpudp" => ("1024-65535", "1024-65535"),
        _ => ("12", "12"), // off — безвредный одиночный порт (как дефолт Flowseal)
    };

    // %BIN% → writable bin-data (оверлей канала), НЕ движок: cwd ниже остаётся
    // на read-only ресурсе (winws.exe + WinDivert.dll грузятся оттуда).
    let bindata = ensure_bindata(&app, &active)?;
    let bindata_s = strip_verbatim(&bindata.to_string_lossy());
    let lists_s = strip_verbatim(&lists.to_string_lossy());
    let args: Vec<String> = strat
        .args
        .iter()
        .map(|a| subst(a, &bindata_s, &lists_s, g_tcp, g_udp))
        .collect();
    // Активный VPN endpoint — отдельные managed-файлы: смена ноды заменяет
    // значение, не накапливает старые адреса и не трогает user exclusions.
    // Игровые секции — до раздачи исключений: снимаем с них ipset-гейт, иначе
    // при IPset=Off/Loaded игровой фильтр не матчит ничего (см. ungate_game_ipset).
    let args = if game_filter == "tcpudp" {
        ungate_game_ipset(args, &lists, g_tcp, g_udp)
    } else {
        args
    };
    // «Только заблокированные»: секции, которые в «Всем сайтам» разгейчены пустым
    // ipset, переводим на автосписок winws — обход достаётся лишь тем доменам,
    // которые повели себя как заблокированные.
    let args = if ipset == "auto" {
        let mut args = gate_by_autohostlist(args, &lists);
        if !logs_disabled {
            if let Some(log) = auto_hostlist_log_file(&app) {
                trim_auto_hostlist_log(&log);
                args.insert(
                    0,
                    format!(
                        "--hostlist-auto-debug={}",
                        strip_verbatim(&log.to_string_lossy())
                    ),
                );
            }
        }
        args
    } else {
        args
    };
    let args = spread_exclusion_across_sections(args, &active_vpn_exclusion_args(&lists));

    if !dpi_operation_current(&state, generation) {
        return Err(crate::util::i18n_error("backend.dpi.cancelled"));
    }

    // Защита от «двойного старта»: гасим stray-winws (сирота от другого инстанса
    // Ninety — по пути в нашем res_dpi) перед запуском своего, иначе два winws
    // дерутся за драйвер WinDivert. Если кого-то убили, даём драйверу отцепиться
    // от мёртвого хэндла до нашего старта.
    let dpi_root = res_dpi(&app)?;
    let killed_stray = tauri::async_runtime::spawn_blocking(move || kill_stray_winws(&dpi_root))
        .await
        .unwrap_or(false);
    if killed_stray {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&args).current_dir(&bin); // cwd = bin → WinDivert.dll грузится по соседству
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // Перенаправляем stdout+stderr winws в capped dpi.log — без этого причина
    // мгновенного выхода (битый аргумент / не найден .bin / WinDivert) теряется.
    // При logs_disabled («Полностью отключить логи») файл не создаём — вывод winws
    // уходит в никуда (CREATE_NO_WINDOW → нет консоли); диагностика краша при этом
    // не сохранится, юзер сам отключил логи.
    let log = if logs_disabled {
        None
    } else {
        dpi_log_file(&app)
    };
    let log_writer = log.as_ref().and_then(|lp| prepare_dpi_log(lp));
    if log_writer.is_some() {
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn winws: {e}"))?;
    crate::vpn::prioritize_datapath_process(child.id());
    // Сирота winws дерётся за драйвер WinDivert со следующим запуском (см.
    // kill_stray_winws); job снимает её до того, как она успеет пережить нас.
    crate::job_guard::bind_pid(child.id());
    if let Some(writer) = log_writer {
        if let Some(stdout) = child.stdout.take() {
            spawn_dpi_log_pipe(stdout, writer.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_dpi_log_pipe(stderr, writer);
        }
    }
    // stop мог прийти между последней проверкой и spawn. Проверяем generation
    // под control-lock и только затем публикуем child в общем состоянии.
    {
        let control = state.control.lock_recover();
        if control.generation != generation || control.operation.is_none() {
            drop(control);
            let _ = terminate_child_bounded(&mut child, "winws");
            return Err(crate::util::i18n_error("backend.dpi.cancelled"));
        }
        let mut published = state.child.lock_recover();
        *published = Some(child);
        state.runtime_session.store(generation, Ordering::SeqCst);
    }
    // winws поднял драйвер WinDivert — при выходе службу надо будет снять.
    state.driver_loaded.store(true, Ordering::SeqCst);

    // Дать winws ~700мс упасть (занятый драйвер / нет прав / битые args).
    dpi_sleep_or_cancel(&state, generation, Duration::from_millis(700)).await?;
    remember_owned_driver_services(&state, &bin);
    // Снимаем до лока child: control-лок берётся раньше child (как при
    // публикации хэндла), обратный порядок недопустим.
    let still_current = dpi_operation_current(&state, generation);
    {
        let mut guard = state.child.lock_recover();
        let Some(child) = guard.as_mut() else {
            // Хэндл забрал stop, пришедший уже после sleep, либо dpi_running,
            // наткнувшийся на труп. В обоих случаях winws не работает, и
            // успехом это не является.
            if !still_current {
                return Err(crate::util::i18n_error("backend.dpi.cancelled"));
            }
            return Err(crate::util::i18n_error_with(
                "backend.dpi.exitedAdmin",
                &[("code", "?")],
            ));
        };
        {
            if let Ok(Some(status)) = child.try_wait() {
                *guard = None;
                state.runtime_session.store(0, Ordering::SeqCst);
                let code = status
                    .code()
                    .map_or_else(|| "?".to_string(), |code| code.to_string());
                let tail = log
                    .as_ref()
                    .and_then(|p| std::fs::read(p).ok())
                    .map(|b| String::from_utf8_lossy(&b).trim().to_string())
                    .filter(|s| !s.is_empty())
                    .map(|s| {
                        let chars: Vec<char> = s.chars().collect();
                        let t: String = if chars.len() > 700 {
                            chars[chars.len() - 700..].iter().collect()
                        } else {
                            s.clone()
                        };
                        crate::util::i18n_error_with(
                            "backend.dpi.exitedOutput",
                            &[("code", &code), ("output", &t)],
                        )
                    })
                    .unwrap_or_else(|| {
                        crate::util::i18n_error_with("backend.dpi.exitedAdmin", &[("code", &code)])
                    });
                return Err(tail);
            }
        }
    }
    // Пережил стартовое окно — дальше за ним следит сторож выхода.
    spawn_dpi_exit_watcher(app, generation);
    Ok(generation)
}

// Остановка winws подтверждается физически: kill + try_wait до 2с, ожидание
// отменяемой операции до 2с и финальный повторный stop. Синхронная команда
// держала бы всё это на главном потоке — при зависшем winws окно переставало
// отвечать на несколько секунд. Ожидание уходит в blocking-пул, контракт IPC
// не меняется (аргументов у команды нет).
#[tauri::command]
pub async fn dpi_stop(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DpiState>();
        stop_dpi_runtime(&state, "winws")
    })
    .await
    .map_err(|e| format!("waiting for winws to stop failed: {e}"))?
}

#[tauri::command]
pub fn dpi_running(app: AppHandle, state: State<'_, DpiState>) -> bool {
    // Труп штатного сеанса — то же падение, что ловит сторож: сообщаем о нём,
    // иначе опрос, успевший первым, молча съел бы событие.
    if let Some(event) = reap_unexpected_exit(&state, None) {
        let _ = app.emit(DPI_EXITED_EVENT, event);
        return false;
    }
    let mut guard = state.child.lock_recover();
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => true, // живой
            _ => {
                *guard = None; // умер — забываем хэндл
                false
            }
        }
    } else {
        false
    }
}

// ── Исключение VPN-нод из winws ─────────────────────────────────────
// Потолки пакета: файлы исключений читает winws, а резолв — сетевое ожидание
// перед запуском обхода, поэтому и то и другое ограничено.
const MAX_ENDPOINT_IPS: usize = 1024;
const MAX_ENDPOINT_DOMAINS: usize = 512;
const MAX_ENDPOINT_RESOLVE: usize = 64;
const ENDPOINT_RESOLVE_PARALLEL: usize = 8;
const ENDPOINT_RESOLVE_BUDGET: Duration = Duration::from_secs(2);

#[derive(Debug, Default, PartialEq)]
struct EndpointBatch {
    // CIDR в формате ipset: /32 и /128 для одиночных адресов.
    ips: Vec<String>,
    domains: Vec<String>,
}

fn valid_port_text(port: &str) -> bool {
    (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit())
}

// Хост без порта: «[v6]:443» → «v6», «host:443» → «host». Голый IPv6
// (двоеточий больше одного) остаётся как есть. None — адрес испорчен.
fn endpoint_host(raw: &str) -> Option<&str> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(rest) = value.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port_ok = tail.is_empty() || tail.strip_prefix(':').is_some_and(valid_port_text);
        return (port_ok && !host.is_empty()).then_some(host);
    }
    match value.split_once(':') {
        Some((host, port)) if !port.contains(':') => {
            (!host.is_empty() && valid_port_text(port)).then_some(host)
        }
        _ => Some(value),
    }
}

// Адрес в каноническом виде: иначе 2001:0db8::1 и 2001:db8::1 разошлись бы
// дублями.
fn canonical_ip_entry(host: &str) -> Option<String> {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(addr)) => Some(format!("{addr}/32")),
        Ok(IpAddr::V6(addr)) => Some(format!("{addr}/128")),
        Err(_) if host.contains('/') => normalize_ipset_entry(host).ok(),
        Err(_) => None,
    }
}

fn push_unique(list: &mut Vec<String>, value: String, cap: usize) {
    if list.len() < cap && !list.contains(&value) {
        list.push(value);
    }
}

// Разобрать пакет адресов нод. Классификация — по содержимому, а не по тому,
// в каком из списков пришла строка: адрес TrustTunnel «ip:port» в domains всё
// равно IP. Испорченная строка отбрасывается сама по себе и не роняет весь
// пакет — иначе в файлах осталось бы исключение прошлых нод.
fn endpoint_batch(ips: &[String], domains: &[String]) -> EndpointBatch {
    let mut batch = EndpointBatch::default();
    for raw in ips.iter().chain(domains) {
        let Some(host) = endpoint_host(raw) else {
            continue;
        };
        if let Some(entry) = canonical_ip_entry(host) {
            push_unique(&mut batch.ips, entry, MAX_ENDPOINT_IPS);
        } else if let Ok(domain) = normalize_exclude_domain(host.trim_end_matches('.')) {
            push_unique(&mut batch.domains, domain, MAX_ENDPOINT_DOMAINS);
        }
    }
    batch
}

fn render_list_lines(values: &[String]) -> String {
    if values.is_empty() {
        return String::new();
    }
    let mut out = values.join("\n");
    out.push('\n');
    out
}

fn resolvable_endpoint_domain(domain: &str) -> bool {
    !domain.contains('*') && domain.bytes().any(|b| b.is_ascii_alphabetic())
}

// Адреса доменов нод в формате ipset. Не больше ENDPOINT_RESOLVE_PARALLEL
// запросов одновременно и один общий бюджет на весь пакет: что не успело —
// пропускается, остальное идёт в дело.
async fn resolve_endpoint_domains(domains: &[String], budget: Duration) -> Vec<String> {
    use futures_util::StreamExt;
    let deadline = tokio::time::Instant::now() + budget;
    let targets: Vec<String> = domains
        .iter()
        .filter(|domain| resolvable_endpoint_domain(domain))
        .take(MAX_ENDPOINT_RESOLVE)
        .map(|domain| format!("{domain}:443"))
        .collect();
    let lookups = futures_util::stream::iter(targets)
        .map(move |target| async move {
            match tokio::time::timeout_at(deadline, tokio::net::lookup_host(target)).await {
                Ok(Ok(addrs)) => addrs.map(|addr| addr.ip()).collect::<Vec<IpAddr>>(),
                _ => Vec::new(),
            }
        })
        .buffer_unordered(ENDPOINT_RESOLVE_PARALLEL);
    let mut lookups = std::pin::pin!(lookups);
    let mut out = Vec::new();
    while let Ok(Some(addrs)) = tokio::time::timeout_at(deadline, lookups.next()).await {
        for addr in addrs {
            if let Some(entry) = canonical_ip_entry(&addr.to_string()) {
                push_unique(&mut out, entry, MAX_ENDPOINT_IPS);
            }
        }
    }
    out
}

/// Атомарно заменить исключение VPN-нод одним пакетом. Это session-managed
/// state, а не пользовательский список: новый пакет заменяет прежний целиком и
/// не трогает правки пользователя в *-user.txt.
///
/// Домен ноды на проводе не появляется: VLESS Reality/XHTTP несёт подставной
/// SNI, поэтому реально защищает только исключение по IP. resolve=true —
/// резолвим домены сами (фронт просит это, только когда winws работает или
/// вот-вот стартует): DNS ждём вне лока данных, а файлы пишем одним пакетом
/// под локом. Ответ запроса, который успел обогнать более новый, отбрасывается.
/// Возвращает false для такого устаревшего запроса.
#[tauri::command]
pub async fn dpi_set_active_vpn_endpoint(
    app: AppHandle,
    state: State<'_, DpiState>,
    ips: Option<Vec<String>>,
    domains: Option<Vec<String>>,
    resolve: Option<bool>,
) -> Result<bool, String> {
    let ticket = state
        .endpoint_seq
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    let mut batch = endpoint_batch(
        ips.as_deref().unwrap_or_default(),
        domains.as_deref().unwrap_or_default(),
    );
    if resolve.unwrap_or(false) && !batch.domains.is_empty() {
        // Best-effort: DNS может быть уже поломан ТСПУ, и провал резолва не
        // должен ронять подключение — останутся литералы.
        for entry in resolve_endpoint_domains(&batch.domains, ENDPOINT_RESOLVE_BUDGET).await {
            push_unique(&mut batch.ips, entry, MAX_ENDPOINT_IPS);
        }
    }
    let _data = state.data.lock().await;
    if state.endpoint_seq.load(Ordering::SeqCst) != ticket {
        return Ok(false);
    }
    let lists = ensure_lists(&app)?;
    write_replace(
        &lists.join("active-vpn-domain.txt"),
        &render_list_lines(&batch.domains),
        "active VPN domains",
    )?;
    write_replace(
        &lists.join("active-vpn-ip.txt"),
        &render_list_lines(&batch.ips),
        "active VPN IPs",
    )?;
    Ok(true)
}

// Имя user-списка по виду: "exclude" → исключения, иначе → пользовательские
// домены обхода. Правим ТОЛЬКО *-user.txt (базовые списки Flowseal не трогаем —
// их перезатирает silent-updater).
fn user_list_name(kind: &str) -> &'static str {
    match kind {
        "exclude" => "list-exclude-user.txt",
        _ => "list-general-user.txt",
    }
}

// Отсутствие файла — пустой список, а ошибка чтения — нет: файл бывает занят или
// не в UTF-8, и пустота привела бы к перезаписи настоящего содержимого.
fn read_list_text(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// Прочитать пользовательский список доменов (для редактора в UI).
/// kind: "user" (домены обхода) | "exclude" (исключения).
#[tauri::command]
pub fn dpi_read_list(app: AppHandle, kind: String) -> Result<String, String> {
    let lists = ensure_lists(&app)?;
    let p = lists.join(user_list_name(&kind));
    read_list_text(&p)
}

/// Сохранить пользовательский список доменов из редактора. Нормализует:
/// trim каждой строки, выкидывает пустые и дубли (комментарии # и // сохраняет).
/// Возвращает число записей-доменов (без комментариев) для обновления счётчика.
#[tauri::command]
pub async fn dpi_write_list(
    app: AppHandle,
    state: State<'_, DpiState>,
    kind: String,
    content: String,
) -> Result<usize, String> {
    let _data = state.data.lock().await;
    let lists = ensure_lists(&app)?;
    let mut seen = std::collections::BTreeSet::new();
    let mut out = String::new();
    let mut n = 0usize;
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with('#') || t.starts_with("//") {
            out.push_str(t);
            out.push('\n');
            continue;
        }
        if seen.insert(t.to_string()) {
            out.push_str(t);
            out.push('\n');
            n += 1;
        }
    }
    write_replace(
        &lists.join(user_list_name(&kind)),
        &out,
        &format!("write {}", user_list_name(&kind)),
    )?;
    Ok(n)
}

// Домен, уходящий в hostlist winws. IP-ветка нормализуется отдельно
// (normalize_ipset_entry), а домен раньше писался как есть после trim: значение
// с переводом строки вставляло в список произвольное число записей, и дедуп по
// целой строке на нём не срабатывал никогда — файл рос при каждом вызове.
fn normalize_exclude_domain(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 253 {
        return Err(crate::util::i18n_error("backend.dpi.badDomain"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '*'))
    {
        return Err(crate::util::i18n_error("backend.dpi.badDomain"));
    }
    Ok(value.to_ascii_lowercase())
}

fn normalize_ipset_entry(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if let Some((ip, prefix)) = value.split_once('/') {
        if ip.contains('/') || prefix.contains('/') {
            return Err(format!("invalid cidr: {value}"));
        }
        let addr = ip
            .parse::<IpAddr>()
            .map_err(|_| format!("invalid cidr ip: {value}"))?;
        let prefix = prefix
            .parse::<u8>()
            .map_err(|_| format!("invalid cidr prefix: {value}"))?;
        let max = match addr {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        if prefix > max {
            return Err(format!("invalid cidr prefix: {value}"));
        }
        return Ok(format!("{ip}/{prefix}"));
    }
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(_)) => Ok(format!("{value}/32")),
        Ok(IpAddr::V6(_)) => Ok(format!("{value}/128")),
        Err(_) => Err(format!("invalid ip: {value}")),
    }
}

// ── Версии / обновление списков ─────────────────────────────────────
// Версия набора стратегий — версия ровно того набора, из которого сейчас взяты
// стратегии (подписанный бандл поколения либо встроенный). Legacy-маркер
// strategies-version.txt описывал игнорируемый теперь оверлей и не читается.
fn strat_version(app: &AppHandle) -> Result<String, String> {
    Ok(load_strategies(app)?.version)
}

// Версия канала — тег Flowseal вида 1.10.2; встречаются буквенные хвосты
// компонента (1.6.3b), pre-release через «-» и build-метаданные через «+».
type ParsedChannelVersion = (Vec<(u64, String)>, Option<String>);

fn parse_channel_version(raw: &str) -> Option<ParsedChannelVersion> {
    let value = raw.trim();
    let value = value.strip_prefix(['v', 'V']).unwrap_or(value);
    let value = value.split('+').next().unwrap_or(value);
    let (core, pre) = match value.split_once('-') {
        Some((core, pre)) if !pre.is_empty() => (core, Some(pre.to_ascii_lowercase())),
        Some(_) => return None,
        None => (value, None),
    };
    if core.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for part in core.split('.') {
        let digits = part.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || digits > 18 {
            return None;
        }
        let suffix = &part[digits..];
        if !suffix.bytes().all(|b| b.is_ascii_alphabetic()) {
            return None;
        }
        parts.push((part[..digits].parse().ok()?, suffix.to_ascii_lowercase()));
    }
    Some((parts, pre))
}

fn compare_prerelease(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering as CmpOrdering;
    let mut left_ids = left.split('.');
    let mut right_ids = right.split('.');
    loop {
        match (left_ids.next(), right_ids.next()) {
            (None, None) => return CmpOrdering::Equal,
            (None, Some(_)) => return CmpOrdering::Less,
            (Some(_), None) => return CmpOrdering::Greater,
            (Some(a), Some(b)) => {
                let order = match (a.parse::<u64>(), b.parse::<u64>()) {
                    (Ok(a), Ok(b)) => a.cmp(&b),
                    (Ok(_), Err(_)) => CmpOrdering::Less,
                    (Err(_), Ok(_)) => CmpOrdering::Greater,
                    (Err(_), Err(_)) => a.cmp(b),
                };
                if order != CmpOrdering::Equal {
                    return order;
                }
            }
        }
    }
}

// Сравнить версии канала как числовые кортежи (1.10 > 1.9, 1.10 == 1.10.0,
// 1.6.3b > 1.6.3, 1.0.0-rc1 < 1.0.0). None — хотя бы одна не разбирается.
fn compare_channel_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering as CmpOrdering;
    let (left_core, left_pre) = parse_channel_version(left)?;
    let (right_core, right_pre) = parse_channel_version(right)?;
    let zero = (0u64, String::new());
    for index in 0..left_core.len().max(right_core.len()) {
        let a = left_core.get(index).unwrap_or(&zero);
        let b = right_core.get(index).unwrap_or(&zero);
        let order = a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1));
        if order != CmpOrdering::Equal {
            return Some(order);
        }
    }
    Some(match (left_pre, right_pre) {
        (None, None) => CmpOrdering::Equal,
        (None, Some(_)) => CmpOrdering::Greater,
        (Some(_), None) => CmpOrdering::Less,
        (Some(a), Some(b)) => compare_prerelease(&a, &b),
    })
}

// «Есть обновление» — только если канал строго новее активного набора, либо
// активное поколение нуждается в пересинхронизации, а канал не старше.
fn channel_update_available(remote: &str, local: &str, needs_resync: bool) -> bool {
    use std::cmp::Ordering as CmpOrdering;
    if !valid_channel_version(remote) {
        return false;
    }
    match compare_channel_versions(remote, local) {
        Some(CmpOrdering::Greater) => true,
        Some(CmpOrdering::Equal) => needs_resync,
        Some(CmpOrdering::Less) => false,
        // Активная версия неизвестна («—») — разбираемый канал её заменит.
        None => parse_channel_version(remote).is_some() && parse_channel_version(local).is_none(),
    }
}

// Принять ли подписанный бандл версии `incoming` поверх активной `active`.
// Старый подписанный бандл подпись проходит тоже, поэтому откат версии
// отсекается отдельно; повтор той же версии разрешён (починка поколения).
fn channel_bundle_acceptable(incoming: &str, active: &str) -> bool {
    match compare_channel_versions(incoming, active) {
        Some(order) => order != std::cmp::Ordering::Less,
        None => parse_channel_version(active).is_none(),
    }
}

// Распарсить версию движка из вывода `winws --version` (баннер вида
// "github version 72.12 (...)" — печатается самим winws). Ищем токен с цифрами
// после слова "version".
fn parse_engine_version(out: &str) -> Option<String> {
    for line in out.lines() {
        let low = line.to_lowercase();
        if let Some(idx) = low.find("version") {
            let after = &line[idx + "version".len()..];
            let tok: String = after
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '.')
                .collect();
            if tok.chars().any(|c| c.is_ascii_digit()) {
                return Some(tok);
            }
        }
    }
    None
}

// Реальная версия движка winws на машине: спрашиваем у самого winws (--version).
// Ограниченное ожидание ~1.5с + kill, чтобы не повиснуть, если бинарь поведёт
// себя неожиданно. Windows-only (winws.exe — Win-бинарь).
#[cfg(target_os = "windows")]
fn engine_version_runtime(app: &AppHandle) -> Option<String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    let bin = bin_dir(app, false).ok()?; // winws.exe идентичен в обоих каталогах
    let exe = bin.join("winws.exe");
    if !exe.exists() {
        return None;
    }
    let mut child = std::process::Command::new(&exe)
        .arg("--version")
        .current_dir(&bin)
        .creation_flags(0x0800_0000)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    let mut waited = 0u64;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if waited >= 1500 {
                    let _ = terminate_child_bounded(&mut child, "winws --version");
                    return None;
                }
                std::thread::sleep(Duration::from_millis(100));
                waited += 100;
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let mut out = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut out);
    }
    if parse_engine_version(&out).is_none() {
        if let Some(mut se) = child.stderr.take() {
            let _ = se.read_to_string(&mut out);
        }
    }
    parse_engine_version(&out).map(|v| format!("zapret {v}"))
}

// Версия движка: реальная от winws (--version) → bundled engine-version.txt → дефолт.
fn engine_version(app: &AppHandle) -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some(v) = engine_version_runtime(app) {
            return v;
        }
    }
    res_dpi(app)
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("engine-version.txt")).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "winws (zapret)".into())
}

/// Три версии для карточки «Обновления»: приложение / движок / набор стратегий.
/// Движок едет в составе приложения (app-OTA), поэтому отдельной кнопки обновления
/// у него нет — обновляется вместе с Ninety.
#[tauri::command]
pub fn dpi_versions(app: AppHandle) -> Result<serde_json::Value, String> {
    let strat = strat_version(&app)?;
    Ok(serde_json::json!({
        "app": app.package_info().version.to_string(),
        "engine": engine_version(&app),
        "strategies": strat,
    }))
}

// Цели автоподбора. Discord — основной сценарий обхода, и одного YouTube не
// хватало: у части провайдеров YouTube открыт, а Discord режется, и тогда
// «прошли все» получали даже стратегии, на которых Discord не работает. Каждая
// цель — свой SNI из наших же списков (list-general.txt).
const AUTOTEST_TARGETS: [&str; 3] = [
    "https://discord.com/api/v10/gateway",
    "https://cdn.discordapp.com/embed/avatars/0.png",
    "https://www.youtube.com/",
];
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
// Драйверу WinDivert нужно отцепиться от умершего winws до следующего
// старта. 150 мс подряд 20 раз давали гонку, в которой движок не
// поднимался, а стратегия выглядела нерабочей.
const AUTOTEST_ENGINE_SETTLE: Duration = Duration::from_millis(500);
// Попыток поднять движок на одну стратегию, прежде чем засчитать провал.
const AUTOTEST_ENGINE_ATTEMPTS: usize = 2;

// Клиент одной пробы автоподбора: без прокси, без переиспользования соединений.
// Пул соединений здесь — источник ложных успехов, см. dpi_autotest.
fn probe_client() -> Result<reqwest::Client, String> {
    crate::util::direct_client_builder()
        .timeout(PROBE_TIMEOUT)
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|e| format!("http client: {e}"))
}

// Клиент для ЗАГРУЗКИ СПИСКОВ (hosts/ipset). port=Some(p>0) → через mixed-inbound
// sing-box (http://127.0.0.1:p), т.е. трафик идёт через обход/VPN; иначе прямой
// запрос. Отличие от probe_client: прямой запрос к raw.githubusercontent.com
// из РФ режется ТСПУ — поэтому при активном VPN (proxy/systemProxy) тянем через
// прокси, а на direct падаем фолбэком (паттерн взят у quality::build_client).
fn list_client(port: Option<u16>) -> Result<reqwest::Client, String> {
    let mut b = crate::util::direct_client_builder().timeout(Duration::from_secs(20));
    if let Some(p) = port {
        if p > 0 {
            let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{p}"))
                .map_err(|e| format!("proxy: {e}"))?;
            b = b.proxy(proxy);
        }
    }
    b.build().map_err(|e| format!("http client: {e}"))
}

// Порядок попыток загрузки: сперва через прокси (если port>0 — путь через обход),
// затем прямой fallback. port=None/0 (VPN выключен / TUN) → только direct. github
// raw и releases из РФ режутся ТСПУ, поэтому при активном VPN тянем через туннель.
fn fetch_routes(port: Option<u16>) -> Vec<Option<u16>> {
    let mut routes: Vec<Option<u16>> = Vec::new();
    if matches!(port, Some(p) if p > 0) {
        routes.push(port); // 1) через mixed-inbound (обход)
    }
    routes.push(None); // 2) прямой fallback
    routes
}

fn ensure_content_length_limit(
    content_length: Option<u64>,
    max_bytes: u64,
    label: &str,
) -> Result<(), String> {
    if let Some(n) = content_length.filter(|n| *n > max_bytes) {
        return Err(format!("{label} too large: {n} bytes > {max_bytes}"));
    }
    Ok(())
}

async fn read_http_body_limited(
    mut resp: Response,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    ensure_content_length_limit(resp.content_length(), max_bytes, label)?;
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read body: {e}"))? {
        let next_len = body.len() as u64 + chunk.len() as u64;
        if next_len > max_bytes {
            return Err(format!("{label} too large: {next_len} bytes > {max_bytes}"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

// Загрузить сырые байты устойчиво: proxy→direct (fetch_routes), по 2 попытки на
// каждый. Ретраи + проксирование повышают шанс пройти сквозь флапающий/режущийся
// ТСПУ github. Если прокси не слушает (VPN выключен) — proxy-попытка быстро падает.
// Байты (не текст): подписанный .zip-бандл канала нельзя декодировать как UTF-8;
// текстовые ассеты (version.txt, .sig) читает fetch_list_text поверх этого.
async fn fetch_list_bytes_limited(
    url: &str,
    port: Option<u16>,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut last = String::from("no attempts");
    for via in fetch_routes(port) {
        let client = match list_client(via) {
            Ok(c) => c,
            Err(e) => {
                last = e;
                continue;
            }
        };
        for attempt in 0..2 {
            match client
                .get(url)
                .send()
                .await
                .and_then(|r| r.error_for_status())
            {
                Ok(resp) => match read_http_body_limited(resp, max_bytes, label).await {
                    Ok(b) => return Ok(b),
                    Err(e) => last = format!("read body: {e}"),
                },
                Err(e) => last = format!("send: {e}"),
            }
            if attempt == 0 {
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }
    }
    Err(last)
}

// Текстовый ассет канала (version.txt, .sig) поверх fetch_list_bytes. Ассеты
// заведомо UTF-8, поэтому lossy-декод безопасен и не плодит второй копии ретрай-цикла.
async fn fetch_list_text_limited(
    url: &str,
    port: Option<u16>,
    max_bytes: u64,
    label: &str,
) -> Result<String, String> {
    let bytes = fetch_list_bytes_limited(url, port, max_bytes, label).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn fetch_list_text(url: &str, port: Option<u16>) -> Result<String, String> {
    fetch_list_text_limited(url, port, MAX_CHANNEL_TEXT_BYTES, "channel text").await
}

/// Доступно ли обновление набора стратегий. Сравниваем с версией НАШЕГО КАНАЛА
/// (version.txt-ассет релиза dpi-channel) — тем, что реально поставит кнопка
/// «Обновить» через dpi_sync_channel. НЕ с live-версией Flowseal: канал
/// публикуется после review и может отставать от свежего релиза
/// Flowseal. Если сверяться с live, в окне «Flowseal зарелизил → канал ещё не
/// синканул» проверка показывает «обновление есть», а кнопка тянет старый бандл
/// → local никогда не догоняет remote → вечный «битый круг» обновления.
#[tauri::command]
pub async fn dpi_check_update(
    app: AppHandle,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    let active = load_strategies(&app)?;
    // port>0 (VPN в proxy/systemProxy) → проверка идёт через туннель: version.txt
    // релиза dpi-channel лежит на github, а он из РФ режется ТСПУ напрямую.
    let remote = fetch_list_text(&format!("{CHANNEL_BASE}/version.txt"), port)
        .await
        .map_err(|e| format!("fetch version: {e}"))?
        .trim()
        .to_string();
    // Не «любое отличие»: канал, отставший от встроенного набора, обновлением
    // не является, а «Обновить» его всё равно отклонило бы.
    Ok(serde_json::json!({
        "local": active.version,
        "remote": remote,
        "available": channel_update_available(&remote, &active.version, active.needs_resync),
        "resync": active.needs_resync,
    }))
}

// ── Канал данных стратегий (подписанный, без переустановки) ──────────

fn decode_channel_public_key(key_b64: &str) -> Result<minisign_verify::PublicKey, String> {
    use base64::Engine;
    let std_b64 = base64::engine::general_purpose::STANDARD;
    // Tauri хранит pubkey как base64 от полного minisign .pub-файла. После
    // одного decode здесь обязан получиться комментарий и одна строка ключа.
    // Лишний слой base64 раньше ломал чистые установки до чтения legacy key.
    let pk_raw = std_b64
        .decode(key_b64)
        .map_err(|e| format!("pubkey b64: {e}"))?;
    let pk_text = String::from_utf8(pk_raw).map_err(|e| format!("pubkey utf8: {e}"))?;
    let key_line = pk_text
        .lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty() && !line.starts_with("untrusted comment"))
        .ok_or("pubkey: key line not found")?;
    minisign_verify::PublicKey::from_base64(key_line).map_err(|e| format!("pubkey decode: {e}"))
}

// Проверить minisign-подпись бандла. Dedicated key пробуем первым, legacy OTA
// key — только для безопасного перехода со старого опубликованного канала.
// sig_b64 — содержимое .sig-ассета (base64 от minisign-подписи, формат tauri).
fn verify_channel(data: &[u8], sig_b64: &str) -> Result<(), String> {
    use base64::Engine;
    use minisign_verify::Signature;
    let std_b64 = base64::engine::general_purpose::STANDARD;
    // .sig: base64 → текст minisign-подписи (с trusted/untrusted comment).
    let sig_raw = std_b64
        .decode(sig_b64.trim())
        .map_err(|e| format!("sig b64: {e}"))?;
    let sig_text = String::from_utf8(sig_raw).map_err(|e| format!("sig utf8: {e}"))?;
    let sig = Signature::decode(&sig_text).map_err(|e| format!("sig decode: {e}"))?;
    let mut key_errors = Vec::new();
    let mut usable_keys = 0usize;
    for key_b64 in [CHANNEL_DEDICATED_PUBKEY_B64, CHANNEL_LEGACY_PUBKEY_B64] {
        let pk = match decode_channel_public_key(key_b64) {
            Ok(pk) => pk,
            Err(error) => {
                key_errors.push(error);
                continue;
            }
        };
        usable_keys += 1;
        if pk.verify(data, &sig, true).is_ok() {
            return Ok(());
        }
    }
    if usable_keys == 0 {
        return Err(format!(
            "DPI channel keys are corrupted: {}",
            key_errors.join("; ")
        ));
    }
    Err(crate::util::i18n_error("backend.dpi.badSignature"))
}

// Какие .bin использует strategies.json (плейсхолдер %BIN%xxx.bin в args).
fn referenced_bins(strategies: &[Strategy]) -> std::collections::HashSet<String> {
    let mut need = std::collections::HashSet::new();
    for st in strategies {
        for a in &st.args {
            if let Some(p) = a.find("%BIN%") {
                let tail = &a[p + "%BIN%".len()..];
                let name: String = tail.chars().take_while(|c| !c.is_whitespace()).collect();
                if name.ends_with(".bin") {
                    need.insert(name);
                }
            }
        }
    }
    need
}

fn service_entry(name: &str) -> PathBuf {
    Path::new("service").join(name)
}

// Файл из подписанного бандла, сохранённого в каталоге `dir` (поколение канала
// или staging). Подпись проверяется при КАЖДОМ чтении, а содержимое берётся из
// самого архива: распакованная копия рядом лежит в пользовательском каталоге,
// и дописанная в неё строка иначе доезжала бы до системного hosts.
fn read_signed_bundle_file(dir: &Path, relative: &Path) -> Result<String, String> {
    let mut entries = read_signed_bundle_entries(dir, &[relative])?;
    Ok(entries.remove(0))
}

// Несколько файлов из подписанного бандла за одну проверку подписи. Порядок
// результата совпадает с `relatives`; отсутствие любого файла — ошибка.
fn read_signed_bundle_entries(dir: &Path, relatives: &[&Path]) -> Result<Vec<String>, String> {
    let bundle = dir.join(GENERATION_BUNDLE_FILE);
    let size = std::fs::metadata(&bundle)
        .map_err(|e| format!("signed DPI bundle is missing: {e}"))?
        .len();
    if size > MAX_CHANNEL_BUNDLE_BYTES {
        return Err(format!("signed DPI bundle is too large: {size} bytes"));
    }
    let zip_bytes = std::fs::read(&bundle).map_err(|e| format!("read signed DPI bundle: {e}"))?;
    let sig_b64 = std::fs::read_to_string(dir.join(GENERATION_SIGNATURE_FILE))
        .map_err(|e| format!("read DPI bundle signature: {e}"))?;
    verify_channel(&zip_bytes, &sig_b64)?;

    let reader = std::io::Cursor::new(zip_bytes.as_slice());
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("open zip: {e}"))?;
    let mut found: Vec<Option<String>> = vec![None; relatives.len()];
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(slot) = entry.enclosed_name().and_then(|name| {
            relatives
                .iter()
                .position(|relative| name.as_path() == *relative)
        }) else {
            continue;
        };
        if found[slot].is_some() {
            continue;
        }
        let relative = relatives[slot];
        if entry.size() > MAX_CHANNEL_ENTRY_BYTES {
            return Err(format!(
                "signed DPI bundle entry is too large: {}",
                relative.display()
            ));
        }
        let mut raw = Vec::new();
        std::io::copy(&mut entry, &mut raw)
            .map_err(|e| format!("unzip {}: {e}", relative.display()))?;
        found[slot] = Some(
            String::from_utf8(raw)
                .map_err(|e| format!("{}: invalid UTF-8: {e}", relative.display()))?,
        );
    }
    found
        .into_iter()
        .zip(relatives)
        .map(|(text, relative)| {
            text.ok_or_else(|| format!("signed DPI bundle has no {}", relative.display()))
        })
        .collect()
}

// Скачать ПОДПИСАННЫЙ бандл канала, проверить minisign-подпись ДО распаковки и
// распаковать в уникальный staging (zip-slip-safe). Возвращает путь staging; чистить
// его — на вызывающем. Единая точка входа доверенных данных канала: dpi_sync_channel
// применяет отсюда strategies/lists/bin, а hosts/ipset берут service/* — все три
// потока идут через подпись, без неподписанного github-raw в открытой сети.
// port>0 (VPN в proxy/systemProxy) → тянем через туннель: ассеты релиза dpi-channel
// на github, из РФ напрямую режутся ТСПУ. Подпись делает маршрут доставки недоверенным.
async fn stage_verified_bundle(app: &AppHandle, port: Option<u16>) -> Result<PathBuf, String> {
    let sig_b64 = fetch_list_text_limited(
        &format!("{CHANNEL_BASE}/dpi-channel.zip.sig"),
        port,
        MAX_CHANNEL_SIGNATURE_BYTES,
        "channel signature",
    )
    .await
    .map_err(|e| format!("fetch sig: {e}"))?;
    let zip_bytes = fetch_list_bytes_limited(
        &format!("{CHANNEL_BASE}/dpi-channel.zip"),
        port,
        MAX_CHANNEL_BUNDLE_BYTES,
        "channel bundle",
    )
    .await
    .map_err(|e| format!("fetch zip: {e}"))?;

    // ВЕРИФИКАЦИЯ подписи до любой распаковки.
    verify_channel(&zip_bytes, &sig_b64)?;

    let dpi_data = crate::app_paths::data_dir(app)?.join("dpi");
    let seq = TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed);
    let staging = dpi_data.join(format!(".staging-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&staging).map_err(|e| format!("mkdir staging: {e}"))?;
    let mut staging_guard = StagingDirGuard {
        path: staging.clone(),
        keep: false,
    };

    let reader = std::io::Cursor::new(zip_bytes.as_slice());
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("open zip: {e}"))?;
    if zip.len() > MAX_CHANNEL_ENTRIES {
        return Err(format!(
            "channel bundle has too many entries: {} > {MAX_CHANNEL_ENTRIES}",
            zip.len()
        ));
    }
    let mut unpacked = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        if entry.size() > MAX_CHANNEL_ENTRY_BYTES {
            return Err(format!(
                "channel entry too large: {} ({} bytes)",
                entry.name().unwrap_or_default(),
                entry.size()
            ));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .ok_or("channel unpacked size overflow")?;
        if unpacked > MAX_CHANNEL_UNPACKED_BYTES {
            return Err(format!(
                "channel unpacked data too large: {unpacked} > {MAX_CHANNEL_UNPACKED_BYTES}"
            ));
        }
        // защита от zip-slip: берём только безопасное относительное имя.
        let name = match entry.enclosed_name() {
            Some(n) => n.to_path_buf(),
            None => {
                return Err(format!(
                    "unsafe channel zip path: {}",
                    entry.name().unwrap_or_default()
                ))
            }
        };
        let out = staging.join(&name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("mkdir {name:?}: {e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        let mut f = std::fs::File::create(&out).map_err(|e| format!("create {name:?}: {e}"))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("unzip {name:?}: {e}"))?;
    }
    // Сам бандл и подпись кладём рядом с распакованным: по ним service-файлы
    // перепроверяются перед использованием (read_signed_bundle_file). Запись
    // идёт после распаковки, поэтому одноимённая запись архива их не подменит.
    std::fs::write(staging.join(GENERATION_BUNDLE_FILE), &zip_bytes)
        .map_err(|e| format!("store channel bundle: {e}"))?;
    std::fs::write(staging.join(GENERATION_SIGNATURE_FILE), sig_b64.as_bytes())
        .map_err(|e| format!("store channel signature: {e}"))?;
    staging_guard.keep = true;
    Ok(staging)
}

// Service-файл последнего применённого поколения (оффлайн-фолбэк). Берётся
// только из подписанного бандла этого поколения: распакованной копии и кешу
// прежних версий без подписи больше не доверяем — до следующей синхронизации
// канала такой фолбэк отвечает «канал не синхронизирован».
fn read_cached_service(app: &AppHandle, name: &str) -> Result<String, String> {
    let not_synced =
        || crate::util::i18n_error_with("backend.dpi.channelNotSynced", &[("name", name)]);
    let Some(generation) = active_channel_generation(app)? else {
        return Err(not_synced());
    };
    read_signed_bundle_file(&generation, &service_entry(name)).map_err(|_| not_synced())
}

// Service-файл активного поколения, если канал уже стоит на опубликованной
// версии. Тогда качать бандл незачем: service/<name> в поколении — тот же самый
// подписанный файл, что лежит в zip. Любая осечка (нет поколения, нет файла,
// версии разошлись, сеть молчит) — None, и вызывающий идёт обычным путём.
async fn current_channel_service(app: &AppHandle, port: Option<u16>, name: &str) -> Option<String> {
    let generation = active_channel_generation(app).ok().flatten()?;
    let local = strat_version(app).ok()?;
    let remote = fetch_list_text(&format!("{CHANNEL_BASE}/version.txt"), port)
        .await
        .ok()?;
    if remote.trim().is_empty() || remote.trim() != local {
        return None;
    }
    // Поколение, собранное до появления сохранённого бандла, проверить нечем:
    // None отправляет вызывающего за свежим подписанным бандлом.
    read_signed_bundle_file(&generation, &service_entry(name)).ok()
}

// Взять service-файл канала (hosts / ipset-service.txt) из ПОДПИСАННОГО бандла.
// Сеть → стейджим свежий bundle (verify), извлекаем service/<name>. Нет сети →
// фолбэк на service из активного поколения (или legacy-кеш до первой миграции).
// Раньше hosts/ipset тянулись напрямую с raw.githubusercontent.com/Flowseal без
// подписи — этот путь закрыт: доверяем только minisign-верифицированным данным.
async fn fetch_channel_service(
    app: &AppHandle,
    port: Option<u16>,
    name: &str,
) -> Result<String, String> {
    // Бандл канала весит десятки мегабайт, а нужен из него один файл. Пока
    // поколение совпадает с опубликованной версией, ограничиваемся version.txt.
    if let Some(current) = current_channel_service(app, port, name).await {
        return Ok(current);
    }
    match stage_verified_bundle(app, port).await {
        Ok(staging) => {
            // Читаем из самого бандла, а не из распакованной копии: staging лежит
            // в пользовательском каталоге. Активное поколение по одному
            // service-файлу не меняем — оно переключается только целиком.
            let result = read_signed_bundle_file(&staging, &service_entry(name))
                .or_else(|_| read_cached_service(app, name));
            let _ = std::fs::remove_dir_all(&staging);
            result
        }
        // Сеть недоступна → отдаём кешированную подпись, если есть; иначе сетевую ошибку.
        Err(net) => read_cached_service(app, name).map_err(|_| net),
    }
}

fn require_regular_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("{label} is missing: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    Ok(())
}

fn valid_channel_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 128
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+'))
}

fn cleanup_channel_generations(
    generations: &Path,
    active: &str,
    previous: Option<&str>,
) -> Vec<String> {
    let mut warnings = Vec::new();
    let entries = match std::fs::read_dir(generations) {
        Ok(entries) => entries,
        Err(e) => {
            warnings.push(format!("read DPI channel generations: {e}"));
            return warnings;
        }
    };
    for item in entries {
        let entry = match item {
            Ok(entry) => entry,
            Err(e) => {
                warnings.push(format!("read DPI channel generation entry: {e}"));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == active || previous == Some(name.as_str()) {
            continue;
        }
        let is_dir = match entry.file_type() {
            Ok(kind) => kind.is_dir(),
            Err(e) => {
                warnings.push(format!("DPI channel generation type ({name}): {e}"));
                continue;
            }
        };
        if !is_dir {
            continue;
        }
        if let Err(e) = std::fs::remove_dir_all(entry.path()) {
            warnings.push(format!("remove stale DPI channel generation {name}: {e}"));
        }
    }
    warnings
}

/// Синхронизировать канал стратегий: скачать подписанный бандл, проверить подпись
/// ДО распаковки, провалидировать (strategies.json парсится, все .bin на месте) и
/// собрать полное поколение в app_data. Единственная commit-точка — атомарная
/// замена channel-current после финализации каталога. Движок НЕ трогает.
#[tauri::command]
pub async fn dpi_sync_channel(
    app: AppHandle,
    state: State<'_, DpiState>,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    // 1–3. Скачать + проверить подпись + распаковать в стейджинг (общий хелпер).
    let dpi_data = crate::app_paths::data_dir(&app)?.join("dpi");
    let staging = stage_verified_bundle(&app, port).await?;
    // Смена поколения канала — операция жизненного цикла DPI, а не просто
    // запись файлов: старое поколение чистится, и подменять его под работающим
    // start/autotest нельзя (winws запущен ровно из этого каталога). Гард
    // берём после скачивания, чтобы длинная загрузка не держала запуск обхода.
    let generation = match begin_dpi_operation(&state, "sync_channel") {
        Ok(generation) => generation,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let _operation = DpiOperationGuard {
        state: &state,
        generation,
    };
    let _data = state.data.lock().await;

    let result = (|| -> Result<serde_json::Value, String> {
        std::fs::create_dir_all(&dpi_data).map_err(|e| format!("mkdir dpi data: {e}"))?;
        // Испорченный pointer не мешает: резолв уже откатился на предыдущее
        // целое поколение или встроенный набор, и новое поколение собирается
        // поверх, а commit pointer ниже перезапишет испорченный.
        let current_generation = active_channel_generation_from_dpi(&dpi_data);
        let previous_name = current_generation
            .as_ref()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .map(str::to_string);
        let current_lists = ensure_lists(&app)?;
        let mut fake_selection = load_fake_selection(&app);
        let active_version = load_strategies_from(&dpi_data)?.version;

        // Стратегии и версия — только из подписанного бандла (подпись
        // перепроверяется: staging лежит в пользовательском каталоге), а не из
        // распакованных рядом копий.
        let signed = read_signed_bundle_entries(
            &staging,
            &[Path::new("strategies.json"), Path::new("version.txt")],
        )?;
        let strat_raw = &signed[0];
        let strategies = parse_checked_strategies(strat_raw)?;
        // Бандл обязан быть самодостаточным: нельзя принять новую стратегию,
        // которая случайно работает лишь пока в bin-data лежит старый payload.
        let staged_bin = staging.join("bin");
        if !staged_bin.is_dir() {
            return Err("the bundle has no bin directory".into());
        }
        let mut payloads = Vec::new();
        let mut incoming = std::collections::HashSet::new();
        let rd = std::fs::read_dir(&staged_bin).map_err(|e| format!("read staged bin: {e}"))?;
        for item in rd {
            let entry = item.map_err(|e| format!("read staged bin entry: {e}"))?;
            let path = entry.path();
            if path.extension().is_none_or(|extension| extension != "bin") {
                continue;
            }
            if !entry
                .file_type()
                .map_err(|e| format!("staged bin file type: {e}"))?
                .is_file()
            {
                return Err("channel payload is not a regular file".into());
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "channel .bin name is not UTF-8".to_string())?;
            if !valid_bin_filename(&name) {
                return Err(format!("invalid channel .bin name: {name}"));
            }
            let size = entry
                .metadata()
                .map_err(|e| format!("staged bin metadata: {e}"))?
                .len();
            if !(1..=MAX_DPI_PAYLOAD_BYTES).contains(&size) {
                return Err(format!("invalid channel .bin size: {name} ({size})"));
            }
            incoming.insert(name.clone());
            payloads.push((path, name));
        }
        if payloads.is_empty() || payloads.len() > 256 {
            return Err(format!("invalid channel .bin count: {}", payloads.len()));
        }
        for name in referenced_bins(&strategies) {
            if !incoming.contains(&name) {
                return Err(format!("the bundle has no .bin: {name}"));
            }
        }

        let ver = signed[1].trim().to_string();
        if !valid_channel_version(&ver) {
            return Err("invalid DPI channel version".into());
        }
        // Подпись старого бандла валидна по-прежнему: без этой проверки
        // подменённый ответ «канала» откатывал бы набор на старую версию.
        if !channel_bundle_acceptable(&ver, &active_version) {
            return Err(crate::util::i18n_error_with(
                "backend.dpi.channelOlder",
                &[("remote", &ver), ("local", &active_version)],
            ));
        }

        let staged_lists = staging.join("lists");
        for name in CHANNEL_LIST_FILES {
            let from = staged_lists.join(name);
            require_regular_file(&from, &format!("staged list {name}"))?;
        }
        let staged_service = staging.join("service");
        for name in CHANNEL_SERVICE_FILES {
            require_regular_file(
                &staged_service.join(name),
                &format!("staged service {name}"),
            )?;
        }

        // Собираем новое поколение отдельно от активного. Пока channel-current
        // указывает на старое, ни один читатель не увидит эти файлы.
        let generations = dpi_data.join(CHANNEL_GENERATIONS_DIR);
        std::fs::create_dir_all(&generations)
            .map_err(|e| format!("mkdir DPI channel generations: {e}"))?;
        let generation_name = channel_generation_name();
        let pending = generations.join(format!(".{generation_name}.pending"));
        let finalized = generations.join(&generation_name);
        std::fs::create_dir(&pending)
            .map_err(|e| format!("create pending DPI channel generation: {e}"))?;

        let build_result = (|| -> Result<Vec<String>, String> {
            let lists = pending.join("lists");
            let bin = pending.join("bin-data");
            let service = pending.join("service");
            std::fs::create_dir_all(&lists).map_err(|e| format!("mkdir pending DPI lists: {e}"))?;
            std::fs::create_dir_all(&bin)
                .map_err(|e| format!("mkdir pending DPI bin-data: {e}"))?;
            std::fs::create_dir_all(&service)
                .map_err(|e| format!("mkdir pending DPI service: {e}"))?;

            // Локальные пользовательские/session-файлы переносятся в снимок,
            // но четыре базовых списка всегда берутся из подписанного bundle.
            for name in LOCAL_LIST_FILES {
                let from = current_lists.join(name);
                let to = lists.join(name);
                if from.is_file() {
                    copy_replace(&from, &to, &format!("local list {name}"))?;
                } else if name == IPSET_BASE_FILE {
                    let bundled = res_lists(&app)?.join(name);
                    if bundled.is_file() {
                        copy_replace(&bundled, &to, "bundled ipset base")?;
                    } else {
                        write_replace(&to, "", "empty ipset base")?;
                    }
                } else {
                    write_replace(&to, "", &format!("empty local list {name}"))?;
                }
            }
            for name in CHANNEL_LIST_FILES {
                copy_replace(
                    &staged_lists.join(name),
                    &lists.join(name),
                    &format!("channel list {name}"),
                )?;
            }
            // Канал везёт списки Flowseal как есть — добавки Ninety сверху.
            apply_list_additions(
                &lists.join("list-general.txt"),
                &NINETY_GENERAL_ADDITIONS,
                "Ninety list additions",
            )?;
            for (path, name) in &payloads {
                copy_replace(path, &bin.join(name), &format!("channel bin {name}"))?;
            }
            for name in CHANNEL_SERVICE_FILES {
                copy_replace(
                    &staged_service.join(name),
                    &service.join(name),
                    &format!("channel service {name}"),
                )?;
            }
            // База ipset приезжает тем же подписанным бандлом, что и стратегии,
            // поэтому обновляем её здесь же. Раньше её двигала только кнопка
            // «Обновить список», и режим «Сайтам из списка IP» мог месяцами
            // работать по набору из установки, пока канал уходил вперёд.
            // Запись идёт ПОСЛЕ переноса LOCAL_LIST_FILES: свежая база обязана
            // перекрыть перенесённую из прошлого поколения, а не наоборот.
            let staged_ipset = std::fs::read_to_string(staged_service.join(IPSET_SERVICE_FILE))
                .map_err(|e| format!("read staged {IPSET_SERVICE_FILE}: {e}"))?;
            if let Some(base) = ipset_base_from_service(&staged_ipset) {
                let base = with_list_additions(&base, &NINETY_IPSET_ADDITIONS).unwrap_or(base);
                write_replace(&lists.join(IPSET_BASE_FILE), &base, "channel ipset base")?;
            }
            // Копия для диагностики и проверки целостности поколения; читаются
            // стратегии всё равно только из bundle.zip.
            write_replace(
                &pending.join("strategies.json"),
                strat_raw,
                "channel strategies",
            )?;
            // Подписанный бандл едет в поколение целиком: service-файлы потом
            // перепроверяются по нему (read_signed_bundle_file).
            for name in [GENERATION_BUNDLE_FILE, GENERATION_SIGNATURE_FILE] {
                copy_replace(
                    &staging.join(name),
                    &pending.join(name),
                    &format!("channel {name}"),
                )?;
            }
            write_replace(
                &pending.join("version.txt"),
                &format!("{ver}\n"),
                "channel version",
            )?;

            // Выбор UDP fake тоже входит в новое поколение. Исчезнувший payload
            // сбрасывается внутри pending, не меняя активный набор до commit.
            let fake_selection_reset =
                reapply_fake_selection_value(&bin, Some(&incoming), &mut fake_selection)?;
            save_fake_selection_at(&pending.join("fake-selection.json"), &fake_selection)?;
            validate_channel_generation(&pending)?;

            // Сначала атомарно финализируем полный каталог, затем одним
            // crash-safe replace переключаем читателей на него.
            finalize_channel_generation(&pending, &finalized)?;
            validate_channel_generation(&finalized)?;
            write_replace(
                &dpi_data.join(CHANNEL_POINTER_FILE),
                &format!("{generation_name}\n"),
                "DPI channel pointer",
            )?;
            Ok(fake_selection_reset)
        })();

        let fake_selection_reset = match build_result {
            Ok(reset) => reset,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&pending);
                let _ = std::fs::remove_dir_all(&finalized);
                return Err(error);
            }
        };

        // Предыдущее поколение оставляем: уже запущенный winws может ещё читать
        // старые пути до frontend-restart. Более старые/осиротевшие поколения
        // удаляем best-effort; они не участвуют в выборе активного набора.
        let cleanup_warnings =
            cleanup_channel_generations(&generations, &generation_name, previous_name.as_deref());

        Ok(serde_json::json!({
            "version": ver,
            "applied": true,
            "fake_selection_reset": fake_selection_reset,
            "cleanup_warnings": cleanup_warnings,
        }))
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

// ── Файл hosts (обход DNS-подмены) + обновление базы ipset ───────────
// Зачем hosts вдобавок к winws: когда провайдер не режет пакеты, а ПОДМЕНЯЕТ
// DNS-ответ, домен резолвится в мусор и handshake не начинается — winws нечего
// десинхронить. Прибиваем рабочие IP гвоздём (голосовые серверы Discord,
// веб-Telegram, GitHub). Пишем ТОЛЬКО свой блок между маркерами, чужие строки
// hosts не трогаем; идемпотентно — повторный apply заменяет блок целиком.
const HOSTS_BEGIN: &str = "# >>> 190x4 Ninety (DPI hosts) >>>";
const HOSTS_END: &str = "# <<< 190x4 Ninety (DPI hosts) <<<";

// Путь собирается от GetSystemDirectoryW (util::system_hosts_path), а не от
// %SystemRoot%: переменную окружения переопределяет HKCU\Environment, а этот
// путь уходит в перезапись файла из elevated-процесса.
#[cfg(target_os = "windows")]
fn system_hosts_path() -> PathBuf {
    crate::util::system_hosts_path()
}
#[cfg(not(target_os = "windows"))]
fn system_hosts_path() -> PathBuf {
    PathBuf::from("/etc/hosts")
}

// Присутствует ли НАШ managed-блок. Маркер обязан быть отдельной строкой —
// ровно так его ищут strip_managed_block и разбор блока в dpi_hosts_status.
// Прежний `content.contains(HOSTS_BEGIN)` был подстрокой по всему файлу:
// комментарий вида `# <маркер> хвост` давал applied=true при пустом блоке, а в
// dpi_hosts_apply — ещё и выбор не того тела для первого бэкапа hosts.
fn has_managed_block(content: &str) -> bool {
    content.lines().any(|line| line.trim() == HOSTS_BEGIN)
}

// Удалить наш managed-блок (BEGIN..END включительно) из текста hosts, не трогая
// остальное. Возвращает текст без блока (с финальным \n у каждой строки).
fn strip_managed_block(content: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut skip = false;
    let mut blocks = 0usize;
    for line in content.lines() {
        let t = line.trim();
        if t == HOSTS_BEGIN {
            if skip {
                return Err("hosts: nested Ninety BEGIN marker".into());
            }
            skip = true;
            blocks += 1;
            continue;
        }
        if t == HOSTS_END {
            if !skip {
                return Err("hosts: Ninety END marker without BEGIN".into());
            }
            skip = false;
            continue;
        }
        if skip {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if skip {
        return Err("hosts: Ninety BEGIN marker without END".into());
    }
    if blocks > 1 {
        return Err(format!(
            "hosts: several managed Ninety blocks found ({blocks})"
        ));
    }
    Ok(out)
}

// Системный hosts читаем байтами. Windows не требует от него UTF-8: сторонние
// утилиты пишут туда комментарии в ANSI-кодировке, и `read_to_string` на таком
// файле падал — функция hosts становилась недоступной целиком. Каждый байт
// отображается в символ U+0000..U+00FF и обратно без потерь, а маркеры и
// записи Ninety — ASCII, поэтому чужие байты возвращаются в файл как были.
fn read_hosts_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read hosts ({}): {e}", path.display()))?;
    Ok(decode_hosts_bytes(&bytes))
}

fn decode_hosts_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| char::from(byte)).collect()
}

fn encode_hosts_text(text: &str) -> Result<Vec<u8>, String> {
    text.chars()
        .map(u8::try_from)
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| "hosts: character outside the single-byte encoding".to_string())
}

// Хвостовые пробелы и переводы строк снимаем только ASCII. Юникодный trim_end
// срезал бы и байты 0x85/0xA0, которые в hosts бывают частью чужих символов
// (UTF-8 «Р» — это D0 A0).
fn trim_hosts_end(text: &str) -> &str {
    text.trim_end_matches([' ', '\t', '\r', '\n'])
}

// Сохранить перенос строки исходного hosts. strip_managed_block работает через
// lines() и отдаёт текст с LF, поэтому CRLF-файл пользователя иначе молча
// нормализуется целиком — включая чужие строки, которых мы не касались.
fn apply_hosts_line_endings(rendered: &str, original: &str) -> String {
    if original.contains("\r\n") {
        rendered.replace('\n', "\r\n")
    } else {
        rendered.to_string()
    }
}

// Сколько валидных записей «IP домен» в тексте (без пустых строк и комментариев).
fn count_hosts_entries(body: &str) -> usize {
    body.lines()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with('#') && t.split_whitespace().count() >= 2
        })
        .count()
}

fn valid_hosts_domain(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 {
        return false;
    }
    name.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

// Проверка формы блока, который уйдёт в системный hosts.
//
// Тело приходит из подписанного бандла (см. read_signed_bundle_file), и это
// второй рубеж поверх подписи: от каждой строки требуем форму
// «IP домен [домен…]», чтобы в системный hosts из elevated-процесса не уехало
// ничего, кроме записей. Тот же shape-check делает CI перед подписью канала.
fn sanitize_hosts_body(body: &str) -> Result<String, String> {
    let mut out = Vec::new();
    for (index, line) in body.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push(trimmed.to_string());
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let address = parts.next().unwrap_or_default();
        if address.parse::<std::net::IpAddr>().is_err() {
            return Err(format!(
                "hosts: line {} does not start with an IP address: {trimmed}",
                index + 1
            ));
        }
        let domains: Vec<&str> = parts.take_while(|token| !token.starts_with('#')).collect();
        if domains.is_empty() {
            return Err(format!(
                "hosts: line {} has no domain: {trimmed}",
                index + 1
            ));
        }
        for domain in &domains {
            if !valid_hosts_domain(domain) {
                return Err(format!(
                    "hosts: line {} has an invalid name \"{domain}\"",
                    index + 1
                ));
            }
        }
        out.push(format!("{address} {}", domains.join(" ")));
    }
    Ok(out.join("\n"))
}

/// Статус системного hosts: применён ли наш блок и сколько в нём записей.
#[tauri::command]
pub fn dpi_hosts_status(_app: AppHandle) -> Result<serde_json::Value, String> {
    let path = system_hosts_path();
    let content = read_hosts_file(&path)?;
    // Повреждённые маркеры нельзя показывать как нормальное applied-состояние:
    // apply/clear в таком случае тоже остановятся без записи.
    let _ = strip_managed_block(&content)?;
    let mut inside = false;
    let mut applied = false;
    let mut block = String::new();
    for line in content.lines() {
        let t = line.trim();
        if t == HOSTS_BEGIN {
            inside = true;
            applied = true;
            continue;
        }
        if t == HOSTS_END {
            inside = false;
            continue;
        }
        if inside {
            block.push_str(line);
            block.push('\n');
        }
    }
    Ok(serde_json::json!({
        "applied": applied,
        "entries": count_hosts_entries(&block),
    }))
}

/// Скачать актуальный hosts из репозитория и (пере)записать наш managed-блок в
/// системный hosts. Требует админ-прав (фронт элевирует перед вызовом). Делает
/// бэкап оригинала при первой записи и сбрасывает DNS-кэш. Возвращает число записей.
#[tauri::command]
pub async fn dpi_hosts_apply(
    app: AppHandle,
    port: Option<u16>,
) -> Result<serde_json::Value, String> {
    // hosts прибивает IP↔домен в системном hosts — самый чувствительный из
    // DPI-путей, поэтому берём его строго из minisign-подписанного канала (было:
    // прямой неподписанный fetch с Flowseal raw).
    let raw = fetch_channel_service(&app, port, "hosts")
        .await
        .map_err(|e| format!("fetch hosts: {e}"))?;
    let body = raw.replace("\r\n", "\n");
    let body = body.trim();
    if count_hosts_entries(body) == 0 {
        return Err(crate::util::i18n_error("backend.dpi.hostsNoRecords"));
    }
    // Форму проверяем ПЕРЕД записью — второй рубеж поверх подписи бандла.
    let sanitized = sanitize_hosts_body(body)?;
    let backup_dir = crate::app_paths::data_dir(&app)?.join("dpi");
    // Дальше — файл в System32 под перехватом Defender и ожидание
    // `ipconfig /flushdns`: блокирующая работа, которая занимала поток async-
    // рантайма на секунды (dpi_hosts_clear вынесен так же).
    let entries = tauri::async_runtime::spawn_blocking(move || {
        write_hosts_block_blocking(&backup_dir, sanitized.trim())
    })
    .await
    .map_err(|e| format!("waiting for the hosts write failed: {e}"))??;
    Ok(serde_json::json!({ "entries": entries }))
}

fn write_hosts_block_blocking(bdir: &Path, body: &str) -> Result<usize, String> {
    let path = system_hosts_path();
    let current = read_hosts_file(&path)?;
    let base = strip_managed_block(&current)?;

    // Бэкап оригинала один раз — до первой нашей записи. Ошибка backup блокирует
    // системную запись: без проверяемого отката менять hosts нельзя.
    std::fs::create_dir_all(bdir).map_err(|e| format!("mkdir hosts backup: {e}"))?;
    let backup = bdir.join("hosts.backup");
    if !backup.exists() {
        // При миграции со старой версии managed-блок уже может быть, а backup —
        // ещё нет. В этом случае сохраняем восстановленную базу без нашего блока.
        let backup_body = encode_hosts_text(if has_managed_block(&current) {
            &base
        } else {
            &current
        })?;
        write_bytes_replace(&backup, &backup_body, "hosts backup")?;
        let saved = std::fs::read(&backup).map_err(|e| format!("verify hosts backup: {e}"))?;
        if saved != backup_body {
            return Err("hosts backup check: contents differ".into());
        }
    } else if backup.exists() {
        std::fs::File::open(&backup).map_err(|e| format!("open hosts backup: {e}"))?;
    }

    // Снять старый блок (если был), дописать свежий в конец.
    let base = trim_hosts_end(&base);
    let mut out = String::new();
    out.push_str(base);
    if !base.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(HOSTS_BEGIN);
    out.push('\n');
    out.push_str(body);
    out.push('\n');
    out.push_str(HOSTS_END);
    out.push('\n');

    // Системный hosts перезаписываем НА МЕСТЕ, а не подменяем: замена файла
    // отдала бы цели DACL временного объекта, а Controlled Folder Access и часть
    // антивирусов блокируют именно подмену. Оборванную запись overwrite_in_place
    // откатывает сам; hosts.backup выше — страховка на случай, если не вышло и это.
    let out = encode_hosts_text(&apply_hosts_line_endings(&out, &current))?;
    let original = encode_hosts_text(&current)?;
    overwrite_in_place(&path, &out, &original, "system hosts").map_err(|e| {
        crate::util::i18n_error_with(
            "backend.dpi.hostsAdmin",
            &[("error", &format!("{}: {e}", path.display()))],
        )
    })?;
    flush_dns();
    Ok(count_hosts_entries(body))
}

/// Удалить наш managed-блок из системного hosts (полный откат). Требует админ-прав.
///
/// async + spawn_blocking: тело читает и переписывает файл в System32 (под
/// перехватом Defender), а затем ждёт завершения `ipconfig /flushdns`. На
/// главном потоке это уносило окно в «не отвечает» на секунды.
#[tauri::command]
pub async fn dpi_hosts_clear(_app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(dpi_hosts_clear_blocking)
        .await
        .map_err(|e| format!("waiting for the hosts cleanup failed: {e}"))?
}

fn dpi_hosts_clear_blocking() -> Result<(), String> {
    let path = system_hosts_path();
    let current = read_hosts_file(&path)?;
    if !has_managed_block(&current) {
        // Даже clear не должен молча принимать лишний END-маркер.
        let _ = strip_managed_block(&current)?;
        return Ok(());
    }
    let stripped = format!("{}\n", trim_hosts_end(&strip_managed_block(&current)?));
    let stripped = encode_hosts_text(&apply_hosts_line_endings(&stripped, &current))?;
    let original = encode_hosts_text(&current)?;
    overwrite_in_place(&path, &stripped, &original, "system hosts")
        .map_err(|e| crate::util::i18n_error_with("backend.dpi.hostsAdmin", &[("error", &e)]))?;
    flush_dns();
    Ok(())
}

fn flush_dns() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new(system32("ipconfig.exe"))
            .arg("/flushdns")
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

// Сколько IP-записей в файле-списке ipset (строки без пустых и комментариев).
fn count_ipset_lines(txt: &str) -> usize {
    txt.lines()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with('#')
        })
        .count()
}

/// Домены, которые winws сам определил как заблокированные (режим «Только
/// заблокированные»). Свежие — первыми: файл дописывается в конец.
#[tauri::command]
pub fn dpi_auto_domains(app: AppHandle) -> Result<Vec<String>, String> {
    let lists = ensure_lists(&app)?;
    let txt = read_list_text(&lists.join(AUTO_HOSTLIST_FILE))?;
    Ok(auto_domains_from(&txt))
}

/// Убрать домен из автосписка: обход перестанет к нему применяться, пока winws
/// снова не увидит признаки блокировки. Возвращает остаток списка.
/// От повторного попадания спасает только список исключений — так же, как
/// советует сам zapret; кнопка «в исключения» в UI дергает dpi_write_list.
#[tauri::command]
pub async fn dpi_auto_forget(
    app: AppHandle,
    state: State<'_, DpiState>,
    domain: String,
) -> Result<Vec<String>, String> {
    let _data = state.data.lock().await;
    let lists = ensure_lists(&app)?;
    let path = lists.join(AUTO_HOSTLIST_FILE);
    let txt = read_list_text(&path)?;
    let target = domain.trim();
    if target.is_empty() {
        return Err("empty domain".into());
    }
    let mut kept = String::new();
    for line in txt.lines() {
        if line.trim().eq_ignore_ascii_case(target) {
            continue;
        }
        kept.push_str(line);
        kept.push('\n');
    }
    // winws перечитывает автосписок по сигнатуре файла, поэтому перезапуск
    // движка не нужен — правка подхватывается на следующем соединении.
    write_replace(&path, &kept, "auto hostlist forget")?;
    Ok(auto_domains_from(&kept))
}

/// Очистить автосписок целиком — обучение начнётся заново.
#[tauri::command]
pub async fn dpi_auto_clear(app: AppHandle, state: State<'_, DpiState>) -> Result<(), String> {
    let _data = state.data.lock().await;
    let lists = ensure_lists(&app)?;
    write_replace(&lists.join(AUTO_HOSTLIST_FILE), "", "auto hostlist clear")
}

// Тело базы ipset из service-файла канала. None — записей нет: такой файл базу
// не заменяет ни при ручном обновлении, ни при синхронизации канала. Прежний
// рабочий список полезнее обнулённого, а пустая коллекция ipset у winws вообще
// означает «не фильтровать по IP» — режим «Сайтам из списка IP» молча
// превратился бы во «Всем сайтам».
fn ipset_base_from_service(raw: &str) -> Option<String> {
    let body = raw.replace("\r\n", "\n");
    (count_ipset_lines(&body) > 0).then_some(body)
}

/// Текущее число IP в активной базе ipset (writable-override → ресурс).
#[tauri::command]
pub fn dpi_ipset_count(app: AppHandle) -> Result<usize, String> {
    let lists = ensure_lists(&app)?;
    let wbase = lists.join(IPSET_BASE_FILE);
    let path = if wbase.exists() {
        wbase
    } else {
        res_lists(&app)?.join(IPSET_BASE_FILE)
    };
    let txt = std::fs::read_to_string(&path).unwrap_or_default();
    Ok(count_ipset_lines(&txt))
}

/// Обновить базу ipset (ipset-all) актуальным списком из репозитория. Пишем в
/// writable-копию app_data — режим IPSet «Загружен» берёт её приоритетно. Если
/// движок запущен в этом режиме, перезапуск winws — на стороне фронта.
/// Возвращает число загруженных IP.
#[tauri::command]
pub async fn dpi_update_ipset(
    app: AppHandle,
    state: State<'_, DpiState>,
    port: Option<u16>,
) -> Result<usize, String> {
    let _data = state.data.lock().await;
    let lists = ensure_lists(&app)?;
    // База ipset — тоже из подписанного канала (было: прямой fetch с Flowseal raw).
    let raw = fetch_channel_service(&app, port, IPSET_SERVICE_FILE)
        .await
        .map_err(|e| format!("fetch ipset: {e}"))?;
    let body = ipset_base_from_service(&raw)
        .ok_or_else(|| crate::util::i18n_error("backend.dpi.ipsetNoRecords"))?;
    let body = with_list_additions(&body, &NINETY_IPSET_ADDITIONS).unwrap_or(body);
    let n = count_ipset_lines(&body);
    write_replace(&lists.join(IPSET_BASE_FILE), &body, "write ipset base")?;
    Ok(n)
}

// ── Авто-подбор стратегии ───────────────────────────────────────────
#[derive(serde::Serialize, Clone)]
struct AutotestProgress {
    i: usize,
    total: usize,
    name: String,
}

/// Перебирает неэкспериментальные стратегии: поднимает winws с каждой (до
/// AUTOTEST_ENGINE_ATTEMPTS попыток — «драйвер занят» гоночно), пробит все цели
/// свежим соединением на каждую и выбирает лучшую по охвату, при равном — по
/// задержке. Прогресс — событием "dpi:autotest", вывод winws — в
/// dpi-autotest.log. winws после теста остаётся выключенным; применяет выбор и
/// возвращает прежнее состояние движка фронт.
///
/// ВАЖНО: бессмысленно в TUN — там проба уходит в туннель мимо winws, и фронт
/// такой запуск не даёт. В proxy/systemProxy проба идёт мимо системного прокси
/// (probe_client), поэтому измеряет реальный канал. Требует элевации.
#[tauri::command]
pub async fn dpi_autotest(
    app: AppHandle,
    state: State<'_, DpiState>,
    test_url: Option<String>,
    monkey: bool,
    logs_disabled: Option<bool>,
) -> Result<serde_json::Value, String> {
    let logs_disabled = logs_disabled.unwrap_or(false);
    let generation = begin_dpi_operation(&state, "autotest")?;
    let _operation = DpiOperationGuard {
        state: &state,
        generation,
    };
    // Глушим текущий winws без изменения generation: autotest теперь владеет
    // lifecycle и публикует каждый test-child в state, поэтому dpi_stop/exit
    // способны отменить и reap'нуть его.
    stop_managed_child(&state, "winws")?;
    // Один пользовательский URL перекрывает набор целиком: ручная проверка
    // конкретного сайта — это ровно одна цель, а не добавка к дефолтным.
    let targets: Vec<String> = match test_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(url) => vec![url.to_string()],
        None => AUTOTEST_TARGETS.iter().map(|u| u.to_string()).collect(),
    };

    // Мьютекс данных держим только на подготовке файлов. Прогон стратегий идёт
    // минутами, и под общим локом он замораживал весь DPI-раздел вместе с
    // dpi_set_active_vpn_endpoint — а его ждёт автозапуск VPN.
    let (strategies, bin, exe, bindata_s, lists, lists_s) = {
        let _data = state.data.lock().await;
        // EXP доступна для ручного выбора, но экспериментальный профиль не должен
        // автоматически становиться рекомендацией автотеста.
        let active = load_strategies(&app)?;
        let bin = bin_dir(&app, monkey)?;
        let exe = bin.join("winws.exe");
        if !exe.exists() {
            return Err(crate::util::i18n_error_with(
                "backend.dpi.winwsMissing",
                &[("path", &exe.display().to_string())],
            ));
        }
        let lists = ensure_lists(&app)?;
        // Прогон всегда идёт в «Всем сайтам»: он меряет саму стратегию на тестовых
        // доменах, а в «Только заблокированным» они ещё не в автосписке — движок не
        // применил бы десинк ни к одному запросу и все стратегии выглядели бы одинаково.
        write_ipset_mode(&app, &lists, "any")?;
        let bindata = ensure_bindata(&app, &active)?;
        let bindata_s = strip_verbatim(&bindata.to_string_lossy());
        let lists_s = strip_verbatim(&lists.to_string_lossy());
        let strategies: Vec<Strategy> = active
            .strategies
            .into_iter()
            .filter(|strategy| !strategy.experimental)
            .collect();
        (strategies, bin, exe, bindata_s, lists, lists_s)
    };
    let exclusion = active_vpn_exclusion_args(&lists);
    // Вывод winws за прогон. Без него провал стратегии неотличим от того, что
    // движок вообще не поднялся: в отчёте и то и другое выглядело как «не
    // прошла», а диагностировать было нечем.
    let log_writer = if logs_disabled {
        None
    } else {
        dpi_autotest_log_file(&app)
            .as_deref()
            .and_then(prepare_dpi_log)
    };
    let total = strategies.len();

    // (id, name, сколько целей открылось, суммарная задержка).
    let mut best: Option<(String, String, usize, u64)> = None;
    let mut passed = 0usize;
    // Стратегии, на которых движок не поднялся. Это не «стратегия не работает»,
    // и отчёт обязан их различать, иначе гонка за драйвер читается как провал
    // половины набора.
    let mut engine_failed = 0usize;

    for (idx, strat) in strategies.iter().enumerate() {
        if !dpi_operation_current(&state, generation) {
            return Err(crate::util::i18n_error("backend.dpi.cancelled"));
        }
        let _ = app.emit(
            "dpi:autotest",
            AutotestProgress {
                i: idx + 1,
                total,
                name: strat.name.clone(),
            },
        );
        // Тот же allowlist, что у dpi_start, прямо перед подстановкой.
        if let Err(error) = validate_strategy_args(&strat.args) {
            if let Some(writer) = log_writer.as_ref() {
                writer
                    .lock_recover()
                    .append(format!("skip {}: {error}\n", strat.name).as_bytes());
            }
            continue;
        }
        let args: Vec<String> = strat
            .args
            .iter()
            .map(|a| subst(a, &bindata_s, &lists_s, "12", "12"))
            .collect();
        // Ровно тот же argv, что соберёт dpi_start: иначе автотест проверяет не
        // то, что потом запустится (исключение ноды меняет матчинг профилей).
        let args = spread_exclusion_across_sections(args, &exclusion);
        // Движку даётся вторая попытка: «драйвер занят» — состояние гоночное,
        // а не свойство стратегии, и один такой промах вычёркивал рабочий
        // профиль из подбора целиком.
        let mut alive = false;
        for attempt in 0..AUTOTEST_ENGINE_ATTEMPTS {
            let mut cmd = std::process::Command::new(&exe);
            cmd.args(&args).current_dir(&bin);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            if let Some(writer) = log_writer.as_ref() {
                writer.lock_recover().append(
                    format!("\n=== autotest: {} (try {}) ===\n", strat.name, attempt + 1)
                        .as_bytes(),
                );
                cmd.stdout(std::process::Stdio::piped());
                cmd.stderr(std::process::Stdio::piped());
            }
            let mut child = match cmd.spawn() {
                Ok(c) => {
                    // Автоподбор поднимает тот же winws с драйвером: сирота от
                    // него так же дерётся за WinDivert, как и от dpi_start.
                    crate::job_guard::bind_pid(c.id());
                    c
                }
                Err(e) => {
                    if let Some(writer) = log_writer.as_ref() {
                        writer
                            .lock_recover()
                            .append(format!("spawn winws: {e}\n").as_bytes());
                    }
                    dpi_sleep_or_cancel(&state, generation, AUTOTEST_ENGINE_SETTLE).await?;
                    continue;
                }
            };
            if let Some(writer) = log_writer.as_ref() {
                if let Some(stdout) = child.stdout.take() {
                    spawn_dpi_log_pipe(stdout, writer.clone());
                }
                if let Some(stderr) = child.stderr.take() {
                    spawn_dpi_log_pipe(stderr, writer.clone());
                }
            }
            {
                let control = state.control.lock_recover();
                if control.generation != generation || control.operation.is_none() {
                    drop(control);
                    let _ = terminate_child_bounded(&mut child, "winws autotest");
                    return Err(crate::util::i18n_error("backend.dpi.cancelled"));
                }
                *state.child.lock_recover() = Some(child);
            }
            state.driver_loaded.store(true, Ordering::SeqCst);
            dpi_sleep_or_cancel(&state, generation, Duration::from_millis(700)).await?;
            remember_owned_driver_services(&state, &bin);

            // winws мог умереть на битом аргументе или занятом драйвере. Без этой
            // проверки мёртвая стратегия засчитывалась как рабочая: запрос всё
            // равно проходит, если сайт у провайдера и так открыт.
            alive = {
                let mut guard = state.child.lock_recover();
                match guard.as_mut() {
                    Some(child) => !matches!(child.try_wait(), Ok(Some(_))),
                    None => false,
                }
            };
            if alive {
                break;
            }
            *state.child.lock_recover() = None;
            dpi_sleep_or_cancel(&state, generation, AUTOTEST_ENGINE_SETTLE).await?;
        }
        if !alive {
            engine_failed += 1;
            continue;
        }

        let mut ok_count = 0usize;
        let mut lat = 0u64;
        for target in &targets {
            // Новый клиент на каждую цель. Общий reqwest::Client держит пул
            // соединений: после первого успеха следующие стратегии переиспользуют
            // уже установленный TCP+TLS, десинк в этом не участвует, и «прошли»
            // получали все подряд. DPI режет именно установление соединения —
            // значит замерять надо только свежий handshake.
            let client = probe_client()?;
            let t0 = Instant::now();
            let ok = tokio::select! {
                response = client.get(target.as_str()).send() => match response {
                    Ok(r) => r.status().is_success() || r.status().is_redirection(),
                    Err(_) => false,
                },
                _ = wait_dpi_cancelled(&state, generation) => {
                    return Err(crate::util::i18n_error("backend.dpi.cancelled"));
                }
            };
            // Цели проверяются все: обрыв на первой неудаче делал оценку
            // зависимой от порядка — стратегия, которая чинит YouTube, но не
            // Discord, была неотличима от полностью нерабочей.
            if ok {
                ok_count += 1;
                lat = lat.saturating_add(t0.elapsed().as_millis() as u64);
            }
        }

        if !dpi_operation_current(&state, generation) {
            return Err(crate::util::i18n_error("backend.dpi.cancelled"));
        }
        stop_managed_child(&state, "winws autotest")?;

        if ok_count > 0 {
            if ok_count == targets.len() {
                passed += 1;
            }
            // Сначала охват (сколько целей открылось), при равном — задержка.
            let better = match &best {
                Some((_, _, bc, bl)) => ok_count > *bc || (ok_count == *bc && lat < *bl),
                None => true,
            };
            if better {
                best = Some((strat.id.clone(), strat.name.clone(), ok_count, lat));
            }
        }
        // пауза, чтобы драйвер успел отцепиться между прогонами
        dpi_sleep_or_cancel(&state, generation, AUTOTEST_ENGINE_SETTLE).await?;
    }

    match best {
        // lat — сумма по открывшимся целям, а UI подписывает число как задержку.
        // Отдаём среднее на проверку, иначе три успешные пробы выглядят как одна
        // втрое более медленная. На ранжирование это не влияет: задержки
        // сравниваются только внутри одинакового охвата.
        Some((id, name, covered, lat)) => Ok(serde_json::json!({
            "best_id": id, "best_name": name, "passed": passed, "total": total,
            "latency_ms": lat / covered.max(1) as u64,
            "targets": targets.len(), "best_targets": covered,
            "engine_failed": engine_failed,
        })),
        None => Ok(serde_json::json!({
            "best_id": null, "best_name": null, "passed": 0, "total": total,
            "latency_ms": null, "targets": targets.len(), "best_targets": 0,
            "engine_failed": engine_failed,
        })),
    }
}

pub fn force_cleanup(state: &DpiState) {
    let _ = stop_dpi_runtime(state, "winws");
}

/// Снять kernel-службы драйвера WinDivert/Monkey. ТРЕБУЕТ админ-прав — вызывать
/// только из elevated-процесса (при запущенном DPI аппа уже elevated: winws — наш
/// child, наследует токен). На kernel-драйвере `sc stop` блокирующий: возвращает
/// управление лишь ПОСЛЕ выгрузки драйвера из ядра — и только тогда снимается лок с
/// `WinDivert64.sys`/`Monkey64.sys` в каталоге установки. `stop` идёт перед `delete`:
/// раз stop синхронный, к delete драйвер уже выгружен и служба-сирота в ядре не
/// повисает (иначе её не снять без перезагрузки). Имя службы у разных сборок winws —
/// WinDivert или WinDivert14 (как чистит service.bat Flowseal), плюс Monkey (наш
/// переименованный вариант, см. bin_dir) — снимаем все.
#[cfg(target_os = "windows")]
fn run_sc_bounded(sc: &str, verb: &str, service: &str, deadline: Instant) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if Instant::now() >= deadline {
        return Err(crate::util::i18n_error("backend.dpi.driverTimeout"));
    }
    let mut child = std::process::Command::new(sc)
        .args([verb, service])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("sc {verb} {service}: {e}"))?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(-1);
                let idempotent = (verb == "stop" && matches!(code, 1060 | 1062))
                    || (verb == "delete" && matches!(code, 1060 | 1072));
                return if status.success() || idempotent {
                    Ok(())
                } else {
                    Err(format!("sc {verb} {service} exited with code {code}"))
                };
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                return Err(format!(
                    "sc {verb} {service} did not finish within the 3 second limit"
                ));
            }
            Err(e) => return Err(format!("sc {verb} {service}: {e}")),
        }
    }
}

#[cfg(target_os = "windows")]
pub fn unload_driver_services(state: &DpiState) -> Result<(), String> {
    let sc = system32("sc.exe");
    let services = state.owned_services.lock_recover().clone();
    let deadline = Instant::now() + DRIVER_UNLOAD_TIMEOUT;
    for svc in &services {
        run_sc_bounded(&sc, "stop", svc, deadline)?;
        run_sc_bounded(&sc, "delete", svc, deadline)?;
    }
    // Стираем ownership только после полного подтверждения. При ошибке весь
    // список остаётся для безопасного повторного unload (операции идемпотентны).
    state.owned_services.lock_recover().clear();
    Ok(())
}
#[cfg(not(target_os = "windows"))]
pub fn unload_driver_services(_state: &DpiState) -> Result<(), String> {
    Ok(())
}

/// Полная выгрузка движка: убить winws И снять kernel-драйвер. Вызывается перед
/// OTA-апдейтом (команда ниже) и при смене режима драйвера. Иначе драйвер остаётся
/// резидентным в ядре, его .sys лочит файл в каталоге установки, и следующая
/// (пере)установка падает на «Невозможно открыть файл для записи». Сначала
/// подтверждаем завершение winws в коротком bounded-цикле — handle к
/// \\.\WinDivert закрывается ДО `sc stop`, поэтому драйвер выгружается с первого
/// раза. Все sc-команды делят один общий трёхсекундный deadline.
pub fn full_unload(state: &DpiState) -> Result<(), String> {
    stop_dpi_runtime(state, "winws")?;
    unload_driver_services(state)?;
    state.driver_loaded.store(false, Ordering::SeqCst);
    Ok(())
}

/// true, если сессия Windows сейчас завершается (shutdown/logoff/reboot).
#[cfg(target_os = "windows")]
fn session_ending() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    // SM_SHUTTINGDOWN != 0 на всём протяжении shutdown-последовательности ОС.
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}
#[cfg(not(target_os = "windows"))]
fn session_ending() -> bool {
    false
}

/// Выгрузка при выходе приложения (lib.rs RunEvent::Exit). В отличие от
/// full_unload здесь `sc.exe` дёргаем ЛИШЬ когда это оправдано:
///  - идёт выключение/logoff ОС → пропускаем: драйвер и так выгрузится при
///    перезагрузке, а запущенный в сворачивающейся сессии `sc.exe` не может
///    инициализироваться и показывает окно ошибки 0xc0000142 (репорт юзера —
///    «вылазит при выключении ПК»);
///  - DPI в этой сессии не поднимался (driver_loaded=false) → снимать нечего,
///    а безусловные 6 запусков `sc.exe` на каждый выход были лишними.
///
/// Кейс «снять лок с .sys для переустановки без перезагрузки» покрыт явной
/// командой dpi_unload_driver (её зовёт фронт перед OTA) — там full_unload.
pub fn cleanup_on_exit(state: &DpiState) {
    force_cleanup(state); // убить winws-child — без sc.exe, всегда безопасно
    if session_ending() {
        return;
    }
    if state.driver_loaded.load(Ordering::SeqCst) && unload_driver_services(state).is_ok() {
        state.driver_loaded.store(false, Ordering::SeqCst);
    }
}

/// Команда из фронта: перед OTA-апдейтом и при смене режима драйвера (WinDivert↔
/// Monkey). Тонкая обёртка над full_unload — оставлена как #[tauri::command] под
/// invoke("dpi_unload_driver").
#[tauri::command]
pub async fn dpi_unload_driver(app: AppHandle) -> Result<(), String> {
    // Как и dpi_stop: подтверждённая остановка winws плюс блокирующие `sc
    // stop/delete` (на kernel-драйвере sc возвращает управление только после
    // выгрузки) складываются в секунды. Фронт зовёт это перед OTA — замирать
    // окну на время выгрузки незачем.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DpiState>();
        full_unload(&state)
    })
    .await
    .map_err(|e| format!("waiting for the DPI driver unload failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // Подпись канала проверяется при загрузке бандла, но service-файлы потом
    // лежат распакованными в пользовательском каталоге и читаются оффлайн уже
    // без проверки. Дописанная туда строка не должна доехать до системного hosts.
    #[test]
    fn hosts_body_rejects_anything_but_ip_and_domains() {
        let good =
            "# comment\n1.2.3.4 discord.com\n2606:4700::1111 cdn.example.org extra.example\n";
        assert_eq!(
            sanitize_hosts_body(good).unwrap(),
            "# comment\n1.2.3.4 discord.com\n2606:4700::1111 cdn.example.org extra.example"
        );

        for planted in [
            "127.0.0.1 bank.example\nnot-an-ip evil.example",
            "1.2.3.4",
            "1.2.3.4 -bad-.example",
            "1.2.3.4 domain with space/slash",
            "cmd.exe /c whoami",
        ] {
            assert!(
                sanitize_hosts_body(planted).is_err(),
                "подменённая строка прошла: {planted}"
            );
        }
    }

    #[test]
    fn hosts_domain_shape() {
        assert!(valid_hosts_domain("discord.com"));
        assert!(valid_hosts_domain("a_b.example-1.org"));
        assert!(!valid_hosts_domain(""));
        assert!(!valid_hosts_domain("double..dot"));
        assert!(!valid_hosts_domain("-lead.example"));
        assert!(!valid_hosts_domain("trail-.example"));
        assert!(!valid_hosts_domain(&format!("{}.example", "x".repeat(64))));
    }

    #[test]
    fn strip_verbatim_forms() {
        assert_eq!(strip_verbatim(r"\\?\C:\dir\winws.exe"), r"C:\dir\winws.exe");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(strip_verbatim(r"C:\plain\path"), r"C:\plain\path");
        assert_eq!(strip_verbatim("/unix/style"), "/unix/style");
    }

    #[test]
    fn subst_replaces_placeholders() {
        let sep = MAIN_SEPARATOR;
        let out = subst("%BIN%tls.bin", "BIN", "LST", "12", "34");
        assert_eq!(out, format!("BIN{sep}tls.bin"));
        let lst = subst("%LISTS%list-general.txt", "BIN", "LST", "12", "34");
        assert_eq!(lst, format!("LST{sep}list-general.txt"));
        // Game-фильтры: TCP/UDP раздельны, а legacy %GameFilter% берёт TCP.
        assert_eq!(
            subst("--wf-tcp=%GameFilterTCP%", "B", "L", "80", "443"),
            "--wf-tcp=80"
        );
        assert_eq!(
            subst("--wf-udp=%GameFilterUDP%", "B", "L", "80", "443"),
            "--wf-udp=443"
        );
        assert_eq!(subst("%GameFilter%", "B", "L", "80", "443"), "80");
    }

    #[test]
    fn active_vpn_exclusion_paths_are_joined_as_single_arguments() {
        let lists = PathBuf::from("C:\\Ninety Data\\Данные\\lists");
        let args = active_vpn_exclusion_args(&lists);
        assert!(!args[0].contains("listsactive-vpn"));
        assert!(!args[1].contains("listsactive-vpn"));
        assert!(args[1].ends_with(&format!("lists{MAIN_SEPARATOR}active-vpn-ip.txt")));
        assert!(args[0].contains("Ninety Data"));
        assert!(args[0].contains("Данные"));
    }

    #[cfg(windows)]
    #[test]
    fn active_vpn_exclusion_paths_use_windows_separator() {
        let args = active_vpn_exclusion_args(Path::new(r"C:\Ninety Data\dpi\lists"));
        assert!(args[1].ends_with(r"lists\active-vpn-ip.txt"));
    }

    // Регресс: исключение активной ноды дописывалось в хвост строки и накрывало
    // только последнюю секцию. VLESS идёт по TCP:443 — то есть по другой секции,
    // и winws десинхрил трафик к собственному серверу.
    #[test]
    fn active_vpn_exclusion_lands_in_every_section() {
        let exclusion = [
            "--hostlist-exclude=D".to_string(),
            "--ipset-exclude=I".to_string(),
        ];
        let args = vec![
            "--filter-udp=443".to_string(),
            "--hostlist=G".to_string(),
            "--dpi-desync=fake".to_string(),
            "--new".to_string(),
            "--filter-tcp=443".to_string(),
            "--hostlist-domains=discord.media".to_string(),
            "--new".to_string(),
            "--filter-tcp=1024-65535".to_string(),
            "--hostlist-auto=A".to_string(),
        ];
        let out = spread_exclusion_across_sections(args, &exclusion);

        // Три секции, в каждой уже есть хостлист → исключение трижды целиком.
        assert_eq!(
            out.iter()
                .filter(|a| a.as_str() == "--hostlist-exclude=D")
                .count(),
            3
        );
        assert_eq!(
            out.iter()
                .filter(|a| a.as_str() == "--ipset-exclude=I")
                .count(),
            3
        );

        // И именно ПЕРЕД разделителем, иначе исключение утечёт в чужую секцию.
        for (i, a) in out.iter().enumerate() {
            if a == "--new" {
                assert_eq!(out[i - 2], "--hostlist-exclude=D");
                assert_eq!(out[i - 1], "--ipset-exclude=I");
            }
        }
        assert_eq!(out.last().unwrap(), "--ipset-exclude=I");
    }

    // Секция без хостлистов (голосовой Discord, Game Filter) ловит трафик без
    // известного хоста. Хостлист в ней запрещает профилю матчиться вообще —
    // туда уходит только ipset-исключение.
    #[test]
    fn active_vpn_exclusion_skips_hostlist_in_hostless_sections() {
        let exclusion = [
            "--hostlist-exclude=D".to_string(),
            "--ipset-exclude=I".to_string(),
        ];
        let args = vec![
            "--filter-udp=443".to_string(),
            "--hostlist=G".to_string(),
            "--new".to_string(),
            "--filter-udp=50000-50100".to_string(),
            "--filter-l7=discord,stun".to_string(),
            "--new".to_string(),
            "--filter-udp=12".to_string(),
            "--dpi-desync-any-protocol=1".to_string(),
        ];
        let out = spread_exclusion_across_sections(args, &exclusion);

        assert_eq!(
            out,
            vec![
                "--filter-udp=443",
                "--hostlist=G",
                "--hostlist-exclude=D",
                "--ipset-exclude=I",
                "--new",
                "--filter-udp=50000-50100",
                "--filter-l7=discord,stun",
                "--ipset-exclude=I",
                "--new",
                "--filter-udp=12",
                "--dpi-desync-any-protocol=1",
                "--ipset-exclude=I",
            ]
        );
    }

    // Игровой фильтр обязан работать при любом режиме IPset. Секции Game Filter
    // уходят на собственный пустой ipset-game.txt, остальные остаются на общем
    // ipset-all.txt, которым управляет переключатель IPset.
    #[test]
    fn game_sections_get_their_own_ipset() {
        let lists = Path::new("L");
        let all = format!("--ipset={}", lists.join("ipset-all.txt").to_string_lossy());
        let game = format!("--ipset={}", lists.join("ipset-game.txt").to_string_lossy());
        let args = vec![
            "--filter-tcp=80,443".to_string(),
            all.clone(),
            "--new".to_string(),
            "--filter-tcp=1024-65535".to_string(),
            all.clone(),
            "--new".to_string(),
            "--filter-udp=1024-65535".to_string(),
            all.clone(),
            "--dpi-desync-any-protocol=1".to_string(),
        ];

        let out = ungate_game_ipset(args, lists, "1024-65535", "1024-65535");

        assert_eq!(
            out,
            vec![
                "--filter-tcp=80,443".to_string(),
                all.clone(),
                "--new".to_string(),
                "--filter-tcp=1024-65535".to_string(),
                game.clone(),
                "--new".to_string(),
                "--filter-udp=1024-65535".to_string(),
                game,
                "--dpi-desync-any-protocol=1".to_string(),
            ]
        );
    }

    // Снятие гейта не должно задевать исключения: активная нода VPN защищена
    // через --ipset-exclude, и подмена основного ipset её не касается.
    #[test]
    fn game_ipset_ungate_keeps_exclusions() {
        let lists = Path::new("L");
        let all = format!("--ipset={}", lists.join("ipset-all.txt").to_string_lossy());
        let game = format!("--ipset={}", lists.join("ipset-game.txt").to_string_lossy());
        let args = vec![
            "--filter-udp=1024-65535".to_string(),
            all,
            "--ipset-exclude=EXCL".to_string(),
        ];

        let out = ungate_game_ipset(args, lists, "1024-65535", "1024-65535");

        assert_eq!(
            out,
            vec![
                "--filter-udp=1024-65535".to_string(),
                game,
                "--ipset-exclude=EXCL".to_string(),
            ]
        );
    }

    // Обновление канала стратегий пересоздаёт каталог списков: всё, что нажито
    // локально, переносится явным перечислением. Автосписок — тоже нажитое.
    #[test]
    fn auto_hostlist_survives_a_channel_update() {
        assert!(LOCAL_LIST_FILES.contains(&AUTO_HOSTLIST_FILE));
        assert!(!CHANNEL_LIST_FILES.contains(&AUTO_HOSTLIST_FILE));
    }

    // Режим «Только заблокированные» снимает с секции IP-гейт и вешает автосписок
    // вместе с порогами детекта.
    #[test]
    fn auto_mode_swaps_ipset_for_autohostlist() {
        let lists = Path::new("L");
        let all = format!("--ipset={}", lists.join("ipset-all.txt").to_string_lossy());
        let args = vec![
            "--filter-tcp=80,443,8443".to_string(),
            all,
            "--dpi-desync=fake".to_string(),
        ];

        let out = gate_by_autohostlist(args, lists);

        assert_eq!(
            out,
            vec![
                "--filter-tcp=80,443,8443".to_string(),
                format!(
                    "--hostlist-auto={}",
                    lists.join(AUTO_HOSTLIST_FILE).to_string_lossy()
                ),
                "--hostlist-auto-fail-threshold=3".to_string(),
                "--hostlist-auto-retrans-threshold=3".to_string(),
                "--dpi-desync=fake".to_string(),
            ]
        );
    }

    // У игровых секций хоста нет по определению: автосписку там нечего решать,
    // а профиль с ним выигрывал бы всегда. IP-гейт остаётся как был.
    #[test]
    fn auto_mode_keeps_any_protocol_sections_on_ipset() {
        let lists = Path::new("L");
        let all = format!("--ipset={}", lists.join("ipset-all.txt").to_string_lossy());
        let args = vec![
            "--filter-tcp=80,443".to_string(),
            all.clone(),
            "--new".to_string(),
            "--filter-tcp=1024-65535".to_string(),
            all.clone(),
            "--dpi-desync-any-protocol=1".to_string(),
        ];

        let out = gate_by_autohostlist(args, lists);

        assert_eq!(out[out.len() - 2], all);
        assert!(!out[..out.len() - 2].contains(&all));
        assert!(out.iter().any(|a| a.starts_with("--hostlist-auto=")));
    }

    // Автосписок — обычная коллекция хостлистов, поэтому активная нода VPN
    // обязана попасть в исключения этой секции: без этого обход зацепил бы
    // собственный VLESS, стоило домену ноды один раз показаться заблокированным.
    #[test]
    fn auto_mode_section_still_gets_vpn_exclusion() {
        let lists = Path::new("L");
        let all = format!("--ipset={}", lists.join("ipset-all.txt").to_string_lossy());
        let args = vec!["--filter-tcp=80,443".to_string(), all];

        let out = spread_exclusion_across_sections(
            gate_by_autohostlist(args, lists),
            &active_vpn_exclusion_args(lists),
        );

        assert!(out.iter().any(|a| a.starts_with("--hostlist-auto=")));
        assert!(out
            .iter()
            .any(|a| a.contains("--hostlist-exclude=") && a.contains("active-vpn-domain.txt")));
    }

    // Файл ведёт winws, дописывая в конец: пользователю показываем свежие сверху,
    // без дублей и комментариев.
    #[test]
    fn auto_domains_are_newest_first_without_dupes() {
        let txt = "# comment\nold.example\nDota2.ru\n\ndota2.ru\nfresh.example\n";
        assert_eq!(
            auto_domains_from(txt),
            vec![
                "fresh.example".to_string(),
                "dota2.ru".to_string(),
                "old.example".to_string(),
            ]
        );
    }

    // Пара --hostlist-auto-* не создаёт коллекцию хостлистов и не должна
    // считаться признаком секции с известным хостом.
    #[test]
    fn hostlist_arg_detection_ignores_auto_tuning_flags() {
        assert!(is_hostlist_arg("--hostlist=x"));
        assert!(is_hostlist_arg("--hostlist-exclude=x"));
        assert!(is_hostlist_arg("--hostlist-domains=a,b"));
        assert!(is_hostlist_arg("--hostlist-exclude-domains=a,b"));
        assert!(is_hostlist_arg("--hostlist-auto=x"));
        assert!(!is_hostlist_arg("--hostlist-auto-fail-threshold=3"));
        assert!(!is_hostlist_arg("--hostlist-auto-retrans-threshold=3"));
        assert!(!is_hostlist_arg("--filter-l7=discord,stun"));
    }

    // Стратегия без --new — одна секция, исключение ровно один раз.
    #[test]
    fn active_vpn_exclusion_single_section_is_not_duplicated() {
        let exclusion = [
            "--hostlist-exclude=D".to_string(),
            "--ipset-exclude=I".to_string(),
        ];
        let out = spread_exclusion_across_sections(
            vec!["--filter-tcp=443".to_string(), "--hostlist=G".to_string()],
            &exclusion,
        );
        assert_eq!(
            out,
            vec![
                "--filter-tcp=443",
                "--hostlist=G",
                "--hostlist-exclude=D",
                "--ipset-exclude=I"
            ]
        );
    }

    #[test]
    fn referenced_bins_collects_only_bin_placeholders() {
        let strat = vec![
            Strategy {
                id: "a".into(),
                name: String::new(),
                desc: String::new(),
                experimental: false,
                args: vec![
                    "--fake-tls=%BIN%tls_clienthello_www_google_com.bin".into(),
                    "--dpi-desync-fake-quic=%BIN%quic_initial_www_google_com.bin".into(),
                    "--filter-tcp=443".into(),
                ],
            },
            Strategy {
                id: "b".into(),
                name: String::new(),
                desc: String::new(),
                experimental: false,
                // %LISTS% и голый %BIN% без .bin не должны попасть в набор.
                args: vec!["%LISTS%list-general.txt".into(), "%BIN%".into()],
            },
        ];
        let need = referenced_bins(&strat);
        assert_eq!(need.len(), 2);
        assert!(need.contains("tls_clienthello_www_google_com.bin"));
        assert!(need.contains("quic_initial_www_google_com.bin"));
    }

    #[test]
    fn fake_filename_validation_rejects_paths_and_active_slots() {
        assert!(valid_fake_filename("quic_initial_example_com.bin"));
        assert!(valid_fake_filename("stun2.bin"));
        for invalid in [
            "",
            "ACTIVE_DISCORD_UDP.bin",
            "active_game_udp.bin",
            "../fake.bin",
            r"..\fake.bin",
            r"C:\fake.bin",
            "/tmp/fake.bin",
            "fake.txt",
            "fake payload.bin",
        ] {
            assert!(!valid_fake_filename(invalid), "{invalid}");
        }
        assert_eq!(fake_target("discord").unwrap(), ACTIVE_DISCORD_FAKE);
        assert_eq!(fake_target("game").unwrap(), ACTIVE_GAME_FAKE);
        assert!(fake_target("other").is_err());
    }

    #[test]
    fn embedded_channel_public_keys_decode_after_exactly_one_base64_layer() {
        assert!(decode_channel_public_key(CHANNEL_DEDICATED_PUBKEY_B64).is_ok());
        assert!(decode_channel_public_key(CHANNEL_LEGACY_PUBKEY_B64).is_ok());
    }

    fn create_test_channel_generation(dpi_data: &Path, name: &str, version: &str) -> PathBuf {
        let generation = dpi_data.join(CHANNEL_GENERATIONS_DIR).join(name);
        std::fs::create_dir_all(generation.join("lists")).unwrap();
        std::fs::create_dir_all(generation.join("bin-data")).unwrap();
        std::fs::create_dir_all(generation.join("service")).unwrap();
        std::fs::write(generation.join("strategies.json"), b"[]\n").unwrap();
        std::fs::write(generation.join("version.txt"), format!("{version}\n")).unwrap();
        for file in CHANNEL_LIST_FILES {
            std::fs::write(generation.join("lists").join(file), b"data\n").unwrap();
        }
        for file in CHANNEL_SERVICE_FILES {
            std::fs::write(generation.join("service").join(file), b"data\n").unwrap();
        }
        generation
    }

    #[test]
    fn channel_generation_is_visible_only_after_pointer_commit() {
        let root = std::env::temp_dir().join(format!(
            "ninety-dpi-generation-test-{}-{}",
            std::process::id(),
            TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let old = create_test_channel_generation(&root, "gen-100-1-0", "old");
        write_replace(
            &root.join(CHANNEL_POINTER_FILE),
            "gen-100-1-0\n",
            "test channel pointer",
        )
        .unwrap();
        assert_eq!(active_channel_generation_from_dpi(&root), Some(old.clone()));

        // Полностью собранное новое поколение ещё не активно без commit pointer.
        let new = create_test_channel_generation(&root, "gen-200-1-0", "new");
        assert_eq!(active_channel_generation_from_dpi(&root), Some(old.clone()));

        write_replace(
            &root.join(CHANNEL_POINTER_FILE),
            "gen-200-1-0\n",
            "test channel pointer",
        )
        .unwrap();
        assert_eq!(active_channel_generation_from_dpi(&root), Some(new.clone()));

        // Повреждённое committed-поколение не роняет раздел: откат на
        // предыдущее целое поколение и признак испорченного pointer.
        std::fs::remove_file(new.join("strategies.json")).unwrap();
        let resolution = resolve_channel_generation(&root);
        assert_eq!(resolution.active, Some(old));
        assert!(resolution.pointer_broken);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn channel_pointer_rejects_path_traversal() {
        for invalid in ["", "../gen-1", "gen-1/other", r"gen-1\other", ".gen-1"] {
            assert!(!valid_channel_generation_name(invalid), "{invalid}");
        }
        assert!(valid_channel_generation_name("gen-123-456-0"));
    }

    #[test]
    fn hosts_keeps_the_original_line_endings() {
        let crlf = "# base\r\n127.0.0.1 localhost\r\n";
        let rendered = "# base\n127.0.0.1 localhost\n";
        assert_eq!(apply_hosts_line_endings(rendered, crlf), crlf);
        assert_eq!(apply_hosts_line_endings(rendered, "# base\n"), rendered);
    }

    // hosts не обязан быть в UTF-8: комментарий в ANSI (0xCF 0xF0 — «Пр» в
    // cp1251) и UTF-8 «Р» в самом конце (D0 A0) обязаны пережить снятие нашего
    // блока байт в байт.
    #[test]
    fn hosts_in_any_encoding_survives_our_block_byte_for_byte() {
        let mut original = b"# \xCF\xF0\xEE\xEA\xF1\xE8\r\n127.0.0.1 localhost\r\n".to_vec();
        let foreign_len = original.len();
        original.extend_from_slice(
            format!("{HOSTS_BEGIN}\r\n1.2.3.4 a.example\r\n{HOSTS_END}\r\n").as_bytes(),
        );
        original.extend_from_slice("# Р".as_bytes());

        let text = decode_hosts_bytes(&original);
        assert!(has_managed_block(&text));
        let stripped = strip_managed_block(&text).unwrap();
        let rendered = format!("{}\n", trim_hosts_end(&stripped));
        let bytes = encode_hosts_text(&apply_hosts_line_endings(&rendered, &text)).unwrap();

        let mut expected = original[..foreign_len].to_vec();
        expected.extend_from_slice("# Р\r\n".as_bytes());
        assert_eq!(bytes, expected);
        assert!(encode_hosts_text("ok\u{100}").is_err());
    }

    #[test]
    fn strip_managed_block_removes_only_our_block() {
        let content = format!(
            "127.0.0.1 localhost\n{HOSTS_BEGIN}\n1.2.3.4 discord.com\n{HOSTS_END}\n10.0.0.1 nas\n"
        );
        let out = strip_managed_block(&content).unwrap();
        assert!(out.contains("127.0.0.1 localhost"));
        assert!(out.contains("10.0.0.1 nas"));
        assert!(!out.contains("discord.com"));
        assert!(!out.contains(HOSTS_BEGIN));
        // Идемпотентность: без блока текст меняется только нормализацией переносов.
        let again = strip_managed_block(&out).unwrap();
        assert_eq!(out, again);
    }

    #[test]
    fn strip_managed_block_rejects_unbalanced_or_duplicate_markers() {
        let open = format!("127.0.0.1 localhost\n{HOSTS_BEGIN}\n1.2.3.4 example.test\n");
        assert!(strip_managed_block(&open)
            .unwrap_err()
            .contains("without END"));

        let close = format!("127.0.0.1 localhost\n{HOSTS_END}\n");
        assert!(strip_managed_block(&close)
            .unwrap_err()
            .contains("without BEGIN"));

        let nested = format!("{HOSTS_BEGIN}\n{HOSTS_BEGIN}\n{HOSTS_END}\n{HOSTS_END}\n");
        assert!(strip_managed_block(&nested).unwrap_err().contains("nested"));

        let duplicate = format!(
            "{HOSTS_BEGIN}\n1.1.1.1 one.test\n{HOSTS_END}\n{HOSTS_BEGIN}\n2.2.2.2 two.test\n{HOSTS_END}\n"
        );
        assert!(strip_managed_block(&duplicate)
            .unwrap_err()
            .contains("several"));
    }

    #[test]
    fn count_hosts_entries_ignores_comments_and_singletons() {
        let body = "# comment\n1.2.3.4 discord.com\n\n5.6.7.8 telegram.org\nonlyonetoken\n";
        assert_eq!(count_hosts_entries(body), 2);
    }

    #[test]
    fn count_ipset_lines_ignores_comments_and_blanks() {
        let txt = "# base\n1.1.1.0/24\n\n8.8.8.0/24\n  # spaced comment\n9.9.9.9/32\n";
        assert_eq!(count_ipset_lines(txt), 3);
    }

    // Синхронизация канала перезаписывает базу ipset его service-файлом. Пустой
    // или чисто комментарийный файл базу трогать не должен: с пустым ipset режим
    // «Сайтам из списка IP» превратился бы во «Всем сайтам» — ровно то, от чего
    // пользователь этим режимом и уходит.
    #[test]
    fn empty_ipset_service_leaves_the_base_alone() {
        assert_eq!(
            ipset_base_from_service("1.2.3.0/24\r\n8.8.8.8/32\r\n").as_deref(),
            Some("1.2.3.0/24\n8.8.8.8/32\n")
        );
        assert!(ipset_base_from_service("").is_none());
        assert!(ipset_base_from_service("# only comments\n\n   \n").is_none());
    }

    #[test]
    fn normalize_ipset_entry_wraps_ipv4_and_ipv6() {
        assert_eq!(normalize_ipset_entry("1.2.3.4").unwrap(), "1.2.3.4/32");
        assert_eq!(
            normalize_ipset_entry("2606:4700:d0::a29f:c001").unwrap(),
            "2606:4700:d0::a29f:c001/128"
        );
        assert_eq!(normalize_ipset_entry("10.0.0.0/8").unwrap(), "10.0.0.0/8");
        assert_eq!(
            normalize_ipset_entry("2001:db8::/32").unwrap(),
            "2001:db8::/32"
        );
        assert_eq!(normalize_ipset_entry("0.0.0.0/0").unwrap(), "0.0.0.0/0");
        assert_eq!(normalize_ipset_entry("::/0").unwrap(), "::/0");
        assert!(normalize_ipset_entry("1.2.3.4/999").is_err());
        assert!(normalize_ipset_entry("2001:db8::/129").is_err());
        assert!(normalize_ipset_entry("evil/thing").is_err());
        assert!(normalize_ipset_entry("1.2.3.4/24/extra").is_err());
        assert!(normalize_ipset_entry("example.com").is_err());
        assert!(normalize_ipset_entry("bad domain").is_err());
    }

    #[test]
    fn channel_content_length_limit_rejects_oversize_declared_body() {
        assert!(ensure_content_length_limit(Some(1024), 1024, "test body").is_ok());
        assert!(ensure_content_length_limit(None, 1024, "test body").is_ok());
        let err = ensure_content_length_limit(Some(1025), 1024, "test body").unwrap_err();
        assert!(err.contains("test body too large"));
    }

    #[test]
    fn parse_engine_version_extracts_token() {
        assert_eq!(
            parse_engine_version("github version 72.12 (abc)"),
            Some("72.12".into())
        );
        assert_eq!(
            parse_engine_version("winws VERSION v70"),
            Some("v70".into())
        );
        assert_eq!(parse_engine_version("no digits here"), None);
        assert_eq!(parse_engine_version(""), None);
    }

    // Домен уходит в hostlist winws построчно: значение с переводом строки
    // вставляло бы произвольные записи, а дедуп по целой строке их не ловил.
    #[test]
    fn exclude_domain_rejects_multiline_and_control_input() {
        assert_eq!(
            normalize_exclude_domain("  Example.COM "),
            Ok("example.com".to_string())
        );
        assert_eq!(
            normalize_exclude_domain("*.example.com"),
            Ok("*.example.com".to_string())
        );
        // Обрамляющий whitespace — мусор ввода, а не инъекция: trim снимает его, и
        // в файл уходит уже чистая запись. Отвергаем только то, что осталось внутри.
        assert_eq!(
            normalize_exclude_domain("example.com\t"),
            Ok("example.com".to_string())
        );
        for bad in [
            "example.com\nevil.com",
            "example.com\r\nevil.com",
            "exa mple.com",
            "exa\tmple.com",
            "example\u{0}.com",
            "",
            "   ",
            "прим.рф",
        ] {
            assert!(
                normalize_exclude_domain(bad).is_err(),
                "{bad:?} обязан отвергаться"
            );
        }
        assert!(normalize_exclude_domain(&"a".repeat(254)).is_err());
    }

    // Соседний каталог с тем же префиксом строки — не наш движок: голое
    // starts_with уводило taskkill в чужой процесс.
    #[cfg(target_os = "windows")]
    #[test]
    fn stray_winws_lookup_respects_the_directory_boundary() {
        let root = r"c:\app\dpi";
        let inside = r"c:\app\dpi\bin\winws.exe";
        let sibling = r"c:\app\dpi-backup\winws.exe";
        assert!(path_is_inside(inside, root));
        assert!(!path_is_inside(sibling, root));
        // Сам корень процессом не является; пустой корень не совпадает ни с чем.
        assert!(!path_is_inside(root, root));
        assert!(!path_is_inside(inside, ""));
        // Хвостовой разделитель у корня границу не ломает.
        assert!(path_is_inside(inside, "c:\\app\\dpi\\"));
    }

    // «Блок применён» обязан считаться по отдельной строке-маркеру, как это
    // делают strip_managed_block и разбор блока в dpi_hosts_status. Подстрока
    // давала applied=true при пустом блоке и не тот выбор тела для бэкапа.
    #[test]
    fn managed_block_is_detected_by_a_whole_marker_line() {
        let applied = format!("127.0.0.1 localhost\n{HOSTS_BEGIN}\nx\n{HOSTS_END}\n");
        assert!(has_managed_block(&applied));
        assert!(has_managed_block(&format!("   {HOSTS_BEGIN}   \n")));
        // Маркер внутри строки — не наш блок.
        assert!(!has_managed_block(&format!("{HOSTS_BEGIN} и хвост\n")));
        assert!(!has_managed_block(&format!("# было: {HOSTS_BEGIN}\n")));
        assert!(!has_managed_block("127.0.0.1 localhost\n"));
    }

    #[test]
    fn user_list_name_maps_kind() {
        assert_eq!(user_list_name("exclude"), "list-exclude-user.txt");
        assert_eq!(user_list_name("user"), "list-general-user.txt");
        assert_eq!(user_list_name("anything-else"), "list-general-user.txt");
    }

    #[test]
    fn dpi_operation_generation_cancels_stale_work() {
        let state = DpiState::default();
        let first = begin_dpi_operation(&state, "start").unwrap();
        let first_guard = DpiOperationGuard {
            state: &state,
            generation: first,
        };
        assert!(dpi_operation_current(&state, first));
        assert!(begin_dpi_operation(&state, "autotest").is_err());

        assert_eq!(cancel_dpi_operation(&state), Some("start"));
        assert!(!dpi_operation_current(&state, first));
        assert!(begin_dpi_operation(&state, "autotest").is_err());
        drop(first_guard);

        let second = begin_dpi_operation(&state, "autotest").unwrap();
        assert_ne!(first, second);
        assert!(dpi_operation_current(&state, second));
    }

    // Ждать завершения имеет смысл только для операций, способных поднять winws.
    #[test]
    fn only_spawning_operations_hold_up_stop() {
        assert!(operation_can_spawn(Some("start")));
        assert!(operation_can_spawn(Some("autotest")));
        assert!(!operation_can_spawn(Some("sync_channel")));
        assert!(!operation_can_spawn(None));
    }

    #[test]
    fn cancel_reports_which_operation_it_took() {
        let state = DpiState::default();
        let generation = begin_dpi_operation(&state, "sync_channel").unwrap();
        let guard = DpiOperationGuard {
            state: &state,
            generation,
        };
        assert_eq!(cancel_dpi_operation(&state), Some("sync_channel"));
        // Повторная отмена уже нечего забирать — stop не должен ждать пустоту.
        assert_eq!(cancel_dpi_operation(&state), None);
        drop(guard);
    }

    fn test_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ninety-dpi-{tag}-{}-{}",
            std::process::id(),
            TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    // ── п.2: сторож выхода winws ──

    fn short_lived_child(code: i32) -> Child {
        #[cfg(windows)]
        let child = std::process::Command::new("cmd")
            .args(["/C", &format!("exit {code}")])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = std::process::Command::new("sh")
            .args(["-c", &format!("exit {code}")])
            .spawn()
            .unwrap();
        child
    }

    fn wait_for_reap(state: &DpiState, expected: Option<u64>) -> Option<DpiExitedEvent> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(event) = reap_unexpected_exit(state, expected) {
                return Some(event);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }

    // Падение штатного сеанса сообщается ровно один раз и с кодом выхода.
    #[test]
    fn crash_of_the_running_session_is_reported_once() {
        let state = DpiState::default();
        *state.child.lock_recover() = Some(short_lived_child(3));
        state.runtime_session.store(7, Ordering::SeqCst);

        // Сторож чужого (старого) сеанса новый не трогает.
        assert!(reap_unexpected_exit(&state, Some(6)).is_none());

        let event = wait_for_reap(&state, Some(7)).expect("падение не замечено");
        assert_eq!(event.generation, 7);
        assert_eq!(event.code, Some(3));
        assert!(event.message.contains("backend.dpi.exitedUnexpectedly"));
        assert!(state.child.lock_recover().is_none());
        assert_eq!(state.runtime_session.load(Ordering::SeqCst), 0);
        assert!(reap_unexpected_exit(&state, None).is_none());
    }

    // Плановая остановка обнуляет сеанс под тем же локом: ложного события нет.
    #[test]
    fn planned_stop_is_not_reported_as_a_crash() {
        let state = DpiState::default();
        *state.child.lock_recover() = Some(short_lived_child(0));
        state.runtime_session.store(9, Ordering::SeqCst);

        stop_managed_child(&state, "test winws").unwrap();

        assert_eq!(state.runtime_session.load(Ordering::SeqCst), 0);
        assert!(reap_unexpected_exit(&state, Some(9)).is_none());
        assert!(reap_unexpected_exit(&state, None).is_none());
    }

    // Процессы автоподбора (сеанс 0) живут и умирают по плану.
    #[test]
    fn autotest_children_never_raise_the_event() {
        let state = DpiState::default();
        *state.child.lock_recover() = Some(short_lived_child(1));
        std::thread::sleep(Duration::from_millis(300));
        assert!(reap_unexpected_exit(&state, None).is_none());
        let _ = stop_managed_child(&state, "test winws");
    }

    // ── п.3: собственные добавки и встроенные базовые списки ──

    #[test]
    fn ninety_additions_are_layered_without_duplicates() {
        // Список Flowseal без добавки (как его везёт канал).
        let flowseal = "discord.com\nlive-video.net";
        assert_eq!(
            with_list_additions(flowseal, &NINETY_GENERAL_ADDITIONS).as_deref(),
            Some("discord.com\nlive-video.net\nvivox.com\n")
        );
        // Уже есть (в любом регистре) — файл не переписывается.
        assert!(with_list_additions("# c\nVIVOX.com\n", &NINETY_GENERAL_ADDITIONS).is_none());
        // Закомментированная запись добавкой не считается.
        assert_eq!(
            with_list_additions("# vivox.com\n", &NINETY_GENERAL_ADDITIONS).as_deref(),
            Some("# vivox.com\nvivox.com\n")
        );
        // ipset: досыпаются только недостающие подсети.
        assert_eq!(
            with_list_additions("1.1.1.0/24\n85.236.96.0/21\n", &NINETY_IPSET_ADDITIONS).as_deref(),
            Some("1.1.1.0/24\n85.236.96.0/21\n85.236.104.0/23\n")
        );
        assert_eq!(
            with_list_additions("", &NINETY_IPSET_ADDITIONS).as_deref(),
            Some("85.236.96.0/21\n85.236.104.0/23\n")
        );
    }

    // Добавки не должны лежать только во встроенных файлах: канал их не везёт.
    #[test]
    fn bundled_lists_already_carry_the_additions() {
        let general = include_str!("../dpi/lists/list-general.txt");
        assert!(with_list_additions(general, &NINETY_GENERAL_ADDITIONS).is_none());
    }

    #[test]
    fn bundled_base_lists_follow_the_app_version_but_not_user_lists() {
        let root = test_root("base-lists");
        let src = root.join("res");
        let dst = root.join("data");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("list-general.txt"), "fresh.example\n").unwrap();
        // Старая установка: базовый список с первой установки, маркера нет.
        std::fs::write(dst.join("list-general.txt"), "stale.example\n").unwrap();
        std::fs::write(dst.join("list-general-user.txt"), "mine.example\n").unwrap();

        refresh_bundled_base_lists(&dst, &src, "0.18.0+1.10.2").unwrap();
        let read = |name: &str| std::fs::read_to_string(dst.join(name)).unwrap();
        assert_eq!(read("list-general.txt"), "fresh.example\n");
        assert_eq!(read("list-general-user.txt"), "mine.example\n");
        // Файла нет в ресурсе — создаётся пустым, а не падает.
        assert_eq!(read("list-google.txt"), "");

        // Та же версия — файлы не переписываются на каждом вызове.
        std::fs::write(src.join("list-general.txt"), "newer.example\n").unwrap();
        refresh_bundled_base_lists(&dst, &src, "0.18.0+1.10.2").unwrap();
        assert_eq!(read("list-general.txt"), "fresh.example\n");

        // Новая версия приложения — базовые списки снова из ресурсов.
        refresh_bundled_base_lists(&dst, &src, "0.18.1+1.10.2").unwrap();
        assert_eq!(read("list-general.txt"), "newer.example\n");
        assert_eq!(read("list-general-user.txt"), "mine.example\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── п.4: версии канала ──

    #[test]
    fn channel_versions_compare_as_numbers() {
        use std::cmp::Ordering as CmpOrdering;
        let cmp = compare_channel_versions;
        assert_eq!(cmp("1.10.2", "1.9.9"), Some(CmpOrdering::Greater));
        assert_eq!(cmp("1.10", "1.10.0"), Some(CmpOrdering::Equal));
        assert_eq!(cmp("v1.10.2", "1.10.2"), Some(CmpOrdering::Equal));
        assert_eq!(cmp("1.6.3b", "1.6.3"), Some(CmpOrdering::Greater));
        assert_eq!(cmp("1.6.3a", "1.6.3b"), Some(CmpOrdering::Less));
        assert_eq!(cmp("1.0.0-rc1", "1.0.0"), Some(CmpOrdering::Less));
        assert_eq!(cmp("1.0.0-rc.2", "1.0.0-rc.10"), Some(CmpOrdering::Less));
        assert_eq!(cmp("1.0.0+build7", "1.0.0"), Some(CmpOrdering::Equal));
        assert_eq!(cmp("—", "1.0.0"), None);
        assert_eq!(cmp("1..2", "1.2"), None);
        assert_eq!(cmp("latest", "1.2"), None);
    }

    // Старый подписанный бандл подпись проходит, но откатить набор не может.
    #[test]
    fn older_signed_bundle_is_rejected() {
        assert!(!channel_bundle_acceptable("1.10.1", "1.10.2"));
        assert!(!channel_bundle_acceptable("1.9.9", "1.10.0"));
        assert!(channel_bundle_acceptable("1.10.2", "1.10.2"));
        assert!(channel_bundle_acceptable("1.10.3", "1.10.2"));
        // Неразбираемая версия не может «обогнать» известную.
        assert!(!channel_bundle_acceptable("latest", "1.10.2"));
        // Активная версия неизвестна — принимаем.
        assert!(channel_bundle_acceptable("1.10.2", "—"));
    }

    #[test]
    fn update_is_offered_only_for_a_strictly_newer_channel() {
        assert!(channel_update_available("1.10.3", "1.10.2", false));
        assert!(!channel_update_available("1.10.2", "1.10.2", false));
        assert!(!channel_update_available("1.10.1", "1.10.2", false));
        // Поколение без доказуемых стратегий — пересинхронизация той же версии.
        assert!(channel_update_available("1.10.2", "1.10.2", true));
        assert!(!channel_update_available("1.10.1", "1.10.2", true));
        assert!(!channel_update_available("", "1.10.2", true));
        assert!(channel_update_available("1.10.2", "—", false));
    }

    // ── п.5: испорченное активное поколение ──

    #[test]
    fn broken_pointer_falls_back_and_never_fails() {
        let root = test_root("broken-pointer");
        // Без pointer — встроенные ресурсы, синхронизировать нечего.
        let none = resolve_channel_generation(&root);
        assert!(none.active.is_none() && !none.pointer_broken);

        let older = create_test_channel_generation(&root, "gen-100-1-0", "1.10.1");
        let newer = create_test_channel_generation(&root, "gen-200-1-0", "1.10.2");
        let pointer = root.join(CHANNEL_POINTER_FILE);

        // Мусор в pointer — самое свежее целое поколение.
        std::fs::write(&pointer, "../evil\n").unwrap();
        let garbage = resolve_channel_generation(&root);
        assert_eq!(garbage.active, Some(newer.clone()));
        assert!(garbage.pointer_broken);

        // Испорченное активное — предыдущее целое.
        std::fs::write(&pointer, "gen-200-1-0\n").unwrap();
        std::fs::remove_file(newer.join("service").join("hosts")).unwrap();
        let broken = resolve_channel_generation(&root);
        assert_eq!(broken.active, Some(older.clone()));
        assert!(broken.pointer_broken);

        // Целых не осталось — встроенный набор, а не ошибка.
        std::fs::remove_dir_all(older.join("bin-data")).unwrap();
        let nothing = resolve_channel_generation(&root);
        assert!(nothing.active.is_none());
        assert!(nothing.pointer_broken);
        let _ = std::fs::remove_dir_all(&root);
    }

    // Стратегии (а значит dpi_start и сам sync) переживают испорченное поколение.
    #[test]
    fn strategies_survive_a_broken_generation() {
        let root = test_root("broken-strategies");
        std::fs::write(root.join(CHANNEL_POINTER_FILE), "gen-300-1-0\n").unwrap();
        let active = load_strategies_from(&root).unwrap();
        assert!(active.channel.is_none());
        assert!(active.needs_resync);
        assert_eq!(active.version, bundled_strategies_version());
        assert!(!active.strategies.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── п.6: стратегии только из подписанного набора + allowlist ──

    // Поколение без bundle.zip/подписи не доказывает свои стратегии: даже
    // подложенный рядом strategies.json не читается, работает встроенный набор.
    #[test]
    fn generation_without_signed_bundle_uses_the_bundled_strategies() {
        let root = test_root("unsigned-generation");
        let generation = create_test_channel_generation(&root, "gen-400-1-0", "9.9.9");
        std::fs::write(
            generation.join("strategies.json"),
            r#"[{"id":"evil","name":"evil","args":["--debug=@C:\\x"]}]"#,
        )
        .unwrap();
        std::fs::write(root.join(CHANNEL_POINTER_FILE), "gen-400-1-0\n").unwrap();

        let active = load_strategies_from(&root).unwrap();
        assert!(active.channel.is_none());
        assert!(active.needs_resync);
        assert_eq!(active.version, bundled_strategies_version());
        assert!(active.strategies.iter().all(|s| s.id != "evil"));
        // Списки и bin-data поколения при этом остаются в работе.
        assert_eq!(active_channel_generation_from_dpi(&root), Some(generation));
        let _ = std::fs::remove_dir_all(&root);
    }

    // Все стратегии встроенного набора проходят allowlist — иначе он сломал
    // бы рабочие профили.
    #[test]
    fn every_bundled_strategy_passes_the_allowlist() {
        let raw: Vec<Strategy> =
            serde_json::from_str(include_str!("../dpi/strategies.json")).unwrap();
        assert!(!raw.is_empty());
        let mut checked = 0usize;
        for strategy in &raw {
            for arg in &strategy.args {
                assert!(
                    validate_strategy_arg(arg).is_ok(),
                    "{}: аргумент отвергнут: {arg}",
                    strategy.id
                );
                checked += 1;
            }
        }
        assert!(checked > raw.len());
        assert_eq!(
            parse_checked_strategies(BUNDLED_STRATEGIES_JSON)
                .unwrap()
                .len(),
            raw.len()
        );
    }

    #[test]
    fn allowlist_keeps_the_strategy_grammar() {
        for arg in [
            "--new",
            "--filter-tcp=%GameFilterTCP%",
            "--filter-udp=19294-19344,50000-50100",
            "--wf-udp=443,19294-19344,50000-50100,%GameFilterUDP%",
            "--dpi-desync-fake-tls=!",
            "--dpi-desync-fake-tls=0x00000000",
            "--dpi-desync-fake-tls=%BIN%tls_clienthello_www_google_com.bin",
            "--dpi-desync-fake-quic=%BIN%quic_initial_4pda.to.bin",
            "--dpi-desync-hostfakesplit-mod=host=www.google.com,altorder=1",
            "--dpi-desync-hostfakesplit-mod=host=www.google.com",
            "--dpi-desync-fake-tls-mod=rnd,dupsid,sni=www.google.com",
            "--dpi-desync-split-pos=2,sniext+1",
            "--dpi-desync-split-pos=1,midsld",
            "--dpi-desync-cutoff=n2",
            "--hostlist=%LISTS%list-general.txt",
            "--ipset-exclude=%LISTS%ipset-exclude-user.txt",
            "--hostlist-domains=discord.media,dis.gd",
        ] {
            assert!(validate_strategy_arg(arg).is_ok(), "{arg}");
        }
    }

    #[test]
    fn allowlist_rejects_forged_arguments() {
        for arg in [
            r"--debug=@C:\x",
            "--debug",
            r"--pidfile=C:\x",
            r"--hostlist=..\..\x",
            r"--hostlist=C:\x",
            r"--hostlist=%LISTS%..\x",
            "--hostlist=@%LISTS%list-general.txt",
            "--hostlist=%LISTS%list-auto.txt",
            "--hostlist-auto=%LISTS%list-auto.txt",
            r"--hostlist-auto-debug=C:\x",
            "--hostlist-auto-fail-threshold=3",
            r"--dpi-desync-fake-quic=%BIN%..\x.bin",
            "--dpi-desync-fake-quic=%BIN%..bin",
            "--dpi-desync-fake-quic=@%BIN%x.bin",
            r"--dpi-desync-fake-tls=C:\x.bin",
            "--dpi-desync-fake-tls=%BIN%x.txt",
            "--ipset=%LISTS%ipset-all.txt\n--debug",
            "--new=1",
            "--filter-tcp=0",
            "--filter-tcp=80-70",
            "--wf-tcp=%GameFilterUDP%",
            "--dpi-desync-cutoff=n0",
            "--dpi-desync-repeats=0",
            "--dpi-desync-fake-tls-mod=rnd,dupsid,sni=../x",
            "--dpi-desync-hostfakesplit-mod=host=x.com,altorder=1,altorder=1",
            "--hostlist-domains=a.com,../b",
            "",
        ] {
            assert!(validate_strategy_arg(arg).is_err(), "{arg:?}");
        }
        assert!(
            validate_strategy_arg(&format!("--dpi-desync-fake-tls=0x{}", "0".repeat(5000)))
                .is_err()
        );
    }

    // Стратегия с запрещённым аргументом выпадает целиком, остальные живут.
    #[test]
    fn tampered_strategy_is_dropped_whole() {
        let raw = r#"[
            {"id":"good","name":"G","args":["--filter-tcp=443","--dpi-desync=fake"]},
            {"id":"bad","name":"B","args":["--filter-tcp=443","--debug=@C:\\x"]}
        ]"#;
        let checked = parse_checked_strategies(raw).unwrap();
        assert_eq!(checked.len(), 1);
        assert_eq!(checked[0].id, "good");
        assert!(parse_checked_strategies(r#"[{"id":"bad","args":["--pidfile=C:\\x"]}]"#).is_err());
        assert!(parse_checked_strategies(r#"[{"id":"empty","args":[]}]"#).is_err());
    }

    // ── п.7: пакет исключений VPN-нод ──

    #[test]
    fn endpoint_hosts_drop_ports_and_keep_ipv6() {
        assert_eq!(endpoint_host("[2001:db8::1]:443"), Some("2001:db8::1"));
        assert_eq!(endpoint_host("[2001:db8::1]"), Some("2001:db8::1"));
        assert_eq!(endpoint_host("2001:db8::1"), Some("2001:db8::1"));
        assert_eq!(endpoint_host(" 162.159.192.1:2408 "), Some("162.159.192.1"));
        assert_eq!(
            endpoint_host("vpn.example.com:443"),
            Some("vpn.example.com")
        );
        assert_eq!(endpoint_host("vpn.example.com"), Some("vpn.example.com"));
        assert_eq!(endpoint_host("host:abc"), None);
        assert_eq!(endpoint_host("host:123456"), None);
        assert_eq!(endpoint_host("[::1]x"), None);
        assert_eq!(endpoint_host("[]:443"), None);
        assert_eq!(endpoint_host("   "), None);
    }

    #[test]
    fn endpoint_batch_dedups_and_formats_entries() {
        let ips: Vec<String> = [
            "1.2.3.4",
            "1.2.3.4:443",
            "[2001:0db8::1]:443",
            "2001:db8::1",
            "bad host",
        ]
        .map(String::from)
        .to_vec();
        let domains: Vec<String> = [
            "VPN.example.com",
            "vpn.example.com:8443",
            "vpn.example.com.",
            "5.6.7.8:2408",
            "*.example.org",
            "exa mple.com",
        ]
        .map(String::from)
        .to_vec();
        let batch = endpoint_batch(&ips, &domains);
        assert_eq!(
            batch,
            EndpointBatch {
                ips: vec![
                    "1.2.3.4/32".to_string(),
                    "2001:db8::1/128".to_string(),
                    "5.6.7.8/32".to_string(),
                ],
                domains: vec!["vpn.example.com".to_string(), "*.example.org".to_string()],
            }
        );
        assert_eq!(
            render_list_lines(&batch.ips),
            "1.2.3.4/32\n2001:db8::1/128\n5.6.7.8/32\n"
        );
        assert_eq!(render_list_lines(&[]), "");
        assert_eq!(endpoint_batch(&[], &[]), EndpointBatch::default());
    }

    #[test]
    fn only_real_names_are_resolved() {
        assert!(resolvable_endpoint_domain("vpn.example.com"));
        assert!(!resolvable_endpoint_domain("*.example.com"));
        assert!(!resolvable_endpoint_domain("999.1.1.1"));
    }

    #[test]
    fn endpoint_batch_is_capped() {
        let ips: Vec<String> = (0..MAX_ENDPOINT_IPS + 50)
            .map(|i| format!("10.{}.{}.1", i / 256, i % 256))
            .collect();
        assert_eq!(endpoint_batch(&ips, &[]).ips.len(), MAX_ENDPOINT_IPS);
    }
}
