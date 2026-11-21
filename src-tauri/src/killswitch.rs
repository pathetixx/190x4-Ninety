// Ninety · WFP kill switch (I.2) — EXPERIMENTAL, off by default.
//
// Purpose: when the core (sing-box/xray) crashes in proxy/systemProxy modes, traffic
// must not leak into the open network. We install WFP filters: BLOCK all outbound
// at ALE_AUTH_CONNECT except (a) loopback (apps talk to the local mixed proxy)
// and (b) Ninety engines by app-id — their sockets to the VPN server. There are several engines:
// it's not only sing-box.exe that makes external connections — with xhttp nodes
// xray.exe goes out, with naive/TT — naive.exe / trusttunnel_client.exe (sing-box reaches them
// via a loopback bridge). Permitting only sing-box would kill such nodes outright.
// If the core dies, its permit becomes useless, and block-all cuts direct
// egress → no leak. For regular TUN, sing-box's strict_route is enough.
// The high-level strict mode additionally passes the TUN interface name:
// then the permit covers all traffic Windows has bound to it. If the interface
// disappears, the permit no longer matches, while block-all stays active.
//
// Safety against a "permanent lock": we open the WFP engine with a DYNAMIC session — all objects
// are removed automatically when the handle is closed OR the Ninety process exits. So if the app
// crashes, the filters disappear on their own, and the network doesn't stay blocked forever.
//
// ⚠️ WARNING: raw FWPM FFI, NOT compiled locally (project rule — builds happen
// only in CI). The first CI run may require fixups of windows-rs field/constant
// names. The feature is off by default (general.killSwitch /
// privacy.strictTunnel) — it doesn't affect regular users until enabled manually.

use std::sync::Mutex;

use tauri::Manager;

use crate::util::MutexExt;

const ENGINE_NAMES: [&str; 8] = [
    "sing-box.exe",
    "sing-box-x86_64-pc-windows-msvc.exe",
    "xray.exe",
    "xray-x86_64-pc-windows-msvc.exe",
    "naive.exe",
    "naive-x86_64-pc-windows-msvc.exe",
    "trusttunnel_client.exe",
    "trusttunnel_client-x86_64-pc-windows-msvc.exe",
];

