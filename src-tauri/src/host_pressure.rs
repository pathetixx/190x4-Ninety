// Ninety · сэмплер давления хоста.
//
// Зачем: liveness-сторож ловит только смерть ядра, движок качества — только
// деградацию канала. Между ними есть третий класс отказов: ядро живо, канал
// цел, но машине не хватает ресурсов (рендер видео, компиляция, игра). Тогда
// userspace-датаплейн не получает CPU вовремя, TUN-очереди не разгребаются,
// хендшейки истекают — и снаружи это выглядит как проблема сети.
//
// Без этого сигнала движок качества лечит локальную нехватку CPU сетевыми
// средствами: сменить ноду → исключить ноду → фрагментация с реконнектом. То
// есть самое дорогое действие ровно в тот момент, когда машине и так плохо, —
// и временный затык превращается в реальный обрыв. Модуль отвечает на один
// вопрос: «сейчас виноват хост?», и не имеет никаких прав на runtime.
//
// Наружу уходят только ограниченные числовые поля (проценты, байты, миллисекунды):
// ни адресов, ни данных подписок, ни метаданных трафика здесь не появляется.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::util::MutexExt;

// 2с: достаточно часто, чтобы поймать затык до того, как движок качества успеет
// отреагировать (его тик — 5с), и достаточно редко, чтобы стоимость трёх
// syscall'ов была неразличима.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);

// Вход в pressure требует двух подряд сэмплов (~4с): одиночный всплеск при
// запуске приложения не должен глушить анти-троттлинг, а вот устойчивая
// загрузка обязана. Выход — три подряд (~6с), чтобы не мигать на границе.
const ENTER_SAMPLES: u8 = 2;
const EXIT_SAMPLES: u8 = 3;

// Пороги входа/выхода разнесены намеренно (гистерезис): без разрыва состояние
// дребезжало бы на каждом сэмпле вокруг одной цифры.
const MEMORY_LOAD_PERCENT: u32 = 95;
const MEMORY_LOAD_EXIT_PERCENT: u32 = 90;
const AVAILABLE_PHYSICAL_BYTES: u64 = 512 * 1024 * 1024;
const AVAILABLE_PHYSICAL_EXIT_BYTES: u64 = 1024 * 1024 * 1024;
const AVAILABLE_COMMIT_BYTES: u64 = 512 * 1024 * 1024;
const AVAILABLE_COMMIT_EXIT_BYTES: u64 = 1024 * 1024 * 1024;
const SCHEDULER_MS: u64 = 1_500;
const SCHEDULER_EXIT_MS: u64 = 500;
const CPU_LOAD_PERCENT: u32 = 95;
const CPU_LOAD_EXIT_PERCENT: u32 = 85;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResourceSample {
    pub memory_load_percent: Option<u32>,
    pub available_memory_bytes: Option<u64>,
    pub available_commit_bytes: Option<u64>,
    pub cpu_load_percent: Option<u32>,
}

impl ResourceSample {
    fn over_enter_threshold(self, scheduler_lateness_ms: u64) -> bool {
        self.memory_load_percent
            .is_some_and(|value| value >= MEMORY_LOAD_PERCENT)
            || self
                .available_memory_bytes
                .is_some_and(|value| value <= AVAILABLE_PHYSICAL_BYTES)
            || self
                .available_commit_bytes
                .is_some_and(|value| value <= AVAILABLE_COMMIT_BYTES)
            || self
                .cpu_load_percent
                .is_some_and(|value| value >= CPU_LOAD_PERCENT)
            || scheduler_lateness_ms >= SCHEDULER_MS
    }

    // Неизвестная метрика (None) выходу не мешает: сэмплер мог не получить
    // счётчик, и это не повод держать pressure вечно.
    fn under_exit_threshold(self, scheduler_lateness_ms: u64) -> bool {
        self.memory_load_percent
            .is_none_or(|value| value <= MEMORY_LOAD_EXIT_PERCENT)
            && self
                .available_memory_bytes
                .is_none_or(|value| value >= AVAILABLE_PHYSICAL_EXIT_BYTES)
            && self
                .available_commit_bytes
                .is_none_or(|value| value >= AVAILABLE_COMMIT_EXIT_BYTES)
            && self
                .cpu_load_percent
                .is_none_or(|value| value <= CPU_LOAD_EXIT_PERCENT)
            && scheduler_lateness_ms <= SCHEDULER_EXIT_MS
    }

    fn reason(self, scheduler_lateness_ms: u64) -> &'static str {
        if scheduler_lateness_ms >= SCHEDULER_MS {
            "scheduler_lateness"
        } else if self
            .cpu_load_percent
            .is_some_and(|value| value >= CPU_LOAD_PERCENT)
        {
            "cpu_load"
        } else if self
            .memory_load_percent
            .is_some_and(|value| value >= MEMORY_LOAD_PERCENT)
        {
            "memory_load"
        } else if self
            .available_commit_bytes
            .is_some_and(|value| value <= AVAILABLE_COMMIT_BYTES)
        {
            "commit_available"
        } else {
            "physical_memory_available"
        }
    }
}

