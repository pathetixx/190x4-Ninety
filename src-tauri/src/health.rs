//! Native dataplane health monitor.
//!
//! The monitor deliberately keeps three concerns separate:
//!
//! * dataplane liveness is decided from a bounded rolling window;
//! * host pressure is a hysteretic signal and never erases dataplane failures;
//! * recovery is owned by one native controller, not by a WebView timer.
//!
//! Only bounded, safe fields leave this module. Probe URLs, IP addresses,
//! subscription data, credentials and traffic metadata never enter the
//! snapshot or the incident ring.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::quality;
use crate::util::MutexExt;

const INITIAL_DELAY: Duration = Duration::from_secs(4);
const HEALTH_INTERVAL: Duration = Duration::from_secs(10);
const PRESSURE_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(6);
const CONTROL_API_TIMEOUT: Duration = Duration::from_millis(1_200);
const PRESSURE_RECOVERY_WAIT: Duration = Duration::from_secs(20);
const NATIVE_RECOVERY_WINDOW: Duration = Duration::from_secs(15 * 60);
// Один быстрый same-config restart полезен при зависшем userspace datapath.
// Повторять тот же конфиг на той же мёртвой ноде бессмысленно: после первой
// попытки отдаём восстановление WebView, который знает альтернативные ноды.
const NATIVE_RECOVERY_MAX: usize = 1;
// Если WebView завис и handoff никто не принял, native controller всё равно
// обязан завершить неисправный runtime fail-closed. Минуты хватает на три
// candidate probe и один полный reconnect, но она не оставляет чёрную дыру
// бесконечно.
const FRONTEND_HANDOFF_WAIT: Duration = Duration::from_secs(60);
const TERMINAL_CLEANUP_COOLDOWN: Duration = Duration::from_secs(60);
const TERMINAL_CLEANUP_WINDOW: Duration = Duration::from_secs(15 * 60);
const TERMINAL_CLEANUP_MAX: usize = 3;
const PROBE_WINDOW_SIZE: usize = 3;
const INCIDENT_RING_SIZE: usize = 32;

const PRESSURE_MEMORY_LOAD_PERCENT: u32 = 95;
const PRESSURE_MEMORY_LOAD_EXIT_PERCENT: u32 = 90;
const PRESSURE_AVAILABLE_PHYSICAL_BYTES: u64 = 512 * 1024 * 1024;
const PRESSURE_AVAILABLE_PHYSICAL_EXIT_BYTES: u64 = 1024 * 1024 * 1024;
const PRESSURE_AVAILABLE_COMMIT_BYTES: u64 = 512 * 1024 * 1024;
const PRESSURE_AVAILABLE_COMMIT_EXIT_BYTES: u64 = 1024 * 1024 * 1024;
const PRESSURE_SCHEDULER_MS: u64 = 1_500;
const PRESSURE_SCHEDULER_EXIT_MS: u64 = 500;
const PRESSURE_EXIT_SAMPLES: u8 = 3;

