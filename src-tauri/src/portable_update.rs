// Ninety · обновление Full Portable в один клик.
//
// Установленная сборка обновляется NSIS-установщиком через updater-плагин, а
// распакованная копия раньше только открывала страницу релиза: скачать ZIP,
// закрыть Ninety, распаковать поверх, запустить заново — руками.
//
// Теперь updater-плагин с отдельной целью `windows-x86_64-portable` качает ZIP
// и проверяет его minisign-подпись тем же ключом, что и установщик (запись
// цели в latest.json добавляет build.yml). Архив распаковывается в staging
// внутри папки программы — тот же том, поэтому замена идёт переименованием.
// После остановки движков каждый файл программы отодвигается в `*.ninety-old`
// (Windows разрешает переименовать даже запущенный exe), на его место встаёт
// новый; любая ошибка откатывает уже сделанное. Затем стартует новый
// Ninety.exe, а этот процесс завершается. Следующий запуск подчищает
// `*.ninety-old` и staging. NinetyData в архив не входит и не трогается.
//
// Portable 0.15.0–0.16.0 по ошибке ставил обновление в NinetyData, а не в
// папку программы: новая версия запускалась из `NinetyData\Ninety.exe` и
// открывала пустое `NinetyData\NinetyData`. Обновление применяет код старой
// версии, поэтому каждое следующее уходило на уровень глубже. Исправленная
// версия, запущенная из такой копии, переносит себя в исходную папку и
// перезапускается оттуда (`repair_nested_install`), а та на старте убирает
// файлы программы из NinetyData и откладывает данные, созданные во вложенных
// копиях, в `NinetyData.recovered-*` (`cleanup_nested_layers`).

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri_plugin_updater::UpdaterExt;

pub const PORTABLE_TARGET: &str = "windows-x86_64-portable";
const STAGING_DIR: &str = ".ninety-update";
const OLD_MARKER: &str = ".ninety-old";
const DATA_DIR: &str = "NinetyData";
const MAIN_EXE: &str = "Ninety.exe";
const PORTABLE_MARKER: &str = "Ninety.portable";
const README: &str = "README.txt";
const RECOVERED_PREFIX: &str = "NinetyData.recovered-";
const REPAIR_DIR: &str = ".ninety-repair";
const LOCK_FILE: &str = ".ninety-update.lock";
/// Верхний уровень Full Portable — всё, что кладёт туда
/// scripts/package-portable.ps1 (сверяется тестом). Только эти имена ремонт
/// переносит из вложенной копии и убирает из NinetyData: рядом с ними там
/// лежат config/data/logs/webview пользователя.
const PROGRAM_ENTRIES: [&str; 10] = [
    MAIN_EXE,
    "sing-box.exe",
    "xray.exe",
    "naive.exe",
    "trusttunnel_client.exe",
    "wintun.dll",
    "dpi",
    "flags",
    README,
    PORTABLE_MARKER,
];
const MAX_ENTRIES: usize = 20_000;
const MAX_UNPACKED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum PortableUpdateEvent {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
    },
    Finished,
}

/// Файл, уже переставленный на новую версию: нужен для отката.
pub struct Applied {
    rel: PathBuf,
    old: Option<PathBuf>,
}

fn validate_version(version: &str) -> Result<(), String> {
    let ok = !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid portable update version: {version:?}"))
    }
}

fn staging_path(root: &Path, version: &str) -> PathBuf {
    root.join(STAGING_DIR).join(version)
}

fn first_component(path: &Path) -> Option<&std::ffi::OsStr> {
    match path.components().next() {
        Some(Component::Normal(name)) => Some(name),
        _ => None,
    }
}

/// Путь файла программы внутри архива: только обычные компоненты, без данных
/// пользователя, staging и наших `*.ninety-old`.
fn safe_program_path(rel: &Path) -> bool {
    if rel.as_os_str().is_empty() {
        return false;
    }
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return false;
    }
    let Some(first) = first_component(rel).and_then(|c| c.to_str()) else {
        return false;
    };
    if [DATA_DIR, STAGING_DIR, REPAIR_DIR, LOCK_FILE]
        .iter()
        .any(|reserved| first.eq_ignore_ascii_case(reserved))
    {
        return false;
    }
    !rel.to_string_lossy().contains(OLD_MARKER)
}

/// Архив собирается из папки `Ninety\`: если все файлы лежат под одной общей
/// папкой верхнего уровня, она снимается.
fn common_root(paths: &[PathBuf]) -> Option<PathBuf> {
    let first = first_component(paths.first()?)?;
    let shared = paths
        .iter()
        .all(|p| p.components().count() > 1 && first_component(p) == Some(first));
    shared.then(|| PathBuf::from(first))
}