/// Снимок для фронта. Уезжает полем `host_pressure` внутри `health_snapshot`,
/// поэтому имена полей — snake_case, как у соседей в этом ответе.
#[derive(Clone, Debug, Default, Serialize)]
pub struct HostPressureSnapshot {
    pub active: bool,
    pub reason: Option<&'static str>,
    pub cpu_load_percent: Option<u32>,
    pub memory_load_percent: Option<u32>,
    pub available_memory_bytes: Option<u64>,
    pub scheduler_lateness_ms: u64,
    /// Счётчик снятых сэмплов. Ноль на живом подключении означает, что сэмплер
    /// не поднялся, — фронт тогда не должен считать «давления нет» фактом.
    pub samples: u64,
}

#[derive(Default)]
struct Inner {
    snapshot: HostPressureSnapshot,
    enter_samples: u8,
    exit_samples: u8,
}

/// Общий стейт сэмплера. Клонируется дёшево: сама Tauri держит один экземпляр
/// как managed state, фоновая задача — второй.
#[derive(Clone, Default)]
pub struct HostPressureState {
    inner: Arc<Mutex<Inner>>,
}

impl HostPressureState {
    pub fn snapshot(&self) -> HostPressureSnapshot {
        self.inner.lock_recover().snapshot.clone()
    }