fn existing_engine_paths(dir: &std::path::Path) -> Vec<String> {
    ENGINE_NAMES
        .iter()
        .map(|name| dir.join(name))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

#[derive(Clone, Copy)]
struct KillSwitchLease {
    /// HANDLE is not Send/Sync — we store it as a number and restore it only inside
    /// the Windows implementation.
    handle: isize,
    /// Each dynamic session has its own sublayer: this lets us fully
    /// assemble the replacement before closing the old session, without a fail-open window.
    sublayer: u128,
    /// Two critical block-all filters (IPv4/IPv6) for the health check.
    block_filters: [u64; 2],
    /// A transition lease is an additional, temporary fail-closed barrier. It
    /// must remain armed after a failed restart; only verified final runtime
    /// policy is allowed to release it.
    transition: bool,
}

/// Active WFP dynamic sessions. Usually there is one. If Windows refused to
/// close the previous session after an atomic replacement, we keep its handle for
/// a repeated disarm instead of irreversibly losing control over the filters.
///
/// `health` is a short cache of the `is_active` answer. The check hits BFE with three
/// requests per session, and it is asked by `runtime_snapshot` (UI),
/// `health_snapshot` (the watchdog, every 5 s), and the dataplane verifier. The cache lives
/// fractions of a second and is reset on any change to the lease set, so
/// "rearmed → asked right away" still sees a fresh answer.
#[derive(Default)]
pub struct KillSwitchState {
    leases: Mutex<Vec<KillSwitchLease>>,
    health: Mutex<Option<HealthCache>>,
    version: std::sync::atomic::AtomicU64,
}

const HEALTH_CACHE: std::time::Duration = std::time::Duration::from_millis(1_500);

struct HealthCache {
    checked_at: std::time::Instant,
    active: bool,
    version: u64,
}

impl KillSwitchState {
    fn version(&self) -> u64 {
        self.version.load(std::sync::atomic::Ordering::SeqCst)
    }

    // Any mutation of the lease set invalidates the cache: an answer taken before it no longer
    // describes the policy in effect.
    fn bump_version(&self) {
        self.version
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.health.lock_recover() = None;
    }

    fn cached_health(&self, version: u64) -> Option<bool> {
        self.health
            .lock_recover()
            .as_ref()
            .filter(|cache| cache.version == version && cache.checked_at.elapsed() < HEALTH_CACHE)
            .map(|cache| cache.active)
    }

    fn store_health(&self, active: bool, version: u64) {
        if self.version() != version {
            return; // the lease set changed while the check was running
        }
        *self.health.lock_recover() = Some(HealthCache {
            checked_at: std::time::Instant::now(),
            active,
            version,
        });
    }
}

/// Internal arm variant for native recovery. It deliberately takes the same
/// policy contract as the IPC command so that recovery doesn't bypass the WFP barrier.
pub(crate) fn arm_policy(
    state: &KillSwitchState,
    allow_lan: Option<bool>,
    tun_interface: Option<String>,
    strict_tunnel: Option<bool>,
) -> Result<(), String> {
    // allow_lan=true (by default — tied to route.bypassLan in the frontend): along
    // with loopback we also let private subnets through so the armed block doesn't break printers/
    // NAS/local shares. DHCP is ALWAYS let through — otherwise the whole network breaks on lease renew
    // "for no apparent reason". Regular TUN doesn't need WFP; strict TUN passes
    // strict_tunnel=true and always installs the filter.
    let allow_lan = allow_lan.unwrap_or(true);
    state.bump_version();
    let mut guard = state.leases.lock_recover();
    #[cfg(target_os = "windows")]
    {
        let strict_tunnel = strict_tunnel.unwrap_or(false);
        let exes = engine_exe_paths(!strict_tunnel)?;
        let tun_interface = tun_interface
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if strict_tunnel {
            if allow_lan {
                return Err("strict kill switch forbids LAN exceptions".into());
            }
            if tun_interface.is_some_and(|alias| !alias.eq_ignore_ascii_case("ninety-tun")) {
                return Err("unexpected TUN interface name for strict mode".into());
            }
        } else if tun_interface.is_some() {
            return Err("a TUN interface is allowed only for the strict kill switch".into());
        }
        // First assemble the new dynamic session entirely. If any filter fails to
        // add, win::arm closes only the new session, and the old one keeps
        // blocking the network. After success, the swap and closing the old one are safe.
        let mut lease = unsafe { win::arm(&exes, allow_lan, tun_interface)? };
        lease.transition = false;
        // Take ONLY the user policy for replacement. The transitional
        // barrier lives separately: only transition_release may remove it,
        // and only after the new runtime has been verified. The old
        // `drain(..)` took it too, so the confirmation arrived into an already
        // empty set, and the actual policy during the replacement was weaker than
        // the barrier (allow_lan and the controller permit versus block-all without them).
        let previous: Vec<_> = guard
            .iter()
            .copied()
            .filter(|existing| !existing.transition)
            .collect();
        guard.retain(|existing| existing.transition);
        guard.push(lease);
        let mut close_errors = Vec::new();
        for previous in previous {
            if let Err(error) = unsafe { win::disarm(previous) } {
                guard.push(previous);
                close_errors.push(error);
            }
        }
        // An old preconnect filter next to a new connected filter can
        // keep blocking TUN because of the same sublayer weight. We don't
        // confirm readiness until the previous session is actually closed;
        // the handle is kept, so the next rearm/disarm can retry.
        if !close_errors.is_empty() {
            return Err(close_errors.join("; "));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (allow_lan, tun_interface, strict_tunnel);
        Err("kill switch is Windows-only".into())
    }
}

/// Arms a separate fail-closed WFP transition barrier.  This intentionally
/// does not replace the user's persistent policy: both leases coexist until a
/// new runtime has been verified and its final policy is confirmed.
pub(crate) fn transition_arm(state: &KillSwitchState, strict_tunnel: bool) -> Result<(), String> {
    state.bump_version();
    let mut guard = state.leases.lock_recover();
    #[cfg(target_os = "windows")]
    {
        if guard.iter().any(|lease| lease.transition) {
            return Ok(());
        }
        let exes = engine_exe_paths(false)?;
        // In strict TUN mode users' sockets are intentionally bound to the
        // virtual interface.  Keep that permit while replacing the runtime;
        // without it a temporary block-all would turn a safe transition into a
        // needless outage even though traffic cannot escape the TUN.
        let tun_interface = strict_tunnel.then_some("ninety-tun");
        let mut lease = match unsafe { win::arm(&exes, false, tun_interface) } {
            Ok(lease) => lease,
            // The Wintun adapter dies together with sing-box: after the core dies
            // there is nothing to bind the TUN permit to. Previously this broke the stop
            // before it even began, and recovery after core death in strict mode
            // never started at all. A barrier without the TUN permit is only stricter:
            // block-all without an exception for an interface that no longer exists.
            Err(error)
                if tun_interface.is_some() && error.starts_with("ConvertInterfaceAliasToLuid") =>
            unsafe { win::arm(&exes, false, None)? },
            Err(error) => return Err(error),
        };
        lease.transition = true;
        guard.push(lease);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &mut guard;
        Err("transition barrier is Windows-only".into())
    }
}

pub(crate) fn transition_active(state: &KillSwitchState) -> bool {
    state
        .leases
        .lock_recover()
        .iter()
        .any(|lease| lease.transition)
}

/// Whether there is an active USER policy (not a transitional barrier).
///
/// Needed by whoever decides to remove the barrier: in a strict session it may be released
/// only once the final fail-closed filter is already assembled, otherwise removing it would open
/// the very window the barrier was installed to close. Liveness of the set is not
/// checked here — `is_active` does that with its cache and the BFE probe.
pub(crate) fn policy_lease_active(state: &KillSwitchState) -> bool {
    state
        .leases
        .lock_recover()
        .iter()
        .any(|lease| !lease.transition)
}

/// Releases only temporary transition leases.  Call this solely after the
/// replacement runtime, identity, listener, dataplane and final user policy
/// have all been verified; failures deliberately preserve the barrier.
pub(crate) fn transition_release(state: &KillSwitchState) -> Result<(), String> {
    state.bump_version();
    let mut guard = state.leases.lock_recover();
    #[cfg(target_os = "windows")]
    {
        let transitions: Vec<_> = guard
            .iter()
            .copied()
            .filter(|lease| lease.transition)
            .collect();
        let mut errors = Vec::new();
        for lease in transitions {
            if let Err(error) = unsafe { win::disarm(lease) } {
                errors.push(error);
            } else if let Some(index) = guard.iter().position(|item| item.handle == lease.handle) {
                guard.remove(index);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &mut guard;
        Ok(())
    }
}

/// Enable or safely rearm the kill switch. The new WFP session is assembled
/// transactionally before closing the previous one. The permit goes to all Ninety engines
/// found next to our binary (Tauri puts the sidecars there too): a permit for
/// an exe that isn't running is inert, while a missing permit kills the protocol outright —
/// so we don't guess which nodes are in the active config.
///
/// The command is async + spawn_blocking on purpose: assembling a session means opening
/// the engine, a sublayer and ~20 FwpmFilterAdd0 calls in a transaction, all of them synchronous
/// RPCs to the BFE service. A synchronous command would run on the main thread, i.e.
/// it would freeze the window and WebView2 IPC exactly during the state transition.
#[tauri::command]
pub async fn killswitch_arm(
    app: tauri::AppHandle,
    allow_lan: Option<bool>,
    tun_interface: Option<String>,
    strict_tunnel: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KillSwitchState>();
        arm_policy(&state, allow_lan, tun_interface, strict_tunnel)
    })
    .await
    .map_err(|e| format!("waiting for the kill switch to turn on failed: {e}"))?
}

/// Disable the kill switch (remove all filters). Idempotent.
/// async + spawn_blocking for the same reason as `killswitch_arm`.
#[tauri::command]
pub async fn killswitch_disarm(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KillSwitchState>();
        disarm_policy(&state)
    })
    .await
    .map_err(|e| format!("waiting for the kill switch to turn off failed: {e}"))?
}

