// Ninety · one-click Full Portable update.
//
// The installed build is updated by the NSIS installer through the updater plugin, while
// the unpacked copy used to only open the release page: download the ZIP,
// close Ninety, unpack over it, start again — by hand.
//
// Now the updater plugin with a separate `windows-x86_64-portable` target downloads the ZIP
// and verifies its minisign signature with the same key as the installer (the target
// entry in latest.json is added by build.yml). The archive is unpacked into staging
// inside the program folder — the same volume, so the replacement is done by renaming.
// After the engines stop, every program file is moved aside to `*.ninety-old`
// (Windows allows renaming even a running exe), and the new one takes its place;
// any error rolls back what has already been done. Then the new
// Ninety.exe starts, and this process exits. The next launch cleans up
// `*.ninety-old` and staging. NinetyData is not in the archive and is not touched.
//
// Before the first rename, the replacement plan is written to a journal next to the
// staging folder. If the process is killed or power is lost mid-replacement, the next
// launch first rolls back the already swapped files according to the journal and only then
// removes the backups — otherwise a mix of two versions would remain with no way back.
//
// Portable 0.15.0–0.16.0 mistakenly installed updates into NinetyData instead of
// the program folder: the new version started from `NinetyData\Ninety.exe` and
// opened an empty `NinetyData\NinetyData`. The update is applied by the old version's code,
// so every following one went one level deeper. The fixed
// version, started from such a copy, moves itself to the original folder and
// restarts from there (`repair_nested_install`), and that one at startup removes
// the program files from NinetyData and sets aside data created in nested
// copies into `NinetyData.recovered-*` (`cleanup_nested_layers`).

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
/// Program file replacement journal (see `Journal`). Outside staging: staging is wiped
/// entirely by stage_archive and the cleanup.
const JOURNAL_FILE: &str = ".ninety-update.journal";
const JOURNAL_VERSION: u32 = 1;
/// The top level of Full Portable — everything that
/// scripts/package-portable.ps1 puts there (checked by a test). Only these names are moved by the repair
/// from a nested copy and removed from NinetyData: next to them there
/// lie the user's config/data/logs/webview.
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
/// Overall ZIP download deadline — the same the frontend gives the installer
/// (`UPDATE_DOWNLOAD_TIMEOUT_MS` in update-modal.js). The frontend passes it itself;
/// the bounds protect against zero and "infinity".
const DOWNLOAD_TIMEOUT_MS: u64 = 15 * 60_000;
const MIN_DOWNLOAD_TIMEOUT_MS: u64 = 30_000;
const MAX_DOWNLOAD_TIMEOUT_MS: u64 = 60 * 60_000;
/// Catalog key for "latest.json already has a different version": update-modal.js recognizes
/// this token and handles it the same way as a version change for the installer.
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

/// A file from the replacement plan: the path inside the program folder and the backup to
/// which the previous file is moved aside (None — there was no previous file).
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

/// Program file path inside the archive: only regular components, no user
/// data, staging or our `*.ninety-old`.
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

/// The archive is built from the `Ninety\` folder: if all files are under one common
/// top-level folder, it is stripped.
fn common_root(paths: &[PathBuf]) -> Option<PathBuf> {
    let first = first_component(paths.first()?)?;
    let shared = paths
        .iter()
        .all(|p| p.components().count() > 1 && first_component(p) == Some(first));
    shared.then(|| PathBuf::from(first))
}

/// Unpacks the signed (already verified by the plugin) ZIP into staging.
pub fn stage_archive(root: &Path, version: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    validate_version(version)?;
    // The staging of an interrupted replacement is material for rolling it back: finish it first,
    // otherwise the cleanup below would destroy it, and the rollback would put old files
    // over the freshly unpacked ones.
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
    // A previous `*.ninety-old` may still be locked (the old process is still alive):
    // then we take the next free name instead of failing.
    for n in 0..10 {
        let candidate = if n == 0 {
            target.with_file_name(format!("{name}{OLD_MARKER}"))
        } else {
            target.with_file_name(format!("{name}{OLD_MARKER}-{n}"))
        };
        // A broken link with this name "doesn't exist" for exists(), but
        // it gets in the way of renaming and would look like a backup to the rollback.
        if !present(&candidate) || std::fs::remove_file(&candidate).is_ok() {
            return Ok(candidate);
        }
    }
    Err(format!("no free backup name for {}", target.display()))
}