    /// Чистый переход состояния — вся логика гистерезиса живёт здесь, чтобы
    /// её можно было прогнать тестами без Windows API.
    pub fn observe(&self, resources: ResourceSample, scheduler_lateness_ms: u64) -> bool {
        let mut inner = self.inner.lock_recover();
        let over = resources.over_enter_threshold(scheduler_lateness_ms);
        let under = resources.under_exit_threshold(scheduler_lateness_ms);

        if inner.snapshot.active {
            inner.enter_samples = 0;
            if under {
                inner.exit_samples = inner.exit_samples.saturating_add(1);
                if inner.exit_samples >= EXIT_SAMPLES {
                    inner.snapshot.active = false;
                    inner.snapshot.reason = None;
                    inner.exit_samples = 0;
                }
            } else {
                inner.exit_samples = 0;
                inner.snapshot.reason = Some(resources.reason(scheduler_lateness_ms));
            }
        } else if over {
            inner.enter_samples = inner.enter_samples.saturating_add(1);
            if inner.enter_samples >= ENTER_SAMPLES {
                inner.snapshot.active = true;
                inner.snapshot.reason = Some(resources.reason(scheduler_lateness_ms));
                inner.enter_samples = 0;
                inner.exit_samples = 0;
            }
        } else {
            inner.enter_samples = 0;
        }

        inner.snapshot.cpu_load_percent = resources.cpu_load_percent;
        inner.snapshot.memory_load_percent = resources.memory_load_percent;
        inner.snapshot.available_memory_bytes = resources.available_memory_bytes;
        inner.snapshot.scheduler_lateness_ms = scheduler_lateness_ms;
        inner.snapshot.samples = inner.snapshot.samples.saturating_add(1);
        inner.snapshot.active
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CpuCounters {
    idle: u64,
    kernel: u64,
    user: u64,
}

/// Дельта системных счётчиков CPU. Kernel-время включает idle, поэтому занято =
/// `kernel + user - idle`. Обнулившиеся или уехавшие назад счётчики дают None,
/// а не выдуманную нагрузку: лучше «неизвестно», чем ложное давление.
fn cpu_load_from_deltas(previous: CpuCounters, current: CpuCounters) -> Option<u32> {
    let idle = current.idle.checked_sub(previous.idle)?;
    let kernel = current.kernel.checked_sub(previous.kernel)?;
    let user = current.user.checked_sub(previous.user)?;
    let total = kernel.checked_add(user)?;
    if total == 0 || idle > total {
        return None;
    }
    let busy = total - idle;
    Some(
        busy.saturating_mul(100)
            .checked_div(total)
            .unwrap_or(0)
            .min(100) as u32,
    )
}

#[cfg(target_os = "windows")]
fn resource_sample() -> ResourceSample {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::GetSystemTimes;

    static PREVIOUS_CPU: Mutex<Option<CpuCounters>> = Mutex::new(None);

    fn filetime(value: FILETIME) -> u64 {
        (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
    }

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

    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let cpu_load_percent =
        if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_ok() {
            let current = CpuCounters {
                idle: filetime(idle),
                kernel: filetime(kernel),
                user: filetime(user),
            };
            let mut previous = PREVIOUS_CPU.lock_recover();
            let load = (*previous).and_then(|old| cpu_load_from_deltas(old, current));
            *previous = Some(current);
            load
        } else {
            None
        };

    ResourceSample {
        memory_load_percent: Some(status.dwMemoryLoad),
        available_memory_bytes: Some(status.ullAvailPhys),
        available_commit_bytes,
        cpu_load_percent,
    }
}

#[cfg(not(target_os = "windows"))]
fn resource_sample() -> ResourceSample {
    ResourceSample::default()
}

/// Поднимает фоновой сэмплер на всё время жизни приложения. Он ничем не владеет
/// и ничего не останавливает — только считает.
pub fn start(state: HostPressureState) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(SAMPLE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // первый тик срабатывает мгновенно
        let mut previous = std::time::Instant::now();
        loop {
            ticker.tick().await;
            let now = std::time::Instant::now();
            // Собственное опоздание таймера — самый прямой индикатор того, что
            // процессу не дают CPU. MissedTickBehavior::Delay гарантирует, что
            // тики не «догоняют» пачкой и опоздание не схлопывается в ноль.
            let lateness = now
                .duration_since(previous)
                .saturating_sub(SAMPLE_INTERVAL)
                .as_millis() as u64;
            previous = now;
            state.observe(resource_sample(), lateness);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cpu(percent: u32) -> ResourceSample {
        ResourceSample {
            cpu_load_percent: Some(percent),
            memory_load_percent: Some(40),
            available_memory_bytes: Some(8 * 1024 * 1024 * 1024),
            available_commit_bytes: Some(8 * 1024 * 1024 * 1024),
        }
    }

    #[test]
    fn single_spike_does_not_enter_pressure() {
        let state = HostPressureState::default();
        assert!(!state.observe(cpu(99), 0));
        assert!(!state.observe(cpu(10), 0));
        assert!(!state.snapshot().active);
    }

    #[test]
    fn sustained_load_enters_pressure_and_names_the_reason() {
        let state = HostPressureState::default();
        assert!(!state.observe(cpu(99), 0));
        assert!(state.observe(cpu(97), 0));
        let snapshot = state.snapshot();
        assert!(snapshot.active);
        assert_eq!(snapshot.reason, Some("cpu_load"));
        assert_eq!(snapshot.cpu_load_percent, Some(97));
    }

    #[test]
    fn hysteresis_band_keeps_pressure_active() {
        let state = HostPressureState::default();
        state.observe(cpu(99), 0);
        assert!(state.observe(cpu(99), 0));
        // 90% ниже порога входа, но выше порога выхода: ни туда, ни обратно.
        for _ in 0..5 {
            assert!(state.observe(cpu(90), 0));
        }
    }

    #[test]
    fn three_clean_samples_exit_pressure() {
        let state = HostPressureState::default();
        state.observe(cpu(99), 0);
        assert!(state.observe(cpu(99), 0));
        assert!(state.observe(cpu(10), 0));
        assert!(state.observe(cpu(10), 0));
        assert!(!state.observe(cpu(10), 0));
        assert_eq!(state.snapshot().reason, None);
    }

    #[test]
    fn interrupted_recovery_restarts_the_exit_streak() {
        let state = HostPressureState::default();
        state.observe(cpu(99), 0);
        state.observe(cpu(99), 0);
        state.observe(cpu(10), 0);
        state.observe(cpu(10), 0);
        assert!(state.observe(cpu(99), 0));
        assert!(state.observe(cpu(10), 0));
        assert!(state.observe(cpu(10), 0));
        assert!(!state.observe(cpu(10), 0));
    }

    #[test]
    fn scheduler_lateness_alone_is_enough() {
        let state = HostPressureState::default();
        assert!(!state.observe(cpu(5), 2_000));
        assert!(state.observe(cpu(5), 1_800));
        assert_eq!(state.snapshot().reason, Some("scheduler_lateness"));
    }

    #[test]
    fn missing_counters_never_manufacture_pressure() {
        let state = HostPressureState::default();
        for _ in 0..4 {
            assert!(!state.observe(ResourceSample::default(), 0));
        }
        assert_eq!(state.snapshot().samples, 4);
    }

    #[test]
    fn low_memory_enters_even_with_idle_cpu() {
        let state = HostPressureState::default();
        let starved = ResourceSample {
            cpu_load_percent: Some(3),
            memory_load_percent: Some(97),
            available_memory_bytes: Some(200 * 1024 * 1024),
            available_commit_bytes: Some(200 * 1024 * 1024),
        };
        assert!(!state.observe(starved, 0));
        assert!(state.observe(starved, 0));
        assert_eq!(state.snapshot().reason, Some("memory_load"));
    }

    #[test]
    fn cpu_delta_ignores_wrapped_or_empty_counters() {
        let base = CpuCounters {
            idle: 100,
            kernel: 200,
            user: 100,
        };
        assert_eq!(cpu_load_from_deltas(base, base), None);
        assert_eq!(
            cpu_load_from_deltas(
                base,
                CpuCounters {
                    idle: 50,
                    kernel: 300,
                    user: 200,
                }
            ),
            None
        );
    }

    #[test]
    fn cpu_delta_reports_busy_share() {
        let previous = CpuCounters {
            idle: 1_000,
            kernel: 2_000,
            user: 1_000,
        };
        // kernel+user выросли на 200, idle — на 20: занято 90%.
        let current = CpuCounters {
            idle: 1_020,
            kernel: 2_100,
            user: 1_100,
        };
        assert_eq!(cpu_load_from_deltas(previous, current), Some(90));
    }
}
