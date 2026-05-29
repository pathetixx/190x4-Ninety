use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;

use crate::consts::{SINGBOX_EXE_NAMES, SINGBOX_LOG_FILE_NAME};
use crate::logging::exe_dir;
use crate::{linfo, lwarn};

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    Stopped,
    Running { pid: u32 },
}

struct Inner {
    child: Option<Child>,
    pid: Option<u32>,
}

pub struct Manager {
    inner: Mutex<Inner>,
    log_tx: broadcast::Sender<String>,
}

fn resolve_singbox_exe() -> Result<PathBuf, String> {
    let dir = exe_dir();
    for name in SINGBOX_EXE_NAMES {
        let p = dir.join(name);
        if p.exists() {
            return Ok(p);
        }
        let p2 = dir.join("binaries").join(name);
        if p2.exists() {
            return Ok(p2);
        }
    }
    Err(format!(
        "sing-box.exe не найден рядом с {} (искали: {})",
        dir.display(),
        SINGBOX_EXE_NAMES.join(", ")
    ))
}

fn singbox_log_path() -> PathBuf {
    exe_dir().join(SINGBOX_LOG_FILE_NAME)
}

fn singbox_config_path() -> PathBuf {
    exe_dir().join("singbox-current.json")
}

// Санитизация конфига, пришедшего по IPC: сервис исполняет sing-box под
// LocalSystem, поэтому конфиг — это привилегированный ввод. Любое поле
// sing-box, задающее путь записи файла, превращается в примитив записи файлов
// от SYSTEM (LPE). Вычищаем такие поля независимо от того, кто прислал конфиг:
//   - log.output        → удаляем; sing-box пишет в stdout, его пампит сервис;
//   - cache_file.path    → если задан, переносим в каталог сервиса (не наружу);
//   - clash_api.external_ui      → удаляем (отдача произвольной директории);
//   - clash_api.external_controller → жёстко 127.0.0.1.
fn sanitize_config(raw: &str) -> Result<String, String> {
    let mut v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("config json: {e}"))?;

    if let Some(log) = v.get_mut("log").and_then(|l| l.as_object_mut()) {
        log.remove("output");
    }
    if let Some(exp) = v.get_mut("experimental").and_then(|e| e.as_object_mut()) {
        if let Some(cf) = exp.get_mut("cache_file").and_then(|c| c.as_object_mut()) {
            if cf.contains_key("path") {
                let safe = exe_dir().join("cache.db").to_string_lossy().to_string();
                cf.insert("path".into(), serde_json::Value::String(safe));
            }
        }
        if let Some(api) = exp.get_mut("clash_api").and_then(|a| a.as_object_mut()) {
            api.remove("external_ui");
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
    }
    serde_json::to_string(&v).map_err(|e| format!("reserialize: {e}"))
}

impl Manager {
    pub fn new() -> Arc<Self> {
        // capacity=256: достаточно для logs viewer, при переполнении старые
        // строки дропаются — это нормально, файловый лог пишется всегда
        let (log_tx, _) = broadcast::channel(256);
        Arc::new(Self {
            inner: Mutex::new(Inner {
                child: None,
                pid: None,
            }),
            log_tx,
        })
    }

    pub fn subscribe_logs(&self) -> broadcast::Receiver<String> {
        self.log_tx.subscribe()
    }

    pub fn status(&self) -> Status {
        let mut g = self.inner.lock().unwrap();
        if let Some(child) = g.child.as_mut() {
            match child.try_wait() {
                Ok(None) => Status::Running {
                    pid: g.pid.unwrap_or(0),
                },
                _ => {
                    // умер — чистим, чтобы следующий start не упал
                    g.child = None;
                    g.pid = None;
                    Status::Stopped
                }
            }
        } else {
            Status::Stopped
        }
    }

