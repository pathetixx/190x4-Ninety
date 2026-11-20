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
// До первого переименования план замены пишется в журнал рядом с папкой
// staging. Если процесс убит или пропало питание посреди замены, следующий
// запуск сначала откатывает по журналу уже переставленные файлы и только потом
// убирает резервные копии — иначе осталась бы смесь двух версий без пути назад.
//
// Portable 0.15.0–0.16.0 по ошибке ставил обновление в NinetyData, а не в
// папку программы: новая версия запускалась из `NinetyData\Ninety.exe` и
// открывала пустое `NinetyData\NinetyData`. Обновление применяет код старой
// версии, поэтому каждое следующее уходило на уровень глубже. Исправленная
// версия, запущенная из такой копии, переносит себя в исходную папку и
// перезапускается оттуда (`repair_nested_install`), а та на старте убирает
// файлы программы из NinetyData и откладывает данные, созданные во вложенных
// копиях, в `NinetyData.recovered-*` (`cleanup_nested_layers`).

use serde::{Deserialize, Serialize};
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
/// Журнал замены файлов программы (см. `Journal`). Вне staging: staging целиком
/// чистят stage_archive и уборка.
const JOURNAL_FILE: &str = ".ninety-update.journal";
const JOURNAL_VERSION: u32 = 1;
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
/// Общий дедлайн скачивания ZIP — тот же, что фронт даёт установщику
/// (`UPDATE_DOWNLOAD_TIMEOUT_MS` в update-modal.js). Фронт передаёт его сам;
/// границы защищают от нуля и от «бесконечности».
const DOWNLOAD_TIMEOUT_MS: u64 = 15 * 60_000;
const MIN_DOWNLOAD_TIMEOUT_MS: u64 = 30_000;
const MAX_DOWNLOAD_TIMEOUT_MS: u64 = 60 * 60_000;
/// Ключ каталога для «в latest.json уже другая версия»: update-modal.js узнаёт
/// этот токен и ведёт его тем же путём, что и смену версии у установщика.
const VERSION_CHANGED_KEY: &str = "updModal.versionChanged";

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

/// Файл из плана замены: путь внутри папки программы и резервная копия, в
/// которую отодвигается прежний файл (None — прежнего файла не было).
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
    if [DATA_DIR, STAGING_DIR, REPAIR_DIR, LOCK_FILE, JOURNAL_FILE]
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
    // Staging прерванной замены — материал для её отката: сначала довести её,
    // иначе очистка ниже уничтожила бы его, а откат переставил бы старые файлы
    // поверх только что распакованных.
    finish_interrupted(root)?;
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
        // Битая ссылка с таким именем для exists() «не существует», но
        // переименованию мешает и откату показалась бы резервной копией.
        if !present(&candidate) || std::fs::remove_file(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err(format!("no free backup name for {}", target.display()))
}

