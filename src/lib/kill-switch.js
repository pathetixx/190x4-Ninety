// Ninety · WFP kill switch glue (moved out of main.js).
//
// In proxy/systemProxy modes with the option on, for the duration of the connection we raise
// a WFP block (all outbound except loopback and Ninety engines by app-id) — when
// the core crashes, traffic doesn't leak past the tunnel. In regular TUN
// strict_route is enough. The high-level "Strict tunnel" additionally arms TUN WFP:
// traffic through the ninety-tun interface and the engines is allowed, and after core death
// block-all stays active until the user explicitly disconnects.
// WFP requires admin rights: if the process isn't elevated, we don't arm and show a hint
// in a toast (once). The Rust side is src-tauri/src/killswitch.rs.

import { loadOptions } from "/lib/options.js";
import { getMode } from "/lib/singbox.js";
import { toast } from "/lib/toast.js";
import { t } from "/lib/i18n/index.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// After a WebView reload the local latch variables disappear, but the backend and
// its dynamic WFP session keep living. The runtime may have already crashed, so
// running is deliberately not required here: a confirmed active policy +
// the saved option are enough to continue guard-only observation.
export function snapshotConfirmsOrdinaryKillSwitch(snapshot, options) {
  return !!options?.general?.killSwitch
    && snapshot?.killSwitchActive === true
    && snapshot?.strictPrivacy === false
    && ["proxy", "systemProxy"].includes(snapshot?.mode);
}

export function snapshotConfirmsStrictKillSwitch(snapshot, options) {
  return !!options?.privacy?.strictTunnel
    && snapshot?.killSwitchActive === true;
}

export function createKillSwitchController(deps = {}) {
  const call = deps.invoke || invoke;
  const options = deps.loadOptions || loadOptions;
  const mode = deps.getMode || getMode;
  const showToast = deps.toast || toast;
  const tr = deps.t || t;
  const warn = deps.warn || ((...args) => console.warn(...args));
  let desiredConnected = false;
  let desiredPhase = "connected";
  let preserveDisconnected = false;
  let desiredPolicyMode = null;
  let revision = 0;
  let queue = Promise.resolve();
  // The rights hint is shown on every attempt, but no more than once every
  // half minute: previously it appeared once per process, and after that every
  // connection ended with a generic "Failed to connect" without a reason.
  const KILL_SWITCH_HINT_INTERVAL_MS = 30_000;
  let killSwitchHintAt = -Infinity;
  const showElevationHint = () => {
    const at = Date.now();
    if (at - killSwitchHintAt < KILL_SWITCH_HINT_INTERVAL_MS) return;
    killSwitchHintAt = at;
    showToast(tr("elev.killSwitchHint"), "warn", 6000);
  };

  async function reconcile() {
    const mine = revision;
    const wanted = desiredConnected;
    const policyMode = desiredPolicyMode;
    try {
      const opts = options();
      const currentMode = policyMode || mode();
      const strictTunnel = !!opts.privacy?.strictTunnel && currentMode === "tun";
      const ordinaryKillSwitch = !!opts.general?.killSwitch && currentMode !== "tun";
      if (!wanted && preserveDisconnected) {
        if (!strictTunnel && !ordinaryKillSwitch) {
          await call("killswitch_disarm");
          return true;
        }
        if (await call("killswitch_active") === true) return true;
        const elevated = await call("is_elevated");
        if (mine !== revision || desiredConnected || !preserveDisconnected) return false;
        if (!elevated) {
          showElevationHint();
          return false;
        }
        // The core is already stopped or about to be stopped: we restore the
        // fail-closed barrier without the TUN permit. For strict this is the preconnect policy,
        // for the regular Kill Switch the same emergency block-all that doesn't
        // let apps out directly after sing-box dies.
        await call("killswitch_arm", {
          allowLan: strictTunnel ? false : opts.route?.bypassLan !== false,
          tunInterface: null,
          strictTunnel,
        });
        return await call("killswitch_active") === true;
      }
      if (!wanted) {
        await call("killswitch_disarm");
        return true;
      }
      if (!strictTunnel && (!opts.general?.killSwitch || currentMode === "tun")) {
        await call("killswitch_disarm");
        return true;
      }
      const elevated = await call("is_elevated");
      // While we waited for UAC/IPC, the user may have disconnected or changed the mode.
      // The next queued reconciliation will apply the latest desired state.
      if (mine !== revision || !desiredConnected) return false;
      if (!elevated) {
        showElevationHint();
        return false;
      }
      // Before the core starts, strict WFP works as a fail-closed shield: only
      // the engines that need to reach the VPN are allowed. Once TUN appears we
      // rearm the filter on the virtual interface's LUID.
      // Rust assembles the new dynamic session entirely and only then atomically
      // swaps it with the old one. So disarm-first is not allowed here: even
      // a short window between sessions would let apps out into the physical network.
      await call("killswitch_arm", {
        allowLan: strictTunnel ? false : opts.route?.bypassLan !== false,
        tunInterface: strictTunnel && desiredPhase === "connected" ? "ninety-tun" : null,
        strictTunnel,
      });
      const active = await call("killswitch_active");
      return active === true;
    } catch (e) {
      warn("kill switch", e);
      return false;
    }
  }

  // All arm/disarm calls run strictly sequentially. If a disconnect arrived
  // during arm, its disarm sits in the same queue and is guaranteed to run after.
  function apply(connected, {
    preserve = false,
    phase = "connected",
    policyMode = null,
  } = {}) {
    desiredConnected = !!connected;
    desiredPhase = phase === "preconnect" ? "preconnect" : "connected";
    preserveDisconnected = !desiredConnected && !!preserve;
    desiredPolicyMode = ["proxy", "systemProxy", "tun"].includes(policyMode)
      ? policyMode
      : null;
    revision++;
    queue = queue.then(reconcile, reconcile);
    return queue;
  }

  return { apply };
}

const killSwitchController = createKillSwitchController();

// connected=true → raise the block (if the option is on, not TUN and elevated);
// connected=false → remove it. Idempotent on the Rust side.
export function applyKillSwitch(connected, options) {
  return killSwitchController.apply(connected, options);
}

// Warning when enabling the kill switch in "Proxy" mode: there the armed block
// cuts ALL traffic except apps manually pointed at the local proxy
// (in systemProxy/TUN traffic goes through 127.0.0.1/the tunnel anyway). Otherwise the user
// is surprised by "missing internet". Shown once per session.
let proxyWarnShown = false;
export function maybeWarnKillSwitchProxy() {
  if (loadOptions().general?.killSwitch && getMode() === "proxy" && !proxyWarnShown) {
    proxyWarnShown = true;
    toast(t("elev.killSwitchProxyHint"), "warn", 7000);
  }
}