/// Распаковывает подписанный (уже проверенный плагином) ZIP в staging.
pub fn stage_archive(root: &Path, version: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    validate_version(version)?;
    let staging_root = root.join(STAGING_DIR);
    if staging_root.exists() {
        std::fs::remove_dir_all(&staging_root).map_err(|e| format!("clear update staging: {e}"))?;
    }
    let staging = staging_path(root, version);
    std::fs::create_dir_all(&staging).map_err(|e| format!("create update staging: {e}"))?;
    let result = extract_archive(&staging, bytes);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging_root);
    }
    result.map(|()| staging)
}

fn extract_archive(staging: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("open portable zip: {e}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(format!("portable zip has too many entries: {}", zip.len()));
    }
    let mut files = Vec::new();
    let mut unpacked = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry
            .enclosed_name()
            .ok_or_else(|| format!("unsafe path in portable zip (entry {i})"))?;
        unpacked = unpacked
            .checked_add(entry.size())
            .ok_or("portable zip size overflow")?;
        if unpacked > MAX_UNPACKED_BYTES {
            return Err("portable zip is too large".into());
        }
        files.push((i, name));
    }
    let names: Vec<PathBuf> = files.iter().map(|(_, n)| n.clone()).collect();
    let prefix = common_root(&names);
    let mut has_exe = false;
    let mut has_marker = false;
    for (i, name) in files {
        let rel = match &prefix {
            Some(p) => name
                .strip_prefix(p)
                .map(Path::to_path_buf)
                .unwrap_or_else(|_| name.clone()),
            None => name,
        };
        if !safe_program_path(&rel) {
            return Err(format!(
                "unexpected path in portable zip: {}",
                rel.display()
            ));
        }
        has_exe |= rel == Path::new(MAIN_EXE);
        has_marker |= rel == Path::new(PORTABLE_MARKER);
        let out = staging.join(&rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        let mut file =
            std::fs::File::create(&out).map_err(|e| format!("create {}: {e}", rel.display()))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|e| format!("unzip {}: {e}", rel.display()))?;
    }
    if !has_exe || !has_marker {
        return Err("portable zip does not contain Ninety.exe and Ninety.portable".into());
    }
    Ok(())
}

fn list_files(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read {dir:?}: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read {dir:?}: {e}"))?;
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|e| format!("stat {path:?}: {e}"))?;
        if kind.is_dir() {
            list_files(&path, base, out)?;
        } else if kind.is_file() {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("staging path {path:?}: {e}"))?;
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

fn old_path_for(target: &Path) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or_else(|| format!("bad target path {target:?}"))?
        .to_string_lossy()
        .into_owned();
    // Прежний `*.ninety-old` мог остаться занятым (старый процесс ещё жив):
    // тогда берём следующее свободное имя, а не падаем.
    for n in 0..10 {
        let candidate = if n == 0 {
            target.with_file_name(format!("{name}{OLD_MARKER}"))
        } else {
            target.with_file_name(format!("{name}{OLD_MARKER}-{n}"))
        };
        if !candidate.exists() || std::fs::remove_file(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err(format!("no free backup name for {}", target.display()))
}

fn apply_one(root: &Path, staging: &Path, rel: &Path) -> Result<Applied, String> {
    let target = root.join(rel);
    let staged = staging.join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    }
    let old = if target.exists() {
        let old = old_path_for(&target)?;
        std::fs::rename(&target, &old).map_err(|e| format!("{} is in use: {e}", rel.display()))?;
        Some(old)
    } else {
        None
    };
    if let Err(e) = std::fs::rename(&staged, &target) {
        if let Some(old) = &old {
            let _ = std::fs::rename(old, &target);
        }
        return Err(format!("replace {}: {e}", rel.display()));
    }
    Ok(Applied {
        rel: rel.to_path_buf(),
        old,
    })
}

/// Есть ли ссылка среди уже существующих компонентов пути `root\rel`.
fn target_crosses_link(root: &Path, rel: &Path) -> bool {
    let mut current = root.to_path_buf();
    if crate::app_paths::is_link(&current) {
        return true;
    }
    rel.components().any(|component| {
        current.push(component);
        crate::app_paths::is_link(&current)
    })
}

/// Возвращает файлы на прежнюю версию в обратном порядке.
pub fn rollback(root: &Path, staging: &Path, applied: &[Applied]) {
    for item in applied.iter().rev() {
        let target = root.join(&item.rel);
        let staged = staging.join(&item.rel);
        if let Some(parent) = staged.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::rename(&target, &staged);
        if let Some(old) = &item.old {
            let _ = std::fs::rename(old, &target);
        }
    }
}

