//! Native dataplane health monitor.
//!
//! Process liveness is not enough for a VPN runtime: sing-box can stay alive
//! while its TUN/proxy datapath is starved by the host. This module keeps a
//! small native probe running outside the WebView timer and publishes only a
//! bounded, non-sensitive health snapshot to the frontend.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::quality;
use crate::util::MutexExt;

const INITIAL_DELAY: Duration = Duration::from_secs(4);
const HEALTH_INTERVAL: Duration = Duration::from_secs(10);
const PRESSURE_INTERVAL: Duration = Duration::from_secs(15);
const PROBE_BUDGET_MS: u64 = 2_500;
const PROBE_BYTES: u64 = 64 * 1024;
const SCHEDULER_PRESSURE_MS: u64 = 1_500;
const FAILED_PROBES: u32 = 2;
const PRESSURE_MEMORY_LOAD_PERCENT: u32 = 95;
const PRESSURE_AVAILABLE_MEMORY_BYTES: u64 = 512 * 1024 * 1024;
const HEALTH_EVENT: &str = "ninety:dataplane-health";

const WATCHDOG_ENDPOINTS: &[&str] = &["https://speed.cloudflare.com/__down?bytes=65536"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataplaneHealthSnapshot {
    pub state: String,
    pub reason: Option<String>,
    pub generation: u64,
    pub consecutive_failures: u32,
    pub last_probe_ms: u64,
    pub last_probe_age_ms: Option<u64>,
    pub scheduler_lateness_ms: u64,
    pub host_pressure: bool,
    pub memory_load_percent: Option<u32>,
    pub available_memory_bytes: Option<u64>,
}

impl Default for DataplaneHealthSnapshot {
    fn default() -> Self {
        Self {
            state: "inactive".into(),
            reason: None,
            generation: 0,
            consecutive_failures: 0,
            last_probe_ms: 0,
            last_probe_age_ms: None,
            scheduler_lateness_ms: 0,
            host_pressure: false,
            memory_load_percent: None,
            available_memory_bytes: None,
        }
    }
}

struct HealthInner {
    state: String,
    reason: Option<String>,
    generation: u64,
    consecutive_failures: u32,
    last_probe_at: Option<Instant>,
    last_probe_ms: u64,
    scheduler_lateness_ms: u64,
    host_pressure: bool,
    memory_load_percent: Option<u32>,
    available_memory_bytes: Option<u64>,
}

impl Default for HealthInner {
    fn default() -> Self {
        Self {
            state: "inactive".into(),
            reason: None,
            generation: 0,
            consecutive_failures: 0,
            last_probe_at: None,
            last_probe_ms: 0,
            scheduler_lateness_ms: 0,
            host_pressure: false,
            memory_load_percent: None,
            available_memory_bytes: None,
        }
    }
}

/// Shared state is deliberately separate from the task handle. A stale task
/// must never be able to overwrite a later runtime generation after stop/start.
pub struct DataplaneHealthState(Mutex<HealthInner>);

impl Default for DataplaneHealthState {
    fn default() -> Self {
        Self(Mutex::new(HealthInner::default()))
    }
}

impl DataplaneHealthState {
    pub fn reset_active(&self, generation: u64) {
        let mut inner = self.0.lock_recover();
        *inner = HealthInner {
            state: "unknown".into(),
            generation,
            ..HealthInner::default()
        };
    }

    pub fn reset_inactive(&self) {
        *self.0.lock_recover() = HealthInner::default();
    }

    pub fn snapshot(&self) -> DataplaneHealthSnapshot {
        let inner = self.0.lock_recover();
        DataplaneHealthSnapshot {
            state: inner.state.clone(),
            reason: inner.reason.clone(),
            generation: inner.generation,
            consecutive_failures: inner.consecutive_failures,
            last_probe_ms: inner.last_probe_ms,
            last_probe_age_ms: inner
                .last_probe_at
                .map(|at| at.elapsed().as_millis().min(u64::MAX as u128) as u64),
            scheduler_lateness_ms: inner.scheduler_lateness_ms,
            host_pressure: inner.host_pressure,
            memory_load_percent: inner.memory_load_percent,
            available_memory_bytes: inner.available_memory_bytes,
        }
    }

    fn record(
        &self,
        generation: u64,
        state: &str,
        reason: Option<&str>,
        consecutive_failures: u32,
        probe_ms: u64,
        scheduler_lateness_ms: u64,
        resources: ResourceSample,
    ) {
        let mut inner = self.0.lock_recover();
        if inner.generation != generation {
            return;
        }
        inner.state = state.into();
        inner.reason = reason.map(str::to_owned);
        inner.consecutive_failures = consecutive_failures;
        inner.last_probe_at = Some(Instant::now());
        inner.last_probe_ms = probe_ms;
        inner.scheduler_lateness_ms = scheduler_lateness_ms;
        inner.host_pressure = resources.pressure;
        inner.memory_load_percent = resources.memory_load_percent;
        inner.available_memory_bytes = resources.available_memory_bytes;
    }
}

#[derive(Clone, Copy, Default)]
struct ResourceSample {
    pressure: bool,
    memory_load_percent: Option<u32>,
    available_memory_bytes: Option<u64>,
}

#[cfg(target_os = "windows")]
fn resource_sample() -> ResourceSample {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    let Ok(()) = (unsafe { GlobalMemoryStatusEx(&mut status) }) else {
        return ResourceSample::default();
    };
    let available = status.ullAvailPhys;
    let load = status.dwMemoryLoad;
    ResourceSample {
        pressure: load >= PRESSURE_MEMORY_LOAD_PERCENT
            || available <= PRESSURE_AVAILABLE_MEMORY_BYTES,
        memory_load_percent: Some(load),
        available_memory_bytes: Some(available),
    }
}

#[cfg(not(target_os = "windows"))]
fn resource_sample() -> ResourceSample {
    ResourceSample::default()
}

fn probe_ok(result: &quality::ProbeResult) -> bool {
    result.ok && !result.stalled && result.bytes >= PROBE_BYTES
}

fn probe_reason(result: &quality::ProbeResult) -> &'static str {
    if result.stalled {
        "dataplane_stalled"
    } else if result.error.is_some() {
        "dataplane_probe_failed"
    } else {
        "dataplane_probe_incomplete"
    }
}

