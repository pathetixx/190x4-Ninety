// WebSocket-стрим clash-API через Rust: события "clash:traffic" приходят как { up, down }
// (байт/сек). Также exposed legacy poll-функция для пинга /proxies.

import { getProxies, lastDelay, pickEffectiveNode, refreshEffectiveDelay } from "/lib/clash-api.js";
import { t } from "/lib/i18n/index.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));
const eventApi = window.__TAURI__?.event;

const DEFAULT_PORT = 9090;
const PING_POLL_MS = 3000;          // как в Hiddify — частый поллинг свежего delay
const DEAD_RETEST_MS = 4000;        // мёртвый/0 замер — оживляем тёплым тестом часто
const WARM_REFRESH_MS = 10000;      // живой замер — периодически освежаем (auto-refresh)

let unlistenTraffic = null;
let pingTimer = null;
let lastEffectiveTag = null;
let lastForceTestTs = 0;
let streamRevision = 0;
let desiredStream = null;
let streamQueue = Promise.resolve();

async function stopCurrentStream() {
  if (unlistenTraffic) { try { unlistenTraffic(); } catch {} unlistenTraffic = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  lastEffectiveTag = null;
  lastForceTestTs = 0;
  try { await invoke("clash_traffic_stop"); } catch {}
}

async function reconcileStream(revision) {
  if (revision !== streamRevision) return;
  await stopCurrentStream();
  if (revision !== streamRevision || !desiredStream) return;
  const { port, onTraffic, onPing, onNodeChange } = desiredStream;
  // подписка на WS-event
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
  // параллельно — пинг-поллинг /proxies для location-card (Hiddify-style: 3с)
  if (onPing) {
    const pollOnce = async () => {
      if (revision !== streamRevision) return;
      try {
        const data = await getProxies(port);
        if (revision !== streamRevision) return;
        const effective = pickEffectiveNode(data);
        const obj = effective ? data?.proxies?.[effective] : null;
        const d = lastDelay(obj);
        // Авто-обновление: периодически в ФОНЕ перемеряем эффективную ноду
        // (refreshEffectiveDelay → одиночный /proxies/{name}/delay, пропатчен на
        // unified → совпадает со списком), результат отдаём через onPing; сам
        // поллинг не блокируется. Мёртвое освежаем чаще, живое — раз в WARM_REFRESH_MS.
        const now = Date.now();
        const dead = !d || d <= 0 || d >= 65000;
        const due = effective && (now - lastForceTestTs) > (dead ? DEAD_RETEST_MS : WARM_REFRESH_MS);
        if (due) {
          lastForceTestTs = now;
          refreshEffectiveDelay({ port, timeoutMs: 4000 })
            .then((r) => {
              if (revision === streamRevision && r?.delay > 0 && r.delay < 65000) onPing({ delay: r.delay, nodeTag: r.tag });
            })
            .catch(() => {});
        }
        if (effective && effective !== lastEffectiveTag) {
          lastEffectiveTag = effective;
          try { onNodeChange?.({ tag: effective }); } catch {}
        }
        onPing({ delay: d, nodeTag: effective });
      } catch {
        if (revision === streamRevision) onPing({ delay: 0, nodeTag: null });
      }
    };
    pollOnce();
    pingTimer = setInterval(pollOnce, PING_POLL_MS);
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
