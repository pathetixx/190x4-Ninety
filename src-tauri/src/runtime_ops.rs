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
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOperationToken {
    pub id: u64,
    pub kind: RuntimeOperationKind,
    pub generation: u64,
    pub source_fingerprint_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOperationSnapshot {
    pub id: u64,
    pub kind: RuntimeOperationKind,
    pub generation: u64,
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
                && !current.cancelled.load(Ordering::SeqCst)
        })
    }

    pub fn cancel(&self, token: &RuntimeOperationToken) -> bool {
        let mut active = self.active.lock_recover();
        let Some(current) = active.as_ref() else {
            return false;
        };
        if current.token.id != token.id {
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
            current.token.id == token.id && !current.cancelled.load(Ordering::SeqCst)
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
    coordinator: tauri::State<'_, RuntimeOperationCoordinator>,
    kind: RuntimeOperationKind,
    generation: Option<u64>,
    source_fingerprint: Option<String>,
) -> Result<RuntimeOperationToken, String> {
    coordinator.begin(kind, generation.unwrap_or(0), source_fingerprint.as_deref())
}

#[tauri::command]
pub fn complete_frontend_runtime_operation(
    coordinator: tauri::State<'_, RuntimeOperationCoordinator>,
    token: RuntimeOperationToken,
) -> bool {
    coordinator.complete(&token)
}

#[tauri::command]
pub fn cancel_frontend_runtime_operation(
    coordinator: tauri::State<'_, RuntimeOperationCoordinator>,
    token: RuntimeOperationToken,
) -> bool {
    coordinator.cancel(&token)
}

#[tauri::command]
pub fn runtime_operation_snapshot(
    coordinator: tauri::State<'_, RuntimeOperationCoordinator>,
) -> Option<RuntimeOperationSnapshot> {
    coordinator.snapshot()
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
}

impl Default for DataplaneProbeCoordinator {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(0),
            permit: Arc::new(Semaphore::new(1)),
        }
    }
}

pub struct DataplaneProbePermit {
    generation: u64,
    _permit: OwnedSemaphorePermit,
}

impl DataplaneProbeCoordinator {
    pub fn reset_generation(&self, generation: u64) {
        self.generation.store(generation, Ordering::SeqCst);
    }

    pub fn invalidate(&self) {
        self.generation.store(0, Ordering::SeqCst);
    }

    pub async fn acquire(
        &self,
        _kind: DataplaneProbeKind,
        generation: u64,
        wait_for: Option<std::time::Duration>,
    ) -> Result<DataplaneProbePermit, ProbeAcquireError> {
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err(ProbeAcquireError::StaleGeneration);
        }
        let acquired = match wait_for {
            Some(wait) => tokio::time::timeout(wait, self.permit.clone().acquire_owned())
                .await
                .ok()
                .and_then(Result::ok),
            None => self.permit.clone().try_acquire_owned().ok(),
        };
        let Some(permit) = acquired else {
            return Err(ProbeAcquireError::Busy);
        };
        if self.generation.load(Ordering::SeqCst) != generation {
            drop(permit);
            return Err(ProbeAcquireError::StaleGeneration);
        }
        Ok(DataplaneProbePermit {
            generation,
            _permit: permit,
        })
    }

    pub fn is_current(&self, permit: &DataplaneProbePermit) -> bool {
        self.generation.load(Ordering::SeqCst) == permit.generation
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
}