/// Есть ли что-то по пути (ссылка — сама, без перехода). Любая ошибка, кроме
/// «нет такого файла», считается присутствием: откат тогда попробует
/// переименовать и честно не сможет, а не пропустит файл молча.
fn present(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Переставляет один файл плана. Оба переименования идут подряд, без другой
/// работы между ними: для Ninety.exe это окно, когда exe на месте нет.
fn apply_one(root: &Path, staging: &Path, item: &Applied) -> Result<(), String> {
    let target = root.join(&item.rel);
    let staged = staging.join(&item.rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    }
    if let Some(old) = &item.old {
        if item.rel == Path::new(PORTABLE_MARKER) {
            // Без маркера Ninety стартует как установленная версия и до отката
            // по журналу не доходит. Маркер никто не держит открытым, поэтому
            // резервная копия — копированием, а ниже он заменяется атомарно:
            // маркер не пропадает ни на миг. Откату всё равно, копия это или
            // перенос: в резервной копии в обоих случаях прежнее содержимое.
            std::fs::copy(&target, old)
                .map_err(|e| format!("back up {}: {e}", item.rel.display()))?;
        } else {
            std::fs::rename(&target, old)
                .map_err(|e| format!("{} is in use: {e}", item.rel.display()))?;
        }
    }
    if let Err(e) = std::fs::rename(&staged, &target) {
        if let Some(old) = &item.old {
            let _ = std::fs::rename(old, &target);
        }
        return Err(format!("replace {}: {e}", item.rel.display()));
    }
    Ok(())
}

/// Файл уже стоит в новой версии: сделаны оба переименования. У маркера
/// резервная копия появляется раньше замены, но он и не последний в плане:
/// «заменено всё» требует Ninety.exe, а тот ставится после маркера.
fn is_applied(root: &Path, item: &Applied) -> bool {
    present(&root.join(&item.rel)) && item.old.as_deref().is_none_or(present)
}

/// Отодвигает новый файл обратно в staging. true — на месте его больше нет.
fn move_to_staging(root: &Path, staging: &Path, rel: &Path) -> bool {
    let target = root.join(rel);
    if !present(&target) {
        return true;
    }
    let staged = staging.join(rel);
    if let Some(parent) = staged.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::rename(&target, &staged).is_ok()
}

/// Возвращает один файл на прежнюю версию. Повторный вызов безопасен: если
/// резервной копии уже нет (замена этого файла не начиналась или уже
/// откачена), файл не трогается. true — замены этого файла на диске больше нет.
fn rollback_one(root: &Path, staging: &Path, item: &Applied) -> bool {
    let Some(old) = &item.old else {
        return move_to_staging(root, staging, &item.rel);
    };
    if !present(old) {
        return true;
    }
    // Прежний файл встаёт поверх нового одним переименованием: ни мгновения
    // без файла на месте (без маркера Ninety не узнал бы себя portable на
    // следующем старте). Занятый новый файл так не заменить — его сначала
    // отодвигаем в staging.
    let target = root.join(&item.rel);
    std::fs::rename(old, &target).is_ok()
        || (move_to_staging(root, staging, &item.rel) && std::fs::rename(old, &target).is_ok())
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

/// Возвращает файлы плана на прежнюю версию в обратном порядке. Журнал сперва
/// переводится в «откат»: оборвись откат — следующий старт доведёт его, а не
/// примет замену за завершённую. Файлы, замена которых не начиналась,
/// пропускаются, поэтому передавать можно весь план. true — откат полный и
/// журнала больше нет; false — часть файлов вернуть не удалось, журнал и
/// резервные копии остаются для следующей попытки.
pub fn rollback(root: &Path, staging: &Path, applied: &[Applied]) -> bool {
    // Без отметки «откат» оборванный откат выглядел бы для следующего старта
    // как завершённая замена, и уборка удалила бы последние резервные копии.
    // Не записалась — файлы не трогаем: журнал, staging и копии остаются.
    if let Err(error) = write_journal(root, staging, JournalState::RollingBack, applied) {
        eprintln!("portable update: {error}");
        return false;
    }
    let mut restored = true;
    for item in applied.iter().rev() {
        restored &= rollback_one(root, staging, item);
    }
    restored && remove_journal(root)
}

/// План замены: файлы staging (Ninety.exe — последним) и имена их резервных
/// копий. Всё проверяется и выбирается до первого переименования: журнал
/// получает план целиком, а между переименованиями Ninety.exe нет лишней работы.
fn plan_replacement(root: &Path, staging: &Path) -> Result<Vec<Applied>, String> {
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
    let mut plan = Vec::with_capacity(files.len());
    for rel in files {
        let target = root.join(&rel);
        let old = if present(&target) {
            Some(old_path_for(&target)?)
        } else {
            None
        };
        plan.push(Applied { rel, old });
    }
    Ok(plan)
}

/// Журнал замены файлов программы. План целиком (пути и имена резервных
/// копий) пишется до первого переименования, поэтому дописывать его после
/// каждого файла не нужно: докуда дошла замена, видно по самим файлам —
/// резервная копия появляется только в apply_one, а её имя выбрано свободным
/// заранее.
#[derive(Serialize, Deserialize)]
struct Journal {
    version: u32,
    state: JournalState,
    /// Staging относительно папки программы, через `/`.
    staging: String,
    files: Vec<JournalEntry>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum JournalState {
    /// Идёт замена. Оборвалась на полпути — старт откатит её.
    Applying,
    /// Заменены все файлы, осталась уборка.
    Complete,
    /// Начат откат (замена упала или новый exe не стартовал) — старт доведёт.
    RollingBack,
}

#[derive(Serialize, Deserialize)]
struct JournalEntry {
    /// Путь файла в папке программы, через `/`.
    rel: String,
    /// Имя резервной копии рядом с файлом; None — файла раньше не было.
    old: Option<String>,
}

/// Относительный путь для журнала: только обычные компоненты, через `/`.
fn journal_rel(path: &Path) -> Option<String> {
    let parts = path
        .components()
        .map(|component| match component {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn write_journal(
    root: &Path,
    staging: &Path,
    state: JournalState,
    plan: &[Applied],
) -> Result<(), String> {
    let staging = staging
        .strip_prefix(root)
        .ok()
        .and_then(journal_rel)
        .ok_or("update staging is outside the program folder")?;
    let mut files = Vec::with_capacity(plan.len());
    for item in plan {
        let rel = journal_rel(&item.rel).ok_or("update path is not valid Unicode")?;
        let old = match &item.old {
            Some(old) => Some(
                old.file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("update backup name is not valid Unicode")?
                    .to_owned(),
            ),
            None => None,
        };
        files.push(JournalEntry { rel, old });
    }
    let journal = Journal {
        version: JOURNAL_VERSION,
        state,
        staging,
        files,
    };
    let body = serde_json::to_vec(&journal).map_err(|e| format!("encode update journal: {e}"))?;
    crate::atomic_file::write_bytes_replace(&root.join(JOURNAL_FILE), &body, "update journal")
}

/// Журнал, прочитанный с диска, с путями, проверенными так же строго, как
/// пути из архива: по нему переименовываются файлы.
struct LoadedJournal {
    state: JournalState,
    staging: PathBuf,
    plan: Vec<Applied>,
}

fn parse_journal(root: &Path, raw: &[u8]) -> Option<LoadedJournal> {
    let journal: Journal = serde_json::from_slice(raw).ok()?;
    if journal.version != JOURNAL_VERSION {
        return None;
    }
    let staging: PathBuf = journal.staging.split('/').collect();
    let staging_ok = staging.components().count() <= 2
        && staging
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && first_component(&staging).is_some_and(|first| {
            first == std::ffi::OsStr::new(STAGING_DIR) || first == std::ffi::OsStr::new(REPAIR_DIR)
        });
    if !staging_ok {
        return None;
    }
    let mut plan = Vec::with_capacity(journal.files.len());
    for entry in journal.files {
        let rel: PathBuf = entry.rel.split('/').collect();
        if !safe_program_path(&rel) {
            return None;
        }
        let old = match entry.old {
            Some(name) => {
                // Только `<имя файла>.ninety-old[-N]` рядом с самим файлом.
                let own = rel.file_name()?.to_str()?;
                let backup = name
                    .strip_prefix(own)
                    .is_some_and(|tail| tail.starts_with(OLD_MARKER))
                    && is_backup_name(&name);
                if !backup {
                    return None;
                }
                Some(root.join(&rel).with_file_name(name))
            }
            None => None,
        };
        plan.push(Applied { rel, old });
    }
    Some(LoadedJournal {
        state: journal.state,
        staging: root.join(staging),
        plan,
    })
}

/// Убирает журнал. true — его больше нет.
fn remove_journal(root: &Path) -> bool {
    match std::fs::remove_file(root.join(JOURNAL_FILE)) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Временный файл атомарной записи журнала, оставшийся после обрыва
/// (`..ninety-update.journal.<pid>.<n>.tmp`, см. atomic_file).
fn is_journal_temp(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|rest| rest.strip_prefix(JOURNAL_FILE))
        .is_some_and(|rest| rest.starts_with('.') && rest.ends_with(".tmp"))
}

/// Доводит замену, оборванную на прошлом запуске (убитый процесс, питание):
/// по журналу либо признаёт её завершённой, либо откатывает. Ok — журнала
/// больше нет, и `*.ninety-old`/staging можно убирать. Err — откатить не
/// вышло (файл занят): журнал, резервные копии и staging остаются до
/// следующей попытки. Вызывается под UpdateLock.
fn finish_interrupted(root: &Path) -> Result<(), String> {
    let raw = match std::fs::read(root.join(JOURNAL_FILE)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read update journal: {error}")),
    };
    let Some(journal) = parse_journal(root, &raw) else {
        // Журнал пишется атомарно, так что испорченный — чужая правка; откатить
        // по нему нечего, дальше уборка как без журнала.
        eprintln!("portable update: ignoring invalid update journal");
        return if remove_journal(root) {
            Ok(())
        } else {
            Err("remove invalid update journal".into())
        };
    };
    // Обе перестановки сделаны для каждого файла — замена дошла до конца, просто
    // не успела отметить это в журнале: откат здесь сломал бы новую версию.
    let finished = journal.state == JournalState::Complete
        || (journal.state == JournalState::Applying
            && journal.plan.iter().all(|item| is_applied(root, item)));
    let settled = if finished {
        remove_journal(root)
    } else {
        rollback(root, &journal.staging, &journal.plan)
    };
    if settled {
        Ok(())
    } else {
        Err("interrupted portable update is not rolled back yet".into())
    }
}

/// Ставит staging на место программы. При ошибке всё уже сделанное откатывается
/// и возвращается Err; при успехе — план для отката, если не стартует новый exe.
pub fn apply_staged(root: &Path, staging: &Path) -> Result<Vec<Applied>, String> {
    // Резервные копии прерванной замены — единственный путь назад: сначала
    // довести её, иначе old_path_for удалил бы их как устаревшие.
    finish_interrupted(root)?;
    let plan = plan_replacement(root, staging)?;
    // Журнал — до первого переименования: оборвись замена, следующий старт
    // откатит её по нему.
    write_journal(root, staging, JournalState::Applying, &plan)?;
    for item in &plan {
        if let Err(error) = apply_one(root, staging, item) {
            rollback(root, staging, &plan);
            return Err(error);
        }
    }
    // Не записалась отметка — не беда: старт увидит, что заменены все файлы.
    if let Err(error) = write_journal(root, staging, JournalState::Complete, &plan) {
        eprintln!("portable update: {error}");
    }
    Ok(plan)
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
        } else if kind.is_file()
            && ((is_backup_name(&name) && (!top || is_program_backup(&name)))
                || (top && is_journal_temp(&name)))
        {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// После обновления: убрать `*.ninety-old` и staging. Ошибки молча пропускаем —
/// занятый файл удалится на следующем запуске. Прерванная замена сначала
/// откатывается по журналу: её резервные копии и staging — материал для отката,
/// и пока откат не удался, ничего не удаляется.
pub fn cleanup_leftovers(root: &Path) {
    if let Err(error) = finish_interrupted(root) {
        eprintln!("portable update: {error}");
        return;
    }
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
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    let stamp = now
        .format(time::macros::format_description!(
            "[year][month][day]-[hour][minute][second]"
        ))
        .unwrap_or_default();
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
    // Как и у обновления: прерванную замену довести до сборки нового staging.
    if let Err(error) = finish_interrupted(&origin) {
        eprintln!("portable repair: {error}");
        return false;
    }
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

/// Дедлайн скачивания: от фронта (`timeoutMs`) или по умолчанию, в границах.
fn download_deadline(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(DOWNLOAD_TIMEOUT_MS)
            .clamp(MIN_DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_TIMEOUT_MS),
    )
}

/// Скачивает ZIP через updater-плагин (подпись проверяется им же) и
/// распаковывает в staging. Ничего из работающей программы не трогает.
#[tauri::command]
pub async fn portable_update_download(
    app: tauri::AppHandle,
    expected_version: String,
    proxy: Option<String>,
    timeout_ms: Option<u64>,
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
        // Пользователь подтверждал другую версию: фронт покажет новую и
        // попросит нажать «Обновить» ещё раз.
        return Err(crate::util::i18n_error_with(
            VERSION_CHANGED_KEY,
            &[("version", update.version.as_str())],
        ));
    }
    let progress = on_event.clone();
    let mut started = false;
    let download = update.download(
        move |chunk_length, content_length| {
            if !started {
                started = true;
                let _ = progress.send(PortableUpdateEvent::Started { content_length });
            }
            let _ = progress.send(PortableUpdateEvent::Progress { chunk_length });
        },
        || {},
    );
    // Таймаут builder'а действует только на проверку: плагин отдаёт Update с
    // `timeout: None`, и зависшее скачивание держало бы модалку обновления
    // заблокированной без конца. Общий дедлайн обрывает его вместе с запросом.
    let bytes = tokio::time::timeout(download_deadline(timeout_ms), download)
        .await
        .map_err(|_| crate::util::i18n_error("backend.diag.timeout"))?
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
        assert!(root.join(JOURNAL_FILE).is_file());

        cleanup_leftovers(&root);
        assert!(!root.join("Ninety.exe.ninety-old").exists());
        assert!(!root.join(STAGING_DIR).exists());
        assert!(!root.join(JOURNAL_FILE).exists());
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
        assert!(rollback(&root, &staging, &applied));
        assert_eq!(
            std::fs::read_to_string(root.join("Ninety.exe")).unwrap(),
            "old-exe"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("sing-box.exe")).unwrap(),
            "old-core"
        );
        assert!(!root.join("Ninety.portable").exists());
        assert!(!root.join(JOURNAL_FILE).exists());
        // Повторный откат ничего не ломает: копий уже нет, файлы не трогаются.
        assert!(rollback(&root, &staging, &applied));
        assert_eq!(
            std::fs::read_to_string(root.join("Ninety.exe")).unwrap(),
            "old-exe"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Старая версия (exe, маркер, ядро, файл в dpi) и staged новая: в новой
    /// другой файл в dpi и флаг, которых раньше не было.
    fn staged_update(tag: &str) -> (PathBuf, PathBuf) {
        let root = temp_root(tag);
        std::fs::write(root.join("Ninety.exe"), "old-exe").unwrap();
        std::fs::write(root.join("Ninety.portable"), "portable=old").unwrap();
        std::fs::write(root.join("sing-box.exe"), "old-core").unwrap();
        std::fs::create_dir_all(root.join("dpi")).unwrap();
        std::fs::write(root.join("dpi/old.txt"), "old-list").unwrap();
        std::fs::create_dir_all(root.join("NinetyData")).unwrap();
        std::fs::write(root.join("NinetyData/profile"), "mine").unwrap();
        let zip = zip_with(&[
            ("Ninety/Ninety.exe", "new-exe"),
            ("Ninety/Ninety.portable", "portable=new"),
            ("Ninety/sing-box.exe", "new-core"),
            ("Ninety/dpi/new.txt", "new-list"),
            ("Ninety/flags/ru.svg", "flag"),
        ]);
        let staging = stage_archive(&root, "2.0.0", &zip).unwrap();
        (root, staging)
    }

    fn item<'a>(plan: &'a [Applied], rel: &str) -> &'a Applied {
        plan.iter().find(|item| item.rel == Path::new(rel)).unwrap()
    }

    fn read(root: &Path, rel: &str) -> String {
        std::fs::read_to_string(root.join(rel)).unwrap()
    }

    #[test]
    fn interrupted_replacement_is_rolled_back_on_start() {
        let (root, staging) = staged_update("interrupted");
        let plan = plan_replacement(&root, &staging).unwrap();
        assert_eq!(plan.last().unwrap().rel, Path::new(MAIN_EXE));
        write_journal(&root, &staging, JournalState::Applying, &plan).unwrap();
        // Процесс оборвался посреди замены: ядро, маркер и dpi/new.txt уже
        // новые, флаг ещё не ставился, а Ninety.exe успел отодвинуться в
        // резервную копию, но новый на его место не встал. Откат не зависит от
        // порядка — здесь проверяются все состояния файла разом.
        apply_one(&root, &staging, item(&plan, "sing-box.exe")).unwrap();
        apply_one(&root, &staging, item(&plan, "dpi/new.txt")).unwrap();
        apply_one(&root, &staging, item(&plan, PORTABLE_MARKER)).unwrap();
        // Маркер заменён без промежутка: старый — в копии, новый — на месте.
        assert_eq!(read(&root, "Ninety.portable"), "portable=new");
        assert_eq!(read(&root, "Ninety.portable.ninety-old"), "portable=old");
        let exe = item(&plan, MAIN_EXE);
        std::fs::rename(root.join(MAIN_EXE), exe.old.as_ref().unwrap()).unwrap();
        assert!(!root.join(MAIN_EXE).exists());

        cleanup_leftovers(&root);
        assert_eq!(read(&root, "Ninety.exe"), "old-exe");
        assert_eq!(read(&root, "Ninety.portable"), "portable=old");
        assert_eq!(read(&root, "sing-box.exe"), "old-core");
        assert_eq!(read(&root, "dpi/old.txt"), "old-list");
        assert!(!root.join("dpi/new.txt").exists());
        assert!(!root.join("flags/ru.svg").exists());
        assert!(!root.join("Ninety.exe.ninety-old").exists());
        assert!(!root.join("Ninety.portable.ninety-old").exists());
        assert!(!root.join("sing-box.exe.ninety-old").exists());
        assert!(!root.join(STAGING_DIR).exists());
        assert!(!root.join(JOURNAL_FILE).exists());
        assert_eq!(read(&root, "NinetyData/profile"), "mine");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn complete_journal_leads_to_plain_cleanup() {
        let (root, staging) = staged_update("complete");
        apply_staged(&root, &staging).unwrap();
        let journal =
            parse_journal(&root, &std::fs::read(root.join(JOURNAL_FILE)).unwrap()).unwrap();
        assert_eq!(journal.state, JournalState::Complete);

        cleanup_leftovers(&root);
        assert_eq!(read(&root, "Ninety.exe"), "new-exe");
        assert_eq!(read(&root, "sing-box.exe"), "new-core");
        assert_eq!(read(&root, "dpi/new.txt"), "new-list");
        assert_eq!(read(&root, "Ninety.portable"), "portable=new");
        assert!(!root.join("Ninety.exe.ninety-old").exists());
        assert!(!root.join("Ninety.portable.ninety-old").exists());
        assert!(!root.join("sing-box.exe.ninety-old").exists());
        assert!(!root.join(STAGING_DIR).exists());
        assert!(!root.join(JOURNAL_FILE).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fully_applied_replacement_without_mark_keeps_new_version() {
        let (root, staging) = staged_update("unmarked");
        let plan = plan_replacement(&root, &staging).unwrap();
        write_journal(&root, &staging, JournalState::Applying, &plan).unwrap();
        // Все файлы переставлены, но отметка «complete» не успела записаться.
        for item in &plan {
            apply_one(&root, &staging, item).unwrap();
        }

        cleanup_leftovers(&root);
        assert_eq!(read(&root, "Ninety.exe"), "new-exe");
        assert_eq!(read(&root, "sing-box.exe"), "new-core");
        assert!(root.join("Ninety.portable").is_file());
        assert!(!root.join("Ninety.exe.ninety-old").exists());
        assert!(!root.join(JOURNAL_FILE).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn interrupted_rollback_is_finished_on_start() {
        let (root, staging) = staged_update("rolling-back");
        let plan = apply_staged(&root, &staging).unwrap();
        // Новый exe не стартовал, и откат оборвался после первого файла.
        write_journal(&root, &staging, JournalState::RollingBack, &plan).unwrap();
        assert!(rollback_one(&root, &staging, plan.last().unwrap()));
        assert_eq!(read(&root, "Ninety.exe"), "old-exe");

        cleanup_leftovers(&root);
        assert_eq!(read(&root, "Ninety.exe"), "old-exe");
        assert_eq!(read(&root, "Ninety.portable"), "portable=old");
        assert_eq!(read(&root, "sing-box.exe"), "old-core");
        assert!(!root.join("flags/ru.svg").exists());
        assert!(!root.join(JOURNAL_FILE).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn journal_paths_are_validated() {
        let root = temp_root("journal-paths");
        let parse = |json: &str| parse_journal(&root, json.as_bytes());
        let ok = r#"{"version":1,"state":"applying","staging":".ninety-update/2.0.0","files":[{"rel":"dpi/a.txt","old":"a.txt.ninety-old-2"},{"rel":"Ninety.exe","old":null}]}"#;
        let journal = parse(ok).unwrap();
        assert_eq!(journal.staging, root.join(".ninety-update").join("2.0.0"));
        assert_eq!(
            journal.plan[0].old.as_deref(),
            Some(root.join("dpi").join("a.txt.ninety-old-2").as_path())
        );
        for bad in [
            ok.replace("dpi/a.txt\"", "../a.txt\""),
            ok.replace("dpi/a.txt\"", "NinetyData/a.txt\""),
            ok.replace("a.txt.ninety-old-2", "../../evil.ninety-old"),
            ok.replace("a.txt.ninety-old-2", "b.txt.ninety-old"),
            ok.replace(".ninety-update/2.0.0", "NinetyData"),
            ok.replace(".ninety-update/2.0.0", ".ninety-update/../.."),
            ok.replace("\"version\":1", "\"version\":2"),
        ] {
            assert!(parse(bad.as_str()).is_none(), "{bad}");
        }
        // Испорченный журнал не мешает уборке: его просто убирают.
        std::fs::write(root.join(JOURNAL_FILE), "{broken").unwrap();
        std::fs::write(root.join("Ninety.exe.ninety-old"), "old").unwrap();
        cleanup_leftovers(&root);
        assert!(!root.join(JOURNAL_FILE).exists());
        assert!(!root.join("Ninety.exe.ninety-old").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn journal_temp_files_are_recognized() {
        assert!(is_journal_temp("..ninety-update.journal.1234.0.tmp"));
        assert!(!is_journal_temp(".ninety-update.journal"));
        assert!(!is_journal_temp("..ninety-update.journalx.tmp"));
        assert!(!is_journal_temp("notes.tmp"));
    }

    #[test]
    fn download_deadline_matches_the_installer_and_is_bounded() {
        assert_eq!(download_deadline(None), Duration::from_millis(15 * 60_000));
        assert_eq!(
            download_deadline(Some(15 * 60_000)),
            download_deadline(None)
        );
        assert_eq!(download_deadline(Some(0)), Duration::from_millis(30_000));
        assert_eq!(
            download_deadline(Some(u64::MAX)),
            Duration::from_millis(60 * 60_000)
        );
    }
}