/// Ставит staging на место программы. При ошибке всё уже сделанное откатывается
/// и возвращается Err; при успехе — список для отката, если не стартует новый exe.
pub fn apply_staged(root: &Path, staging: &Path) -> Result<Vec<Applied>, String> {
    let mut files = Vec::new();
    list_files(staging, staging, &mut files)?;
    if !files.iter().any(|f| f == Path::new(MAIN_EXE)) {
        return Err("staged portable update has no Ninety.exe".into());
    }
    if let Some(bad) = files.iter().find(|f| !safe_program_path(f)) {
        return Err(format!("unexpected staged path: {}", bad.display()));
    }
    // Ссылка или junction на пути назначения увела бы замену в чужие файлы
    // (например, `flags` → NinetyData\config). Проверяем всё до первой замены.
    if let Some(bad) = files.iter().find(|f| target_crosses_link(root, f)) {
        return Err(format!("link on update path: {}", bad.display()));
    }
    // Ninety.exe — последним: пока он не заменён, прежняя версия цела и
    // запускается, даже если процесс оборвётся посреди замены.
    files.sort_by_key(|f| f == Path::new(MAIN_EXE));
    let mut applied = Vec::with_capacity(files.len());
    for rel in &files {
        match apply_one(root, staging, rel) {
            Ok(item) => applied.push(item),
            Err(error) => {
                rollback(root, staging, &applied);
                return Err(error);
            }
        }
    }
    Ok(applied)
}

/// Резервная копия, которую оставляет `old_path_for`: `имя.ninety-old` или
/// `имя.ninety-old-N`. Подстроки мало: такое имя может быть у файла юзера.
fn is_backup_name(name: &str) -> bool {
    match name.rfind(OLD_MARKER) {
        Some(at) => {
            let tail = &name[at + OLD_MARKER.len()..];
            at > 0
                && (tail.is_empty()
                    || tail
                        .strip_prefix('-')
                        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
        }
        None => false,
    }
}

/// Резервная копия файла программы верхнего уровня (`Ninety.exe.ninety-old`).
fn is_program_backup(name: &str) -> bool {
    is_backup_name(name)
        && name.rfind(OLD_MARKER).is_some_and(|at| {
            PROGRAM_ENTRIES
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case(&name[..at]))
        })
}

/// Удаляет `*.ninety-old` в папке программы: на верхнем уровне и внутри
/// каталогов программы (dpi, flags). В NinetyData, recovered и прочие чужие
/// каталоги не заходит, по ссылкам не ходит.
fn cleanup_dir(dir: &Path, top: bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if top
                && !PROGRAM_ENTRIES
                    .iter()
                    .any(|p| p.eq_ignore_ascii_case(&name))
            {
                continue;
            }
            cleanup_dir(&path, false);
        } else if kind.is_file() && is_backup_name(&name) && (!top || is_program_backup(&name)) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// После обновления: убрать `*.ninety-old` и staging. Ошибки молча пропускаем —
/// занятый файл удалится на следующем запуске.
pub fn cleanup_leftovers(root: &Path) {
    for dir in [STAGING_DIR, REPAIR_DIR] {
        let staging = root.join(dir);
        if staging.is_dir() && !crate::app_paths::is_link(&staging) {
            let _ = std::fs::remove_dir_all(&staging);
        }
    }
    cleanup_dir(root, true);
}

/// Межпроцессная блокировка папки программы на время обновления, ремонта и
/// уборки: ремонт идёт до single-instance, и без неё уборка другого процесса
/// могла бы удалить staging или резервные копии посреди замены файлов.
/// Файл открыт без общего доступа и освобождается с процессом.
struct UpdateLock {
    _file: std::fs::File,
}

fn try_update_lock(root: &Path) -> Result<UpdateLock, String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(false).write(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options
        .open(root.join(LOCK_FILE))
        .map(|file| UpdateLock { _file: file })
        .map_err(|e| format!("portable folder is busy: {e}"))
}

/// Что сделал ремонт на этом запуске: фронт один раз сообщает об этом.
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
pub struct RepairReport {
    /// Папка с данными, введёнными во вложенных копиях, если такие были.
    pub recovered: Option<String>,
}

fn repair_report_slot() -> &'static std::sync::Mutex<Option<RepairReport>> {
    static SLOT: std::sync::OnceLock<std::sync::Mutex<Option<RepairReport>>> =
        std::sync::OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(None))
}

