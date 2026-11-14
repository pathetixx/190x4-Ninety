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
    if first.eq_ignore_ascii_case(DATA_DIR) || first.eq_ignore_ascii_case(STAGING_DIR) {
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
            if top && (name.eq_ignore_ascii_case(DATA_DIR) || name == STAGING_DIR) {
                continue;
            }
            cleanup_dir(&path, false);
        } else if kind.is_file() && name.contains(OLD_MARKER) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// После обновления: убрать `*.ninety-old` и staging. Ошибки молча пропускаем —
/// занятый файл удалится на следующем запуске.
pub fn cleanup_leftovers(root: &Path) {
    let staging = root.join(STAGING_DIR);
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    cleanup_dir(root, true);
}

pub fn spawn_cleanup_after_update() {
    if !crate::app_paths::is_portable() {
        return;
    }
    let Ok(root) = crate::app_paths::portable_root() else {
        return;
    };
    std::thread::spawn(move || {
        // Прежний процесс выходит сразу после запуска нового; даём ему время,
        // чтобы его Ninety.exe.ninety-old уже можно было удалить.
        std::thread::sleep(Duration::from_secs(10));
        cleanup_leftovers(&root);
    });
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
    let root = crate::app_paths::portable_root()?;
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
    tokio::task::spawn_blocking(move || stage_archive(&root, &version, &bytes))
        .await
        .map_err(|e| format!("portable update staging was interrupted: {e}"))?
        .map(|_| ())
}

/// Ставит staged-версию и запускает новый Ninety.exe. Ok(()) значит, что новый
/// процесс уже стартовал и текущему пора выйти.
pub fn apply_and_launch(version: &str) -> Result<(), String> {
    validate_version(version)?;
    let root = crate::app_paths::portable_root()?;
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