const HEALTH_EVENT: &str = "ninety:dataplane-health";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeWindowEntry {
    pub age_ms: u64,
    pub success: bool,
    pub reason: Option<String>,
    pub duration_ms: u64,
    pub bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentSnapshot {
    pub age_ms: u64,
    pub generation: u64,
    pub state: String,
    pub reason: Option<String>,
    pub scheduler_lateness_ms: u64,
    pub probe_duration_ms: Option<u64>,
    pub probe_outcome: Option<String>,
    pub host_pressure: bool,
    pub memory_load_percent: Option<u32>,
    pub available_memory_bytes: Option<u64>,
    pub available_commit_bytes: Option<u64>,
    pub available_pagefile_bytes: Option<u64>,
    pub cpu_load_percent: Option<u32>,
    pub recovery_action: Option<String>,
    pub recovery_outcome: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataplaneHealthSnapshot {
    /// Compatibility field for the existing frontend. `failed` is never
    /// replaced by `pressure`; pressure is exposed independently below.
    pub state: String,
    pub dataplane_state: String,
    pub reason: Option<String>,
    pub generation: u64,
    pub consecutive_failures: u32,
    pub consecutive_successes: u32,
    pub last_probe_ms: u64,
    pub last_probe_age_ms: Option<u64>,
    pub last_successful_probe_age_ms: Option<u64>,
    pub scheduler_lateness_ms: u64,
    pub host_pressure: bool,
    pub pressure_reason: Option<String>,
    pub pressure_since_age_ms: Option<u64>,
    pub memory_load_percent: Option<u32>,
    pub available_memory_bytes: Option<u64>,
    pub available_commit_bytes: Option<u64>,
    pub available_pagefile_bytes: Option<u64>,
    pub cpu_load_percent: Option<u32>,
    pub monitoring_mode: String,
    pub unmonitored_privacy_mode: bool,
    pub native_recovery_owner: String,
    pub native_recovery_state: String,
    pub native_recovery_attempts: u32,
    pub probe_window: Vec<ProbeWindowEntry>,
    pub incidents: Vec<IncidentSnapshot>,
}

impl Default for DataplaneHealthSnapshot {
    fn default() -> Self {
        Self {
            state: "inactive".into(),
            dataplane_state: "inactive".into(),
            reason: None,
            generation: 0,
            consecutive_failures: 0,
            consecutive_successes: 0,
            last_probe_ms: 0,
            last_probe_age_ms: None,
            last_successful_probe_age_ms: None,
            scheduler_lateness_ms: 0,
            host_pressure: false,
            pressure_reason: None,
            pressure_since_age_ms: None,
            memory_load_percent: None,
            available_memory_bytes: None,
            available_commit_bytes: None,
            available_pagefile_bytes: None,
            cpu_load_percent: None,
            monitoring_mode: "inactive".into(),
            unmonitored_privacy_mode: false,
            native_recovery_owner: "none".into(),
            native_recovery_state: "idle".into(),
            native_recovery_attempts: 0,
            probe_window: Vec::new(),
            incidents: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Default)]
struct ResourceSample {
    memory_load_percent: Option<u32>,
    available_memory_bytes: Option<u64>,
    available_commit_bytes: Option<u64>,
    available_pagefile_bytes: Option<u64>,
    cpu_load_percent: Option<u32>,
}

impl ResourceSample {
    fn pressure_entered(self, scheduler_lateness_ms: u64) -> bool {
        self.memory_load_percent
            .is_some_and(|value| value >= PRESSURE_MEMORY_LOAD_PERCENT)
            || self
                .available_memory_bytes
                .is_some_and(|value| value <= PRESSURE_AVAILABLE_PHYSICAL_BYTES)
            || self
                .available_commit_bytes
                .is_some_and(|value| value <= PRESSURE_AVAILABLE_COMMIT_BYTES)
            || scheduler_lateness_ms >= PRESSURE_SCHEDULER_MS
    }

    fn pressure_recovered(self, scheduler_lateness_ms: u64) -> bool {
        self.memory_load_percent
            .is_none_or(|value| value <= PRESSURE_MEMORY_LOAD_EXIT_PERCENT)
            && self
                .available_memory_bytes
                .is_none_or(|value| value >= PRESSURE_AVAILABLE_PHYSICAL_EXIT_BYTES)
            && self
                .available_commit_bytes
                .is_none_or(|value| value >= PRESSURE_AVAILABLE_COMMIT_EXIT_BYTES)
            && scheduler_lateness_ms <= PRESSURE_SCHEDULER_EXIT_MS
    }
}

#[derive(Clone)]
struct ProbeSample {
    at: Instant,
    success: bool,
    reason: Option<String>,
    duration_ms: u64,
    bytes: u64,
}

struct Incident {
    at: Instant,
    generation: u64,
    state: String,
    reason: Option<String>,
    scheduler_lateness_ms: u64,
    probe_duration_ms: Option<u64>,
    probe_outcome: Option<String>,
    host_pressure: bool,
    memory_load_percent: Option<u32>,
    available_memory_bytes: Option<u64>,
    available_commit_bytes: Option<u64>,
    available_pagefile_bytes: Option<u64>,
    cpu_load_percent: Option<u32>,
    recovery_action: Option<String>,
    recovery_outcome: Option<String>,
}

struct HealthInner {
    state: String,
    dataplane_state: String,
    reason: Option<String>,
    generation: u64,
    consecutive_failures: u32,
    consecutive_successes: u32,
    last_probe_at: Option<Instant>,
    last_successful_probe_at: Option<Instant>,
    last_probe_ms: u64,
    scheduler_lateness_ms: u64,
    host_pressure: bool,
    pressure_reason: Option<String>,
    pressure_since: Option<Instant>,
    pressure_exit_samples: u8,
    resources: ResourceSample,
    monitoring_mode: String,
    unmonitored_privacy_mode: bool,
    probe_window: VecDeque<ProbeSample>,
    incidents: VecDeque<Incident>,
    native_recovery_owner: String,
    native_recovery_state: String,
    native_recovery_attempts: u32,
    native_recovery_times: VecDeque<Instant>,
    frontend_handoff_since: Option<Instant>,
    terminal_cleanup_times: VecDeque<Instant>,
}

impl Default for HealthInner {
    fn default() -> Self {
        Self {
            state: "inactive".into(),
            dataplane_state: "inactive".into(),
            reason: None,
            generation: 0,
            consecutive_failures: 0,
            consecutive_successes: 0,
            last_probe_at: None,
            last_successful_probe_at: None,
            last_probe_ms: 0,
            scheduler_lateness_ms: 0,
            host_pressure: false,
            pressure_reason: None,
            pressure_since: None,
            pressure_exit_samples: 0,
            resources: ResourceSample::default(),
            monitoring_mode: "inactive".into(),
            unmonitored_privacy_mode: false,
            probe_window: VecDeque::with_capacity(PROBE_WINDOW_SIZE),
            incidents: VecDeque::with_capacity(INCIDENT_RING_SIZE),
            native_recovery_owner: "none".into(),
            native_recovery_state: "idle".into(),
            native_recovery_attempts: 0,
            native_recovery_times: VecDeque::new(),
            frontend_handoff_since: None,
            terminal_cleanup_times: VecDeque::new(),
        }
    }
}

/// Shared state is separate from task handles. A stale task can update neither
/// a later runtime generation nor its incident history.
pub struct DataplaneHealthState {
    inner: Mutex<HealthInner>,
    heartbeat_lateness_ms: AtomicU64,
}

impl Default for DataplaneHealthState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HealthInner::default()),
            heartbeat_lateness_ms: AtomicU64::new(0),
        }
    }
}

impl DataplaneHealthState {
    pub fn reset_active_for_runtime(
        &self,
        generation: u64,
        strict_privacy: bool,
        preserve_recovery_budget: bool,
    ) {
        let mut inner = self.inner.lock_recover();
        let old_attempts = if preserve_recovery_budget {
            inner.native_recovery_attempts
        } else {
            0
        };
        let old_times = if preserve_recovery_budget {
            inner.native_recovery_times.clone()
        } else {
            VecDeque::new()
        };
        let passive = strict_privacy;
        *inner = HealthInner {
            state: if passive {
                "unmonitoredPrivacyMode".into()
            } else {
                "unknown".into()
            },
            dataplane_state: if passive {
                "unmonitoredPrivacyMode".into()
            } else {
                "unknown".into()
            },
            generation,
            monitoring_mode: if passive {
                "privacy_passive".into()
            } else {
                "active_probe".into()
            },
            unmonitored_privacy_mode: passive,
            native_recovery_owner: "native".into(),
            native_recovery_attempts: old_attempts,
            native_recovery_times: old_times,
            ..HealthInner::default()
        };
    }

    pub fn reset_inactive(&self) {
        *self.inner.lock_recover() = HealthInner::default();
        self.heartbeat_lateness_ms.store(0, Ordering::SeqCst);
    }

