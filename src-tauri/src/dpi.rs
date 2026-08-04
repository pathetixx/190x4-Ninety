// Ninety · DPI-обход (winws engine). Запуск/останов движка winws (zapret),
// управление стратегиями и списками. winws грузит kernel-драйвер WinDivert →
// требует админ-прав: фронт перед стартом гарантирует элевацию (та же инфра,
// что у TUN: is_elevated/relaunch_elevated), winws стартует как наш child и
// наследует права. Бинари движка — read-only в resource_dir (install dir),
// списки — writable-копия в app_data (для exclude VPN-нод и режима ipset).
//
// Точки интеграции backend↔frontend: dpi_start/stop/running, dpi_strategies,
// dpi_domains_count, dpi_set_node_exclude (главный риск из спайка — нода VPN
// в exclude, иначе winws корёжит зашифрованный VLESS).

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
            Ok(None) => return Err(format!("{label} не завершился за 2 секунды")),
            Err(e) => return Err(format!("не удалось подтвердить остановку {label}: {e}")),
        }
        if let Some(e) = kill_error.as_ref() {
            // Ошибка kill допустима только если try_wait выше уже подтвердил,
            // что процесс успел завершиться самостоятельно.
            if Instant::now() >= deadline {
                return Err(format!("не удалось остановить {label}: {e}"));
            }
        }
    }
}

