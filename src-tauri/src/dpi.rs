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

use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::process::Child;
use std::sync::Mutex;

use serde::Deserialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct DpiState {
    // Child winws.exe. None — не запущен. Хэндл мутабелен для try_wait/kill.
    child: Mutex<Option<Child>>,
}

#[derive(Deserialize)]
struct Strategy {
    id: String,
    #[serde(default)]
    name: String,
    args: Vec<String>,
}

const FLOWSEAL_RAW: &str = "https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/main";

// Канал данных стратегий: подписанный prerelease-ассет, который раз в сутки
// обновляет робот dpi-channel.yml из релизов Flowseal. Ninety тянет его на лету,
// проверяет minisign-подпись и применяет — БЕЗ обновления приложения. Возит только
// данные (strategies.json + списки + .bin), движок едет через OTA (см. engine-watch).
const CHANNEL_BASE: &str =
    "https://github.com/pathetixx/190x4-Ninety/releases/download/dpi-channel";
// minisign-pubkey: ДОЛЖЕН совпадать с plugins.updater.pubkey в tauri.conf.json
// (тот же ключ подписывает и OTA, и канал). base64 от файла minisign-pubkey.
const CHANNEL_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc1N0I1RTAwMEQ3MUQ3OUUKUldTZTEzRU5BRjU3ZGN3TkZoK28yeFRVa2tLdlhxNy8zUXo1aUdXN1lOSUE3MzZLUmVCRnFYamsK";

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
// Writable-каталог списков: <app_data>/dpi/lists.
fn lists_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("dpi")
        .join("lists");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir lists: {e}"))?;
    Ok(dir)
}

// Засеять writable-списки: базовые копируем из ресурсов (если ещё нет —
// updater и пользователь правят writable-версию, поэтому не перезатираем),
// user-списки создаём пустыми. ipset-all.txt пишется отдельно по режиму.
fn ensure_lists(app: &AppHandle) -> Result<PathBuf, String> {
    let dst = lists_dir(app)?;
    let src = res_lists(app)?;
    for name in ["list-general.txt", "list-google.txt", "list-exclude.txt", "ipset-exclude.txt"] {
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
    for name in ["list-general-user.txt", "list-exclude-user.txt", "ipset-exclude-user.txt"] {
        let to = dst.join(name);
        if !to.exists() {
            std::fs::write(&to, b"").map_err(|e| format!("touch {name}: {e}"))?;
        }
    }
    Ok(dst)
}

// Writable-каталог .bin-пейлоадов: <app_data>/dpi/bin-data. Движок (winws.exe +
// драйвер) остаётся read-only в ресурсе, а .bin выносим сюда, чтобы канал мог их
// обновлять без переустановки. winws читает .bin по абсолютному пути (%BIN%),
// независимо от cwd — поэтому свойство «движок из read-only» не нарушается.
fn bindata_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("dpi")
        .join("bin-data");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir bin-data: {e}"))?;
    Ok(dir)
}

// Засеять bin-data из ресурсного движка, если ещё нет ни одного .bin (первый
// запуск / до первого синка канала). Канал потом перезатирает/добавляет файлы.
fn ensure_bindata(app: &AppHandle) -> Result<PathBuf, String> {
    let dst = bindata_dir(app)?;
    let has_bin = std::fs::read_dir(&dst)
        .map(|it| {
            it.flatten()
                .any(|e| e.path().extension().is_some_and(|x| x == "bin"))
        })
        .unwrap_or(false);
    if !has_bin {
        if let Ok(rd) = std::fs::read_dir(bin_dir(app, false)?) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "bin") {
                    if let Some(name) = p.file_name() {
                        let _ = std::fs::copy(&p, dst.join(name));
                    }
                }
            }
        }
    }
    Ok(dst)
}