/// Отчёт о ремонте отдаётся один раз: повторный вызов вернёт None.
#[tauri::command]
pub fn portable_repair_report() -> Option<RepairReport> {
    repair_report_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

/// Уборка на старте portable-сборки. Вызывается из setup(), то есть уже после
/// single-instance, и под блокировкой папки — синхронно, раньше, чем фронт
/// успеет начать новое скачивание в staging.
pub fn cleanup_on_start() {
    let Ok(root) = crate::app_paths::portable_app_dir() else {
        return;
    };
    if crate::app_paths::nested_portable_origin(&root).is_some() {
        // Ремонт не удался: уборка здесь удалила бы файлы работающей копии.
        return;
    }
    let Ok(_lock) = try_update_lock(&root) else {
        return;
    };
    cleanup_leftovers(&root);
    let report = cleanup_nested_layers(&root);
    // Каждый запуск, а не только после ремонта: разовая ошибка записи в реестр
    // иначе навсегда оставила бы схему за удалённым вложенным exe.
    crate::url_handler::refresh_owned_handlers(&root.join(DATA_DIR));
    if let Some(report) = report {
        *repair_report_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(report);
    }
}

/// Удаляет файл, каталог или ссылку (саму, не заходя внутрь). true — пути
/// больше нет.
fn remove_entry(path: &Path) -> bool {
    if crate::app_paths::is_link(path) {
        let _ = std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path));
    } else if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    matches!(
        std::fs::symlink_metadata(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

fn holds_program(dir: &Path) -> bool {
    dir.join(MAIN_EXE).exists() || dir.join(PORTABLE_MARKER).exists()
}

/// Убирает из уровня NinetyData файлы программы, которые туда поставило
/// сломанное обновление. Маркер — только когда всё остальное удалилось: пока
/// он есть, уровень снова распознаётся, и прерванная уборка продолжится.
/// true — уровень чист.
fn strip_program_files(level: &Path) -> bool {
    let mut clean = remove_entry(&level.join(STAGING_DIR));
    match std::fs::read_dir(level) {
        Ok(entries) => {
            for entry in entries {
                let Ok(entry) = entry else {
                    clean = false;
                    continue;
                };
                let path = entry.path();
                if is_program_backup(&entry.file_name().to_string_lossy()) && path.is_file() {
                    clean &= remove_entry(&path);
                }
            }
        }
        Err(_) => clean = false,
    }
    for name in PROGRAM_ENTRIES {
        if name != PORTABLE_MARKER {
            clean &= remove_entry(&level.join(name));
        }
    }
    clean && remove_entry(&level.join(PORTABLE_MARKER))
}

/// Есть ли в каталоге файлы. Ошибка чтения — Err: такой каталог не удаляем.
fn dir_has_files(dir: &Path) -> Result<bool, String> {
    let mut files = Vec::new();
    list_files(dir, dir, &mut files)?;
    Ok(!files.is_empty())
}

fn recovered_target(root: &Path) -> PathBuf {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let base = root.join(format!("{RECOVERED_PREFIX}{stamp}"));
    if !base.exists() {
        return base;
    }
    (1..100)
        .map(|n| root.join(format!("{RECOVERED_PREFIX}{stamp}-{n}")))
        .find(|p| !p.exists())
        .unwrap_or(base)
}

/// Чинит NinetyData после сломанного обновления: убирает файлы программы со
/// всех вложенных уровней и выносит `NinetyData\NinetyData` (данные, введённые
/// после «сброса») в `NinetyData.recovered-*` рядом с программой. Настоящие
/// данные в NinetyData остаются основными; вынесенное не сливается само и не
/// удаляется. Возвращает отчёт, если что-то было исправлено.
pub(crate) fn cleanup_nested_layers(root: &Path) -> Option<RepairReport> {
    let data = root.join(DATA_DIR);
    if !data.is_dir() || crate::app_paths::is_link(&data) {
        return None;
    }
    let mut repaired = false;
    let mut all_clean = true;
    let mut level = data.clone();
    for _ in 0..crate::app_paths::MAX_NESTED_DEPTH {
        if holds_program(&level) {
            all_clean &= strip_program_files(&level);
            repaired = true;
        }
        let inner = level.join(DATA_DIR);
        if !inner.is_dir() || crate::app_paths::is_link(&inner) {
            break;
        }
        level = inner;
    }

    let inner = data.join(DATA_DIR);
    let mut recovered = None;
    // Пока на каком-то уровне остались файлы программы (заняты), вложенное не
    // трогаем: следующий запуск продолжит. Отчёт — только о законченном ремонте.
    if !all_clean || holds_program(&data) {
        return None;
    }
    if inner.is_dir() && !crate::app_paths::is_link(&inner) {
        repaired = true;
        // Пустой только по достоверному списку; при ошибке чтения — выносим.
        if matches!(dir_has_files(&inner), Ok(false)) {
            if !remove_entry(&inner) {
                return None;
            }
        } else {
            let target = recovered_target(root);
            std::fs::rename(&inner, &target).ok()?;
            recovered = target.file_name().map(|n| n.to_string_lossy().into_owned());
        }
    }
    repaired.then_some(RepairReport { recovered })
}

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.trim().split('.');
    let version = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(version)
}

/// Версия из Ninety.portable (`version=X.Y.Z`, пишет package-portable.ps1).
fn marker_version(dir: &Path) -> Option<(u64, u64, u64)> {
    std::fs::read_to_string(dir.join(PORTABLE_MARKER))
        .ok()?
        .lines()
        .find_map(|line| line.trim().strip_prefix("version="))
        .and_then(parse_version)
}

/// Есть ли в дереве ссылка или junction (сам путь тоже проверяется).
fn tree_has_link(path: &Path) -> bool {
    if crate::app_paths::is_link(path) {
        return true;
    }
    if !path.is_dir() {
        return false;
    }
    match std::fs::read_dir(path) {
        Ok(entries) => entries.flatten().any(|e| tree_has_link(&e.path())),
        Err(_) => true,
    }
}

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {dst:?}: {e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read {src:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("read {src:?}: {e}"))?;
        let path = entry.path();
        let name = entry.file_name();
        if is_backup_name(&name.to_string_lossy()) || crate::app_paths::is_link(&path) {
            continue;
        }
        let target = dst.join(&name);
        if path.is_dir() {
            copy_tree(&path, &target)?;
        } else {
            std::fs::copy(&path, &target).map_err(|e| format!("copy {path:?}: {e}"))?;
        }
    }
    Ok(())
}