fn stop_managed_child(state: &DpiState, label: &str) -> Result<(), String> {
    let Some(mut child) = state.child.lock_recover().take() else {
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
    cancel_dpi_operation(state);
    stop_managed_child(state, label)?;
    let deadline = Instant::now() + CHILD_STOP_TIMEOUT;
    while state.operation_active.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return Err(format!(
                "{label}: отменяемая операция не завершилась за 2 секунды"
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
        return Err("предыдущая DPI-операция ещё завершается".into());
    }
    let mut control = state.control.lock_recover();
    if let Some(active) = control.operation {
        state.operation_active.store(false, Ordering::SeqCst);
        return Err(format!("DPI-операция уже выполняется: {active}"));
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
    label: &str,
) -> Result<(), String> {
    tokio::select! {
        _ = tokio::time::sleep(duration) => Ok(()),
        _ = wait_dpi_cancelled(state, generation) => Err(format!("{label} отменён")),
    }
}

fn cancel_dpi_operation(state: &DpiState) {
    let mut control = state.control.lock_recover();
    control.generation = control.generation.wrapping_add(1);
    control.operation = None;
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

#[derive(Deserialize)]
struct Strategy {
    id: String,
    #[serde(default)]
    name: String,
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
const LOCAL_LIST_FILES: [&str; 7] = [
    "list-general-user.txt",
    "list-exclude-user.txt",
    "ipset-exclude-user.txt",
    "active-vpn-domain.txt",
    "active-vpn-ip.txt",
    "ipset-all.txt",
    "ipset-all.base.txt",
];
const CHANNEL_SERVICE_FILES: [&str; 2] = ["hosts", "ipset-service.txt"];

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

fn active_channel_generation_from_dpi(dpi_data: &Path) -> Result<Option<PathBuf>, String> {
    let pointer = dpi_data.join(CHANNEL_POINTER_FILE);
    let raw = match std::fs::read_to_string(&pointer) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read DPI channel pointer: {e}")),
    };
    let name = raw.trim();
    if !valid_channel_generation_name(name) {
        return Err("DPI channel pointer is invalid".into());
    }
    let generation = dpi_data.join(CHANNEL_GENERATIONS_DIR).join(name);
    validate_channel_generation(&generation)?;
    Ok(Some(generation))
}

fn active_channel_generation(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let dpi_data = crate::app_paths::data_dir(app)?.join("dpi");
    active_channel_generation_from_dpi(&dpi_data)
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

// Writable-каталог списков: активное поколение канала либо legacy dpi/lists
// до первой успешной поколенческой синхронизации.
fn lists_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match active_channel_generation(app)? {
        Some(generation) => generation.join("lists"),
        None => crate::app_paths::data_dir(app)?.join("dpi").join("lists"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir lists: {e}"))?;
    Ok(dir)
}

// Засеять writable-списки: базовые копируем из ресурсов (если ещё нет —
// updater и пользователь правят writable-версию, поэтому не перезатираем),
// user-списки создаём пустыми. ipset-all.txt пишется отдельно по режиму.
fn ensure_lists(app: &AppHandle) -> Result<PathBuf, String> {
    let dst = lists_dir(app)?;
    let src = res_lists(app)?;
    for name in [
        "list-general.txt",
        "list-google.txt",
        "list-exclude.txt",
        "ipset-exclude.txt",
    ] {
        let to = dst.join(name);
        if !to.exists() {
            let from = src.join(name);
            if from.exists() {
                std::fs::copy(&from, &to).map_err(|e| format!("seed {name}: {e}"))?;
            } else {
                std::fs::write(&to, b"").map_err(|e| format!("touch {name}: {e}"))?;
            }
        }
    }
    for name in [
        "list-general-user.txt",
        "list-exclude-user.txt",
        "ipset-exclude-user.txt",
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
fn ensure_bindata(app: &AppHandle) -> Result<PathBuf, String> {
    let dst = bindata_dir(app)?;
    sync_bundled_bindata(app, &dst)?;
    let _ = reapply_fake_selection(app, &dst)?;
    Ok(dst)
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
        _ => Err("неизвестный тип UDP-подмены".into()),
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
    let authoritative = crate::app_paths::data_dir(app)
        .map(|dir| !dir.join("dpi").join("strategies.json").is_file())
        .unwrap_or(true);
    if !authoritative {
        return Ok(());
    }
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
        return Err("недопустимое имя fake-файла".into());
    }
    let source = dir.join(file);
    let meta =
        std::fs::symlink_metadata(&source).map_err(|e| format!("fake '{file}' не найден: {e}"))?;
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > MAX_DPI_PAYLOAD_BYTES {
        return Err("fake-файл пуст, слишком велик или не является обычным файлом".into());
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

// Путь к strategies.json: активное поколение → legacy overlay → ресурс.
// Поколение выбирается тем же единым pointer, что списки и .bin.
fn strategies_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(generation) = active_channel_generation(app)? {
        return Ok(generation.join("strategies.json"));
    }
    let dir = crate::app_paths::data_dir(app)?;
    let p = dir.join("dpi").join("strategies.json");
    if p.exists() {
        return Ok(p);
    }
    Ok(res_dpi(app)?.join("strategies.json"))
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
            let wbase = lists.join("ipset-all.base.txt");
            let base = if wbase.exists() {
                wbase
            } else {
                res_lists(app)?.join("ipset-all.base.txt")
            };
            copy_replace(&base, &target, "ipset loaded")?;
        }
        "off" => {
            write_replace(&target, "203.0.113.113/32\n", "ipset off")?;
        }
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

/// Путь к логу winws (для UI «Открыть логи»).
#[tauri::command]
pub fn dpi_log_path(app: AppHandle) -> Result<String, String> {
    dpi_log_file(&app)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "log_dir недоступен".into())
}

/// Хвост лога winws (для показа в UI при ошибке).
#[tauri::command]
pub fn dpi_read_log(app: AppHandle) -> Result<String, String> {
    let Some(p) = dpi_log_file(&app) else {
        return Ok(String::new());
    };
    // read_tail капит хвостом (дефолт 128 КБ) вместо слурпа файла целиком: winws
    // при verbose-логе за долгую сессию раздувает dpi.log, а гнать его весь через
    // IPC незачем (тот же приём, что для singbox.log — см. vpn::read_tail).
    crate::vpn::read_tail(&p, None)
}

fn read_strategies(app: &AppHandle) -> Result<Vec<Strategy>, String> {
    let path = strategies_path(app)?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read strategies.json: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse strategies.json: {e}"))
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

// Абсолютный путь к утилите в System32. Не полагаемся на PATH: DPI-команды
// исполняются в elevated-процессе, где PATH-hijack (подсунутый taskkill.exe/sc.exe
// в каталоге раньше System32) выполнялся бы с правами администратора. SystemRoot —
// из окружения, фолбэк C:\Windows на случай пустой переменной.
#[cfg(target_os = "windows")]
fn system32(exe: &str) -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{root}\System32\{exe}")
}
// powershell.exe лежит в отдельном подкаталоге System32 (не в самом System32).
#[cfg(target_os = "windows")]
fn powershell_exe() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe")
}

// Снять winws.exe-СИРОТУ ОТ ДРУГОГО ИНСТАНСА Ninety. Возвращает true, если хоть
// один был убит. Вызывается из dpi_start перед спавном своего winws: к той точке
// наш child уже не жив (дедуп вернул бы «уже запущен»), значит живой winws из
// нашего каталога движка — сирота от второго инстанса Ninety (элевация поднимает
// ВТОРОЙ процесс со своим DpiState; дедуп видит только свой child). Без этого два
// winws дерутся за один kernel-драйвер WinDivert и движок падает «драйвер занят».
//
// Фильтруем по ExecutablePath: убиваем ТОЛЬКО winws внутри нашего res_dpi. Прежний
// `taskkill /IM winws.exe` глушил ВСЕ процессы с этим именем — включая отдельный
// zapret/аналог, запущенный юзером независимо от Ninety.
#[cfg(target_os = "windows")]
fn kill_stray_winws(dpi_root: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // PID|путь каждого winws.exe. CIM отдаёт обычный путь (без verbatim \\?\).
    let ps = "Get-CimInstance Win32_Process -Filter \"Name='winws.exe'\" | \
              ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }";
    let Ok(out) = std::process::Command::new(powershell_exe())
        .args(["-NoProfile", "-NonInteractive", "-Command", ps])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return false;
    };
    // res_dpi может прийти в verbatim-форме — срезаем для префиксного сравнения.
    let root = strip_verbatim(&dpi_root.to_string_lossy()).to_lowercase();
    let text = String::from_utf8_lossy(&out.stdout);
    let mut killed = false;
    for line in text.lines() {
        let Some((pid, path)) = line.trim().split_once('|') else {
            continue;
        };
        let (pid, path) = (pid.trim(), path.trim());
        if pid.is_empty() || path.is_empty() {
            continue;
        }
        // Не наш каталог движка → чужой winws, не трогаем.
        if !path.to_lowercase().starts_with(&root) {
            continue;
        }
        let ok = std::process::Command::new(system32("taskkill.exe"))
            .args(["/F", "/PID", pid])
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

/// Сырой strategies.json — фронт рендерит список стратегий из него.
#[tauri::command]
pub fn dpi_strategies(app: AppHandle) -> Result<String, String> {
    let path = strategies_path(&app)?;
    std::fs::read_to_string(&path).map_err(|e| format!("read strategies.json: {e}"))
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
    let dir = ensure_bindata(&app)?;
    let options = fake_options(&dir)?;
    let selection = load_fake_selection(&app);
    let referenced = referenced_bins(&read_strategies(&app)?);
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
    let dir = ensure_bindata(&app)?;
    let options = fake_options(&dir)?;
    if !options.contains(&file) {
        return Err("fake-файл отсутствует в текущем подписанном наборе".into());
    }
    let target = dir.join(fake_target(&kind)?);
    let previous = match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_file() && meta.len() <= MAX_DPI_PAYLOAD_BYTES => Some(
            std::fs::read(&target)
                .map_err(|e| format!("не удалось сохранить текущий UDP fake: {e}"))?,
        ),
        Ok(_) => return Err("текущий ACTIVE-файл небезопасен или слишком велик".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("не удалось сохранить текущий UDP fake: {e}")),
    };
    apply_fake_file(&dir, &kind, &file)?;
    let mut selection = load_fake_selection(&app);
    match kind.as_str() {
        "discord" => selection.discord = Some(file.clone()),
        "game" => selection.game = Some(file.clone()),
        _ => return Err("неизвестный тип UDP-подмены".into()),
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
                "{marker_error}; откат ACTIVE-файла тоже не удался: {rollback_error}"
            )),
        };
    }
    Ok(serde_json::json!({ "kind": kind, "file": file }))
}

const DPI_LOG_CAP_BYTES: u64 = 8 * 1024 * 1024;

struct DpiLogWriter {
    file: std::fs::File,
    written: u64,
}

impl DpiLogWriter {
    fn append(&mut self, bytes: &[u8]) {
        use std::io::Write;
        if self.written.saturating_add(bytes.len() as u64) > DPI_LOG_CAP_BYTES
            && self.file.set_len(0).is_ok()
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
    let _ = file.set_len(0); // новая сессия — новый диагностический лог
    let written = 0;
    Some(Arc::new(Mutex::new(DpiLogWriter { file, written })))
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
/// ipset: "any"|"loaded"|"off". Должен вызываться из elevated-процесса.
#[tauri::command]
pub async fn dpi_start(
    app: AppHandle,
    state: State<'_, DpiState>,
    strategy_id: String,
    game_filter: String,
    ipset: String,
    monkey: bool,
    logs_disabled: Option<bool>,
) -> Result<(), String> {
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
                    *guard = None;
                } // умер — перезапустим
                Ok(None) => return Err("DPI-обход уже запущен".into()),
                Err(_) => return Err("DPI-обход уже запущен".into()),
            }
        }
    }

    let _data = state.data.lock().await;
    let strategies = read_strategies(&app)?;
    let strat = strategies
        .into_iter()
        .find(|s| s.id == strategy_id)
        .ok_or_else(|| format!("стратегия '{strategy_id}' не найдена"))?;

    let bin = bin_dir(&app, monkey)?;
    let exe = bin.join("winws.exe");
    if !exe.exists() {
        return Err(format!("winws.exe не найден: {}", exe.display()));
    }
    let lists = ensure_lists(&app)?;
    write_ipset_mode(&app, &lists, &ipset)?;

    let (g_tcp, g_udp) = match game_filter.as_str() {
        "tcpudp" => ("1024-65535", "1024-65535"),
        _ => ("12", "12"), // off — безвредный одиночный порт (как дефолт Flowseal)
    };

    // %BIN% → writable bin-data (оверлей канала), НЕ движок: cwd ниже остаётся
    // на read-only ресурсе (winws.exe + WinDivert.dll грузятся оттуда).
    let bindata = ensure_bindata(&app)?;
    let bindata_s = strip_verbatim(&bindata.to_string_lossy());
    let lists_s = strip_verbatim(&lists.to_string_lossy());
    let mut args: Vec<String> = strat
        .args
        .iter()
        .map(|a| subst(a, &bindata_s, &lists_s, g_tcp, g_udp))
        .collect();
    // Активный VPN endpoint — отдельные managed-файлы: смена ноды заменяет
    // значение, не накапливает старые адреса и не трогает user exclusions.
    args.extend(active_vpn_exclusion_args(&lists));

    if !dpi_operation_current(&state, generation) {
        return Err("DPI start отменён".into());
    }

    // Защита от «двойного старта»: гасим stray-winws (сирота от другого инстанса
    // Ninety — по пути в нашем res_dpi) перед запуском своего, иначе два winws
    // дерутся за драйвер WinDivert. Если кого-то убили, даём драйверу отцепиться
    // от мёртвого хэндла до нашего старта.
    if kill_stray_winws(&res_dpi(&app)?) {
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
            return Err("DPI start отменён".into());
        }
        *state.child.lock_recover() = Some(child);
    }
    // winws поднял драйвер WinDivert — при выходе службу надо будет снять.
    state.driver_loaded.store(true, Ordering::SeqCst);

    // Дать winws ~700мс упасть (занятый драйвер / нет прав / битые args).
    dpi_sleep_or_cancel(&state, generation, Duration::from_millis(700), "DPI start").await?;
    remember_owned_driver_services(&state, &bin);
    {
        let mut guard = state.child.lock_recover();
        if let Some(child) = guard.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                *guard = None;
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
                        format!("\nВывод winws:\n{t}")
                    })
                    .unwrap_or_else(|| {
                        " Нужны права администратора или занят драйвер WinDivert.".into()
                    });
                return Err(format!(
                    "winws завершился сразу (код {:?}).{}",
                    status.code(),
                    tail
                ));
            }
        }
    }
    Ok(())
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
    .map_err(|e| format!("не удалось дождаться остановки winws: {e}"))?
}

