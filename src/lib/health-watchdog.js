// Ninety · health watchdog (core liveness + bridge reconnect). Moved out of main.js.
// While connected — call health_snapshot every 5 s:
//   sing-box crashed → the tunnel is closed: remove the proxy, go idle, notify with the reason, logs.
//   the xray/naive/TT bridge crashed → auto-reconnect (rebuilds the config and brings up the cores).
// After an emergency fail-closed shutdown the same timer stays in guard-only
// mode and watches only WFP until the user explicitly removes the block.
// Everything pulled from main (current state, the update install flag, killing the core,
// reconnect, switching views, the quality engine) is injected — the same pattern as in
// /lib/warp-rescan.js, /lib/dns-guard.js, /lib/wifi-guard.js.
//
// Layer separation: the FACT of core death arrives as an event from Rust (vpn:core-died)
// instantly, and this module decides what to do with it. The timer stays as the second
// loop: it checks WFP, the bridges and quality — things that have no events.

import { toast } from "/lib/toast.js";
import { notify } from "/lib/notify.js";
import { t } from "/lib/i18n/index.js";
import { perfObserver } from "/lib/performance-observer.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const HEALTH_TICK_MS = 5000;
// The core may die for a reason a restart doesn't fix (a broken config,
// a busy port, a binary killed by antivirus). One attempt per window: it covers
// a one-off crash under load — the scenario recovery is needed for —
// and doesn't turn into an "up → dead" loop with a new tunnel every half minute.
const CORE_RESTORE_MAX = 1;
const CORE_RESTORE_WINDOW_MS = 15 * 60_000;
// A tick later than this means the WebView timer is throttled (a hidden page in the tray
// or renderer starvation). We log it, because in this mode the WFP check
// and the quality engine don't run at the declared frequency, and that must be visible.
const TICK_LATE_MS = 15_000;
const TICK_LATE_REPORT_GAP_MS = 60_000;
// Cap on catch-up bridge reconnects (xray/naive/TT). A bridge dying right at start
// fails start_singbox (fail-fast in Rust), but dying mid-session is fixed by
// a reconnect — without a cap a consistently crashing bridge would loop "crash → reconnect →
// crash" with toasts every ~10 seconds forever.
const BRIDGE_RECONNECT_MAX = 3;
const BRIDGE_RECONNECT_WINDOW_MS = 10 * 60_000;
// "Connection storm" (#168): the core's own connections loop back into
// TUN, sing-box racks up tens of thousands of sockets within a minute and passes no
// traffic. A healthy session holds tens to hundreds of sockets, a heavy one (torrent) —
// a couple of thousand; a loop crosses the threshold within half a minute. Two ticks in a row cut off
// a one-off spike.
const STORM_SOCKETS = 6000;
const STORM_TICKS = 2;