fn disarm_policy(state: &KillSwitchState) -> Result<(), String> {
    state.bump_version();
    let mut guard = state.leases.lock_recover();
    #[cfg(target_os = "windows")]
    {
        let leases: Vec<_> = guard.drain(..).collect();
        let mut errors = Vec::new();
        for lease in leases {
            if let Err(error) = unsafe { win::disarm(lease) } {
                guard.push(lease);
                errors.push(error);
            }
        }
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        guard.clear();
    }
    Ok(())
}

/// Whether the kill switch is active (for UI sync).
/// async + spawn_blocking: with a cold cache `is_active` hits BFE with three
/// requests per session — not a job for the main thread.
#[tauri::command]
pub async fn killswitch_active(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KillSwitchState>();
        is_active(&state)
    })
    .await
    .map_err(|e| format!("could not read the kill switch state: {e}"))
}

pub fn is_active(state: &KillSwitchState) -> bool {
    let version = state.version();
    if let Some(cached) = state.cached_health(version) {
        return cached;
    }
    let active = probe_active(state);
    state.store_health(active, version);
    active
}

// Live check: confirms the sublayer and both block filters of each session in BFE.
fn probe_active(state: &KillSwitchState) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut guard = state.leases.lock_recover();
        if guard.is_empty() {
            return false;
        }
        let leases: Vec<_> = guard.drain(..).collect();
        let before = leases.len();
        let mut any_alive = false;
        for lease in leases {
            if unsafe { win::session_alive(lease) } {
                any_alive = true;
                guard.push(lease);
            } else {
                // A BFE restart/loss of dynamic objects must not leave a false
                // true in runtime_snapshot. But on a Close0 error we don't lose the raw
                // handle: the next health check/disarm will retry the cleanup.
                if unsafe { win::disarm(lease) }.is_err() {
                    guard.push(lease);
                }
            }
        }
        let dropped = guard.len() != before;
        drop(guard);
        // Removing a dead session is the same kind of set mutation as arm/disarm.
        // Without a bump, a cache taken BEFORE it would formally describe a different set:
        // right now the answers match, but the invariant "any mutation invalidates the cache"
        // (see bump_version) only holds as long as it is observed everywhere.
        if dropped {
            state.bump_version();
        }
        any_alive
    }
    #[cfg(not(target_os = "windows"))]
    {
        !state.leases.lock_recover().is_empty()
    }
}

