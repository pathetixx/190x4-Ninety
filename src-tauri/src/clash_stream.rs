// Subscription to the clash WebSocket /traffic (sing-box clash API).
// Frames: {"up": <bytes/sec>, "down": <bytes/sec>} every second.
// Emitted to JS as the Tauri event "clash:traffic".

use futures_util::StreamExt;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
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

async fn run_stream(
    app: AppHandle,
    port: u16,
    generation: u64,
    current_generation: Arc<AtomicU64>,
) {
    // token in the query — this is how the clash API authorizes websockets (a browser WS client cannot
    // send headers, so the server accepts a query token too). The connection is
    // 127.0.0.1, the secret is visible only to this process, so a token in the URL is safe.
    // ⚠️ INVARIANT: do NOT log the whole `url` (it contains the secret) — on errors
    // below we log only the fact, without the address. Violating this would leak the clash API secret into the log.
    let url = format!(
        "ws://127.0.0.1:{port}/traffic?token={}",
        crate::clash::clash_secret()
    );
    let is_current = || current_generation.load(Ordering::SeqCst) == generation;
    // Simple reconnect loop: if the core restarted / hasn't brought up WS yet — wait.
    // 🔴 The loop MUST die together with its generation: after stop the port can
    // be taken by any other local process, and the clash API secret goes into the URL —
    // an endless reconnect would hand that process full control of the core.
    while is_current() {
        match connect_async(&url).await {
            Ok((ws, _)) => {
                let (_, mut read) = ws.split();
                while let Some(msg) = read.next().await {
                    if !is_current() {
                        return;
                    }
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
                // couldn't connect — wait and try again
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
pub async fn clash_traffic_start(
    app: AppHandle,
    runtime: State<'_, crate::vpn::SingboxState>,
    port: u16,
) -> Result<(), String> {
    // The same gate as the other clash commands (clash.rs::validate_clash_port).
    // Without it the frontend could name ANY port, and the clash API secret would go
    // in the query string to an arbitrary local listener — together with full
    // control of the core (switching nodes, reading the config with node UUIDs/passwords).
    crate::clash::validate_clash_port_ref(&runtime, port)?;
    let generation = crate::vpn::active_runtime_generation(&runtime)?;
    if generation == 0 {
        return Err("clash traffic stream requires a running runtime".into());
    }
    let current_generation = crate::vpn::process_generation_handle(&runtime);

    let state = app
        .try_state::<ClashStreamState>()
        .ok_or_else(|| "ClashStreamState not managed".to_string())?;
    let mut h = state.handle.lock().await;
    if let Some(existing) = h.take() {
        existing.abort();
    }
    let app_clone = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        run_stream(app_clone, port, generation, current_generation).await;
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