#[tauri::command]
pub fn dpi_running(state: State<'_, DpiState>) -> bool {
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

/// Внести IP и/или домен активной VPN-ноды в exclude-списки запрета, чтобы
/// winws не трогал зашифрованный трафик к серверу (главный риск из спайка).
/// Дедуп; домен — в list-exclude-user.txt, IP — в ipset-exclude-user.txt.
#[tauri::command]
pub async fn dpi_set_node_exclude(
    app: AppHandle,
    state: State<'_, DpiState>,
    ip: Option<String>,
    domain: Option<String>,
) -> Result<(), String> {
    let _data = state.data.lock().await;
    let lists = ensure_lists(&app)?;
    if let Some(d) = domain.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        append_unique(&lists.join("list-exclude-user.txt"), d)?;
    }
    if let Some(i) = ip.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // ipset ждёт CIDR: одиночный IPv4 → /32, одиночный IPv6 → /128.
        let entry = normalize_ipset_entry(i)?;
        append_unique(&lists.join("ipset-exclude-user.txt"), &entry)?;
    }
    Ok(())
}

/// Атомарно заменить исключение активного VPN endpoint. В отличие от
/// dpi_set_node_exclude это session-managed state, а не пользовательский список.
#[tauri::command]
pub async fn dpi_set_active_vpn_endpoint(
    app: AppHandle,
    state: State<'_, DpiState>,
    ip: Option<String>,
    domain: Option<String>,
) -> Result<(), String> {
    let _data = state.data.lock().await;
    let lists = ensure_lists(&app)?;
    let domain_value = domain
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let ip_value = match ip.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(value) => normalize_ipset_entry(value)?,
        None => String::new(),
    };
    write_replace(
        &lists.join("active-vpn-domain.txt"),
        domain_value,
        "active VPN domain",
    )?;
    write_replace(&lists.join("active-vpn-ip.txt"), &ip_value, "active VPN IP")?;
    Ok(())
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