    fn set_heartbeat_lateness(&self, generation: u64, lateness_ms: u64) {
        if self.inner.lock_recover().generation == generation {
            self.heartbeat_lateness_ms
                .store(lateness_ms, Ordering::SeqCst);
        }
    }

    fn heartbeat_lateness(&self) -> u64 {
        self.heartbeat_lateness_ms.load(Ordering::SeqCst)
    }

    pub fn snapshot(&self) -> DataplaneHealthSnapshot {
        let inner = self.inner.lock_recover();
        let now = Instant::now();
        DataplaneHealthSnapshot {
            state: inner.state.clone(),
            dataplane_state: inner.dataplane_state.clone(),
            reason: inner.reason.clone(),
            generation: inner.generation,
            consecutive_failures: inner.consecutive_failures,
            consecutive_successes: inner.consecutive_successes,
            last_probe_ms: inner.last_probe_ms,
            last_probe_age_ms: inner.last_probe_at.map(|at| elapsed_ms(now, at)),
            last_successful_probe_age_ms: inner
                .last_successful_probe_at
                .map(|at| elapsed_ms(now, at)),
            scheduler_lateness_ms: inner.scheduler_lateness_ms,
            host_pressure: inner.host_pressure,
            pressure_reason: inner.pressure_reason.clone(),
            pressure_since_age_ms: inner.pressure_since.map(|at| elapsed_ms(now, at)),
            memory_load_percent: inner.resources.memory_load_percent,
            available_memory_bytes: inner.resources.available_memory_bytes,
            available_commit_bytes: inner.resources.available_commit_bytes,
            available_pagefile_bytes: inner.resources.available_pagefile_bytes,
            cpu_load_percent: inner.resources.cpu_load_percent,
            monitoring_mode: inner.monitoring_mode.clone(),
            unmonitored_privacy_mode: inner.unmonitored_privacy_mode,
            native_recovery_owner: inner.native_recovery_owner.clone(),
            native_recovery_state: inner.native_recovery_state.clone(),
            native_recovery_attempts: inner.native_recovery_attempts,
            probe_window: inner
                .probe_window
                .iter()
                .map(|sample| ProbeWindowEntry {
                    age_ms: elapsed_ms(now, sample.at),
                    success: sample.success,
                    reason: sample.reason.clone(),
                    duration_ms: sample.duration_ms,
                    bytes: sample.bytes,
                })
                .collect(),
            incidents: inner
                .incidents
                .iter()
                .map(|incident| IncidentSnapshot {
                    age_ms: elapsed_ms(now, incident.at),
                    generation: incident.generation,
                    state: incident.state.clone(),
                    reason: incident.reason.clone(),
                    scheduler_lateness_ms: incident.scheduler_lateness_ms,
                    probe_duration_ms: incident.probe_duration_ms,
                    probe_outcome: incident.probe_outcome.clone(),
                    host_pressure: incident.host_pressure,
                    memory_load_percent: incident.memory_load_percent,
                    available_memory_bytes: incident.available_memory_bytes,
                    available_commit_bytes: incident.available_commit_bytes,
                    available_pagefile_bytes: incident.available_pagefile_bytes,
                    cpu_load_percent: incident.cpu_load_percent,
                    recovery_action: incident.recovery_action.clone(),
                    recovery_outcome: incident.recovery_outcome.clone(),
                })
                .collect(),
        }
    }

