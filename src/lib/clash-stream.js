// clash API WebSocket stream through Rust: "clash:traffic" events arrive as { up, down }
// (bytes/sec). A legacy poll function for pinging /proxies is also exposed.

import { getProxies, lastDelay, pickEffectiveNode, refreshEffectiveDelay } from "/lib/clash-api.js";
import { activityController } from "/lib/activity-controller.js";
import { createDistinctEmitter } from "/lib/distinct-emitter.js";
import { perfObserver } from "/lib/performance-observer.js";
import { t } from "/lib/i18n/index.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));
const eventApi = window.__TAURI__?.event;

const DEFAULT_PORT = 9090;
const PING_POLL_MS = 3000;          // frequent polling: the ping in the UI must be fresh
const DEAD_RETEST_MS = 4000;        // a dead/0 measurement — revive it often with a warm test
const WARM_REFRESH_MS = 10000;      // a live measurement — refresh it periodically (auto-refresh)

let unlistenTraffic = null;
let unlistenActivity = null;
let pingTimer = null;
let pingPollOnce = null;
let lastEffectiveTag = null;
let lastForceTestTs = 0;
let streamRevision = 0;
let desiredStream = null;
let streamQueue = Promise.resolve();

export function createSingleFlightRunner(task) {
  let inFlight = null;
  return (...args) => {
    if (inFlight) return inFlight;
    const run = Promise.resolve().then(() => task(...args));
    const wrapped = run.finally(() => {
      if (inFlight === wrapped) inFlight = null;
    });
    inFlight = wrapped;
    return wrapped;
  };
}

function stopPingPolling() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function startPingPolling() {
  if (!pingPollOnce || pingTimer || !activityController.isInteractive()) return;
  pingPollOnce();
  pingTimer = setInterval(pingPollOnce, PING_POLL_MS);
}

async function stopCurrentStream() {
  if (unlistenTraffic) { try { unlistenTraffic(); } catch {} unlistenTraffic = null; }
  if (unlistenActivity) { try { unlistenActivity(); } catch {} unlistenActivity = null; }
  stopPingPolling();
  pingPollOnce = null;
  lastEffectiveTag = null;
  lastForceTestTs = 0;
  try { await invoke("clash_traffic_stop"); } catch {}
}

async function reconcileStream(revision) {
  if (revision !== streamRevision) return;
  await stopCurrentStream();
  if (revision !== streamRevision || !desiredStream) return;
  const { port, token, onTraffic, onPing, onNodeChange } = desiredStream;
  // the WS event subscription stays active in the tray: it feeds the traffic meter and
  // the quality engine. The pause applies only to the visual ping polling.
  if (eventApi?.listen && onTraffic) {
    const unlisten = await eventApi.listen("clash:traffic", (ev) => {
      if (revision !== streamRevision) return;
      const p = ev?.payload || {};
      const up = Number(p.up) || 0;
      const down = Number(p.down) || 0;
      onTraffic({ up, down });
    });
    if (revision !== streamRevision) {
      try { unlisten(); } catch {}
      return;
    }
    unlistenTraffic = unlisten;
  }
  // start the Rust WS pump task
  try { await invoke("clash_traffic_start", { port }); } catch (e) {
    console.warn("clash_traffic_start failed", e);
  }

  if (onPing) {
    const distinctPing = createDistinctEmitter(onPing, ({ delay, nodeTag }) => `${delay}|${nodeTag || ""}`);
    const emitPing = (payload) => {
      if (!distinctPing(payload)) perfObserver.increment("clash.ui.ping.suppressed");
    };

    pingPollOnce = createSingleFlightRunner(async () => {
      if (revision !== streamRevision || !activityController.isInteractive()) return;
      try {
        const data = await getProxies(port, { token });
        if (revision !== streamRevision || !activityController.isInteractive()) return;
        const effective = pickEffectiveNode(data);
        const obj = effective ? data?.proxies?.[effective] : null;
        const d = lastDelay(obj);
        // Auto-refresh: periodically re-measure the effective node in the BACKGROUND.
        // When the window is hidden, the visual probe isn't needed and isn't started.
        const now = Date.now();
        const dead = !d || d <= 0 || d >= 65000;
        const due = effective && (now - lastForceTestTs) > (dead ? DEAD_RETEST_MS : WARM_REFRESH_MS);
        if (due) {
          lastForceTestTs = now;
          refreshEffectiveDelay({ port, timeoutMs: 4000, token })
            .then((r) => {
              if (revision === streamRevision && activityController.isInteractive()
                && r?.delay > 0 && r.delay < 65000) {
                emitPing({ delay: r.delay, nodeTag: r.tag });
              }
            })
            .catch(() => {});
        }
        if (effective && effective !== lastEffectiveTag) {
          lastEffectiveTag = effective;
          try { onNodeChange?.({ tag: effective }); } catch {}
        }
        emitPing({ delay: d, nodeTag: effective });
      } catch {
        if (revision === streamRevision && activityController.isInteractive()) {
          emitPing({ delay: 0, nodeTag: null });
        }
      }
    });

    unlistenActivity = activityController.subscribe(({ visible, focused }) => {
      if (revision !== streamRevision) return;
      if (visible && focused) startPingPolling();
      else {
        stopPingPolling();
        perfObserver.increment("clash.ui.ping.pauses");
      }
    });
  }
}

export function startClashStream({ port = DEFAULT_PORT, token, onTraffic, onPing, onNodeChange } = {}) {
  desiredStream = { port, token, onTraffic, onPing, onNodeChange };
  const revision = ++streamRevision;
  streamQueue = streamQueue.then(() => reconcileStream(revision), () => reconcileStream(revision));
  return streamQueue;
}

export function stopClashStream() {
  desiredStream = null;
  const revision = ++streamRevision;
  streamQueue = streamQueue.then(() => reconcileStream(revision), () => reconcileStream(revision));
  return streamQueue;
}

// Bytes/sec → {value: string, unit: string} in KiB/s or MiB/s
export function formatRate(bytesPerSec) {
  const b = Math.max(0, Number(bytesPerSec) || 0);
  if (b < 1024) {
    return { value: b.toFixed(0), unit: t("units.rateB") };
  }
  const kib = b / 1024;
  if (kib < 1024) {
    return { value: kib < 10 ? kib.toFixed(1) : kib.toFixed(0), unit: t("units.rateKiB") };
  }
  const mib = kib / 1024;
  return { value: mib < 10 ? mib.toFixed(2) : mib.toFixed(1), unit: t("units.rateMiB") };
}