/// Прочитать пользовательский список доменов (для редактора в UI).
/// kind: "user" (домены обхода) | "exclude" (исключения).
#[tauri::command]
pub fn dpi_read_list(app: AppHandle, kind: String) -> Result<String, String> {
    let lists = ensure_lists(&app)?;
    let p = lists.join(user_list_name(&kind));
    Ok(std::fs::read_to_string(&p).unwrap_or_default())
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

fn append_unique(path: &Path, line: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == line) {
        return Ok(());
    }
    let mut out = existing;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(line);
    out.push('\n');
    write_replace(path, &out, "write exclude")
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
// Версия набора стратегий: активное поколение → legacy marker → ресурс.
// Так UI не может увидеть версию, не совпадающую с активными данными.
fn strat_version(app: &AppHandle) -> Result<String, String> {
    if let Some(generation) = active_channel_generation(app)? {
        let version = std::fs::read_to_string(generation.join("version.txt"))
            .map_err(|e| format!("read DPI channel version: {e}"))?
            .trim()
            .to_string();
        if version.is_empty() {
            return Err("DPI channel version is empty".into());
        }
        return Ok(version);
    }
    let dir = crate::app_paths::data_dir(app)?;
    let marker = dir.join("dpi").join("strategies-version.txt");
    if let Ok(v) = std::fs::read_to_string(&marker) {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return Ok(v);
        }
    }
    Ok(res_dpi(app)
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("version.txt")).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "—".into()))
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

fn no_proxy_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy() // бьём напрямую (мимо системного прокси VPN), иначе тест/апдейт бессмысленны
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