/// Копирует в staging только файлы программы из PROGRAM_ENTRIES.
fn copy_program_entries(nested: &Path, staging: &Path) -> Result<(), String> {
    for name in PROGRAM_ENTRIES {
        let src = nested.join(name);
        if crate::app_paths::is_link(&src) {
            continue;
        }
        if src.is_dir() {
            copy_tree(&src, &staging.join(name))?;
        } else if src.is_file() {
            std::fs::copy(&src, staging.join(name)).map_err(|e| format!("copy {name}: {e}"))?;
        }
    }
    if !staging.join(MAIN_EXE).is_file() || !staging.join(PORTABLE_MARKER).is_file() {
        return Err("nested portable copy has no Ninety.exe or marker".to_string());
    }
    Ok(())
}

/// Копирует программу из вложенной папки в staging исходной. Копия, а не
/// перенос: из этой папки сейчас запущен exe, а рядом лежат данные.
fn stage_nested_program(nested: &Path, origin: &Path) -> Result<PathBuf, String> {
    let staging = origin.join(REPAIR_DIR);
    if crate::app_paths::is_link(&staging) {
        return Err("repair staging is a link".into());
    }
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| format!("clear repair staging: {e}"))?;
    }
    std::fs::create_dir_all(&staging).map_err(|e| format!("create repair staging: {e}"))?;
    if let Err(error) = copy_program_entries(nested, &staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    Ok(staging)
}

/// Ставит программу из вложенной копии в исходную папку. Ok(false) — в
/// исходной папке уже более новая версия, её не понижаем. Если версию одной
/// из сторон прочитать нельзя или в назначении есть ссылка, автоматически
/// ничего не меняем.
pub(crate) fn promote_nested(
    nested: &Path,
    origin: &Path,
    own_version: &str,
) -> Result<bool, String> {
    let own = parse_version(own_version).ok_or("own version is not X.Y.Z")?;
    let installed = marker_version(origin).ok_or("origin portable marker has no version")?;
    if installed > own {
        return Ok(false);
    }
    if crate::app_paths::is_link(origin)
        || PROGRAM_ENTRIES
            .iter()
            .any(|name| tree_has_link(&origin.join(name)))
    {
        return Err("origin program folder contains links".into());
    }
    let staging = stage_nested_program(nested, origin)?;
    match apply_staged(origin, &staging) {
        Ok(_) => Ok(true),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

/// Первое, что делает Ninety на старте (после подтверждённого выхода прежнего
/// процесса и до single-instance). Если exe запущен из вложенной копии,
/// переносит программу в исходную папку и запускает её; true — текущему
/// процессу пора выйти. При любой ошибке возвращает false: лучше открыть
/// вложенную копию, чем ничего.
pub fn repair_nested_install() -> bool {
    let Ok(exe_dir) = crate::app_paths::executable_dir() else {
        return false;
    };
    let Some(origin) = crate::app_paths::nested_portable_origin(&exe_dir) else {
        return false;
    };
    let lock = match try_update_lock(&origin) {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("portable repair: {error}");
            return false;
        }
    };
    if let Err(error) = promote_nested(&exe_dir, &origin, env!("CARGO_PKG_VERSION")) {
        eprintln!("portable repair: {error}");
        return false;
    }
    let args: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with("--wait-parent="))
        .collect();
    let spawned = std::process::Command::new(origin.join(MAIN_EXE))
        .args(args)
        .arg(format!("--wait-parent={}", std::process::id()))
        .current_dir(&origin)
        .spawn()
        .is_ok();
    drop(lock);
    spawned
}

/// Папка, в которую ставится обновление: папка программы, а не NinetyData.
/// Из вложенной копии (ремонт не удался) обновляться нельзя — это и создаёт
/// вложенность.
fn update_root() -> Result<PathBuf, String> {
    let root = crate::app_paths::portable_app_dir()?;
    if crate::app_paths::nested_portable_origin(&root).is_some() {
        return Err("portable folder needs repair: restart Ninety".into());
    }
    Ok(root)
}

