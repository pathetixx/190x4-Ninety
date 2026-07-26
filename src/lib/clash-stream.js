// WebSocket-стрим clash-API через Rust: события "clash:traffic" приходят как { up, down }
// (байт/сек). Также exposed legacy poll-функция для пинга /proxies.

import { getProxies, lastDelay, pickEffectiveNode, refreshEffectiveDelay } from "/lib/clash-api.js";
import { activityController } from "/lib/activity-controller.js";
import { createDistinctEmitter } from "/lib/distinct-emitter.js";
import { perfObserver } from "/lib/performance-observer.js";
import { t } from "/lib/i18n/index.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));
const eventApi = window.__TAURI__?.event;

const DEFAULT_PORT = 9090;
const PING_POLL_MS = 3000;          // как в Hiddify — частый поллинг свежего delay
const DEAD_RETEST_MS = 4000;        // мёртвый/0 замер — оживляем тёплым тестом часто
const WARM_REFRESH_MS = 10000;      // живой замер — периодически освежаем (auto-refresh)

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
  if (!pingPollOnce || pingTimer || !activityController.isVisible()) return;
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
  const { port, onTraffic, onPing, onNodeChange } = desiredStream;
  // подписка на WS-event остаётся активной в трее: она питает traffic meter и
  // quality engine. Пауза относится только к визуальному ping-поллингу.
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
  // запускаем Rust-таску WS-pump
  try { await invoke("clash_traffic_start", { port }); } catch (e) {
    console.warn("clash_traffic_start failed", e);
  }

  if (onPing) {
    const distinctPing = createDistinctEmitter(onPing, ({ delay, nodeTag }) => `${delay}|${nodeTag || ""}`);
    const emitPing = (payload) => {
      if (!distinctPing(payload)) perfObserver.increment("clash.ui.ping.suppressed");
    };

    pingPollOnce = createSingleFlightRunner(async () => {
      if (revision !== streamRevision || !activityController.isVisible()) return;
      try {
        const data = await getProxies(port);
        if (revision !== streamRevision || !activityController.isVisible()) return;
        const effective = pickEffectiveNode(data);
        const obj = effective ? data?.proxies?.[effective] : null;
        const d = lastDelay(obj);
        // Авто-обновление: периодически в ФОНЕ перемеряем эффективную ноду.
        // Когда окно скрыто, визуальная проба не нужна и не запускается.
        const now = Date.now();
        const dead = !d || d <= 0 || d >= 65000;
        const due = effective && (now - lastForceTestTs) > (dead ? DEAD_RETEST_MS : WARM_REFRESH_MS);
        if (due) {
          lastForceTestTs = now;
          refreshEffectiveDelay({ port, timeoutMs: 4000 })
            .then((r) => {
              if (revision === streamRevision && activityController.isVisible()
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
        if (revision === streamRevision && activityController.isVisible()) {
          emitPing({ delay: 0, nodeTag: null });
        }
      }
    });

    unlistenActivity = activityController.subscribe(({ visible }) => {
      if (revision !== streamRevision) return;
      if (visible) startPingPolling();
      else {
        stopPingPolling();
        perfObserver.increment("clash.ui.ping.pauses");
      }
    });
  }
}

export function startClashStream({ port = DEFAULT_PORT, onTraffic, onPing, onNodeChange } = {}) {
  desiredStream = { port, onTraffic, onPing, onNodeChange };
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

// Bytes/sec → {value: string, unit: string} в КиБ/с или МиБ/с
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