// Клиент для ЗАГРУЗКИ СПИСКОВ (hosts/ipset). port=Some(p>0) → через mixed-inbound
// sing-box (http://127.0.0.1:p), т.е. трафик идёт через обход/VPN; иначе прямой
// запрос. Отличие от no_proxy_client: прямой запрос к raw.githubusercontent.com
// из РФ режется ТСПУ — поэтому при активном VPN (proxy/systemProxy) тянем через
// прокси, а на direct падаем фолбэком (паттерн взят у quality::build_client).
fn list_client(port: Option<u16>) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder().timeout(Duration::from_secs(20));
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
    let mut last = String::from("нет попыток");
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
    let local = strat_version(&app)?;
    // port>0 (VPN в proxy/systemProxy) → проверка идёт через туннель: version.txt
    // релиза dpi-channel лежит на github, а он из РФ режется ТСПУ напрямую.
    let remote = fetch_list_text(&format!("{CHANNEL_BASE}/version.txt"), port)
        .await
        .map_err(|e| format!("fetch version: {e}"))?
        .trim()
        .to_string();
    Ok(serde_json::json!({
        "local": local,
        "remote": remote,
        "available": !remote.is_empty() && remote != local,
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
        .ok_or("pubkey: ключевая строка не найдена")?;
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
            "ключи DPI-канала повреждены: {}",
            key_errors.join("; ")
        ));
    }
    Err("ПОДПИСЬ НЕВЕРНА: не принята dedicated или legacy ключом DPI-канала".into())
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

// Каталог последнего применённого подписанного service-набора (hosts/ipset) —
// оффлайн-фолбэк, когда сеть недоступна, но канал уже синкали хоть раз.
fn channel_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(match active_channel_generation(app)? {
        Some(generation) => generation.join("service"),
        None => crate::app_paths::data_dir(app)?.join("dpi").join("channel"),
    })
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
                entry.name(),
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
            None => return Err(format!("unsafe channel zip path: {}", entry.name())),
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
    staging_guard.keep = true;
    Ok(staging)
}

// Прочитать последнюю применённую подписанную копию service-файла (оффлайн-фолбэк).
fn read_cached_service(app: &AppHandle, name: &str) -> Result<String, String> {
    let p = channel_cache_dir(app)?.join(name);
    if p.exists() {
        std::fs::read_to_string(&p).map_err(|e| format!("read cached {name}: {e}"))
    } else {
        Err(format!("{name}: подписанный канал ещё не синхронизирован"))
    }
}

// Service-файл активного поколения, если канал уже стоит на опубликованной
// версии. Тогда качать бандл незачем: service/<name> в поколении — тот же самый
// подписанный файл, что лежит в zip. Любая осечка (нет поколения, нет файла,
// версии разошлись, сеть молчит) — None, и вызывающий идёт обычным путём.
async fn current_channel_service(app: &AppHandle, port: Option<u16>, name: &str) -> Option<String> {
    let generation = active_channel_generation(app).ok().flatten()?;
    let path = generation.join("service").join(name);
    if !path.is_file() {
        return None;
    }
    let local = strat_version(app).ok()?;
    let remote = fetch_list_text(&format!("{CHANNEL_BASE}/version.txt"), port)
        .await
        .ok()?;
    if remote.trim().is_empty() || remote.trim() != local {
        return None;
    }
    std::fs::read_to_string(&path).ok()
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
            let result = (|| -> Result<String, String> {
                let src = staging.join("service").join(name);
                if !src.exists() {
                    // Старые установки могут иметь кеш от переходного bundle.
                    return read_cached_service(app, name);
                }
                let body =
                    std::fs::read_to_string(&src).map_err(|e| format!("read {name}: {e}"))?;
                // До первой полной синхронизации сохраняем совместимый legacy-кеш.
                // Активное поколение не меняем по одному service-файлу: оно является
                // снимком подписанного bundle и переключается только целиком.
                if active_channel_generation(app)?.is_none() {
                    let dir = channel_cache_dir(app)?;
                    std::fs::create_dir_all(&dir)
                        .map_err(|e| format!("mkdir channel cache: {e}"))?;
                    write_replace(&dir.join(name), &body, &format!("service {name}"))?;
                }
                Ok(body)
            })();
            let _ = std::fs::remove_dir_all(&staging);
            result
        }
        // Сеть недоступна → отдаём кешированную подпись, если есть; иначе сетевую ошибку.
        Err(net) => read_cached_service(app, name).map_err(|_| net),
    }
}

