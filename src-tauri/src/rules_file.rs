// Ninety · файл правил маршрутизации: экспорт и импорт через системный диалог.
//
// Путь выбирает пользователь в нативном окне Windows, фронт путей не передаёт:
// скрипт страницы не может ни записать, ни прочитать произвольный файл. Форму
// правил проверяет и нормализует фронт (routing-rules.js), здесь — только
// лимит размера, кодировка и то, что экспортируемый текст является JSON.

use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};

use crate::util::i18n_error;

// Тысяча правил с длинными списками доменов укладывается с большим запасом.
const MAX_RULES_FILE_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_FILE_NAME: &str = "ninety-routing-rules.json";

fn file_dialog(app: &AppHandle) -> FileDialogBuilder<tauri::Wry> {
    let mut builder = app.dialog().file().add_filter("JSON", &["json"]);
    // Диалог с владельцем модален: окно Ninety не примет клики, пока он открыт.
    if let Some(window) = app.get_webview_window("main") {
        builder = builder.set_parent(&window);
    }
    builder
}

fn picked_path(picked: tauri_plugin_dialog::FilePath) -> Result<PathBuf, String> {
    picked.into_path().map_err(|e| format!("rules path: {e}"))
}

fn validate_export(json: &str) -> Result<(), String> {
    if json.len() as u64 > MAX_RULES_FILE_BYTES {
        return Err(i18n_error("rr.io.errTooBig"));
    }
    serde_json::from_str::<serde_json::Value>(json)
        .map(|_| ())
        .map_err(|e| format!("rules export json: {e}"))
}

fn read_rules_file(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path);
    let file = file.map_err(|e| format!("open rules file: {e}"))?;
    // Читаем на байт больше лимита: так переполнение видно без чтения всего файла.
    let mut limited = file.take(MAX_RULES_FILE_BYTES + 1);
    let mut body = Vec::new();
    let read = limited.read_to_end(&mut body);
    read.map_err(|e| format!("read rules file: {e}"))?;
    if body.len() as u64 > MAX_RULES_FILE_BYTES {
        return Err(i18n_error("rr.io.errTooBig"));
    }
    let text = String::from_utf8(body);
    let text = text.map_err(|_| i18n_error("rr.io.errParse"))?;
    // Блокнот Windows сохраняет UTF-8 с BOM, а JSON.parse на BOM падает.
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// Сохранить правила в файл, выбранный пользователем. `false` — диалог закрыли.
#[tauri::command]
pub async fn routing_rules_export_file(app: AppHandle, json: String) -> Result<bool, String> {
    validate_export(&json)?;
    // blocking_* нельзя звать с главного потока: диалог ждёт его же цикл сообщений.
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = file_dialog(&app).set_file_name(DEFAULT_FILE_NAME);
        let Some(picked) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let path = picked_path(picked)?;
        crate::atomic_file::write_replace(&path, &json, "rules file")?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("rules export did not finish: {e}"))?
}

/// Прочитать файл правил, выбранный пользователем. `None` — диалог закрыли.
#[tauri::command]
pub async fn routing_rules_import_file(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(picked) = file_dialog(&app).blocking_pick_file() else {
            return Ok(None);
        };
        read_rules_file(&picked_path(picked)?).map(Some)
    })
    .await
    .map_err(|e| format!("rules import did not finish: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, body: &[u8]) -> PathBuf {
        let dir_name = format!("ninety-rules-file-{}", std::process::id());
        let dir = std::env::temp_dir().join(dir_name);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn reads_utf8_and_strips_bom() {
        let path = temp_file("bom.json", "\u{feff}{\"rules\":[]}".as_bytes());
        assert_eq!(read_rules_file(&path).unwrap(), "{\"rules\":[]}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_oversized_file() {
        let body = vec![b' '; (MAX_RULES_FILE_BYTES + 1) as usize];
        let path = temp_file("big.json", &body);
        assert_eq!(read_rules_file(&path).unwrap_err(), "[[rr.io.errTooBig]]");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_non_utf8_file() {
        let path = temp_file("bin.json", &[0xff, 0xfe, 0x00, 0x7b]);
        assert_eq!(read_rules_file(&path).unwrap_err(), "[[rr.io.errParse]]");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn export_requires_json() {
        assert!(validate_export("{\"rules\":[]}").is_ok());
        assert!(validate_export("not json").is_err());
    }
}