// Remove the engine on app exit (in case the frontend didn't get to it) — the filters
// go away with the process anyway (dynamic session), but we close it explicitly.
pub fn force_disarm(state: &KillSwitchState) {
    state.bump_version();
    let mut guard = state.leases.lock_recover();
    for lease in guard.drain(..) {
        #[cfg(target_os = "windows")]
        let _ = unsafe { win::disarm(lease) };
        #[cfg(not(target_os = "windows"))]
        let _ = lease;
    }
}

// All engines capable of making external connections (see externalBin in tauri.conf.json).
// Those missing on disk (e.g. a dev run without sidecars) are simply left out of
// the permit; if NOT A SINGLE one is found, it's an error: an armed block without a single permit
// would cut the network entirely, including the tunnel itself.
#[cfg(target_os = "windows")]
fn engine_exe_paths(include_controller: bool) -> Result<Vec<String>, String> {
    // Tauri CLI resolves `externalBin: ["binaries/sing-box", ...]` to target-
    // suffixed files in dev/build (`sing-box-x86_64-pc-windows-msvc.exe`).
    // Keep the short names too: they make local/manual sidecar layouts harmless.
    let self_exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = self_exe
        .parent()
        .ok_or("the exe has no parent directory")?
        .to_path_buf();
    let mut exes = existing_engine_paths(&dir);
    if exes.is_empty() {
        return Err(crate::util::i18n_error("backend.killSwitch.engineMissing"));
    }
    // The regular kill switch also lets Ninety through: in proxy/systemProxy its service
    // reqwest requests go direct. Strict TUN doesn't allow the controller —
    // updater/subscriptions/other fetches must go into the virtual interface.
    if include_controller {
        exes.push(self_exe.to_string_lossy().to_string());
    }
    Ok(exes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The cache must reflect exactly the lease set it was taken on: otherwise
    // after rearming, the UI and the verifier would see the previous answer.
    #[test]
    fn health_cache_is_scoped_to_the_lease_version() {
        let state = KillSwitchState::default();
        let version = state.version();
        assert_eq!(state.cached_health(version), None);
        state.store_health(true, version);
        assert_eq!(state.cached_health(version), Some(true));

        state.bump_version();
        assert_eq!(
            state.cached_health(state.version()),
            None,
            "мутация набора lease обязана сбрасывать кэш"
        );

        // An answer computed before the mutation must not be stored anymore.
        state.store_health(true, version);
        assert_eq!(state.cached_health(state.version()), None);
    }

    #[test]
    fn engine_discovery_only_returns_known_existing_binaries() {
        let dir =
            std::env::temp_dir().join(format!("ninety-killswitch-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sing-box.exe"), b"").unwrap();
        std::fs::write(dir.join("unrelated.exe"), b"").unwrap();
        let found = existing_engine_paths(&dir);
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("sing-box.exe"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(target_os = "windows")]
mod win {
    use rand_core::{OsRng, RngCore};
    use windows::core::{GUID, PCWSTR, PWSTR};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::NetworkManagement::IpHelper::ConvertInterfaceAliasToLuid;
    use windows::Win32::NetworkManagement::Ndis::NET_LUID_LH;
    use windows::Win32::NetworkManagement::WindowsFilteringPlatform::*;

    const AUTHN_DEFAULT: u32 = 0xFFFF_FFFF; // RPC_C_AUTHN_DEFAULT

    // FwpmEngineOpen0 isn't in the windows-rs bindings (its signature pulls in
    // SEC_WINNT_AUTH_IDENTITY_W, adding the feature didn't help) — we import the symbol
    // directly from fwpuclnt.dll via raw-dylib (independent of the windows-rs linking
    // mechanism). authidentity is passed as null.
    #[link(name = "fwpuclnt", kind = "raw-dylib")]
    extern "system" {
        fn FwpmEngineOpen0(
            servername: *const u16,
            authnservice: u32,
            authidentity: *const core::ffi::c_void,
            session: *const FWPM_SESSION0,
            enginehandle: *mut HANDLE,
        ) -> u32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub unsafe fn arm(
        exe_paths: &[String],
        allow_lan: bool,
        tun_interface: Option<&str>,
    ) -> Result<super::KillSwitchLease, String> {
        let tun_luid = tun_interface
            .map(|alias| unsafe { interface_luid(alias) })
            .transpose()?;
        let sublayer_id = random_sublayer_id()?;
        let sublayer = GUID::from_u128(sublayer_id);
        let mut engine = HANDLE::default();
        let mut session: FWPM_SESSION0 = std::mem::zeroed();
        session.flags = FWPM_SESSION_FLAG_DYNAMIC;
        let rc = FwpmEngineOpen0(
            std::ptr::null(),
            AUTHN_DEFAULT,
            std::ptr::null(),
            &session,
            &mut engine,
        );
        if rc != 0 {
            return Err(format!("FwpmEngineOpen0: {rc}"));
        }

        let tx_rc = FwpmTransactionBegin0(engine, 0);
        if tx_rc != 0 {
            let _ = FwpmEngineClose0(engine);
            return Err(format!("FwpmTransactionBegin0: {tx_rc}"));
        }
        let res = build_filters(engine, &sublayer, exe_paths, allow_lan, tun_luid);
        match res {
            Ok(block_filters) => {
                let commit_rc = FwpmTransactionCommit0(engine);
                if commit_rc != 0 {
                    let _ = FwpmTransactionAbort0(engine);
                    let _ = FwpmEngineClose0(engine);
                    return Err(format!("FwpmTransactionCommit0: {commit_rc}"));
                }
                Ok(super::KillSwitchLease {
                    handle: engine.0 as isize,
                    sublayer: sublayer_id,
                    block_filters,
                    transition: false,
                })
            }
            Err(e) => {
                let _ = FwpmTransactionAbort0(engine);
                let _ = FwpmEngineClose0(engine);
                Err(e)
            }
        }
    }

    pub unsafe fn disarm(lease: super::KillSwitchLease) -> Result<(), String> {
        // Closing the dynamic session handle removes all our filters/sublayer.
        let rc = FwpmEngineClose0(HANDLE(lease.handle as *mut core::ffi::c_void));
        if rc == 0 {
            Ok(())
        } else {
            Err(format!("FwpmEngineClose0: {rc}"))
        }
    }

    pub unsafe fn session_alive(lease: super::KillSwitchLease) -> bool {
        let engine = HANDLE(lease.handle as *mut core::ffi::c_void);
        let sublayer = GUID::from_u128(lease.sublayer);
        let mut sublayer_ptr: *mut FWPM_SUBLAYER0 = std::ptr::null_mut();
        let sublayer_rc = FwpmSubLayerGetByKey0(engine, &sublayer, &mut sublayer_ptr);
        let sublayer_found = !sublayer_ptr.is_null();
        if !sublayer_ptr.is_null() {
            let mut memory = sublayer_ptr.cast::<core::ffi::c_void>();
            FwpmFreeMemory0(&mut memory);
        }
        if sublayer_rc != 0 || !sublayer_found {
            return false;
        }
        for filter_id in lease.block_filters {
            let mut filter_ptr: *mut FWPM_FILTER0 = std::ptr::null_mut();
            let rc = FwpmFilterGetById0(engine, filter_id, &mut filter_ptr);
            let filter_found = !filter_ptr.is_null();
            if !filter_ptr.is_null() {
                let mut memory = filter_ptr.cast::<core::ffi::c_void>();
                FwpmFreeMemory0(&mut memory);
            }
            if rc != 0 || !filter_found {
                return false;
            }
        }
        true
    }

    fn random_sublayer_id() -> Result<u128, String> {
        loop {
            let mut bytes = [0u8; 16];
            OsRng
                .try_fill_bytes(&mut bytes)
                .map_err(|e| format!("could not get a random WFP GUID: {e}"))?;
            let value = u128::from_be_bytes(bytes);
            if value != 0 {
                return Ok(value);
            }
        }
    }

    unsafe fn build_filters(
        engine: HANDLE,
        sublayer_key: &GUID,
        exe_paths: &[String],
        allow_lan: bool,
        tun_luid: Option<u64>,
    ) -> Result<[u64; 2], String> {
        // sublayer
        let mut sname = wide("Ninety Kill Switch");
        let mut sub: FWPM_SUBLAYER0 = std::mem::zeroed();
        sub.subLayerKey = *sublayer_key;
        sub.displayData.name = PWSTR(sname.as_mut_ptr());
        sub.weight = 0x0100;
        let rc = FwpmSubLayerAdd0(engine, &sub, None);
        if rc != 0 {
            return Err(format!("FwpmSubLayerAdd0: {rc}"));
        }

        let layers = [
            FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
        ];

        // block-all (low weight). We keep the IDs and check them later: a live engine
        // handle without these filters is not an active kill switch.
        let block_filters = [
            add_filter(
                engine,
                sublayer_key,
                &layers[0],
                FWP_ACTION_BLOCK,
                0,
                &mut [],
            )?,
            add_filter(
                engine,
                sublayer_key,
                &layers[1],
                FWP_ACTION_BLOCK,
                0,
                &mut [],
            )?,
        ];
        // permit loopback (high weight)
        for layer in layers {
            let mut c = loopback_condition();
            add_filter(
                engine,
                sublayer_key,
                &layer,
                FWP_ACTION_PERMIT,
                15,
                std::slice::from_mut(&mut c),
            )?;
        }
        // Strict TUN: user traffic is allowed only after
        // Windows has bound the local route to ninety-tun. When the interface disappears,
        // the permit stops matching, while block-all keeps holding the network.
        if let Some(mut luid) = tun_luid {
            for layer in layers {
                let mut c = local_interface_condition(&mut luid);
                add_filter(
                    engine,
                    sublayer_key,
                    &layer,
                    FWP_ACTION_PERMIT,
                    15,
                    std::slice::from_mut(&mut c),
                )?;
            }
        }
        // permit DHCP (always): without it lease renew breaks the whole network. The DHCPv4 client
        // holds local UDP port 68, DHCPv6 — 546. Installed per matching layer.
        {
            let mut c4 = [
                protocol_condition(17),
                local_port_condition(68),
                remote_port_condition(67),
            ];
            add_filter(
                engine,
                sublayer_key,
                &FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                FWP_ACTION_PERMIT,
                14,
                &mut c4,
            )?;
            let mut c6 = [
                protocol_condition(17),
                local_port_condition(546),
                remote_port_condition(547),
            ];
            add_filter(
                engine,
                sublayer_key,
                &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                FWP_ACTION_PERMIT,
                14,
                &mut c6,
            )?;
        }
        // permit LAN (optional): private/link-local/broadcast/multicast subnets,
        // so the block doesn't cut printers, NAS and device discovery. bypassLan in
        // sing-box doesn't save these packets from bypassing the core — WFP's block-all cuts them.
        if allow_lan {
            permit_lan(engine, sublayer_key)?;
        }
        // permit each engine by app-id (high weight): sing-box + the
        // xray/naive/trusttunnel_client bridges — any of them makes external connections.
        for exe in exe_paths {
            let blob = app_id_blob(exe)?;
            let add_result = (|| {
                for layer in layers {
                    let mut c = appid_condition(blob);
                    add_filter(
                        engine,
                        sublayer_key,
                        &layer,
                        FWP_ACTION_PERMIT,
                        15,
                        std::slice::from_mut(&mut c),
                    )?;
                }
                Ok::<(), String>(())
            })();
            FwpmFreeMemory0(&mut (blob as *mut core::ffi::c_void));
            add_result?;
        }
        Ok(block_filters)
    }

    // Private IPv4 ranges (addr/mask in host order) + IPv6 unique-local and
    // link-local. broadcast/multicast — for DHCP offers, mDNS, SSDP discovery.
    unsafe fn permit_lan(engine: HANDLE, sublayer_key: &GUID) -> Result<(), String> {
        const V4: &[(u32, u32)] = &[
            (0x0A00_0000, 0xFF00_0000), // 10.0.0.0/8
            (0xAC10_0000, 0xFFF0_0000), // 172.16.0.0/12
            (0xC0A8_0000, 0xFFFF_0000), // 192.168.0.0/16
            (0xA9FE_0000, 0xFFFF_0000), // 169.254.0.0/16 link-local
            (0xE000_0000, 0xF000_0000), // 224.0.0.0/4 multicast
            (0xFFFF_FFFF, 0xFFFF_FFFF), // 255.255.255.255 broadcast
        ];
        for &(addr, mask) in V4 {
            let am = FWP_V4_ADDR_AND_MASK { addr, mask };
            let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
            c.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
            c.matchType = FWP_MATCH_EQUAL;
            c.conditionValue.r#type = FWP_V4_ADDR_MASK;
            c.conditionValue.Anonymous.v4AddrMask = &am as *const _ as *mut FWP_V4_ADDR_AND_MASK;
            add_filter(
                engine,
                sublayer_key,
                &FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                FWP_ACTION_PERMIT,
                12,
                std::slice::from_mut(&mut c),
            )?;
        }
        // IPv6: fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast).
        const V6: &[([u8; 16], u8)] = &[
            ([0xFC, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 7),
            ([0xFE, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10),
            ([0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 8),
        ];
        for &(addr, prefix) in V6 {
            let am = FWP_V6_ADDR_AND_MASK {
                addr,
                prefixLength: prefix,
            };
            let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
            c.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
            c.matchType = FWP_MATCH_EQUAL;
            c.conditionValue.r#type = FWP_V6_ADDR_MASK;
            c.conditionValue.Anonymous.v6AddrMask = &am as *const _ as *mut FWP_V6_ADDR_AND_MASK;
            add_filter(
                engine,
                sublayer_key,
                &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                FWP_ACTION_PERMIT,
                12,
                std::slice::from_mut(&mut c),
            )?;
        }
        Ok(())
    }

    // Condition "local port equals N" (for the DHCP permit).
    unsafe fn local_port_condition(port: u16) -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        c.fieldKey = FWPM_CONDITION_IP_LOCAL_PORT;
        c.matchType = FWP_MATCH_EQUAL;
        c.conditionValue.r#type = FWP_UINT16;
        c.conditionValue.Anonymous.uint16 = port;
        c
    }

    unsafe fn remote_port_condition(port: u16) -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        c.fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
        c.matchType = FWP_MATCH_EQUAL;
        c.conditionValue.r#type = FWP_UINT16;
        c.conditionValue.Anonymous.uint16 = port;
        c
    }

    unsafe fn protocol_condition(protocol: u8) -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        c.fieldKey = FWPM_CONDITION_IP_PROTOCOL;
        c.matchType = FWP_MATCH_EQUAL;
        c.conditionValue.r#type = FWP_UINT8;
        c.conditionValue.Anonymous.uint8 = protocol;
        c
    }

    unsafe fn local_interface_condition(luid: &mut u64) -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        // IP_LOCAL_INTERFACE is officially available on ALE_AUTH_CONNECT. The runtime
        // field NEXTHOP_INTERFACE exists, but a management filter condition for
        // this layer is not supported and FwpmFilterAdd0 rejects such a filter.
        c.fieldKey = FWPM_CONDITION_IP_LOCAL_INTERFACE;
        c.matchType = FWP_MATCH_EQUAL;
        c.conditionValue.r#type = FWP_UINT64;
        c.conditionValue.Anonymous.uint64 = luid as *mut u64;
        c
    }

    unsafe fn add_filter(
        engine: HANDLE,
        sublayer_key: &GUID,
        layer: &GUID,
        action: FWP_ACTION_TYPE,
        weight: u8,
        conds: &mut [FWPM_FILTER_CONDITION0],
    ) -> Result<u64, String> {
        let mut fname = wide("Ninety Kill Switch");
        let mut f: FWPM_FILTER0 = std::mem::zeroed();
        f.displayData.name = PWSTR(fname.as_mut_ptr());
        f.layerKey = *layer;
        f.subLayerKey = *sublayer_key;
        f.weight = val_u8(weight);
        f.action.r#type = action;
        if !conds.is_empty() {
            f.numFilterConditions = conds.len() as u32;
            f.filterCondition = conds.as_mut_ptr();
        }
        let mut filter_id = 0u64;
        let rc = FwpmFilterAdd0(engine, &f, None, Some(&mut filter_id));
        if rc != 0 {
            return Err(format!("FwpmFilterAdd0: {rc}"));
        }
        if filter_id == 0 {
            return Err("FwpmFilterAdd0 returned no filter id".into());
        }
        Ok(filter_id)
    }

    unsafe fn val_u8(v: u8) -> FWP_VALUE0 {
        let mut val: FWP_VALUE0 = std::mem::zeroed();
        val.r#type = FWP_UINT8;
        val.Anonymous.uint8 = v;
        val
    }

    unsafe fn loopback_condition() -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        c.fieldKey = FWPM_CONDITION_FLAGS;
        c.matchType = FWP_MATCH_FLAGS_ALL_SET;
        c.conditionValue.r#type = FWP_UINT32;
        c.conditionValue.Anonymous.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
        c
    }

    unsafe fn appid_condition(blob: *mut FWP_BYTE_BLOB) -> FWPM_FILTER_CONDITION0 {
        let mut c: FWPM_FILTER_CONDITION0 = std::mem::zeroed();
        c.fieldKey = FWPM_CONDITION_ALE_APP_ID;
        c.matchType = FWP_MATCH_EQUAL;
        c.conditionValue.r#type = FWP_BYTE_BLOB_TYPE;
        c.conditionValue.Anonymous.byteBlob = blob;
        c
    }

    unsafe fn app_id_blob(exe: &str) -> Result<*mut FWP_BYTE_BLOB, String> {
        let w = wide(exe);
        let mut blob: *mut FWP_BYTE_BLOB = std::ptr::null_mut();
        let rc = FwpmGetAppIdFromFileName0(PCWSTR(w.as_ptr()), &mut blob);
        if rc != 0 {
            return Err(format!("FwpmGetAppIdFromFileName0: {rc}"));
        }
        if blob.is_null() {
            return Err("app id blob is empty".into());
        }
        Ok(blob)
    }

    unsafe fn interface_luid(alias: &str) -> Result<u64, String> {
        let w = wide(alias);
        let mut luid: NET_LUID_LH = std::mem::zeroed();
        let rc = ConvertInterfaceAliasToLuid(PCWSTR(w.as_ptr()), &mut luid);
        if rc.0 != 0 {
            return Err(format!("ConvertInterfaceAliasToLuid({alias}): {}", rc.0));
        }
        Ok(luid.Value)
    }
}