fn require_regular_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("{label} отсутствует: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!("{label} не является обычным файлом"));
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
        let current_generation = active_channel_generation_from_dpi(&dpi_data)?;
        let previous_name = current_generation
            .as_ref()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .map(str::to_string);
        let current_lists = ensure_lists(&app)?;
        let mut fake_selection = load_fake_selection(&app);

        // strategies.json валиден?
        let strat_path = staging.join("strategies.json");
        require_regular_file(&strat_path, "staged strategies.json")?;
        let strat_raw = std::fs::read_to_string(&strat_path)
            .map_err(|e| format!("staged strategies.json: {e}"))?;
        let strategies: Vec<Strategy> =
            serde_json::from_str(&strat_raw).map_err(|e| format!("parse strategies: {e}"))?;
        if strategies.is_empty() {
            return Err("в бандле нет стратегий".into());
        }
        // Бандл обязан быть самодостаточным: нельзя принять новую стратегию,
        // которая случайно работает лишь пока в bin-data лежит старый payload.
        let staged_bin = staging.join("bin");
        if !staged_bin.is_dir() {
            return Err("в бандле отсутствует каталог bin".into());
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
                return Err("payload канала не является обычным файлом".into());
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "имя .bin в канале не является UTF-8".to_string())?;
            if !valid_bin_filename(&name) {
                return Err(format!("недопустимое имя .bin в канале: {name}"));
            }
            let size = entry
                .metadata()
                .map_err(|e| format!("staged bin metadata: {e}"))?
                .len();
            if !(1..=MAX_DPI_PAYLOAD_BYTES).contains(&size) {
                return Err(format!(
                    "недопустимый размер .bin в канале: {name} ({size})"
                ));
            }
            incoming.insert(name.clone());
            payloads.push((path, name));
        }
        if payloads.is_empty() || payloads.len() > 256 {
            return Err(format!(
                "недопустимое количество .bin в канале: {}",
                payloads.len()
            ));
        }
        for name in referenced_bins(&strategies) {
            if !incoming.contains(&name) {
                return Err(format!("в бандле нет .bin: {name}"));
            }
        }

        let ver = std::fs::read_to_string(staging.join("version.txt"))
            .map_err(|e| format!("staged version.txt: {e}"))?
            .trim()
            .to_string();
        if !valid_channel_version(&ver) {
            return Err("недопустимая версия DPI-канала".into());
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
                } else if name == "ipset-all.base.txt" {
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
            copy_replace(
                &strat_path,
                &pending.join("strategies.json"),
                "channel strategies",
            )?;
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

#[cfg(target_os = "windows")]
fn system_hosts_path() -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    PathBuf::from(root).join(r"System32\drivers\etc\hosts")
}
#[cfg(not(target_os = "windows"))]
fn system_hosts_path() -> PathBuf {
    PathBuf::from("/etc/hosts")
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
                return Err("hosts: вложенный BEGIN-маркер Ninety".into());
            }
            skip = true;
            blocks += 1;
            continue;
        }
        if t == HOSTS_END {
            if !skip {
                return Err("hosts: END-маркер Ninety без BEGIN".into());
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
        return Err("hosts: BEGIN-маркер Ninety без END".into());
    }
    if blocks > 1 {
        return Err(format!(
            "hosts: найдено несколько managed-блоков Ninety ({blocks})"
        ));
    }
    Ok(out)
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

/// Статус системного hosts: применён ли наш блок и сколько в нём записей.
#[tauri::command]
pub fn dpi_hosts_status(_app: AppHandle) -> Result<serde_json::Value, String> {
    let path = system_hosts_path();
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("чтение hosts ({}): {e}", path.display()))?;
    // Повреждённые маркеры нельзя показывать как нормальное applied-состояние:
    // apply/clear в таком случае тоже остановятся без записи.
    let _ = strip_managed_block(&content)?;
    let mut inside = false;
    let mut block = String::new();
    for line in content.lines() {
        let t = line.trim();
        if t == HOSTS_BEGIN {
            inside = true;
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
        "applied": content.contains(HOSTS_BEGIN),
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
        return Err("в источнике нет записей hosts".into());
    }

    let path = system_hosts_path();
    let current = std::fs::read_to_string(&path)
        .map_err(|e| format!("чтение hosts ({}): {e}", path.display()))?;
    let base = strip_managed_block(&current)?;

    // Бэкап оригинала один раз — до первой нашей записи. Ошибка backup блокирует
    // системную запись: без проверяемого отката менять hosts нельзя.
    let bdir = crate::app_paths::data_dir(&app)?.join("dpi");
    std::fs::create_dir_all(&bdir).map_err(|e| format!("mkdir hosts backup: {e}"))?;
    let backup = bdir.join("hosts.backup");
    if !backup.exists() {
        // При миграции со старой версии managed-блок уже может быть, а backup —
        // ещё нет. В этом случае сохраняем восстановленную базу без нашего блока.
        let backup_body = if current.contains(HOSTS_BEGIN) {
            base.as_bytes()
        } else {
            current.as_bytes()
        };
        write_bytes_replace(&backup, backup_body, "hosts backup")?;
        let saved = std::fs::read(&backup).map_err(|e| format!("verify hosts backup: {e}"))?;
        if saved != backup_body {
            return Err("проверка backup hosts: содержимое не совпало".into());
        }
    } else if backup.exists() {
        std::fs::File::open(&backup).map_err(|e| format!("open hosts backup: {e}"))?;
    }

    // Снять старый блок (если был), дописать свежий в конец.
    let base = base.trim_end();
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
    // антивирусов блокируют именно подмену. Откат при сбое — проверенный
    // hosts.backup выше.
    let out = apply_hosts_line_endings(&out, &current);
    overwrite_in_place(&path, out.as_bytes(), "system hosts").map_err(|e| {
        format!(
            "запись hosts ({}): нужны права администратора — {e}",
            path.display()
        )
    })?;
    flush_dns();
    Ok(serde_json::json!({ "entries": count_hosts_entries(body) }))
}

/// Удалить наш managed-блок из системного hosts (полный откат). Требует админ-прав.
#[tauri::command]
pub fn dpi_hosts_clear(_app: AppHandle) -> Result<(), String> {
    let path = system_hosts_path();
    let current = std::fs::read_to_string(&path)
        .map_err(|e| format!("чтение hosts ({}): {e}", path.display()))?;
    if !current.contains(HOSTS_BEGIN) {
        // Даже clear не должен молча принимать лишний END-маркер.
        let _ = strip_managed_block(&current)?;
        return Ok(());
    }
    let stripped = format!("{}\n", strip_managed_block(&current)?.trim_end());
    let stripped = apply_hosts_line_endings(&stripped, &current);
    overwrite_in_place(&path, stripped.as_bytes(), "system hosts")
        .map_err(|e| format!("запись hosts: нужны права администратора — {e}"))?;
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

/// Текущее число IP в активной базе ipset (writable-override → ресурс).
#[tauri::command]
pub fn dpi_ipset_count(app: AppHandle) -> Result<usize, String> {
    let lists = ensure_lists(&app)?;
    let wbase = lists.join("ipset-all.base.txt");
    let path = if wbase.exists() {
        wbase
    } else {
        res_lists(&app)?.join("ipset-all.base.txt")
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
    let raw = fetch_channel_service(&app, port, "ipset-service.txt")
        .await
        .map_err(|e| format!("fetch ipset: {e}"))?;
    let body = raw.replace("\r\n", "\n");
    let n = count_ipset_lines(&body);
    if n == 0 {
        return Err("в источнике нет IP-записей".into());
    }
    write_replace(
        &lists.join("ipset-all.base.txt"),
        &body,
        "запись ipset base",
    )?;
    Ok(n)
}

// ── Авто-подбор стратегии ───────────────────────────────────────────
#[derive(serde::Serialize, Clone)]
struct AutotestProgress {
    i: usize,
    total: usize,
    name: String,
}

/// Перебирает все стратегии: поднимает winws с каждой, пробит test_url, мерит
/// задержку, выбирает лучшую по (успех, мин. задержка). Прогресс — событием
/// "dpi:autotest". winws после теста остаётся выключенным; применяет выбор фронт.
/// ВАЖНО: запускать при ВЫКЛЮЧЕННОМ VPN (иначе проба идёт через туннель мимо
/// winws и тест бессмысленен). Требует элевации.
#[tauri::command]
pub async fn dpi_autotest(
    app: AppHandle,
    state: State<'_, DpiState>,
    test_url: Option<String>,
    monkey: bool,
) -> Result<serde_json::Value, String> {
    let generation = begin_dpi_operation(&state, "autotest")?;
    let _operation = DpiOperationGuard {
        state: &state,
        generation,
    };
    // Глушим текущий winws без изменения generation: autotest теперь владеет
    // lifecycle и публикует каждый test-child в state, поэтому dpi_stop/exit
    // способны отменить и reap'нуть его.
    stop_managed_child(&state, "winws")?;
    let url = test_url.unwrap_or_else(|| "https://www.youtube.com/".into());

    // Мьютекс данных держим только на подготовке файлов. Прогон стратегий идёт
    // минутами, и под общим локом он замораживал весь DPI-раздел вместе с
    // dpi_set_active_vpn_endpoint — а его ждёт автозапуск VPN.
    let (strategies, bin, exe, bindata_s, lists_s) = {
        let _data = state.data.lock().await;
        // EXP доступна для ручного выбора, но экспериментальный профиль не должен
        // автоматически становиться рекомендацией автотеста.
        let strategies: Vec<Strategy> = read_strategies(&app)?
            .into_iter()
            .filter(|strategy| !strategy.experimental)
            .collect();
        let bin = bin_dir(&app, monkey)?;
        let exe = bin.join("winws.exe");
        if !exe.exists() {
            return Err(format!("winws.exe не найден: {}", exe.display()));
        }
        let lists = ensure_lists(&app)?;
        write_ipset_mode(&app, &lists, "any")?;
        let bindata = ensure_bindata(&app)?;
        let bindata_s = strip_verbatim(&bindata.to_string_lossy());
        let lists_s = strip_verbatim(&lists.to_string_lossy());
        (strategies, bin, exe, bindata_s, lists_s)
    };
    let client = no_proxy_client()?;
    let total = strategies.len();

    let mut best: Option<(String, String, u64)> = None; // (id, name, latency)
    let mut passed = 0usize;

    for (idx, strat) in strategies.iter().enumerate() {
        if !dpi_operation_current(&state, generation) {
            return Err("DPI autotest отменён".into());
        }
        let _ = app.emit(
            "dpi:autotest",
            AutotestProgress {
                i: idx + 1,
                total,
                name: strat.name.clone(),
            },
        );
        let args: Vec<String> = strat
            .args
            .iter()
            .map(|a| subst(a, &bindata_s, &lists_s, "12", "12"))
            .collect();
        let mut cmd = std::process::Command::new(&exe);
        cmd.args(&args).current_dir(&bin);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(_) => continue,
        };
        {
            let control = state.control.lock_recover();
            if control.generation != generation || control.operation.is_none() {
                drop(control);
                let mut child = child;
                let _ = terminate_child_bounded(&mut child, "winws autotest");
                return Err("DPI autotest отменён".into());
            }
            *state.child.lock_recover() = Some(child);
        }
        state.driver_loaded.store(true, Ordering::SeqCst);
        dpi_sleep_or_cancel(
            &state,
            generation,
            Duration::from_millis(700),
            "DPI autotest",
        )
        .await?;
        remember_owned_driver_services(&state, &bin);

        let t0 = Instant::now();
        let ok = tokio::select! {
            response = client.get(url.as_str()).send() => match response {
                Ok(r) => r.status().is_success() || r.status().is_redirection(),
                Err(_) => false,
            },
            _ = wait_dpi_cancelled(&state, generation) => {
                return Err("DPI autotest отменён".into());
            }
        };
        let lat = t0.elapsed().as_millis() as u64;

        if !dpi_operation_current(&state, generation) {
            return Err("DPI autotest отменён".into());
        }
        stop_managed_child(&state, "winws autotest")?;

        if ok {
            passed += 1;
            let better = match &best {
                Some((_, _, bl)) => lat < *bl,
                None => true,
            };
            if better {
                best = Some((strat.id.clone(), strat.name.clone(), lat));
            }
        }
        // короткая пауза, чтобы драйвер успел отцепиться между прогонами
        dpi_sleep_or_cancel(
            &state,
            generation,
            Duration::from_millis(150),
            "DPI autotest",
        )
        .await?;
    }

    match best {
        Some((id, name, lat)) => Ok(serde_json::json!({
            "best_id": id, "best_name": name, "passed": passed, "total": total, "latency_ms": lat,
        })),
        None => Ok(serde_json::json!({
            "best_id": null, "best_name": null, "passed": 0, "total": total, "latency_ms": null,
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
        return Err("выгрузка DPI-драйвера превысила 3 секунды".into());
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
                    Err(format!("sc {verb} {service} завершился с кодом {code}"))
                };
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                return Err(format!(
                    "sc {verb} {service} не завершился за общий лимит 3 секунды"
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
    .map_err(|e| format!("не удалось дождаться выгрузки DPI-драйвера: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn referenced_bins_collects_only_bin_placeholders() {
        let strat = vec![
            Strategy {
                id: "a".into(),
                name: String::new(),
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
        assert_eq!(
            active_channel_generation_from_dpi(&root).unwrap(),
            Some(old.clone())
        );

        // Полностью собранное новое поколение ещё не активно без commit pointer.
        let new = create_test_channel_generation(&root, "gen-200-1-0", "new");
        assert_eq!(
            active_channel_generation_from_dpi(&root).unwrap(),
            Some(old)
        );

        write_replace(
            &root.join(CHANNEL_POINTER_FILE),
            "gen-200-1-0\n",
            "test channel pointer",
        )
        .unwrap();
        assert_eq!(
            active_channel_generation_from_dpi(&root).unwrap(),
            Some(new.clone())
        );

        // Повреждённое committed-поколение не откатывается молча к смеси legacy.
        std::fs::remove_file(new.join("strategies.json")).unwrap();
        assert!(active_channel_generation_from_dpi(&root).is_err());
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
        assert!(strip_managed_block(&open).unwrap_err().contains("без END"));

        let close = format!("127.0.0.1 localhost\n{HOSTS_END}\n");
        assert!(strip_managed_block(&close)
            .unwrap_err()
            .contains("без BEGIN"));

        let nested = format!("{HOSTS_BEGIN}\n{HOSTS_BEGIN}\n{HOSTS_END}\n{HOSTS_END}\n");
        assert!(strip_managed_block(&nested)
            .unwrap_err()
            .contains("вложенный"));

        let duplicate = format!(
            "{HOSTS_BEGIN}\n1.1.1.1 one.test\n{HOSTS_END}\n{HOSTS_BEGIN}\n2.2.2.2 two.test\n{HOSTS_END}\n"
        );
        assert!(strip_managed_block(&duplicate)
            .unwrap_err()
            .contains("несколько"));
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

        cancel_dpi_operation(&state);
        assert!(!dpi_operation_current(&state, first));
        assert!(begin_dpi_operation(&state, "autotest").is_err());
        drop(first_guard);

        let second = begin_dpi_operation(&state, "autotest").unwrap();
        assert_ne!(first, second);
        assert!(dpi_operation_current(&state, second));
    }
}
