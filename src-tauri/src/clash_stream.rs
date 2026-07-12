// Подписка на clash WebSocket /traffic (sing-box clash-API).
// Кадры: {"up": <bytes/sec>, "down": <bytes/sec>} каждую секунду.
// Эмитим как Tauri event "clash:traffic" в JS.

use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct ClashStreamState {
    pub handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

fn parse_traffic_message(text: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if !object.get("up").is_some_and(Value::is_number)
        || !object.get("down").is_some_and(Value::is_number)
    {
        return None;
    }
    Some(value)
}

async fn run_stream(app: AppHandle, port: u16) {
    // token в query — так clash-API авторизует websocket (браузерный WS-клиент не
    // умеет слать заголовки, поэтому сервер принимает и query-token). Соединение —
    // 127.0.0.1, секрет виден только этому процессу, поэтому token в URL безопасен.
    // ⚠️ ИНВАРИАНТ: НЕ логировать `url` целиком (он содержит секрет) — при ошибках
    // ниже пишем только факт, без адреса. Нарушение слило бы секрет clash-API в лог.
    let url = format!(
        "ws://127.0.0.1:{port}/traffic?token={}",
        crate::clash::clash_secret()
    );
    // Простой reconnect-цикл: если ядро перезапустилось / ещё не подняло WS — ждём.
    loop {
        match connect_async(&url).await {
            Ok((ws, _)) => {
                let (_, mut read) = ws.split();
                while let Some(msg) = read.next().await {
                    match msg {
                        Ok(Message::Text(t)) => {
                            if let Some(v) = parse_traffic_message(&t) {
                                let _ = app.emit("clash:traffic", v);
                            }
                        }
                        Ok(Message::Close(_)) => break,
                        Err(_) => break,
                        _ => {}
                    }
                }
            }
            Err(_) => {
                // соединиться не получилось — подождём и попробуем снова
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traffic_message_requires_numeric_up_and_down() {
        assert!(parse_traffic_message(r#"{"up":10,"down":20}"#).is_some());
        assert!(parse_traffic_message(r#"{"up":"10","down":20}"#).is_none());
        assert!(parse_traffic_message(r#"{"down":20}"#).is_none());
        assert!(parse_traffic_message("not json").is_none());
    }
}

#[tauri::command]
pub async fn clash_traffic_start(app: AppHandle, port: u16) -> Result<(), String> {
    let state = app
        .try_state::<ClashStreamState>()
        .ok_or_else(|| "ClashStreamState not managed".to_string())?;
    let mut h = state.handle.lock().await;
    if let Some(existing) = h.take() {
        existing.abort();
    }
    let app_clone = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        run_stream(app_clone, port).await;
    });
    *h = Some(task);
    Ok(())
}

#[tauri::command]
pub async fn clash_traffic_stop(state: State<'_, ClashStreamState>) -> Result<(), String> {
    let mut h = state.handle.lock().await;
    if let Some(handle) = h.take() {
        handle.abort();
    }
    Ok(())
}