// getState() → "idle"|"connecting"|"connected"; isUpdateInstalling() → the update modal
// kills the cores itself (otherwise the watchdog would find a "corpse" and send a false error);
// shutdownCore/reconnectForSourceChange/switchView — the controlling hands from main;
// getQualityEngine() → the quality engine instance (created in main later, hence a getter).
export function initHealthWatchdog({
  getState,
  isUpdateInstalling,
  shutdownCore,
  reconnectForSourceChange,
  switchView,
  getQualityEngine,
  shouldPreserveKillSwitch = () => false,
  isKillSwitchRequired = () => false,
  rearmKillSwitch = async () => false,
  reconcileKillSwitch = async () => true,
  beginRuntimeOperation = null,
  completeRuntimeOperation = async () => false,
  // Bring the runtime back up after core death. Not injected → the watchdog behaves
  // as before: it shuts down and leaves the decision to the user.
  restoreAfterCoreDeath = null,
  // Subscription to vpn:core-died. Returns an unsubscribe function.
  subscribeCoreDeath = null,
  recordDiagnostic = () => {},
  // A connection storm is confirmed — once per session; main writes it to the feed.
  onConnectionStorm = () => {},
  invoke: invokeFn = invoke,
  toast: toastFn = toast,
  notify: notifyFn = notify,
  t: tr = t,
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
  perf = perfObserver,
  now = Date.now,
}) {
  let timer = null;
  let busy = false;
  let bridgeReconnects = [];
  let coreRestores = [];
  let generation = 0;
  let killSwitchAlerted = false;
  let systemProxyToast = null;
  let unsubscribeCoreDeath = null;
  let lastTimerAt = 0;
  let lastLateReportAt = 0;
  let stormTicks = 0;
  let stormReported = false;

  const current = (run) => run === generation && !isUpdateInstalling();
  const active = (run) => current(run) && getState() === "connected";

  async function withFrontendRecovery(dataplane, run) {
    const token = typeof beginRuntimeOperation === "function"
      ? await beginRuntimeOperation("frontendRecovery", dataplane)
      : null;
    if (typeof beginRuntimeOperation === "function" && !token) return false;
    try {
      return await run(token);
    } finally {
      if (token) await completeRuntimeOperation(token);
    }
  }

  function withOperationToken(payload, operationToken) {
    return operationToken ? { ...payload, operationToken } : payload;
  }

  function bridgeReconnectAllowed() {
    const cut = now() - BRIDGE_RECONNECT_WINDOW_MS;
    bridgeReconnects = bridgeReconnects.filter((ts) => ts > cut);
    if (bridgeReconnects.length >= BRIDGE_RECONNECT_MAX) return false;
    bridgeReconnects.push(now());
    return true;
  }

  function coreRestoreAllowed() {
    if (typeof restoreAfterCoreDeath !== "function") return false;
    const cut = now() - CORE_RESTORE_WINDOW_MS;
    coreRestores = coreRestores.filter((ts) => ts > cut);
    if (coreRestores.length >= CORE_RESTORE_MAX) return false;
    coreRestores.push(now());
    return true;
  }

  // Budget exhausted — the bridge crashes systematically, reconnects don't help. We close the tunnel
  // entirely (as on sing-box death): an honest error instead of an endless loop.
  async function stopForBridgeLoop(run) {
    if (!active(run)) return;
    const stopped = await withFrontendRecovery(
      { reason: "bridge_reconnect_budget_exhausted" },
      (operationToken) => shutdownCore(withOperationToken({
        preserveKillSwitch: shouldPreserveKillSwitch(),
      }, operationToken)),
    );
    if (!stopped) return;
    toastFn(tr("conn.bridgeLoop"), "error", 8000, { group: "conn", desc: tr("conn.bridgeLoopDesc") });
    notifyFn(tr("conn.notifyClosedTitle"), tr("conn.bridgeLoopDesc"));
    switchView("logs");
  }

  // Lateness is measured on the timer itself, not inside tick(): tick is also called by
  // the core death event and by tests, and such calls say nothing about how often
  // the WebView wakes up.
  function timerTick() {
    const at = now();
    if (lastTimerAt) {
      const gap = at - lastTimerAt;
      perf.gauge("watchdog.tickGapMs", gap);
      if (gap - HEALTH_TICK_MS >= TICK_LATE_MS) {
        perf.increment("watchdog.tickLate");
        console.warn(`health tick late: gap ${gap}ms (expected ${HEALTH_TICK_MS}ms)`);
        if (at - lastLateReportAt >= TICK_LATE_REPORT_GAP_MS) {
          lastLateReportAt = at;
          recordDiagnostic("watchdog_tick", "degraded", `gap_${Math.round(gap)}ms`);
        }
      }
    }
    lastTimerAt = at;
    void tick();
  }

  function clearSystemProxyAlert() {
    if (systemProxyToast == null) return;
    try { toastFn.dismiss?.(systemProxyToast); } catch {}
    systemProxyToast = null;
  }

  // In "System proxy" mode only the Windows setting routes browsers
  // into the tunnel. Another program (a second VPN client, the Windows settings themselves)
  // may override it: the core is alive, the screen says "connected", and traffic goes past.
  // We don't restore the proxy ourselves — pulling the setting back from another program
  // means fighting with it. We say honestly: reconnecting will restore Ninety's
  // proxy, and the other setting will be restored on disconnect.
  function reportSystemProxy(snap) {
    if (snap.system_proxy_lost !== true) {
      clearSystemProxyAlert();
      return;
    }
    if (systemProxyToast != null) return;
    recordDiagnostic("system_proxy", "degraded", "foreign_change");
    systemProxyToast = toastFn(tr("conn.systemProxyLost"), "warn", 0, {
      group: "system-proxy",
      desc: tr("conn.systemProxyLostDesc"),
    }) ?? true;
    notifyFn(tr("conn.systemProxyLost"), tr("conn.systemProxyLostDesc"));
  }

  // The core holds thousands of sockets tick after tick. We don't fix it ourselves: the cause is outside
  // Ninety (most often IP forwarding in Windows), and a reconnect would only restart
  // the same loop. We tell the person and write to the log — instead of a mute "Checking".
  function reportConnectionStorm(snap) {
    const sockets = snap.core_sockets;
    if (typeof sockets !== "number") return;
    stormTicks = sockets >= STORM_SOCKETS ? stormTicks + 1 : 0;
    if (stormTicks < STORM_TICKS || stormReported) return;
    stormReported = true;
    recordDiagnostic("core_sockets", "degraded", "connection_storm");
    toastFn(tr("conn.storm"), "warn", 0, {
      group: "connection-storm",
      desc: tr("conn.stormDesc", { count: sockets }),
    });
    onConnectionStorm(sockets);
  }

  function start() {
    if (timer) return;
    generation++;
    stormTicks = 0;
    stormReported = false;
    killSwitchAlerted = false;
    clearSystemProxyAlert();
    lastTimerAt = now();
    lastLateReportAt = 0;
    timer = setIntervalFn(timerTick, HEALTH_TICK_MS);
    if (typeof subscribeCoreDeath === "function" && !unsubscribeCoreDeath) {
      const run = generation;
      const settle = (off) => {
        if (typeof off !== "function") return;
        // The subscription travels through IPC. While it was traveling, the watchdog may have been stopped and
        // started again — then it's someone else's: we remove it rather than replace
        // the current one with it, otherwise an extra listener would pile up on every stop/start cycle.
        if (run !== generation || !timer || unsubscribeCoreDeath) { off(); return; }
        unsubscribeCoreDeath = off;
      };
      // The event only SHORTENS the delay: it carries no logic of its own but calls
      // the same tick. All guards (busy, generation, update install) and the decision
      // stay in one place.
      const result = subscribeCoreDeath(() => { if (run === generation) void tick(); });
      if (typeof result === "function") settle(result);
      else if (result && typeof result.then === "function") {
        result.then(settle).catch((error) => console.warn("core death subscription failed", error));
      }
    }
  }

  function stop() {
    generation++;
    killSwitchAlerted = false;
    clearSystemProxyAlert();
    lastTimerAt = 0;
    if (timer) { clearIntervalFn(timer); timer = null; }
    if (unsubscribeCoreDeath) {
      try { unsubscribeCoreDeath(); } catch (error) { console.warn("core death unsubscribe failed", error); }
      unsubscribeCoreDeath = null;
    }
  }

  async function verifyKillSwitch(run, snap, { connected = false } = {}) {
    const stillCurrent = connected ? active : current;
    if (!isKillSwitchRequired()) {
      killSwitchAlerted = false;
      return true;
    }
    if (snap.kill_switch_active === true) {
      if (killSwitchAlerted) {
        toastFn(tr("privacyToast.guardRestored"), "success", 2400, {
          group: "privacy-guard",
        });
      }
      killSwitchAlerted = false;
      return true;
    }

    const restored = await rearmKillSwitch();
    // The setting or the transition latch may have been removed while an IPC rearm was already
    // queued. By then the side effect may have managed to restore the old block-all,
    // so a single flag check isn't enough: the current policy must become
    // the last queued operation.
    if (!isKillSwitchRequired()) {
      await reconcileKillSwitch();
      killSwitchAlerted = false;
      return true;
    }
    if (!stillCurrent(run)) return false;
    if (!restored) {
      if (!killSwitchAlerted) {
        killSwitchAlerted = true;
        toastFn(tr("privacyToast.guardLost"), "error", 0, { group: "privacy-guard" });
        notifyFn("Ninety", tr("privacyToast.guardLost"));
        switchView("logs");
      }
      return false;
    }
    if (killSwitchAlerted) {
      toastFn(tr("privacyToast.guardRestored"), "success", 2400, {
        group: "privacy-guard",
      });
    }
    killSwitchAlerted = false;
    return true;
  }

  async function tick() {
    const connectedAtStart = getState() === "connected";
    const guardOnly = !connectedAtStart && isKillSwitchRequired();
    if ((!connectedAtStart && !guardOnly) || busy || isUpdateInstalling()) return;
    const run = generation;
    busy = true;
    try {
      // One aggregating call instead of four (singbox_running/vpn_last_error/
      // xray_status/sidecar_status) — removes extra IPC traffic on every tick.
      const snap = await invokeFn("health_snapshot");
      if (!current(run)) return;

      // After an emergency shutdown the state is already idle/cleanup_error, but the saved
      // fail-closed WFP must live until an explicit disconnect/turning the setting off.
      // In this mode we don't check the dead core — only the dynamic WFP objects.
      if (guardOnly) {
        await verifyKillSwitch(run, snap);
        return;
      }

      if (!active(run)) return;
      if (!snap.singbox_running) {
        // The snapshot reads the cause of death synchronously with the running status (before
        // shutdownCore, which resets the flags).
        const why = snap.last_error;
        if (why) console.warn("sing-box died:", why);
        // The budget is charged AFTER a confirmed stop. Previously it was counted
        // before it, and a failed stop (cleanup not confirmed — the process hung,
        // the port wasn't released) ate the window's only attempt without ever
        // reaching recovery: for the next 15 minutes the core no longer came up.
        // This doesn't double-charge — after a confirmed stop the state
        // is no longer connected, and the tick doesn't enter this branch a second time.
        let restoreAttempted = false;
        const outcome = await withFrontendRecovery(
          { reason: "process_dead" },
          async (operationToken) => {
            const stopped = await shutdownCore(withOperationToken({
              preserveKillSwitch: shouldPreserveKillSwitch(),
            }, operationToken));
            if (!stopped) return "stop_failed";
            if (!coreRestoreAllowed()) return "stopped";
            restoreAttempted = true;
            // Recovery is kept inside THE SAME operation: no other operation must squeeze in
            // between the stop and the restart, and the fail-closed WFP
            // is kept by shutdownCore all this time.
            toastFn(tr("conn.coreRestoring"), "warn", 4000, { group: "conn", connecting: true });
            const restored = await restoreAfterCoreDeath(
              tr("conn.coreRestoring"),
              withOperationToken({}, operationToken),
            );
            return restored ? "restored" : "restore_failed";
          },
        );
        if (!outcome || outcome === "stop_failed") return;
        recordDiagnostic("core_death", outcome, restoreAttempted ? "restore_attempted" : "restore_budget");
        if (outcome === "restored") {
          toastFn(tr("conn.coreRestored"), "success", 5000, { group: "conn" });
          notifyFn("Ninety", tr("conn.coreRestored"));
          return;
        }
        toastFn(tr("conn.coreStopped"), "error", 7000, { group: "conn", desc: tr("conn.coreStoppedDesc") });
        notifyFn(tr("conn.notifyClosedTitle"), tr("conn.notifyClosedBody"));
        switchView("logs");
        return;
      }
      // BFE/Windows Firewall may be restarted independently of Ninety:
      // the dynamic WFP objects then disappear, although the core and TUN stay alive.
      // On every liveness tick we confirm the two block filters and atomically
      // rearm the policy. Until recovery succeeds, we don't start
      // automatic reconnects: stopping a live TUN without WFP would only increase
      // the risk of apps leaving through the physical interface.
      if (!(await verifyKillSwitch(run, snap, { connected: true }))) return;
      // sing-box is alive — check the xray bridge (xhttp).
      if (snap.xray === "died") {
        if (!bridgeReconnectAllowed()) { await stopForBridgeLoop(run); return; }
        if (!active(run)) return;
        toastFn(tr("conn.xhttpDown"), "warn", 4000, { group: "conn", connecting: true });
        notifyFn("Ninety", tr("conn.xhttpNotify"));
        // reconnectForSourceChange sets needsReconnect itself and calls a reconnect,
        // which brings up sing-box AND xray again from a fresh config.
        void withFrontendRecovery(
          { reason: "xhttp_bridge_dead" },
          (operationToken) => reconnectForSourceChange(
            tr("conn.xhttpReconnect"),
            withOperationToken({}, operationToken),
          ),
        ).catch((error) => console.warn("xhttp bridge recovery failed", error));
        return;
      }
      // naive/trusttunnel sidecar clients — the same logic as the xray bridge.
      if (snap.sidecar === "died") {
        if (!bridgeReconnectAllowed()) { await stopForBridgeLoop(run); return; }
        if (!active(run)) return;
        toastFn(tr("conn.clientDown"), "warn", 4000, { group: "conn", connecting: true });
        notifyFn("Ninety", tr("conn.clientNotify"));
        void withFrontendRecovery(
          { reason: "sidecar_bridge_dead" },
          (operationToken) => reconnectForSourceChange(
            tr("conn.clientReconnect"),
            withOperationToken({}, operationToken),
          ),
        ).catch((error) => console.warn("sidecar bridge recovery failed", error));
        return;
      }
      if (!active(run)) return;
      reportSystemProxy(snap);
      reportConnectionStorm(snap);
      // Liveness OK — hand over to the quality engine (throttling/degradation detection).
      // Fire-and-forget: a probe of up to 4 s must not hold busy and slow down the next
      // liveness tick; the engine has its own probing/remediating guards.
      const engine = getQualityEngine();
      // First we tell the engine whether the host is to blame. Under a CPU/memory shortage
      // channel degradation is a consequence, not the cause: treating it with a node switch and
      // a reconnect means paying with the most expensive action exactly when
      // the machine is already struggling.
      engine?.setHostPressure?.(snap.host_pressure?.active === true);
      engine?.tick().catch(() => {});
    } catch (e) {
      console.warn("healthTick failed", e);
    } finally {
      busy = false;
    }
  }

  return { start, stop, tick };
}
