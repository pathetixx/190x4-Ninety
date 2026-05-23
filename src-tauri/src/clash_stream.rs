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

async fn run_stream(app: AppHandle, port: u16) {
    let url = format!("ws://127.0.0.1:{port}/traffic");
    // Простой reconnect-цикл: если ядро перезапустилось / ещё не подняло WS — ждём.
    loop {
        match connect_async(&url).await {
            Ok((ws, _)) => {
                let (_, mut read) = ws.split();
                while let Some(msg) = read.next().await {
                    match msg {
                        Ok(Message::Text(t)) => {
                            if let Ok(v) = serde_json::from_str::<Value>(&t) {
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

#[tauri::command]
pub async fn clash_traffic_start(
    app: AppHandle,
    port: u16,
) -> Result<(), String> {
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
pub async fn clash_traffic_stop(
    state: State<'_, ClashStreamState>,
) -> Result<(), String> {
    let mut h = state.handle.lock().await;
    if let Some(handle) = h.take() {
        handle.abort();
    }
    Ok(())
}
