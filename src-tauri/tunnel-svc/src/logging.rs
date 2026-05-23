use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::consts::LOG_FILE_NAME;

static LOG_LOCK: Mutex<()> = Mutex::new(());

pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn log_path() -> PathBuf {
    exe_dir().join(LOG_FILE_NAME)
}

fn ts() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{h:02}:{m:02}:{s:02}")
}

pub fn log(level: &str, msg: &str) {
    let _guard = LOG_LOCK.lock();
    let line = format!("[{}] {} {}\n", ts(), level, msg);
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = f.write_all(line.as_bytes());
    }
}

#[macro_export]
macro_rules! linfo {
    ($($arg:tt)*) => { $crate::logging::log("INFO", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! lwarn {
    ($($arg:tt)*) => { $crate::logging::log("WARN", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! lerr {
    ($($arg:tt)*) => { $crate::logging::log("ERROR", &format!($($arg)*)) };
}
