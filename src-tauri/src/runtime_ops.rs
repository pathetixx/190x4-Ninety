//! One authoritative owner for VPN runtime mutations.
//!
//! The WebView is allowed to request an operation, but it is never the source
//! of truth for whether a stop/start is still allowed.  A token is cheap to
//! copy over IPC and is checked by the native side after every await that can
//! otherwise let an old callback mutate a newer runtime generation.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use crate::util::MutexExt;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeOperationKind {
    UserConnect,
    UserDisconnect,
    SourceSwitch,
    NativeRecovery,
    FrontendRecovery,
    QualityRemediation,
}

impl RuntimeOperationKind {
    fn priority(self) -> u8 {
        match self {
            Self::UserDisconnect => 5,
            Self::SourceSwitch | Self::UserConnect => 4,
            Self::NativeRecovery => 3,
            Self::FrontendRecovery => 2,
            Self::QualityRemediation => 1,
        }
    }

    pub fn needs_transition_barrier(self) -> bool {
        matches!(
            self,
            Self::SourceSwitch
                | Self::NativeRecovery
                | Self::FrontendRecovery
                | Self::QualityRemediation
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOperationToken {
    pub id: u64,
    pub kind: RuntimeOperationKind,
    pub generation: u64,
    /// Safe identity supplied by the operation owner. This is deliberately
    /// kept separate from the diagnostic hash: a verifier must compare the
    /// active runtime with the exact source selected by the operation, not
    /// with a value read back from RuntimeSnapshot.
    pub expected_source_fingerprint: Option<String>,
    pub source_fingerprint_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOperationSnapshot {
    pub id: u64,
    pub kind: RuntimeOperationKind,
    pub generation: u64,
    pub expected_source_fingerprint: Option<String>,
    pub source_fingerprint_hash: Option<String>,
    pub started_at_ms: u64,
    pub cancelled: bool,
}

struct ActiveOperation {
    token: RuntimeOperationToken,
    started_at_ms: u64,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct RuntimeOperationCoordinator {
    next_id: AtomicU64,
    active: Mutex<Option<ActiveOperation>>,
}

impl RuntimeOperationCoordinator {
    /// Starts an operation or supersedes a lower-priority owner.  Equal
    /// priority source switches are intentionally latest-wins; other equal
    /// priority requests are rejected so accidental duplicate clicks cannot
    /// create a second lifecycle owner.
    pub fn begin(
        &self,
        kind: RuntimeOperationKind,
        generation: u64,
        source_fingerprint: Option<&str>,
    ) -> Result<RuntimeOperationToken, String> {
        let mut active = self.active.lock_recover();
        if let Some(current) = active.as_ref() {
            let supersedes = kind.priority() > current.token.kind.priority()
                || (kind == RuntimeOperationKind::SourceSwitch
                    && current.token.kind == RuntimeOperationKind::SourceSwitch)
                || (kind == RuntimeOperationKind::UserDisconnect
                    && current.token.kind != RuntimeOperationKind::UserDisconnect);
            if !supersedes {
                return Err(format!("runtime operation busy: {:?}", current.token.kind));
            }
            current.cancelled.store(true, Ordering::SeqCst);
        }

        let token = RuntimeOperationToken {
            id: self.next_id.fetch_add(1, Ordering::SeqCst) + 1,
            kind,
            generation,
            expected_source_fingerprint: source_fingerprint.map(str::to_string),
            source_fingerprint_hash: source_fingerprint.map(fingerprint_hash),
        };
        *active = Some(ActiveOperation {
            token: token.clone(),
            started_at_ms: now_ms(),
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        Ok(token)
    }

    pub fn authorize(&self, token: &RuntimeOperationToken) -> bool {
        let active = self.active.lock_recover();
        active.as_ref().is_some_and(|current| {
            current.token.id == token.id
                && current.token.kind == token.kind
                && current.token.generation == token.generation
                && current.token.expected_source_fingerprint == token.expected_source_fingerprint
                && current.token.source_fingerprint_hash == token.source_fingerprint_hash
                && !current.cancelled.load(Ordering::SeqCst)
        })
    }

    pub fn cancel(&self, token: &RuntimeOperationToken) -> bool {
        let mut active = self.active.lock_recover();
        let Some(current) = active.as_ref() else {
            return false;
        };
        if current.token != *token {
            return false;
        }
        current.cancelled.store(true, Ordering::SeqCst);
        // Removing it immediately matters for watchdog ownership: a cancelled
        // source/recovery must not keep suppressing a later, valid handoff
        // while its old async caller is still unwinding.
        *active = None;
        true
    }

    pub fn complete(&self, token: &RuntimeOperationToken) -> bool {
        let mut active = self.active.lock_recover();
        if active.as_ref().is_some_and(|current| {
            current.token == *token && !current.cancelled.load(Ordering::SeqCst)
        }) {
            *active = None;
            true
        } else {
            false
        }
    }

    pub fn snapshot(&self) -> Option<RuntimeOperationSnapshot> {
        self.active
            .lock_recover()
            .as_ref()
            .map(|current| RuntimeOperationSnapshot {
                id: current.token.id,
                kind: current.token.kind,
                generation: current.token.generation,
                expected_source_fingerprint: current.token.expected_source_fingerprint.clone(),
                source_fingerprint_hash: current.token.source_fingerprint_hash.clone(),
                started_at_ms: current.started_at_ms,
                cancelled: current.cancelled.load(Ordering::SeqCst),
            })
    }

    pub fn active_kind(&self) -> Option<RuntimeOperationKind> {
        self.active
            .lock_recover()
            .as_ref()
            .filter(|current| !current.cancelled.load(Ordering::SeqCst))
            .map(|current| current.token.kind)
    }
}

#[tauri::command]
pub fn begin_frontend_runtime_operation(
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, RuntimeOperationCoordinator>,
    kind: RuntimeOperationKind,
    generation: Option<u64>,
    source_fingerprint: Option<String>,
) -> Result<RuntimeOperationToken, String> {
    let previous = coordinator.snapshot();
    let result = coordinator.begin(kind, generation.unwrap_or(0), source_fingerprint.as_deref());
    match &result {
        Ok(token) => {
            if let Some(previous) = previous {
                if previous.id != token.id {
                    append_operation_diagnostic(
                        &app,
                        previous.id,
                        previous.kind,
                        previous.generation,
                        previous.source_fingerprint_hash.as_deref(),
                        "superseded",
                        None,
                    );
                }
            }
            append_operation_diagnostic(
                &app,
                token.id,
                token.kind,
                token.generation,
                token.source_fingerprint_hash.as_deref(),
                "acquired",
                None,
            );
        }
        Err(_) => append_operation_attempt_diagnostic(&app, kind, "coordinator_busy"),
    }
    result
}

#[tauri::command]
pub fn complete_frontend_runtime_operation(
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, RuntimeOperationCoordinator>,
    token: RuntimeOperationToken,
) -> bool {
    let completed = coordinator.complete(&token);
    append_operation_diagnostic(
        &app,
        token.id,
        token.kind,
        token.generation,
        token.source_fingerprint_hash.as_deref(),
        if completed { "completed" } else { "failed" },
        (!completed).then_some("stale_or_cancelled"),
    );
    completed
}

#[tauri::command]
pub fn cancel_frontend_runtime_operation(
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, RuntimeOperationCoordinator>,
    token: RuntimeOperationToken,
) -> bool {
    let cancelled = coordinator.cancel(&token);
    append_operation_diagnostic(
        &app,
        token.id,
        token.kind,
        token.generation,
        token.source_fingerprint_hash.as_deref(),
        if cancelled { "cancelled" } else { "failed" },
        (!cancelled).then_some("stale_or_superseded"),
    );
    cancelled
}

#[tauri::command]
pub fn runtime_operation_snapshot(
    coordinator: tauri::State<'_, RuntimeOperationCoordinator>,
) -> Option<RuntimeOperationSnapshot> {
    coordinator.snapshot()
}

fn append_operation_attempt_diagnostic(
    app: &tauri::AppHandle,
    kind: RuntimeOperationKind,
    reason: &str,
) {
    crate::vpn::append_runtime_diagnostic(
        app,
        &format!("runtime_operation kind={kind:?} event=failed reason={reason}"),
    );
}

fn append_operation_diagnostic(
    app: &tauri::AppHandle,
    id: u64,
    kind: RuntimeOperationKind,
    generation: u64,
    source_hash: Option<&str>,
    event: &str,
    reason: Option<&str>,
) {
    crate::vpn::append_runtime_diagnostic(
        app,
        &format!(
            "runtime_operation id={id} kind={kind:?} generation={generation} source_hash={} event={event} reason={}",
            source_hash.unwrap_or("none"),
            reason.unwrap_or("none"),
        ),
    );
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DataplaneProbeKind {
    SourceVerification,
    HealthProbe,
    QualityProbe,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProbeAcquireError {
    Busy,
    StaleGeneration,
}

/// A generation-scoped, one-permit dataplane gate.  Priority is enforced at
/// admission: low-priority work never waits behind higher-priority work,
/// health reports `ProbeBusy` rather than a route failure, and source
/// verification alone may wait for a short bounded interval.
pub struct DataplaneProbeCoordinator {
    generation: AtomicU64,
    permit: Arc<Semaphore>,
    waiters: Mutex<Vec<ProbeWaiter>>,
    next_waiter: AtomicU64,
    notify: Arc<Notify>,
}

#[derive(Clone, Copy)]
struct ProbeWaiter {
    ticket: u64,
    generation: u64,
    kind: DataplaneProbeKind,
}

impl DataplaneProbeKind {
    fn priority(self) -> u8 {
        match self {
            Self::SourceVerification => 3,
            Self::HealthProbe => 2,
            Self::QualityProbe => 1,
        }
    }
}

impl Default for DataplaneProbeCoordinator {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(0),
            permit: Arc::new(Semaphore::new(1)),
            waiters: Mutex::new(Vec::new()),
            next_waiter: AtomicU64::new(0),
            notify: Arc::new(Notify::new()),
        }
    }
}

pub struct DataplaneProbePermit {
    generation: u64,
    _permit: Option<OwnedSemaphorePermit>,
    notify: Arc<Notify>,
}

impl Drop for DataplaneProbePermit {
    fn drop(&mut self) {
        // Release before waking contenders.  If Notify fired while the
        // semaphore was still occupied, a waiter could consume the wake-up
        // and sleep forever until its bounded deadline.
        self._permit.take();
        self.notify.notify_waiters();
    }
}

impl DataplaneProbeCoordinator {
    pub fn reset_generation(&self, generation: u64) {
        self.generation.store(generation, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn invalidate(&self) {
        self.generation.store(0, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub async fn acquire(
        &self,
        kind: DataplaneProbeKind,
        generation: u64,
        wait_for: Option<std::time::Duration>,
    ) -> Result<DataplaneProbePermit, ProbeAcquireError> {
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err(ProbeAcquireError::StaleGeneration);
        }
        let Some(wait) = wait_for else {
            // Health and quality probes are deliberately non-blocking.  A
            // queued source verification (or any other queued probe) wins
            // admission instead of allowing a low-priority caller to starve it.
            {
                let mut waiters = self.waiters.lock_recover();
                waiters.retain(|waiter| waiter.generation == generation);
                if !waiters.is_empty() {
                    return Err(ProbeAcquireError::Busy);
                }
            }
            let Some(permit) = self.permit.clone().try_acquire_owned().ok() else {
                return Err(ProbeAcquireError::Busy);
            };
            if self.generation.load(Ordering::SeqCst) != generation {
                drop(permit);
                return Err(ProbeAcquireError::StaleGeneration);
            }
            return Ok(DataplaneProbePermit {
                generation,
                _permit: Some(permit),
                notify: self.notify.clone(),
            });
        };

        let ticket = self.next_waiter.fetch_add(1, Ordering::SeqCst) + 1;
        self.waiters.lock_recover().push(ProbeWaiter {
            ticket,
            generation,
            kind,
        });
        let deadline = tokio::time::Instant::now() + wait;

        loop {
            if self.generation.load(Ordering::SeqCst) != generation {
                self.remove_waiter(ticket);
                return Err(ProbeAcquireError::StaleGeneration);
            }

            let admitted = {
                let mut waiters = self.waiters.lock_recover();
                waiters.retain(|waiter| waiter.generation == generation);
                let best = waiters.iter().copied().max_by(|left, right| {
                    left.kind
                        .priority()
                        .cmp(&right.kind.priority())
                        .then_with(|| right.ticket.cmp(&left.ticket))
                });
                best.is_some_and(|candidate| candidate.ticket == ticket)
                    && self.permit.available_permits() > 0
            };

            if admitted {
                if let Ok(permit) = self.permit.clone().try_acquire_owned() {
                    self.remove_waiter(ticket);
                    if self.generation.load(Ordering::SeqCst) != generation {
                        drop(permit);
                        return Err(ProbeAcquireError::StaleGeneration);
                    }
                    return Ok(DataplaneProbePermit {
                        generation,
                        _permit: Some(permit),
                        notify: self.notify.clone(),
                    });
                }
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                self.remove_waiter(ticket);
                return Err(ProbeAcquireError::Busy);
            }
            let notified = self.notify.notified();
            if tokio::time::timeout(remaining, notified).await.is_err() {
                self.remove_waiter(ticket);
                return Err(ProbeAcquireError::Busy);
            }
        }
    }

    pub fn is_current(&self, permit: &DataplaneProbePermit) -> bool {
        self.generation.load(Ordering::SeqCst) == permit.generation
    }

    fn remove_waiter(&self, ticket: u64) {
        self.waiters
            .lock_recover()
            .retain(|waiter| waiter.ticket != ticket);
        self.notify.notify_waiters();
    }
}

pub fn fingerprint_hash(value: &str) -> String {
    // The value is diagnostic correlation only.  Never expose the source URL,
    // credentials, config, or node name.
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn higher_priority_cancels_lower_priority_operation() {
        let coordinator = RuntimeOperationCoordinator::default();
        let quality = coordinator
            .begin(RuntimeOperationKind::QualityRemediation, 7, Some("a"))
            .unwrap();
        let disconnect = coordinator
            .begin(RuntimeOperationKind::UserDisconnect, 7, Some("a"))
            .unwrap();
        assert!(!coordinator.authorize(&quality));
        assert!(coordinator.authorize(&disconnect));
    }

    #[test]
    fn latest_source_switch_supersedes_previous() {
        let coordinator = RuntimeOperationCoordinator::default();
        let first = coordinator
            .begin(RuntimeOperationKind::SourceSwitch, 1, Some("a"))
            .unwrap();
        let second = coordinator
            .begin(RuntimeOperationKind::SourceSwitch, 1, Some("b"))
            .unwrap();
        assert!(!coordinator.authorize(&first));
        assert!(coordinator.authorize(&second));
    }

    #[test]
    fn cancelling_operation_releases_watchdog_ownership() {
        let coordinator = RuntimeOperationCoordinator::default();
        let token = coordinator
            .begin(RuntimeOperationKind::NativeRecovery, 1, None)
            .unwrap();
        assert!(coordinator.cancel(&token));
        assert!(!coordinator.authorize(&token));
        assert!(coordinator.snapshot().is_none());
    }

    #[test]
    fn operation_token_keeps_owner_identity_and_rejects_tampering() {
        let coordinator = RuntimeOperationCoordinator::default();
        let token = coordinator
            .begin(
                RuntimeOperationKind::SourceSwitch,
                7,
                Some("target-fingerprint"),
            )
            .unwrap();
        assert_eq!(
            token.expected_source_fingerprint.as_deref(),
            Some("target-fingerprint")
        );
        assert!(coordinator.authorize(&token));

        let mut forged = token.clone();
        forged.expected_source_fingerprint = Some("other-fingerprint".into());
        assert!(!coordinator.authorize(&forged));
    }

    #[tokio::test]
    async fn source_verification_has_priority_over_queued_health_and_quality() {
        let coordinator = Arc::new(DataplaneProbeCoordinator::default());
        coordinator.reset_generation(7);
        let quality = coordinator
            .acquire(DataplaneProbeKind::QualityProbe, 7, None)
            .await
            .unwrap();
        let source_coordinator = coordinator.clone();
        let source = tokio::spawn(async move {
            source_coordinator
                .acquire(
                    DataplaneProbeKind::SourceVerification,
                    7,
                    Some(std::time::Duration::from_millis(250)),
                )
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(matches!(
            coordinator
                .acquire(DataplaneProbeKind::HealthProbe, 7, None)
                .await,
            Err(ProbeAcquireError::Busy)
        ));
        drop(quality);
        let source_permit = source.await.unwrap().unwrap();
        assert!(coordinator.is_current(&source_permit));
    }

    #[tokio::test]
    async fn queued_probe_becomes_stale_when_generation_changes() {
        let coordinator = Arc::new(DataplaneProbeCoordinator::default());
        coordinator.reset_generation(3);
        let held = coordinator
            .acquire(DataplaneProbeKind::QualityProbe, 3, None)
            .await
            .unwrap();
        let waiter = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .acquire(
                        DataplaneProbeKind::SourceVerification,
                        3,
                        Some(std::time::Duration::from_secs(1)),
                    )
                    .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        coordinator.reset_generation(4);
        drop(held);
        assert!(matches!(
            waiter.await.unwrap(),
            Err(ProbeAcquireError::StaleGeneration)
        ));
    }
}