    fn set_resources(&self, generation: u64, resources: ResourceSample, scheduler: u64) {
        let mut inner = self.inner.lock_recover();
        if inner.generation != generation {
            return;
        }
        let pressure_was_active = inner.host_pressure;
        update_pressure(&mut inner, resources, scheduler);
        inner.scheduler_lateness_ms = scheduler;
        inner.resources = resources;
        if !pressure_was_active && inner.host_pressure {
            record_incident(
                &mut inner,
                generation,
                "pressure",
                Some("host_resource_pressure"),
                scheduler,
                Some("pressure_entered"),
                None,
                None,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn record_probe(
        &self,
        generation: u64,
        success: bool,
        reason: Option<&str>,
        duration_ms: u64,
        bytes: u64,
        resources: ResourceSample,
        scheduler: u64,
    ) {
        let mut inner = self.inner.lock_recover();
        if inner.generation != generation {
            return;
        }
        let pressure_was_active = inner.host_pressure;
        update_pressure(&mut inner, resources, scheduler);
        inner.scheduler_lateness_ms = scheduler;
        inner.resources = resources;
        if !pressure_was_active && inner.host_pressure {
            record_incident(
                &mut inner,
                generation,
                "pressure",
                Some("host_resource_pressure"),
                scheduler,
                Some("pressure_entered"),
                None,
                None,
            );
        }
        inner.last_probe_at = Some(Instant::now());
        inner.last_probe_ms = duration_ms;
        if success {
            inner.last_successful_probe_at = inner.last_probe_at;
            inner.consecutive_successes = inner.consecutive_successes.saturating_add(1);
            inner.consecutive_failures = 0;
        } else {
            inner.consecutive_failures = inner.consecutive_failures.saturating_add(1);
            inner.consecutive_successes = 0;
        }
        if inner.probe_window.len() == PROBE_WINDOW_SIZE {
            inner.probe_window.pop_front();
        }
        inner.probe_window.push_back(ProbeSample {
            at: Instant::now(),
            success,
            reason: reason.map(str::to_owned),
            duration_ms,
            bytes,
        });

        let failure_count = inner
            .probe_window
            .iter()
            .filter(|sample| {
                !sample.success && sample.reason.as_deref() != Some("probe_monitor_error")
            })
            .count();
        // Одна реальная передача данных уже доказывает liveness. Для fail-closed
        // решения, наоборот, требуем всё полное окно: два кратких сбоя внешних
        // endpoint'ов не должны ронять рабочий VPN через 15–20 секунд.
        if inner.consecutive_successes >= 1 {
            inner.dataplane_state = "healthy".into();
            inner.reason = None;
            inner.frontend_handoff_since = None;
            if inner.native_recovery_state == "handoff" {
                inner.native_recovery_state = "idle".into();
            }
        } else if inner.consecutive_failures >= PROBE_WINDOW_SIZE as u32
            && failure_count == PROBE_WINDOW_SIZE
        {
            inner.dataplane_state = "failed".into();
            inner.reason = reason.map(str::to_owned);
        } else {
            inner.dataplane_state = "suspect".into();
            inner.reason = reason.map(str::to_owned);
        }
        inner.state = if inner.dataplane_state == "failed" {
            "failed"
        } else if inner.host_pressure {
            "pressure"
        } else {
            inner.dataplane_state.as_str()
        }
        .into();
        let incident_state = inner.state.clone();
        let incident_reason = inner.reason.clone();
        record_incident(
            &mut inner,
            generation,
            &incident_state,
            incident_reason.as_deref(),
            scheduler,
            Some(if success { "success" } else { "failure" }),
            None,
            None,
        );
    }

    fn record_passive(
        &self,
        generation: u64,
        local_ok: bool,
        reason: Option<&str>,
        duration_ms: u64,
        resources: ResourceSample,
        scheduler: u64,
    ) {
        let mut inner = self.inner.lock_recover();
        if inner.generation != generation {
            return;
        }
        let pressure_was_active = inner.host_pressure;
        update_pressure(&mut inner, resources, scheduler);
        inner.scheduler_lateness_ms = scheduler;
        inner.resources = resources;
        if !pressure_was_active && inner.host_pressure {
            record_incident(
                &mut inner,
                generation,
                "pressure",
                Some("host_resource_pressure"),
                scheduler,
                Some("pressure_entered"),
                None,
                None,
            );
        }
        inner.last_probe_at = Some(Instant::now());
        inner.last_probe_ms = duration_ms;
        if local_ok {
            inner.last_successful_probe_at = inner.last_probe_at;
            inner.consecutive_successes = inner.consecutive_successes.saturating_add(1);
            inner.consecutive_failures = 0;
        } else {
            inner.consecutive_failures = inner.consecutive_failures.saturating_add(1);
            inner.consecutive_successes = 0;
        }
        inner.unmonitored_privacy_mode = true;
        inner.monitoring_mode = "privacy_passive".into();
        if inner.probe_window.len() == PROBE_WINDOW_SIZE {
            inner.probe_window.pop_front();
        }
        inner.probe_window.push_back(ProbeSample {
            at: Instant::now(),
            success: local_ok,
            reason: reason.map(str::to_owned),
            duration_ms,
            bytes: 0,
        });
        let failure_count = inner
            .probe_window
            .iter()
            .filter(|sample| !sample.success)
            .count();
        if inner.consecutive_successes >= 1 {
            inner.dataplane_state = "unmonitoredPrivacyMode".into();
            inner.reason = None;
        } else if inner.consecutive_failures >= PROBE_WINDOW_SIZE as u32
            && failure_count == PROBE_WINDOW_SIZE
        {
            inner.dataplane_state = "failed".into();
            inner.reason = reason.map(str::to_owned);
        } else {
            inner.dataplane_state = "suspect".into();
            inner.reason = reason.map(str::to_owned);
        }
        inner.state = if inner.dataplane_state == "failed" {
            "failed"
        } else if inner.host_pressure {
            "pressure"
        } else {
            inner.dataplane_state.as_str()
        }
        .into();
        let incident_state = inner.state.clone();
        let incident_reason = inner.reason.clone();
        record_incident(
            &mut inner,
            generation,
            &incident_state,
            incident_reason.as_deref(),
            scheduler,
            Some(if local_ok {
                "passive_ok"
            } else {
                "passive_failure"
            }),
            None,
            None,
        );
    }

    fn recovery_decision(&self, now: Instant) -> RecoveryDecision {
        let mut inner = self.inner.lock_recover();
        prune_recovery_times(&mut inner, now);
        if inner.native_recovery_state == "recovering" {
            return RecoveryDecision::Busy;
        }
        if inner.host_pressure {
            if let Some(since) = inner.pressure_since {
                if now.saturating_duration_since(since) < PRESSURE_RECOVERY_WAIT {
                    inner.native_recovery_state = "pressure_wait".into();
                    return RecoveryDecision::PressureWait;
                }
            } else {
                inner.native_recovery_state = "pressure_wait".into();
                return RecoveryDecision::PressureWait;
            }
        }
        if inner.native_recovery_times.len() >= NATIVE_RECOVERY_MAX {
            let since = *inner.frontend_handoff_since.get_or_insert(now);
            if now.saturating_duration_since(since) < FRONTEND_HANDOFF_WAIT {
                let entering = inner.native_recovery_state != "handoff";
                inner.native_recovery_state = "handoff".into();
                if entering {
                    let generation = inner.generation;
                    let incident_reason = inner.reason.clone();
                    let scheduler_lateness = inner.scheduler_lateness_ms;
                    record_incident(
                        &mut inner,
                        generation,
                        "handoff",
                        incident_reason.as_deref(),
                        scheduler_lateness,
                        None,
                        Some("frontend_candidate_recovery"),
                        Some("requested"),
                    );
                }
                return RecoveryDecision::FrontendHandoff;
            }
            inner.native_recovery_state = "exhausted".into();
            return RecoveryDecision::Exhausted;
        }
        inner.native_recovery_times.push_back(now);
        inner.native_recovery_attempts = inner.native_recovery_attempts.saturating_add(1);
        inner.native_recovery_state = "recovering".into();
        let generation = inner.generation;
        let incident_reason = inner.reason.clone();
        let scheduler_lateness = inner.scheduler_lateness_ms;
        record_incident(
            &mut inner,
            generation,
            "recovering",
            incident_reason.as_deref(),
            scheduler_lateness,
            None,
            Some("native_same_config_restart"),
            Some("started"),
        );
        RecoveryDecision::Allowed
    }

    fn terminal_cleanup_decision(&self, now: Instant) -> TerminalCleanupDecision {
        let mut inner = self.inner.lock_recover();
        while inner
            .terminal_cleanup_times
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= TERMINAL_CLEANUP_WINDOW)
        {
            inner.terminal_cleanup_times.pop_front();
        }
        if inner.native_recovery_state == "terminal"
            || inner.terminal_cleanup_times.len() >= TERMINAL_CLEANUP_MAX
        {
            return TerminalCleanupDecision::Exhausted;
        }
        if let Some(last) = inner.terminal_cleanup_times.back() {
            if now.saturating_duration_since(*last) < TERMINAL_CLEANUP_COOLDOWN {
                return TerminalCleanupDecision::Cooldown;
            }
        }

        inner.terminal_cleanup_times.push_back(now);
        inner.native_recovery_state = "terminal_cleanup".into();
        let generation = inner.generation;
        let incident_reason = inner.reason.clone();
        let scheduler_lateness = inner.scheduler_lateness_ms;
        record_incident(
            &mut inner,
            generation,
            "cleanup_error",
            incident_reason.as_deref(),
            scheduler_lateness,
            None,
            Some("fail_closed_cleanup"),
            Some("started"),
        );
        TerminalCleanupDecision::Allowed
    }

    pub fn native_recovery_failed(&self, generation: u64, reason: &str) {
        let mut inner = self.inner.lock_recover();
        if inner.generation != generation {
            return;
        }
        inner
            .frontend_handoff_since
            .get_or_insert_with(Instant::now);
        inner.native_recovery_state = "handoff".into();
        inner.state = if inner.dataplane_state == "failed" {
            "failed"
        } else {
            "cleanup_error"
        }
        .into();
        inner.reason = Some(reason.to_string());
        let incident_state = inner.state.clone();
        let incident_reason = inner.reason.clone();
        let scheduler_lateness = inner.scheduler_lateness_ms;
        record_incident(
            &mut inner,
            generation,
            &incident_state,
            incident_reason.as_deref(),
            scheduler_lateness,
            None,
            Some("native_same_config_restart"),
            Some("failed_retryable"),
        );
    }

    pub fn native_terminal_result(&self, generation: u64, cleanup_confirmed: bool) {
        let mut inner = self.inner.lock_recover();
        if inner.generation != generation {
            return;
        }
        inner.native_recovery_state = if cleanup_confirmed {
            "terminal"
        } else {
            "cleanup_error"
        }
        .into();
        inner.state = if cleanup_confirmed {
            "failed"
        } else {
            "cleanup_error"
        }
        .into();
        inner.reason = Some(
            if cleanup_confirmed {
                "all_candidates_failed"
            } else {
                "cleanup_error"
            }
            .into(),
        );
        let incident_state = inner.state.clone();
        let incident_reason = inner.reason.clone();
        let scheduler_lateness = inner.scheduler_lateness_ms;
        record_incident(
            &mut inner,
            generation,
            &incident_state,
            incident_reason.as_deref(),
            scheduler_lateness,
            None,
            Some("fail_closed_cleanup"),
            Some(if cleanup_confirmed {
                "confirmed"
            } else {
                "failed_retryable"
            }),
        );
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryDecision {
    Allowed,
    Busy,
    PressureWait,
    FrontendHandoff,
    Exhausted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalCleanupDecision {
    Allowed,
    Cooldown,
    Exhausted,
}

fn elapsed_ms(now: Instant, then: Instant) -> u64 {
    now.saturating_duration_since(then)
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn prune_recovery_times(inner: &mut HealthInner, now: Instant) {
    while inner
        .native_recovery_times
        .front()
        .is_some_and(|at| now.saturating_duration_since(*at) >= NATIVE_RECOVERY_WINDOW)
    {
        inner.native_recovery_times.pop_front();
    }
    if inner.native_recovery_times.is_empty() {
        inner.frontend_handoff_since = None;
    }
}

fn update_pressure(inner: &mut HealthInner, resources: ResourceSample, scheduler: u64) {
    let entered = resources.pressure_entered(scheduler);
    if !inner.host_pressure && entered {
        inner.host_pressure = true;
        inner.pressure_since = Some(Instant::now());
        inner.pressure_exit_samples = 0;
        inner.pressure_reason = Some(pressure_reason(resources, scheduler).into());
        return;
    }
    if inner.host_pressure {
        if resources.pressure_recovered(scheduler) {
            inner.pressure_exit_samples = inner.pressure_exit_samples.saturating_add(1);
            if inner.pressure_exit_samples >= PRESSURE_EXIT_SAMPLES {
                inner.host_pressure = false;
                inner.pressure_since = None;
                inner.pressure_reason = None;
                inner.pressure_exit_samples = 0;
            }
        } else {
            inner.pressure_exit_samples = 0;
            inner.pressure_reason = Some(pressure_reason(resources, scheduler).into());
        }
    }
}

fn pressure_reason(resources: ResourceSample, scheduler: u64) -> &'static str {
    if scheduler >= PRESSURE_SCHEDULER_MS {
        "scheduler_lateness"
    } else if resources
        .memory_load_percent
        .is_some_and(|value| value >= PRESSURE_MEMORY_LOAD_PERCENT)
    {
        "memory_load"
    } else if resources
        .available_commit_bytes
        .is_some_and(|value| value <= PRESSURE_AVAILABLE_COMMIT_BYTES)
    {
        "commit_available"
    } else {
        "physical_memory_available"
    }
}

#[allow(clippy::too_many_arguments)]
fn record_incident(
    inner: &mut HealthInner,
    generation: u64,
    state: &str,
    reason: Option<&str>,
    scheduler_lateness_ms: u64,
    probe_outcome: Option<&str>,
    recovery_action: Option<&str>,
    recovery_outcome: Option<&str>,
) {
    if inner.incidents.len() == INCIDENT_RING_SIZE {
        inner.incidents.pop_front();
    }
    inner.incidents.push_back(Incident {
        at: Instant::now(),
        generation,
        state: state.into(),
        reason: reason.map(str::to_owned),
        scheduler_lateness_ms,
        probe_duration_ms: inner.last_probe_at.map(|_| inner.last_probe_ms),
        probe_outcome: probe_outcome.map(str::to_owned),
        host_pressure: inner.host_pressure,
        memory_load_percent: inner.resources.memory_load_percent,
        available_memory_bytes: inner.resources.available_memory_bytes,
        available_commit_bytes: inner.resources.available_commit_bytes,
        available_pagefile_bytes: inner.resources.available_pagefile_bytes,
        cpu_load_percent: inner.resources.cpu_load_percent,
        recovery_action: recovery_action.map(str::to_owned),
        recovery_outcome: recovery_outcome.map(str::to_owned),
    });
}

#[cfg(target_os = "windows")]
fn resource_sample() -> ResourceSample {
    use windows::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    let Ok(()) = (unsafe { GlobalMemoryStatusEx(&mut status) }) else {
        return ResourceSample::default();
    };
    let mut performance = PERFORMANCE_INFORMATION {
        cb: std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32,
        ..Default::default()
    };
    let performance_cb = performance.cb;
    let available_commit_bytes =
        if unsafe { GetPerformanceInfo(&mut performance, performance_cb) }.is_ok() {
            Some(
                (performance
                    .CommitLimit
                    .saturating_sub(performance.CommitTotal) as u64)
                    .saturating_mul(performance.PageSize as u64),
            )
        } else {
            None
        };
    ResourceSample {
        memory_load_percent: Some(status.dwMemoryLoad),
        available_memory_bytes: Some(status.ullAvailPhys),
        available_commit_bytes,
        available_pagefile_bytes: Some(status.ullAvailPageFile),
        cpu_load_percent: None,
    }
}

#[cfg(not(target_os = "windows"))]
fn resource_sample() -> ResourceSample {
    ResourceSample::default()
}

fn publish(app: &AppHandle, health: &DataplaneHealthState) {
    let _ = app.emit(HEALTH_EVENT, health.snapshot());
}

fn local_reason(
    status: &crate::vpn::NativeRuntimeStatus,
    control_ok: bool,
) -> Option<&'static str> {
    if !status.running {
        Some("unknown_datapath_failure")
    } else if !status.xray_alive || !status.sidecars_alive {
        Some("required_sidecar_failed")
    } else if !status.clash_ready || !control_ok {
        Some("control_api_unreachable")
    } else {
        None
    }
}

async fn control_api_ok(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    matches!(
        tokio::time::timeout(
            CONTROL_API_TIMEOUT,
            crate::clash::clash_get_proxies_unchecked(port),
        )
        .await,
        Ok(Ok(_))
    )
}

/// Starts a monitor for one runtime generation. `probe_port=None` is still a
/// valid runtime: the native status/control checks remain useful, but no
/// arbitrary direct endpoint is introduced.
pub fn start_dataplane_watchdog(
    app: AppHandle,
    health: Arc<DataplaneHealthState>,
    generation_token: Arc<AtomicU64>,
    generation: u64,
    probe_port: Option<u16>,
    strict_privacy: bool,
    preserve_recovery_budget: bool,
    logs_disabled: bool,
) {
    generation_token.store(generation, Ordering::SeqCst);
    health.reset_active_for_runtime(generation, strict_privacy, preserve_recovery_budget);
    publish(&app, &health);

    // A deliberately tiny OS heartbeat. It measures scheduler lateness only;
    // it does not perform IO, logging, HTTPS, frontend IPC or channel sends.
    let heartbeat_token = generation_token.clone();
    let heartbeat_health = health.clone();
    std::thread::spawn(move || {
        let mut scheduled = Instant::now() + HEARTBEAT_INTERVAL;
        loop {
            if heartbeat_token.load(Ordering::SeqCst) != generation {
                break;
            }
            let now = Instant::now();
            if now < scheduled {
                std::thread::sleep(scheduled.duration_since(now));
            }
            if heartbeat_token.load(Ordering::SeqCst) != generation {
                break;
            }
            let late = elapsed_ms(Instant::now(), scheduled);
            heartbeat_health.set_heartbeat_lateness(generation, late);
            scheduled += HEARTBEAT_INTERVAL;
        }
    });

    if !logs_disabled {
        crate::vpn::append_runtime_diagnostic(
            &app,
            &format!(
                "monitoring: dataplane watchdog started generation={generation} mode={}",
                if strict_privacy {
                    "privacy_passive"
                } else {
                    "active"
                }
            ),
        );
    }

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        let mut next = Instant::now();
        let mut logged_state = String::from("unknown");

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
            let scheduler_lateness =
                elapsed_ms(started, scheduled).max(health.heartbeat_lateness());
            let resources = resource_sample();
            health.set_resources(generation, resources, scheduler_lateness);
            let status = crate::vpn::native_runtime_status(&app, generation);
            let control_ok = if status.clash_ready {
                control_api_ok(status.clash_port).await
            } else {
                false
            };

            if strict_privacy {
                let reason = local_reason(&status, control_ok);
                health.record_passive(
                    generation,
                    reason.is_none(),
                    reason,
                    started.elapsed().as_millis() as u64,
                    resources,
                    scheduler_lateness,
                );
            } else if let Some(reason) = local_reason(&status, control_ok) {
                health.record_probe(
                    generation,
                    false,
                    Some(reason),
                    started.elapsed().as_millis() as u64,
                    0,
                    resources,
                    scheduler_lateness,
                );
            } else if probe_port.is_none() {
                health.record_probe(
                    generation,
                    false,
                    Some("probe_inbound_unreachable"),
                    started.elapsed().as_millis() as u64,
                    0,
                    resources,
                    scheduler_lateness,
                );
            } else {
                let probe = tokio::time::timeout(
                    HEALTH_PROBE_TIMEOUT,
                    quality::probe_health_inner(probe_port),
                )
                .await;
                match probe {
                    Ok(Ok(result)) if result.ok => health.record_probe(
                        generation,
                        true,
                        None,
                        result.ms,
                        result.bytes,
                        resources,
                        scheduler_lateness,
                    ),
                    // HTTP-ответ с ошибочным статусом всё равно доказывает, что
                    // DNS/TCP/TLS и маршрут через активный outbound работают.
                    // Это отказ конкретного сервиса, а не мёртвый VPN.
                    Ok(Ok(result))
                        if result
                            .error
                            .as_deref()
                            .is_some_and(|error| error.starts_with("HTTP")) =>
                    {
                        health.record_probe(
                            generation,
                            true,
                            Some("probe_endpoint_rejected"),
                            result.ms,
                            result.bytes,
                            resources,
                            scheduler_lateness,
                        )
                    }
                    Ok(Ok(result)) => health.record_probe(
                        generation,
                        false,
                        Some("active_outbound_failed"),
                        result.ms,
                        result.bytes,
                        resources,
                        scheduler_lateness,
                    ),
                    // Ошибка сборки локального probe-клиента не является
                    // доказательством обрыва пользовательского dataplane.
                    Ok(Err(_)) => health.record_probe(
                        generation,
                        false,
                        Some("probe_monitor_error"),
                        started.elapsed().as_millis() as u64,
                        0,
                        resources,
                        scheduler_lateness,
                    ),
                    // Полный timeout обоих endpoint'ов — уже сигнал маршрута,
                    // но terminal решение всё равно потребует три подряд.
                    Err(_) => health.record_probe(
                        generation,
                        false,
                        Some("active_outbound_timeout"),
                        started.elapsed().as_millis() as u64,
                        0,
                        resources,
                        scheduler_lateness,
                    ),
                }
            }
            publish(&app, &health);

            let snapshot = health.snapshot();
            if !logs_disabled && snapshot.dataplane_state != logged_state {
                crate::vpn::append_runtime_diagnostic(
                    &app,
                    &format!(
                        "monitoring: dataplane generation={} state={} reason={} failures={} successes={} probe_ms={}",
                        snapshot.generation,
                        snapshot.dataplane_state,
                        snapshot.reason.as_deref().unwrap_or("none"),
                        snapshot.consecutive_failures,
                        snapshot.consecutive_successes,
                        snapshot.last_probe_ms,
                    ),
                );
                logged_state = snapshot.dataplane_state.clone();
            }
            let failed = snapshot.dataplane_state == "failed";
            if failed {
                match health.recovery_decision(Instant::now()) {
                    RecoveryDecision::Allowed => {
                        if !logs_disabled {
                            crate::vpn::append_runtime_diagnostic(
                                &app,
                                &format!(
                                    "monitoring: dataplane generation={generation} action=native_same_config_restart reason={}",
                                    snapshot.reason.as_deref().unwrap_or("unknown")
                                ),
                            );
                        }
                        publish(&app, &health);
                        let recovered =
                            crate::vpn::native_recover_current_runtime(&app, generation).await;
                        if recovered {
                            if !logs_disabled {
                                crate::vpn::append_runtime_diagnostic(
                                    &app,
                                    &format!(
                                        "monitoring: dataplane generation={generation} recovery=started_new_generation"
                                    ),
                                );
                            }
                            // A successful same-config restart starts a new
                            // monitor generation. The old coordinator exits.
                            break;
                        }
                        if !logs_disabled {
                            crate::vpn::append_runtime_diagnostic(
                                &app,
                                &format!(
                                    "monitoring: dataplane generation={generation} recovery=failed handoff=frontend"
                                ),
                            );
                        }
                        health.native_recovery_failed(generation, "native_recovery_failed");
                        publish(&app, &health);
                    }
                    RecoveryDecision::Exhausted => {
                        match health.terminal_cleanup_decision(Instant::now()) {
                            TerminalCleanupDecision::Allowed => {
                                let cleanup_confirmed =
                                    crate::vpn::native_terminal_fail_closed(&app, generation).await;
                                health.native_terminal_result(generation, cleanup_confirmed);
                                publish(&app, &health);
                                if cleanup_confirmed {
                                    break;
                                }
                            }
                            TerminalCleanupDecision::Cooldown
                            | TerminalCleanupDecision::Exhausted => {}
                        }
                    }
                    RecoveryDecision::FrontendHandoff => {
                        // WebView получает явный handoff через snapshot/event и
                        // пробует альтернативную ноду. Если он завис, по
                        // FRONTEND_HANDOFF_WAIT этот же coordinator перейдёт в
                        // bounded terminal cleanup.
                        publish(&app, &health);
                    }
                    RecoveryDecision::Busy | RecoveryDecision::PressureWait => {}
                }
            }

            let snapshot = health.snapshot();
            next = Instant::now()
                + if snapshot.host_pressure {
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

    fn sample(health: &DataplaneHealthState, generation: u64, ok: bool) {
        health.record_probe(
            generation,
            ok,
            if ok {
                None
            } else {
                Some("active_outbound_failed")
            },
            100,
            if ok { 16 * 1024 } else { 0 },
            ResourceSample::default(),
            0,
        );
    }

    #[test]
    fn default_health_is_inactive() {
        let health = DataplaneHealthState::default();
        assert_eq!(health.snapshot().state, "inactive");
    }

    #[test]
    fn active_health_starts_unknown_and_keeps_generation() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, false, false);
        let snapshot = health.snapshot();
        assert_eq!(snapshot.state, "unknown");
        assert_eq!(snapshot.generation, 42);
    }

    #[test]
    fn rolling_window_requires_three_consecutive_failures_and_one_success_recovers() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, false, false);
        sample(&health, 42, false);
        sample(&health, 42, true);
        sample(&health, 42, false);
        assert_eq!(health.snapshot().dataplane_state, "suspect");
        sample(&health, 42, false);
        sample(&health, 42, false);
        assert_eq!(health.snapshot().dataplane_state, "failed");
        sample(&health, 42, true);
        assert_eq!(health.snapshot().dataplane_state, "healthy");
        assert_eq!(health.snapshot().probe_window.len(), PROBE_WINDOW_SIZE);
    }

    #[test]
    fn one_success_is_enough_to_confirm_liveness() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, false, false);
        sample(&health, 42, true);
        assert_eq!(health.snapshot().dataplane_state, "healthy");
    }

    #[test]
    fn monitor_errors_never_become_dataplane_failure() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, false, false);
        for _ in 0..4 {
            health.record_probe(
                42,
                false,
                Some("probe_monitor_error"),
                10,
                0,
                ResourceSample::default(),
                0,
            );
        }
        assert_eq!(health.snapshot().dataplane_state, "suspect");
    }

    #[test]
    fn pressure_does_not_erase_dataplane_failure() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, false, false);
        sample(&health, 42, false);
        sample(&health, 42, false);
        sample(&health, 42, false);
        {
            let mut inner = health.inner.lock_recover();
            update_pressure(
                &mut inner,
                ResourceSample {
                    memory_load_percent: Some(99),
                    ..ResourceSample::default()
                },
                0,
            );
            inner.state = "failed".into();
        }
        let snapshot = health.snapshot();
        assert_eq!(snapshot.dataplane_state, "failed");
        assert!(snapshot.host_pressure);
    }

    #[test]
    fn pressure_incident_keeps_safe_resource_evidence() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, false, false);
        health.set_resources(
            42,
            ResourceSample {
                memory_load_percent: Some(99),
                available_memory_bytes: Some(128 * 1024 * 1024),
                available_commit_bytes: Some(256 * 1024 * 1024),
                available_pagefile_bytes: Some(512 * 1024 * 1024),
                cpu_load_percent: Some(97),
            },
            2_000,
        );
        let incident = health
            .snapshot()
            .incidents
            .pop()
            .expect("pressure incident");
        assert_eq!(incident.reason.as_deref(), Some("host_resource_pressure"));
        assert_eq!(incident.probe_duration_ms, None);
        assert_eq!(incident.memory_load_percent, Some(99));
        assert_eq!(incident.available_memory_bytes, Some(128 * 1024 * 1024));
        assert_eq!(incident.available_commit_bytes, Some(256 * 1024 * 1024));
        assert_eq!(incident.available_pagefile_bytes, Some(512 * 1024 * 1024));
        assert_eq!(incident.cpu_load_percent, Some(97));
    }

    #[test]
    fn strict_privacy_uses_explicit_passive_state() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, true, false);
        let initial = health.snapshot();
        assert_eq!(initial.state, "unmonitoredPrivacyMode");
        assert!(initial.unmonitored_privacy_mode);
        assert_eq!(initial.monitoring_mode, "privacy_passive");

        health.record_passive(
            42,
            false,
            Some("control_api_unreachable"),
            12,
            ResourceSample::default(),
            0,
        );
        assert_eq!(health.snapshot().dataplane_state, "suspect");
        health.record_passive(
            42,
            false,
            Some("control_api_unreachable"),
            12,
            ResourceSample::default(),
            0,
        );
        assert_eq!(health.snapshot().dataplane_state, "suspect");
        health.record_passive(
            42,
            false,
            Some("control_api_unreachable"),
            12,
            ResourceSample::default(),
            0,
        );
        let failed = health.snapshot();
        assert_eq!(failed.dataplane_state, "failed");
        assert_eq!(failed.reason.as_deref(), Some("control_api_unreachable"));
        assert!(failed.unmonitored_privacy_mode);
    }

    #[test]
    fn stale_generation_cannot_overwrite_new_runtime_health() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, false, false);
        sample(&health, 41, false);
        assert_eq!(health.snapshot().state, "unknown");
    }

    #[test]
    fn one_native_restart_hands_off_before_terminal_cleanup() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, false, false);
        sample(&health, 42, false);
        sample(&health, 42, false);
        sample(&health, 42, false);
        assert_eq!(
            health.recovery_decision(Instant::now()),
            RecoveryDecision::Allowed
        );
        health.native_recovery_failed(42, "test_failure");
        assert_eq!(
            health.recovery_decision(Instant::now()),
            RecoveryDecision::FrontendHandoff
        );
        let terminal_at = {
            let inner = health.inner.lock_recover();
            inner.frontend_handoff_since.unwrap() + FRONTEND_HANDOFF_WAIT
        };
        assert_eq!(
            health.recovery_decision(terminal_at),
            RecoveryDecision::Exhausted
        );
    }

    #[test]
    fn terminal_cleanup_is_retryable_but_bounded() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, false, false);
        let first = Instant::now();
        assert_eq!(
            health.terminal_cleanup_decision(first),
            TerminalCleanupDecision::Allowed
        );
        health.native_terminal_result(42, false);
        assert_eq!(
            health.terminal_cleanup_decision(first + Duration::from_secs(1)),
            TerminalCleanupDecision::Cooldown
        );

        let second = first + TERMINAL_CLEANUP_COOLDOWN;
        assert_eq!(
            health.terminal_cleanup_decision(second),
            TerminalCleanupDecision::Allowed
        );
        health.native_terminal_result(42, false);
        let third = second + TERMINAL_CLEANUP_COOLDOWN;
        assert_eq!(
            health.terminal_cleanup_decision(third),
            TerminalCleanupDecision::Allowed
        );
        health.native_terminal_result(42, false);

        assert_eq!(
            health.terminal_cleanup_decision(third + TERMINAL_CLEANUP_COOLDOWN),
            TerminalCleanupDecision::Exhausted
        );
        assert_eq!(health.snapshot().native_recovery_state, "cleanup_error");
    }

    #[test]
    fn incident_ring_is_bounded() {
        let health = DataplaneHealthState::default();
        health.reset_active_for_runtime(42, false, false);
        for _ in 0..(INCIDENT_RING_SIZE + 5) {
            sample(&health, 42, false);
        }
        assert_eq!(health.snapshot().incidents.len(), INCIDENT_RING_SIZE);
    }
}