/// Whether something is at the path (a link itself, without following it). Any error other than
/// "no such file" counts as presence: the rollback will then try to
/// rename and honestly fail, rather than silently skip the file.
fn present(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Swaps one plan file. Both renames go back to back, with no other
/// work between them: for Ninety.exe this is the window when the exe isn't in place.
fn apply_one(root: &Path, staging: &Path, item: &Applied) -> Result<(), String> {
    let target = root.join(&item.rel);
    let staged = staging.join(&item.rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
    }
    if let Some(old) = &item.old {
        if item.rel == Path::new(PORTABLE_MARKER) {
            // Without the marker Ninety starts as the installed version and never gets to
            // the journal rollback. Nobody keeps the marker open, so
            // the backup is made by copying, and below it is replaced atomically:
            // the marker never disappears even for an instant. The rollback doesn't care whether it's a copy or
            // a move: in both cases the backup holds the previous contents.
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

/// The file is already at the new version: both renames are done. The marker's
/// backup appears before the replacement, but it isn't last in the plan either:
/// "everything replaced" requires Ninety.exe, and that one is installed after the marker.
fn is_applied(root: &Path, item: &Applied) -> bool {
    present(&root.join(&item.rel)) && item.old.as_deref().is_none_or(present)
}

/// Moves the new file back into staging. true — it is no longer in place.
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

/// Returns one file to the previous version. Calling it again is safe: if
/// the backup is already gone (replacement of this file didn't start or has already been
/// rolled back), the file isn't touched. true — this file's replacement is no longer on disk.
fn rollback_one(root: &Path, staging: &Path, item: &Applied) -> bool {
    let Some(old) = &item.old else {
        return move_to_staging(root, staging, &item.rel);
    };
    if !present(old) {
        return true;
    }
    // The previous file goes over the new one with a single rename: not a moment
    // without a file in place (without the marker Ninety wouldn't recognize itself as portable on
    // the next start). A locked new file can't be replaced this way — it is first
    // moved aside into staging.
    let target = root.join(&item.rel);
    std::fs::rename(old, &target).is_ok()
        || (move_to_staging(root, staging, &item.rel) && std::fs::rename(old, &target).is_ok())
}

/// Whether there is a link among the already existing components of the path `root\rel`.
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

/// Returns the plan's files to the previous version in reverse order. The journal is first
/// switched to "rollback": if the rollback breaks off, the next start finishes it rather than
/// taking the replacement as completed. Files whose replacement didn't start
/// are skipped, so the whole plan can be passed. true — the rollback is complete and
/// the journal is gone; false — some files couldn't be restored, the journal and
/// backups stay for the next attempt.
pub fn rollback(root: &Path, staging: &Path, applied: &[Applied]) -> bool {
    // Without the "rollback" mark, an interrupted rollback would look to the next start
    // like a completed replacement, and the cleanup would delete the last backups.
    // If it didn't get written, we don't touch the files: the journal, staging and copies remain.
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

/// Replacement plan: staging files (Ninety.exe last) and the names of their
/// backups. Everything is checked and chosen before the first rename: the journal
/// gets the whole plan, and there is no extra work between the Ninety.exe renames.
fn plan_replacement(root: &Path, staging: &Path) -> Result<Vec<Applied>, String> {
    let mut files = Vec::new();
    list_files(staging, staging, &mut files)?;
    if !files.iter().any(|f| f == Path::new(MAIN_EXE)) {
        return Err("staged portable update has no Ninety.exe".into());
    }
    if let Some(bad) = files.iter().find(|f| !safe_program_path(f)) {
        return Err(format!("unexpected staged path: {}", bad.display()));
    }
    // A link or junction on the destination path would lead the replacement into foreign files
    // (e.g. `flags` → NinetyData\config). We check everything before the first replacement.
    if let Some(bad) = files.iter().find(|f| target_crosses_link(root, f)) {
        return Err(format!("link on update path: {}", bad.display()));
    }
    // Ninety.exe goes last: until it is replaced, the previous version is intact and
    // starts, even if the process breaks off mid-replacement.
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

/// Program file replacement journal. The whole plan (paths and backup
/// names) is written before the first rename, so it doesn't need to be appended after
/// every file: how far the replacement got is visible from the files themselves —
/// a backup appears only in apply_one, and its name is chosen as free
/// in advance.
#[derive(Serialize, Deserialize)]
struct Journal {
    version: u32,
    state: JournalState,
    /// Staging relative to the program folder, with `/`.
    staging: String,
    files: Vec<JournalEntry>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum JournalState {
    /// Replacement in progress. If it broke off halfway, the start will roll it back.
    Applying,
    /// All files replaced, only the cleanup is left.
    Complete,
    /// Rollback started (the replacement failed or the new exe didn't start) — the start will finish it.
    RollingBack,
}

#[derive(Serialize, Deserialize)]
struct JournalEntry {
    /// File path in the program folder, with `/`.
    rel: String,
    /// Backup name next to the file; None — the file didn't exist before.
    old: Option<String>,
}

/// Relative path for the journal: only regular components, with `/`.
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

/// A journal read from disk, with paths validated as strictly as
/// paths from the archive: files are renamed based on it.
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
                // Only `<file name>.ninety-old[-N]` next to the file itself.
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

/// Removes the journal. true — it is gone.
fn remove_journal(root: &Path) -> bool {
    match std::fs::remove_file(root.join(JOURNAL_FILE)) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Temporary file of the atomic journal write left behind after a break
/// (`..ninety-update.journal.<pid>.<n>.tmp`, see atomic_file).
fn is_journal_temp(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|rest| rest.strip_prefix(JOURNAL_FILE))
        .is_some_and(|rest| rest.starts_with('.') && rest.ends_with(".tmp"))
}

/// Finishes a replacement interrupted on the previous launch (killed process, power loss):
/// based on the journal it either accepts it as completed or rolls it back. Ok — the journal
/// is gone, and `*.ninety-old`/staging can be cleaned up. Err — the rollback
/// failed (a file is locked): the journal, backups and staging stay until
/// the next attempt. Called under UpdateLock.
fn finish_interrupted(root: &Path) -> Result<(), String> {
    let raw = match std::fs::read(root.join(JOURNAL_FILE)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read update journal: {error}")),
    };
    let Some(journal) = parse_journal(root, &raw) else {
        // The journal is written atomically, so a corrupted one is someone else's edit; there is nothing
        // to roll back based on it, the cleanup continues as without a journal.
        eprintln!("portable update: ignoring invalid update journal");
        return if remove_journal(root) {
            Ok(())
        } else {
            Err("remove invalid update journal".into())
        };
    };
    // Both swaps are done for every file — the replacement reached the end, it just
    // didn't get to mark that in the journal: a rollback here would break the new version.
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

/// Puts staging in place of the program. On error everything already done is rolled back
/// and Err is returned; on success — a plan for rolling back if the new exe doesn't start.
pub fn apply_staged(root: &Path, staging: &Path) -> Result<Vec<Applied>, String> {
    // The backups of an interrupted replacement are the only way back: finish
    // it first, otherwise old_path_for would delete them as outdated.
    finish_interrupted(root)?;
    let plan = plan_replacement(root, staging)?;
    // The journal comes before the first rename: if the replacement breaks off, the next start
    // rolls it back based on it.
    write_journal(root, staging, JournalState::Applying, &plan)?;
    for item in &plan {
        if let Err(error) = apply_one(root, staging, item) {
            rollback(root, staging, &plan);
            return Err(error);
        }
    }
    // If the mark didn't get written, no big deal: the start will see that all files are replaced.
    if let Err(error) = write_journal(root, staging, JournalState::Complete, &plan) {
        eprintln!("portable update: {error}");
    }
    Ok(plan)
}

/// The backup left by `old_path_for`: `name.ninety-old` or
/// `name.ninety-old-N`. A substring isn't enough: a user file may have such a name.
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

/// Backup of a top-level program file (`Ninety.exe.ninety-old`).
fn is_program_backup(name: &str) -> bool {
    is_backup_name(name)
        && name.rfind(OLD_MARKER).is_some_and(|at| {
            PROGRAM_ENTRIES
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case(&name[..at]))
        })
}

/// Deletes `*.ninety-old` in the program folder: at the top level and inside
/// program directories (dpi, flags). Doesn't go into NinetyData, recovered or other foreign
/// directories, doesn't follow links.
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

/// After an update: remove `*.ninety-old` and staging. Errors are silently skipped —
/// a locked file will be deleted on the next launch. An interrupted replacement is first
/// rolled back based on the journal: its backups and staging are material for the rollback,
/// and nothing is deleted until the rollback succeeds.
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

/// Inter-process lock of the program folder for the duration of the update, repair and
/// cleanup: the repair runs before single-instance, and without it another process's cleanup
/// could delete staging or backups mid-replacement.
/// The file is opened without sharing and released with the process.
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

/// What the repair did on this launch: the frontend reports it once.
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
pub struct RepairReport {
    /// The folder with data entered in nested copies, if there were any.
    pub recovered: Option<String>,
}

fn repair_report_slot() -> &'static std::sync::Mutex<Option<RepairReport>> {
    static SLOT: std::sync::OnceLock<std::sync::Mutex<Option<RepairReport>>> =
        std::sync::OnceLock::new();
    SLOT.get_or_init(|| std::sync::Mutex::new(None))
}

/// The repair report is given out once: a repeated call returns None.
#[tauri::command]
pub fn portable_repair_report() -> Option<RepairReport> {
    repair_report_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

/// Cleanup at portable build startup. Called from setup(), i.e. after
/// single-instance, and under the folder lock — synchronously, before the frontend
/// gets a chance to start a new download into staging.
pub fn cleanup_on_start() {
    let Ok(root) = crate::app_paths::portable_app_dir() else {
        return;
    };
    if crate::app_paths::nested_portable_origin(&root).is_some() {
        // The repair failed: the cleanup here would delete the running copy's files.
        return;
    }
    let Ok(_lock) = try_update_lock(&root) else {
        return;
    };
    cleanup_leftovers(&root);
    let report = cleanup_nested_layers(&root);
    // Every launch, not only after a repair: a one-off registry write error
    // would otherwise leave the scheme pointing at the deleted nested exe forever.
    crate::url_handler::refresh_owned_handlers(&root.join(DATA_DIR));
    if let Some(report) = report {
        *repair_report_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(report);
    }
}

/// Deletes a file, directory or link (the link itself, without going inside). true — the path
/// is gone.
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

/// Removes program files that the broken update put into the NinetyData level.
/// The marker goes only when everything else has been deleted: as long as
/// it exists, the level is recognized again, and an interrupted cleanup continues.
/// true — the level is clean.
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

/// Whether the directory has files. A read error is Err: such a directory isn't deleted.
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

/// Repairs NinetyData after a broken update: removes program files from
/// all nested levels and moves `NinetyData\NinetyData` (data entered
/// after the "reset") into `NinetyData.recovered-*` next to the program. The real
/// data in NinetyData stays primary; what was moved out isn't merged automatically and isn't
/// deleted. Returns a report if something was fixed.
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
    // While program files remain on some level (locked), the nested part isn't
    // touched: the next launch will continue. The report is only about a finished repair.
    if !all_clean || holds_program(&data) {
        return None;
    }
    if inner.is_dir() && !crate::app_paths::is_link(&inner) {
        repaired = true;
        // Empty only per a reliable listing; on a read error — move it out.
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

/// Version from Ninety.portable (`version=X.Y.Z`, written by package-portable.ps1).
fn marker_version(dir: &Path) -> Option<(u64, u64, u64)> {
    std::fs::read_to_string(dir.join(PORTABLE_MARKER))
        .ok()?
        .lines()
        .find_map(|line| line.trim().strip_prefix("version="))
        .and_then(parse_version)
}

/// Whether the tree contains a link or junction (the path itself is checked too).
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

/// Copies only the program files from PROGRAM_ENTRIES into staging.
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

/// Copies the program from the nested folder into the original one's staging. A copy, not
/// a move: the exe is currently running from this folder, and data lies next to it.
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

/// Installs the program from the nested copy into the original folder. Ok(false) — the
/// original folder already has a newer version, we don't downgrade it. If the version of either
/// side can't be read or the destination contains a link, nothing is
/// changed automatically.
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

/// The first thing Ninety does at startup (after the previous process's exit is confirmed
/// and before single-instance). If the exe is running from a nested copy,
/// moves the program to the original folder and starts it; true — the current
/// process should exit. On any error returns false: better to open
/// the nested copy than nothing.
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
    // As with the update: finish an interrupted replacement before building a new staging.
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

/// The folder the update is installed into: the program folder, not NinetyData.
/// Updating from a nested copy (the repair failed) is not allowed — that's what creates
/// the nesting.
fn update_root() -> Result<PathBuf, String> {
    let root = crate::app_paths::portable_app_dir()?;
    if crate::app_paths::nested_portable_origin(&root).is_some() {
        return Err("portable folder needs repair: restart Ninety".into());
    }
    Ok(root)
}

/// Download deadline: from the frontend (`timeoutMs`) or the default, within bounds.
fn download_deadline(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(DOWNLOAD_TIMEOUT_MS)
            .clamp(MIN_DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_TIMEOUT_MS),
    )
}

/// Downloads the ZIP through the updater plugin (it also verifies the signature) and
/// unpacks it into staging. Doesn't touch anything in the running program.
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
        // The user confirmed a different version: the frontend will show the new one and
        // ask to press "Update" again.
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
    // The builder timeout applies only to the check: the plugin returns Update with
    // `timeout: None`, and a hung download would keep the update modal
    // blocked forever. The overall deadline cuts it off together with the request.
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

/// Installs the staged version and starts the new Ninety.exe. Ok(()) means the new
/// process has already started and the current one should exit.
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

    /// Layout after two updates with the broken code:
    /// R\Ninety.exe (old) + R\NinetyData (real data + a copy of the program)
    /// + R\NinetyData\NinetyData (data after the "reset" + one more copy).
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
        // Data from the nested folder didn't get into the program.
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
        // A repeated launch finds nothing.
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
        // A repeated rollback breaks nothing: the copies are already gone, files aren't touched.
        assert!(rollback(&root, &staging, &applied));
        assert_eq!(
            std::fs::read_to_string(root.join("Ninety.exe")).unwrap(),
            "old-exe"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The old version (exe, marker, core, a file in dpi) and the staged new one: the new one has
    /// a different file in dpi and a flag that didn't exist before.
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
        // The process broke off mid-replacement: the core, marker and dpi/new.txt are already
        // new, the flag hasn't been installed yet, and Ninety.exe managed to move aside into
        // the backup, but the new one didn't take its place. The rollback doesn't depend on
        // the order — all file states are checked here at once.
        apply_one(&root, &staging, item(&plan, "sing-box.exe")).unwrap();
        apply_one(&root, &staging, item(&plan, "dpi/new.txt")).unwrap();
        apply_one(&root, &staging, item(&plan, PORTABLE_MARKER)).unwrap();
        // The marker is replaced without a gap: the old one is in the copy, the new one is in place.
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
        // All files are swapped, but the "complete" mark didn't get written.
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
        // The new exe didn't start, and the rollback broke off after the first file.
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
        // A corrupted journal doesn't get in the way of the cleanup: it is simply removed.
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