fn publish(app: &AppHandle, health: &DataplaneHealthState) {
    let _ = app.emit(HEALTH_EVENT, health.snapshot());
}

/// Starts one native monitor for one runtime generation.
///
/// The monitor intentionally does not perform recovery itself yet: recovery
/// still needs frontend-owned profile/config selection. It does, however,
/// keep the observation and pressure classification alive outside WebView
/// timers and supplies the recovery controller with a trustworthy signal.
pub fn start_dataplane_watchdog(
    app: AppHandle,
    health: Arc<DataplaneHealthState>,
    generation_token: Arc<AtomicU64>,
    generation: u64,
    probe_port: u16,
) {
    generation_token.store(generation, Ordering::SeqCst);
    health.reset_active(generation);
    publish(&app, &health);

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        let mut next = Instant::now();
        let mut failures = 0u32;

        loop {
            if generation_token.load(Ordering::SeqCst) != generation {
                break;
            }
            let scheduled = next;
            let now = Instant::now();
            if now < scheduled {
                tokio::time::sleep(scheduled.duration_since(now)).await;
            }
            if generation_token.load(Ordering::SeqCst) != generation {
                break;
            }

            let started = Instant::now();
            let lateness = started
                .saturating_duration_since(scheduled)
                .as_millis()
                .min(u64::MAX as u128) as u64;
            let resources = resource_sample();
            let result = quality::probe_quality_inner(
                Some(probe_port),
                WATCHDOG_ENDPOINTS.iter().map(|url| (*url).into()).collect(),
                Some(PROBE_BYTES),
                Some(PROBE_BUDGET_MS),
            )
            .await;
            if generation_token.load(Ordering::SeqCst) != generation {
                break;
            }

            let probe_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            let scheduler_pressure = lateness >= SCHEDULER_PRESSURE_MS;
            let pressure = scheduler_pressure || resources.pressure;
            let (state, reason, current_failures) = match result {
                Ok(ref probe) if probe_ok(probe) && !pressure => {
                    failures = 0;
                    ("healthy", None, failures)
                }
                Ok(ref probe) if pressure => {
                    failures = 0;
                    ("pressure", Some("host_resource_pressure"), failures)
                }
                Err(_) if pressure => {
                    failures = 0;
                    ("pressure", Some("host_resource_pressure"), failures)
                }
                Ok(ref probe) => {
                    failures = failures.saturating_add(1);
                    let state = if failures >= FAILED_PROBES {
                        "failed"
                    } else {
                        "suspect"
                    };
                    (state, Some(probe_reason(probe)), failures)
                }
                Err(_) => {
                    failures = failures.saturating_add(1);
                    let state = if failures >= FAILED_PROBES {
                        "failed"
                    } else {
                        "suspect"
                    };
                    (state, Some("dataplane_probe_error"), failures)
                }
            };

            health.record(
                generation,
                state,
                reason,
                current_failures,
                probe_ms,
                lateness,
                ResourceSample {
                    pressure,
                    ..resources
                },
            );
            publish(&app, &health);
            next = Instant::now()
                + if pressure {
                    PRESSURE_INTERVAL
                } else {
                    HEALTH_INTERVAL
                };
        }
    });
}

pub fn stop_dataplane_watchdog(health: &DataplaneHealthState, generation_token: &AtomicU64) {
    generation_token.store(0, Ordering::SeqCst);
    health.reset_inactive();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_health_is_inactive() {
        let health = DataplaneHealthState::default();
        assert_eq!(health.snapshot().state, "inactive");
    }

    #[test]
    fn active_health_starts_unknown_and_keeps_generation() {
        let health = DataplaneHealthState::default();
        health.reset_active(42);
        let snapshot = health.snapshot();
        assert_eq!(snapshot.state, "unknown");
        assert_eq!(snapshot.generation, 42);
    }

    #[test]
    fn stale_generation_cannot_overwrite_new_runtime_health() {
        let health = DataplaneHealthState::default();
        health.reset_active(42);
        health.record(
            41,
            "failed",
            Some("stale"),
            2,
            100,
            0,
            ResourceSample::default(),
        );
        assert_eq!(health.snapshot().state, "unknown");
    }
}