    pub fn start(self: &Arc<Self>, config_json: &str) -> Result<u32, String> {
        {
            let mut g = self.inner.lock().unwrap();
            if let Some(child) = g.child.as_mut() {
                if matches!(child.try_wait(), Ok(None)) {
                    return Err("sing-box уже запущен".into());
                }
                g.child = None;
                g.pid = None;
            }
        }

        // Конфиг пишет сервис у себя (LocalSystem, %ProgramFiles%\Ninety\),
        // а не Tauri (user profile). LocalSystem может не иметь доступа на
        // чтение %APPDATA% других юзеров, поэтому inline-передача через IPC.
        let sanitized = sanitize_config(config_json)?;
        let config_path = singbox_config_path();
        std::fs::write(&config_path, &sanitized)
            .map_err(|e| format!("write config {}: {e}", config_path.display()))?;

        let exe = resolve_singbox_exe()?;
        linfo!(
            "spawn sing-box: {} run -c {}",
            exe.display(),
            config_path.display()
        );

        let mut cmd = Command::new(&exe);
        cmd.arg("run")
            .arg("-c")
            .arg(&config_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());

        // CREATE_NO_WINDOW = без вспышки консоли.
        // CREATE_NEW_PROCESS_GROUP нужен чтобы GenerateConsoleCtrlEvent(CTRL_BREAK)
        // в stop() мог адресоваться к sing-box и его потомкам как к группе —
        // без этого Ctrl+Break применяется ко всему дереву родителей.
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }

        let mut child = cmd.spawn().map_err(|e| format!("spawn sing-box: {e}"))?;
        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        {
            let mut g = self.inner.lock().unwrap();
            g.child = Some(child);
            g.pid = Some(pid);
        }

        // Перетекание stdout/stderr → файл + broadcast (для IPC subscribers).
        // truncate=false, append=true — лог растёт, чистится через IPC `clear_log`.
        let log_path = singbox_log_path();
        if let Some(out) = stdout {
            let tx = self.log_tx.clone();
            let path = log_path.clone();
            std::thread::spawn(move || pump_pipe(out, "OUT", path, tx));
        }
        if let Some(err) = stderr {
            let tx = self.log_tx.clone();
            std::thread::spawn(move || pump_pipe(err, "ERR", log_path, tx));
        }

        linfo!("sing-box started, pid={pid}");
        Ok(pid)
    }

    pub fn stop(&self) -> Result<(), String> {
        let taken = {
            let mut g = self.inner.lock().unwrap();
            let pid = g.pid.take();
            g.child.take().map(|c| (c, pid))
        };
        if let Some((child, pid)) = taken {
            graceful_then_kill(child, pid, std::time::Duration::from_secs(3));
            linfo!("sing-box остановлен");
        }
        Ok(())
    }

    pub fn force_cleanup(&self) {
        let taken = {
            let mut g = self.inner.lock().unwrap();
            let pid = g.pid.take();
            g.child.take().map(|c| (c, pid))
        };
        if let Some((child, pid)) = taken {
            graceful_then_kill(child, pid, std::time::Duration::from_secs(2));
            lwarn!("force_cleanup: sing-box остановлен");
        }
    }

    pub fn singbox_log_path(&self) -> PathBuf {
        singbox_log_path()
    }
}

// Graceful shutdown: послать CTRL+BREAK группе процесса (sing-box получит сигнал
// и корректно закроет Wintun-интерфейс), дождаться выхода до timeout, потом
// TerminateProcess. Без graceful Wintun-адаптер NinetyTunnel может остаться
// висеть в системе. Аналог Hiddify box.CloseService() через CTRL.
fn graceful_then_kill(
    mut child: std::process::Child,
    pid: Option<u32>,
    timeout: std::time::Duration,
) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = pid {
        use windows::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
        unsafe {
            // CTRL_BREAK_EVENT адресуется по process group ID = первый PID группы.
            // Sing-box стартовал с CREATE_NEW_PROCESS_GROUP → его PID = ID группы.
            let _ = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid);
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = pid;

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            _ => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn pump_pipe<R: std::io::Read>(
    pipe: R,
    tag: &'static str,
    log_path: PathBuf,
    tx: broadcast::Sender<String>,
) {
    let mut writer = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();
    let reader = BufReader::new(pipe);
    for line in reader.lines().flatten() {
        if let Some(w) = writer.as_mut() {
            let _ = writeln!(w, "{tag}: {line}");
        }
        // send() возвращает Err когда нет subscriber'ов — это нормально
        let _ = tx.send(format!("{tag}: {line}"));
    }
}