// Путь к strategies.json: оверлей канала (<app_data>/dpi/strategies.json) имеет
// приоритет над забандленным ресурсом. Так обновлённые стратегии применяются без
// переустановки приложения.
fn strategies_path(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().app_data_dir() {
        let p = dir.join("dpi").join("strategies.json");
        if p.exists() {
            return p;
        }
    }
    res_dpi(app)
        .map(|d| d.join("strategies.json"))
        .unwrap_or_default()
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
            let base = if wbase.exists() { wbase } else { res_lists(app)?.join("ipset-all.base.txt") };
            std::fs::copy(&base, &target).map_err(|e| format!("ipset loaded: {e}"))?;
        }
        "off" => {
            std::fs::write(&target, b"203.0.113.113/32\n").map_err(|e| format!("ipset off: {e}"))?;
        }
        _ => {
            std::fs::write(&target, b"").map_err(|e| format!("ipset any: {e}"))?;
        }
    }
    Ok(())
}

// Лог winws (stdout+stderr) — критичен для диагностики мгновенных падений.
fn dpi_log_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
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
    let Some(p) = dpi_log_file(&app) else { return Ok(String::new()) };
    if !p.exists() {
        return Ok(String::new());
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("read dpi.log: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn read_strategies(app: &AppHandle) -> Result<Vec<Strategy>, String> {
    let path = strategies_path(app);
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

// ── Команды ─────────────────────────────────────────────────────────

/// Сырой strategies.json — фронт рендерит список стратегий из него.
#[tauri::command]
pub fn dpi_strategies(app: AppHandle) -> Result<String, String> {
    let path = strategies_path(&app);
    std::fs::read_to_string(&path).map_err(|e| format!("read strategies.json: {e}"))
}

/// Сколько доменов в активных списках (для карточки «Списки доменов»).
#[tauri::command]
pub fn dpi_domains_count(app: AppHandle) -> Result<usize, String> {
    let lists = ensure_lists(&app)?;
    let mut n = 0usize;
    for name in ["list-general.txt", "list-general-user.txt", "list-google.txt"] {
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
    // Уже запущен? Чистим труп / отказываем.
    {
        let mut guard = state.child.lock().unwrap();
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
    let args: Vec<String> = strat
        .args
        .iter()
        .map(|a| subst(a, &bindata_s, &lists_s, g_tcp, g_udp))
        .collect();

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&args).current_dir(&bin); // cwd = bin → WinDivert.dll грузится по соседству
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // Перенаправляем stdout+stderr winws в dpi.log — без этого причина
    // мгновенного выхода (битый аргумент / не найден .bin / WinDivert) теряется.
    // При logs_disabled («Полностью отключить логи») файл не создаём — вывод winws
    // уходит в никуда (CREATE_NO_WINDOW → нет консоли); диагностика краша при этом
    // не сохранится, юзер сам отключил логи.
    let log = if logs_disabled { None } else { dpi_log_file(&app) };
    if let Some(ref lp) = log {
        if let Ok(f) = std::fs::File::create(lp) {
            if let Ok(f2) = f.try_clone() {
                cmd.stdout(std::process::Stdio::from(f));
                cmd.stderr(std::process::Stdio::from(f2));
            }
        }
    }

    let child = cmd.spawn().map_err(|e| format!("spawn winws: {e}"))?;
    *state.child.lock().unwrap() = Some(child);

    // Дать winws ~700мс упасть (занятый драйвер / нет прав / битые args).
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    {
        let mut guard = state.child.lock().unwrap();
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
                    .unwrap_or_else(|| " Нужны права администратора или занят драйвер WinDivert.".into());
                return Err(format!("winws завершился сразу (код {:?}).{}", status.code(), tail));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn dpi_stop(state: State<'_, DpiState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn dpi_running(state: State<'_, DpiState>) -> bool {
    let mut guard = state.child.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => true,          // живой
            _ => {
                *guard = None;         // умер — забываем хэндл
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
pub fn dpi_set_node_exclude(
    app: AppHandle,
    ip: Option<String>,
    domain: Option<String>,
) -> Result<(), String> {
    let lists = ensure_lists(&app)?;
    if let Some(d) = domain.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        append_unique(&lists.join("list-exclude-user.txt"), d)?;
    }
    if let Some(i) = ip.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // ipset ждёт CIDR — одиночный IP оборачиваем в /32.
        let entry = if i.contains('/') { i.to_string() } else { format!("{i}/32") };
        append_unique(&lists.join("ipset-exclude-user.txt"), &entry)?;
    }
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
pub fn dpi_write_list(app: AppHandle, kind: String, content: String) -> Result<usize, String> {
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
    std::fs::write(lists.join(user_list_name(&kind)), out)
        .map_err(|e| format!("write {}: {e}", user_list_name(&kind)))?;
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
    std::fs::write(path, out).map_err(|e| format!("write exclude: {e}"))
}

// ── Версии / обновление списков ─────────────────────────────────────
// Версия набора стратегий: app_data-маркер (после обновления) приоритетнее
// ресурсной (bundled). Так UI отражает обновления и гасит badge.
fn strat_version(app: &AppHandle) -> String {
    if let Ok(dir) = app.path().app_data_dir() {
        let marker = dir.join("dpi").join("strategies-version.txt");
        if let Ok(v) = std::fs::read_to_string(&marker) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return v;
            }
        }
    }
    res_dpi(app)
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("version.txt")).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "—".into())
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
                    let _ = child.kill();
                    let _ = child.wait();
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
pub fn dpi_versions(app: AppHandle) -> serde_json::Value {
    let strat = strat_version(&app);
    serde_json::json!({
        "app": app.package_info().version.to_string(),
        "engine": engine_version(&app),
        "strategies": strat,
    })
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

// Загрузить текст списка устойчиво: сперва через прокси (если port задан — путь
// через обход), при неудаче — прямым запросом; по 2 попытки на каждый. github raw
// из РФ флапает/режется ТСПУ, поэтому ретраи + проксирование повышают шанс пройти.
// Если прокси не слушает (VPN выключен) — proxy-попытка быстро падает → direct.
async fn fetch_list_text(url: &str, port: Option<u16>) -> Result<String, String> {
    let mut routes: Vec<Option<u16>> = Vec::new();
    if matches!(port, Some(p) if p > 0) {
        routes.push(port); // 1) через mixed-inbound (обход)
    }
    routes.push(None); // 2) прямой fallback
    let mut last = String::from("нет попыток");
    for via in routes {
        let client = match list_client(via) {
            Ok(c) => c,
            Err(e) => {
                last = e;
                continue;
            }
        };
        for attempt in 0..2 {
            match client.get(url).send().await.and_then(|r| r.error_for_status()) {
                Ok(resp) => match resp.text().await {
                    Ok(t) => return Ok(t),
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

/// Доступно ли обновление набора стратегий. Сравниваем с версией НАШЕГО КАНАЛА
/// (version.txt-ассет релиза dpi-channel) — тем, что реально поставит кнопка
/// «Обновить» через dpi_sync_channel. НЕ с live-версией Flowseal: канал
/// пересобирается роботом раз в сутки и неизбежно отстаёт от свежего релиза
/// Flowseal. Если сверяться с live, в окне «Flowseal зарелизил → канал ещё не
/// синканул» проверка показывает «обновление есть», а кнопка тянет старый бандл
/// → local никогда не догоняет remote → вечный «битый круг» обновления.
#[tauri::command]
pub async fn dpi_check_update(app: AppHandle) -> Result<serde_json::Value, String> {
    let local = strat_version(&app);
    let client = no_proxy_client()?;
    let remote = client
        .get(format!("{CHANNEL_BASE}/version.txt"))
        .send()
        .await
        .map_err(|e| format!("fetch version: {e}"))?
        .error_for_status()
        .map_err(|e| format!("version http: {e}"))?
        .text()
        .await
        .map_err(|e| format!("read version: {e}"))?
        .trim()
        .to_string();
    Ok(serde_json::json!({
        "local": local,
        "remote": remote,
        "available": !remote.is_empty() && remote != local,
    }))
}

/// Silent-обновление списков из Flowseal (домены/исключения) БЕЗ переустановки
/// и без трогания user-списков. Перезапуск winws — на стороне фронта (если был
/// включён). Возвращает новую версию набора.
#[tauri::command]
pub async fn dpi_update_strategies(app: AppHandle) -> Result<String, String> {
    let lists = ensure_lists(&app)?;
    let client = no_proxy_client()?;
    // Базовые списки доменов/исключений (user-версии не трогаем).
    for name in ["list-general.txt", "list-google.txt", "list-exclude.txt", "ipset-exclude.txt"] {
        let url = format!("{FLOWSEAL_RAW}/lists/{name}");
        if let Ok(resp) = client.get(url.as_str()).send().await {
            if resp.status().is_success() {
                if let Ok(body) = resp.text().await {
                    if !body.trim().is_empty() {
                        let _ = std::fs::write(lists.join(name), body);
                    }
                }
            }
        }
    }
    // Зафиксировать новую версию набора в app_data-маркере.
    let remote = client
        .get(format!("{FLOWSEAL_RAW}/.service/version.txt"))
        .send()
        .await
        .ok();
    let ver = if let Some(r) = remote {
        r.text().await.unwrap_or_default().trim().to_string()
    } else {
        String::new()
    };
    if !ver.is_empty() {
        if let Ok(dir) = app.path().app_data_dir() {
            let dpi_dir = dir.join("dpi");
            let _ = std::fs::create_dir_all(&dpi_dir);
            let _ = std::fs::write(dpi_dir.join("strategies-version.txt"), &ver);
        }
    }
    Ok(ver)
}

// ── Канал данных стратегий (подписанный, без переустановки) ──────────

// Проверить minisign-подпись бандла нашим pubkey (тем же, что у OTA).
// sig_b64 — содержимое .sig-ассета (base64 от minisign-подписи, формат tauri).
fn verify_channel(data: &[u8], sig_b64: &str) -> Result<(), String> {
    use base64::Engine;
    use minisign_verify::{PublicKey, Signature};
    let std_b64 = base64::engine::general_purpose::STANDARD;
    // pubkey: base64 → текст файла minisign-pubkey → берём не-комментарную строку.
    let pk_raw = std_b64
        .decode(CHANNEL_PUBKEY_B64)
        .map_err(|e| format!("pubkey b64: {e}"))?;
    let pk_text = String::from_utf8(pk_raw).map_err(|e| format!("pubkey utf8: {e}"))?;
    let key_line = pk_text
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with("untrusted comment"))
        .ok_or("pubkey: ключевая строка не найдена")?;
    let pk = PublicKey::from_base64(key_line).map_err(|e| format!("pubkey decode: {e}"))?;
    // .sig: base64 → текст minisign-подписи (с trusted/untrusted comment).
    let sig_raw = std_b64
        .decode(sig_b64.trim())
        .map_err(|e| format!("sig b64: {e}"))?;
    let sig_text = String::from_utf8(sig_raw).map_err(|e| format!("sig utf8: {e}"))?;
    let sig = Signature::decode(&sig_text).map_err(|e| format!("sig decode: {e}"))?;
    pk.verify(data, &sig, true)
        .map_err(|e| format!("ПОДПИСЬ НЕВЕРНА: {e}"))
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

/// Синхронизировать канал стратегий: скачать подписанный бандл, проверить подпись
/// ДО распаковки, провалидировать (strategies.json парсится, все .bin на месте) и
/// атомарно применить в app_data. Возвращает {version, applied}. Движок НЕ трогает.
#[tauri::command]
pub async fn dpi_sync_channel(app: AppHandle) -> Result<serde_json::Value, String> {
    let client = no_proxy_client()?;
    // 1. подпись + бандл
    let sig_b64 = client
        .get(format!("{CHANNEL_BASE}/dpi-channel.zip.sig"))
        .send()
        .await
        .map_err(|e| format!("fetch sig: {e}"))?
        .error_for_status()
        .map_err(|e| format!("sig http: {e}"))?
        .text()
        .await
        .map_err(|e| format!("read sig: {e}"))?;
    let zip_bytes = client
        .get(format!("{CHANNEL_BASE}/dpi-channel.zip"))
        .send()
        .await
        .map_err(|e| format!("fetch zip: {e}"))?
        .error_for_status()
        .map_err(|e| format!("zip http: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("read zip: {e}"))?;

    // 2. ВЕРИФИКАЦИЯ подписи до любой распаковки.
    verify_channel(&zip_bytes, &sig_b64)?;

    // 3. Распаковать в стейджинг, провалидировать.
    let dpi_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("dpi");
    let staging = dpi_data.join(".staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("mkdir staging: {e}"))?;

    let reader = std::io::Cursor::new(zip_bytes.as_ref());
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("open zip: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        // защита от zip-slip: берём только безопасное относительное имя.
        let name = match entry.enclosed_name() {
            Some(n) => n.to_path_buf(),
            None => continue,
        };
        let out = staging.join(&name);
        if entry.is_dir() {
            let _ = std::fs::create_dir_all(&out);
            continue;
        }
        if let Some(parent) = out.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut f = std::fs::File::create(&out).map_err(|e| format!("create {name:?}: {e}"))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| format!("unzip {name:?}: {e}"))?;
    }

    // strategies.json валиден?
    let strat_raw = std::fs::read_to_string(staging.join("strategies.json"))
        .map_err(|e| format!("staged strategies.json: {e}"))?;
    let strategies: Vec<Strategy> =
        serde_json::from_str(&strat_raw).map_err(|e| format!("parse strategies: {e}"))?;
    // все ли нужные .bin есть в бандле (или уже в bin-data)?
    let staged_bin = staging.join("bin");
    let existing = bindata_dir(&app)?;
    for name in referenced_bins(&strategies) {
        if !staged_bin.join(&name).exists() && !existing.join(&name).exists() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("в бандле нет .bin: {name}"));
        }
    }

    // 4. Применить: strategies.json, базовые списки, .bin, версия. user-списки и
    // ipset-all.txt НЕ трогаем (они на стороне клиента / задаются режимом).
    std::fs::copy(staging.join("strategies.json"), dpi_data.join("strategies.json"))
        .map_err(|e| format!("apply strategies: {e}"))?;
    let lists = lists_dir(&app)?;
    let staged_lists = staging.join("lists");
    for name in ["list-general.txt", "list-google.txt", "list-exclude.txt", "ipset-exclude.txt"] {
        let from = staged_lists.join(name);
        if from.exists() {
            let _ = std::fs::copy(&from, lists.join(name));
        }
    }
    if let Ok(rd) = std::fs::read_dir(&staged_bin) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "bin") {
                if let Some(n) = p.file_name() {
                    let _ = std::fs::copy(&p, existing.join(n));
                }
            }
        }
    }
    let ver = std::fs::read_to_string(staging.join("version.txt"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if !ver.is_empty() {
        let _ = std::fs::write(dpi_data.join("strategies-version.txt"), &ver);
    }
    let _ = std::fs::remove_dir_all(&staging);
    Ok(serde_json::json!({ "version": ver, "applied": true }))
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
fn strip_managed_block(content: &str) -> String {
    let mut out = String::new();
    let mut skip = false;
    for line in content.lines() {
        let t = line.trim();
        if t == HOSTS_BEGIN {
            skip = true;
            continue;
        }
        if t == HOSTS_END {
            skip = false;
            continue;
        }
        if skip {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
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
    let content = std::fs::read_to_string(system_hosts_path()).unwrap_or_default();
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
pub async fn dpi_hosts_apply(app: AppHandle, port: Option<u16>) -> Result<serde_json::Value, String> {
    let raw = fetch_list_text(&format!("{FLOWSEAL_RAW}/.service/hosts"), port)
        .await
        .map_err(|e| format!("fetch hosts: {e}"))?;
    let body = raw.replace("\r\n", "\n");
    let body = body.trim();
    if count_hosts_entries(body) == 0 {
        return Err("в источнике нет записей hosts".into());
    }

    let path = system_hosts_path();
    let current = std::fs::read_to_string(&path).unwrap_or_default();

    // Бэкап оригинала один раз — до первой нашей записи.
    if let Ok(dir) = app.path().app_data_dir() {
        let bdir = dir.join("dpi");
        let _ = std::fs::create_dir_all(&bdir);
        let backup = bdir.join("hosts.backup");
        if !backup.exists() && !current.contains(HOSTS_BEGIN) {
            let _ = std::fs::write(&backup, &current);
        }
    }

    // Снять старый блок (если был), дописать свежий в конец.
    let base = strip_managed_block(&current);
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

    std::fs::write(&path, out.as_bytes()).map_err(|e| {
        format!("запись hosts ({}): нужны права администратора — {e}", path.display())
    })?;
    flush_dns();
    Ok(serde_json::json!({ "entries": count_hosts_entries(body) }))
}

/// Удалить наш managed-блок из системного hosts (полный откат). Требует админ-прав.
#[tauri::command]
pub fn dpi_hosts_clear(_app: AppHandle) -> Result<(), String> {
    let path = system_hosts_path();
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if !current.contains(HOSTS_BEGIN) {
        return Ok(());
    }
    let stripped = format!("{}\n", strip_managed_block(&current).trim_end());
    std::fs::write(&path, stripped.as_bytes())
        .map_err(|e| format!("запись hosts: нужны права администратора — {e}"))?;
    flush_dns();
    Ok(())
}

fn flush_dns() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("ipconfig")
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
    let path = if wbase.exists() { wbase } else { res_lists(&app)?.join("ipset-all.base.txt") };
    let txt = std::fs::read_to_string(&path).unwrap_or_default();
    Ok(count_ipset_lines(&txt))
}

/// Обновить базу ipset (ipset-all) актуальным списком из репозитория. Пишем в
/// writable-копию app_data — режим IPSet «Загружен» берёт её приоритетно. Если
/// движок запущен в этом режиме, перезапуск winws — на стороне фронта.
/// Возвращает число загруженных IP.
#[tauri::command]
pub async fn dpi_update_ipset(app: AppHandle, port: Option<u16>) -> Result<usize, String> {
    let lists = ensure_lists(&app)?;
    let raw = fetch_list_text(&format!("{FLOWSEAL_RAW}/.service/ipset-service.txt"), port)
        .await
        .map_err(|e| format!("fetch ipset: {e}"))?;
    let body = raw.replace("\r\n", "\n");
    let n = count_ipset_lines(&body);
    if n == 0 {
        return Err("в источнике нет IP-записей".into());
    }
    std::fs::write(lists.join("ipset-all.base.txt"), body.as_bytes())
        .map_err(|e| format!("запись ipset base: {e}"))?;
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
    force_cleanup(&state); // глушим текущий winws — будем цикловать свои
    let url = test_url.unwrap_or_else(|| "https://www.youtube.com/".into());

    let strategies = read_strategies(&app)?;
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
    let client = no_proxy_client()?;
    let total = strategies.len();

    let mut best: Option<(String, String, u64)> = None; // (id, name, latency)
    let mut passed = 0usize;

    for (idx, strat) in strategies.iter().enumerate() {
        let _ = app.emit(
            "dpi:autotest",
            AutotestProgress { i: idx + 1, total, name: strat.name.clone() },
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
        let child = cmd.spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(_) => continue,
        };
        tokio::time::sleep(Duration::from_millis(700)).await;

        let t0 = Instant::now();
        let ok = match client.get(url.as_str()).send().await {
            Ok(r) => r.status().is_success() || r.status().is_redirection(),
            Err(_) => false,
        };
        let lat = t0.elapsed().as_millis() as u64;

        let _ = child.kill();
        let _ = child.wait();

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
        tokio::time::sleep(Duration::from_millis(150)).await;
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
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Полная выгрузка движка перед OTA-апдейтом. Гасим winws И СНИМАЕМ kernel-драйвер
/// WinDivert: его служба winws ставит сам при старте, и после kill процесса она
/// остаётся загруженной в ядре, лоча `WinDivert64.sys`/`winws.exe` → NSIS-инсталлер
/// падает на «файл занят» (та самая ошибка OTA). `sc stop/delete` требует
/// админ-прав, но при запущенном DPI аппа уже elevated (winws — наш child,
/// наследует токен), поэтому здесь команды проходят. Ошибки не критичны —
/// драйвера могло и не быть; имя службы у разных сборок winws — WinDivert или
/// WinDivert14 (как чистит service.bat Flowseal), плюс Monkey (наш переименованный
/// вариант, см. bin_dir) — снимаем все.
#[tauri::command]
pub fn dpi_unload_driver(state: State<'_, DpiState>) -> Result<(), String> {
    force_cleanup(&state);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        for svc in ["WinDivert", "WinDivert14", "Monkey"] {
            for verb in ["stop", "delete"] {
                let _ = std::process::Command::new("sc")
                    .args([verb, svc])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
            }
        }
    }
    Ok(())
}
