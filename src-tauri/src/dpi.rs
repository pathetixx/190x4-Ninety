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
fn bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(res_dpi(app)?.join("bin"))
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

// Режим ipset → содержимое ipset-all.txt (как в service.bat Flowseal):
//   any    — пустой файл (обход по совпадению домена, рекомендуется);
//   loaded — полный набор IP из ресурсного ipset-all.base.txt;
//   off    — заглушка (одна несуществующая подсеть, фильтр фактически выключен).
fn write_ipset_mode(app: &AppHandle, lists: &Path, mode: &str) -> Result<(), String> {
    let target = lists.join("ipset-all.txt");
    match mode {
        "loaded" => {
            let base = res_lists(app)?.join("ipset-all.base.txt");
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

fn read_strategies(app: &AppHandle) -> Result<Vec<Strategy>, String> {
    let path = res_dpi(app)?.join("strategies.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read strategies.json: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse strategies.json: {e}"))
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
    let path = res_dpi(&app)?.join("strategies.json");
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
) -> Result<(), String> {
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

    let bin = bin_dir(&app)?;
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

    let bin_s = bin.to_string_lossy().to_string();
    let lists_s = lists.to_string_lossy().to_string();
    let args: Vec<String> = strat
        .args
        .iter()
        .map(|a| subst(a, &bin_s, &lists_s, g_tcp, g_udp))
        .collect();

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&args).current_dir(&bin); // cwd = bin → WinDivert.dll грузится по соседству
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
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
                return Err(format!(
                    "winws завершился сразу (код {:?}). Нужны права администратора или занят драйвер WinDivert.",
                    status.code()
                ));
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

/// Три версии для карточки «Обновления»: приложение / движок / набор стратегий.
#[tauri::command]
pub fn dpi_versions(app: AppHandle) -> serde_json::Value {
    let strat = strat_version(&app);
    serde_json::json!({
        "app": app.package_info().version.to_string(),
        "engine": "winws (zapret)",
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

/// Доступно ли обновление набора стратегий (сравнение с version.txt Flowseal).
#[tauri::command]
pub async fn dpi_check_update(app: AppHandle) -> Result<serde_json::Value, String> {
    let local = strat_version(&app);
    let client = no_proxy_client()?;
    let remote = client
        .get(format!("{FLOWSEAL_RAW}/.service/version.txt"))
        .send()
        .await
        .map_err(|e| format!("fetch version: {e}"))?
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
) -> Result<serde_json::Value, String> {
    force_cleanup(&state); // глушим текущий winws — будем цикловать свои
    let url = test_url.unwrap_or_else(|| "https://www.youtube.com/".into());

    let strategies = read_strategies(&app)?;
    let bin = bin_dir(&app)?;
    let exe = bin.join("winws.exe");
    if !exe.exists() {
        return Err(format!("winws.exe не найден: {}", exe.display()));
    }
    let lists = ensure_lists(&app)?;
    write_ipset_mode(&app, &lists, "any")?;
    let bin_s = bin.to_string_lossy().to_string();
    let lists_s = lists.to_string_lossy().to_string();
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
            .map(|a| subst(a, &bin_s, &lists_s, "12", "12"))
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