/// Скачивает ZIP через updater-плагин (подпись проверяется им же) и
/// распаковывает в staging. Ничего из работающей программы не трогает.
#[tauri::command]
pub async fn portable_update_download(
    app: tauri::AppHandle,
    expected_version: String,
    proxy: Option<String>,
    on_event: Channel<PortableUpdateEvent>,
) -> Result<(), String> {
    validate_version(&expected_version)?;
    let root = update_root()?;
    let mut builder = app
        .updater_builder()
        .target(PORTABLE_TARGET)
        .timeout(CHECK_TIMEOUT);
    if let Some(proxy) = proxy.filter(|p| !p.trim().is_empty()) {
        let url = tauri::Url::parse(&proxy).map_err(|e| format!("updater proxy: {e}"))?;
        builder = builder.proxy(url);
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("portable update is not available")?;
    if update.version != expected_version {
        return Err(format!(
            "portable update version changed to {}",
            update.version
        ));
    }
    let progress = on_event.clone();
    let mut started = false;
    let bytes = update
        .download(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = progress.send(PortableUpdateEvent::Started { content_length });
                }
                let _ = progress.send(PortableUpdateEvent::Progress { chunk_length });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = on_event.send(PortableUpdateEvent::Finished);
    let version = update.version.clone();
    tokio::task::spawn_blocking(move || {
        let _lock = try_update_lock(&root)?;
        stage_archive(&root, &version, &bytes)
    })
    .await
    .map_err(|e| format!("portable update staging was interrupted: {e}"))?
    .map(|_| ())
}

/// Ставит staged-версию и запускает новый Ninety.exe. Ok(()) значит, что новый
/// процесс уже стартовал и текущему пора выйти.
pub fn apply_and_launch(version: &str) -> Result<(), String> {
    validate_version(version)?;
    let root = update_root()?;
    let _lock = try_update_lock(&root)?;
    let staging = staging_path(&root, version);
    if !staging.is_dir() {
        return Err("portable update is not downloaded".into());
    }
    let applied = apply_staged(&root, &staging)?;
    let spawned = std::process::Command::new(root.join(MAIN_EXE))
        .arg(format!("--wait-parent={}", std::process::id()))
        .current_dir(&root)
        .spawn();
    if let Err(error) = spawned {
        rollback(&root, &staging, &applied);
        return Err(format!("start updated Ninety: {error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ninety-portable-update-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn zip_with(files: &[(&str, &str)]) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut out);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, body) in files {
                zip.start_file(*name, options).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        out.into_inner()
    }

    #[test]
    fn program_paths_exclude_user_data_and_backups() {
        assert!(safe_program_path(Path::new("Ninety.exe")));
        assert!(safe_program_path(Path::new("dpi/bin/winws.exe")));
        assert!(!safe_program_path(Path::new("NinetyData/config/x")));
        assert!(!safe_program_path(Path::new("ninetydata/x")));
        assert!(!safe_program_path(Path::new(
            ".ninety-update/1.0.0/Ninety.exe"
        )));
        assert!(!safe_program_path(Path::new("Ninety.exe.ninety-old")));
        assert!(!safe_program_path(Path::new("../evil.exe")));
        assert!(!safe_program_path(Path::new("")));
    }

    #[test]
    fn version_must_be_plain() {
        assert!(validate_version("0.15.0").is_ok());
        assert!(validate_version("../x").is_err());
        assert!(validate_version("").is_err());
    }

    #[test]
    fn stage_strips_top_folder_and_requires_main_files() {
        let root = temp_root("stage");
        let zip = zip_with(&[
            ("Ninety/Ninety.exe", "new-exe"),
            ("Ninety/Ninety.portable", "portable=1"),
            ("Ninety/dpi/lists/a.txt", "list"),
        ]);
        let staging = stage_archive(&root, "1.2.3", &zip).unwrap();
        assert_eq!(
            std::fs::read_to_string(staging.join("Ninety.exe")).unwrap(),
            "new-exe"
        );
        assert!(staging.join("dpi/lists/a.txt").is_file());

        let no_marker = zip_with(&[("Ninety/Ninety.exe", "x")]);
        assert!(stage_archive(&root, "1.2.3", &no_marker).is_err());
        assert!(!root.join(STAGING_DIR).exists());

        let with_data = zip_with(&[
            ("Ninety.exe", "x"),
            ("Ninety.portable", "p"),
            ("NinetyData/config/state", "steal"),
        ]);
        assert!(stage_archive(&root, "1.2.3", &with_data).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_replaces_program_files_and_keeps_user_data() {
        let root = temp_root("apply");
        std::fs::write(root.join("Ninety.exe"), "old-exe").unwrap();
        std::fs::write(root.join("sing-box.exe"), "old-core").unwrap();
        std::fs::create_dir_all(root.join("NinetyData")).unwrap();
        std::fs::write(root.join("NinetyData/profile"), "mine").unwrap();
        let zip = zip_with(&[
            ("Ninety/Ninety.exe", "new-exe"),
            ("Ninety/Ninety.portable", "portable=1"),
            ("Ninety/sing-box.exe", "new-core"),
            ("Ninety/flags/ru.svg", "flag"),
        ]);
        let staging = stage_archive(&root, "2.0.0", &zip).unwrap();
        let applied = apply_staged(&root, &staging).unwrap();
        assert_eq!(applied.len(), 4);
        assert_eq!(
            std::fs::read_to_string(root.join("Ninety.exe")).unwrap(),
            "new-exe"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("sing-box.exe")).unwrap(),
            "new-core"
        );
        assert!(root.join("flags/ru.svg").is_file());
        assert_eq!(
            std::fs::read_to_string(root.join("NinetyData/profile")).unwrap(),
            "mine"
        );
        assert!(root.join("Ninety.exe.ninety-old").is_file());

        cleanup_leftovers(&root);
        assert!(!root.join("Ninety.exe.ninety-old").exists());
        assert!(!root.join(STAGING_DIR).exists());
        assert!(root.join("NinetyData/profile").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn program_entries_match_the_portable_package_script() {
        let script = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/package-portable.ps1"),
        )
        .unwrap();
        let mut packaged = std::collections::BTreeSet::new();
        for part in script.split("Join-Path $appDir \"").skip(1) {
            let rel = part.split('"').next().unwrap();
            packaged.insert(rel.split('/').next().unwrap().to_string());
        }
        let known: std::collections::BTreeSet<String> =
            PROGRAM_ENTRIES.iter().map(|s| s.to_string()).collect();
        assert_eq!(packaged, known);
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(parse_version("0.16.1") > parse_version("0.16.0"));
        assert!(parse_version("0.100.0") > parse_version("0.99.9"));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
    }

    /// Раскладка после двух обновлений сломанным кодом:
    /// R\Ninety.exe (старый) + R\NinetyData (настоящие данные + копия программы)
    /// + R\NinetyData\NinetyData (данные после «сброса» + ещё одна копия).
    fn nested_layout(tag: &str, origin_version: &str) -> (PathBuf, PathBuf) {
        let root = temp_root(tag);
        std::fs::write(root.join("Ninety.exe"), "old-exe").unwrap();
        std::fs::write(
            root.join("Ninety.portable"),
            format!("portable=1\r\nversion={origin_version}\r\n"),
        )
        .unwrap();
        let first = root.join("NinetyData");
        std::fs::create_dir_all(first.join("config")).unwrap();
        std::fs::create_dir_all(first.join("webview")).unwrap();
        std::fs::write(first.join("config/profile-store.v1"), "real").unwrap();
        std::fs::write(first.join("Ninety.exe"), "mid-exe").unwrap();
        std::fs::write(first.join("Ninety.portable"), "portable=1\nversion=0.16.0").unwrap();
        std::fs::write(first.join("sing-box.exe"), "mid-core").unwrap();
        std::fs::create_dir_all(first.join("dpi/lists")).unwrap();
        std::fs::write(first.join("dpi/lists/a.txt"), "list").unwrap();
        std::fs::create_dir_all(first.join(".ninety-update/0.16.0")).unwrap();
        let second = first.join("NinetyData");
        std::fs::create_dir_all(second.join("config")).unwrap();
        std::fs::write(second.join("config/profile-store.v1"), "after-reset").unwrap();
        std::fs::write(second.join("Ninety.exe"), "new-exe").unwrap();
        std::fs::write(second.join("Ninety.portable"), "portable=1\nversion=0.16.1").unwrap();
        std::fs::write(second.join("sing-box.exe"), "new-core").unwrap();
        std::fs::create_dir_all(second.join("flags")).unwrap();
        std::fs::write(second.join("flags/ru.svg"), "flag").unwrap();
        std::fs::create_dir_all(second.join("NinetyData/config")).unwrap();
        (root, second)
    }

    #[test]
    fn nested_install_is_promoted_and_user_data_is_kept() {
        let (root, nested) = nested_layout("repair", "0.15.0");
        assert_eq!(
            crate::app_paths::nested_portable_origin(&nested),
            Some(root.clone())
        );
        assert!(promote_nested(&nested, &root, "0.16.1").unwrap());
        assert_eq!(
            std::fs::read_to_string(root.join("Ninety.exe")).unwrap(),
            "new-exe"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("sing-box.exe")).unwrap(),
            "new-core"
        );
        assert!(root.join("flags/ru.svg").is_file());
        assert!(std::fs::read_to_string(root.join("Ninety.portable"))
            .unwrap()
            .contains("0.16.1"));
        // Данные из вложенной папки в программу не попали.
        assert!(!root.join("config").exists());

        cleanup_leftovers(&root);
        let report = cleanup_nested_layers(&root).unwrap();
        let data = root.join("NinetyData");
        assert_eq!(
            std::fs::read_to_string(data.join("config/profile-store.v1")).unwrap(),
            "real"
        );
        assert!(data.join("webview").is_dir());
        for name in PROGRAM_ENTRIES {
            assert!(!data.join(name).exists(), "{name} left in NinetyData");
        }
        assert!(!data.join(".ninety-update").exists());
        assert!(!data.join("NinetyData").exists());
        let recovered = root.join(report.recovered.unwrap());
        assert_eq!(
            std::fs::read_to_string(recovered.join("config/profile-store.v1")).unwrap(),
            "after-reset"
        );
        assert!(!recovered.join("Ninety.exe").exists());
        assert!(!root.join("Ninety.exe.ninety-old").exists());
        // Повторный запуск ничего не находит.
        assert_eq!(cleanup_nested_layers(&root), None);
        assert_eq!(crate::app_paths::nested_portable_origin(&root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn newer_origin_is_not_downgraded() {
        let (root, nested) = nested_layout("downgrade", "0.17.0");
        assert!(!promote_nested(&nested, &root, "0.16.1").unwrap());
        assert_eq!(
            std::fs::read_to_string(root.join("Ninety.exe")).unwrap(),
            "old-exe"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn backup_names_are_matched_exactly() {
        assert!(is_backup_name("Ninety.exe.ninety-old"));
        assert!(is_backup_name("Ninety.exe.ninety-old-3"));
        assert!(!is_backup_name("notes.ninety-old.txt"));
        assert!(!is_backup_name("x.ninety-old-"));
        assert!(!is_backup_name("x.ninety-old-2a"));
        assert!(!is_backup_name(".ninety-old"));
        assert!(is_program_backup("Ninety.exe.ninety-old-2"));
        assert!(!is_program_backup("Ninety.exe.ninety-old.txt"));
        assert!(!is_program_backup("notes.ninety-old"));
    }

    #[test]
    fn cleanup_leaves_recovered_and_user_files_alone() {
        let root = temp_root("cleanup-scope");
        std::fs::write(root.join("Ninety.exe.ninety-old"), "old").unwrap();
        std::fs::create_dir_all(root.join("dpi")).unwrap();
        std::fs::write(root.join("dpi/winws.exe.ninety-old-1"), "old").unwrap();
        let recovered = root.join("NinetyData.recovered-20261116-120000/config");
        std::fs::create_dir_all(&recovered).unwrap();
        std::fs::write(recovered.join("x.ninety-old"), "user").unwrap();
        std::fs::create_dir_all(root.join("mine")).unwrap();
        std::fs::write(root.join("mine/notes.ninety-old"), "user").unwrap();
        std::fs::write(root.join("notes.ninety-old"), "user").unwrap();
        cleanup_leftovers(&root);
        assert!(root.join("notes.ninety-old").is_file());
        assert!(!root.join("Ninety.exe.ninety-old").exists());
        assert!(!root.join("dpi/winws.exe.ninety-old-1").exists());
        assert!(recovered.join("x.ninety-old").is_file());
        assert!(root.join("mine/notes.ninety-old").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_origin_version_blocks_automatic_promotion() {
        let (root, nested) = nested_layout("noversion", "0.16.0");
        std::fs::write(root.join("Ninety.portable"), "portable=1").unwrap();
        assert!(promote_nested(&nested, &root, "0.16.1").is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("Ninety.exe")).unwrap(),
            "old-exe"
        );
        assert!(!root.join(REPAIR_DIR).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_nested_layer_is_removed_without_a_recovered_folder() {
        let root = temp_root("empty-layer");
        std::fs::write(root.join("Ninety.exe"), "exe").unwrap();
        std::fs::write(root.join("Ninety.portable"), "portable=1\nversion=0.16.1").unwrap();
        let data = root.join("NinetyData");
        std::fs::create_dir_all(data.join("config")).unwrap();
        std::fs::write(data.join("config/profile-store.v1"), "real").unwrap();
        std::fs::write(data.join("Ninety.exe"), "stray").unwrap();
        std::fs::write(data.join("Ninety.portable"), "portable=1").unwrap();
        std::fs::create_dir_all(data.join("NinetyData/config")).unwrap();
        let report = cleanup_nested_layers(&root).unwrap();
        assert_eq!(report.recovered, None);
        assert!(!data.join("NinetyData").exists());
        assert!(data.join("config/profile-store.v1").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn regular_install_needs_no_repair() {
        let root = temp_root("regular");
        std::fs::write(root.join("Ninety.exe"), "exe").unwrap();
        std::fs::write(root.join("Ninety.portable"), "portable=1").unwrap();
        std::fs::create_dir_all(root.join("NinetyData/config")).unwrap();
        std::fs::write(root.join("NinetyData/config/profile-store.v1"), "real").unwrap();
        assert_eq!(cleanup_nested_layers(&root), None);
        assert!(root.join("NinetyData/config/profile-store.v1").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rollback_restores_previous_version() {
        let root = temp_root("rollback");
        std::fs::write(root.join("Ninety.exe"), "old-exe").unwrap();
        std::fs::write(root.join("sing-box.exe"), "old-core").unwrap();
        let zip = zip_with(&[
            ("Ninety/Ninety.exe", "new-exe"),
            ("Ninety/Ninety.portable", "portable=1"),
            ("Ninety/sing-box.exe", "new-core"),
        ]);
        let staging = stage_archive(&root, "2.0.0", &zip).unwrap();
        let applied = apply_staged(&root, &staging).unwrap();
        rollback(&root, &staging, &applied);
        assert_eq!(
            std::fs::read_to_string(root.join("Ninety.exe")).unwrap(),
            "old-exe"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("sing-box.exe")).unwrap(),
            "old-core"
        );
        assert!(!root.join("Ninety.portable").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
