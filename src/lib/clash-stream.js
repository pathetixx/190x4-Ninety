// WebSocket-стрим clash-API через Rust: события "clash:traffic" приходят как { up, down }
// (байт/сек). Также exposed legacy poll-функция для пинга /proxies.

import { getProxies, lastDelay, pickEffectiveNode, warmTestNode } from "/lib/clash-api.js";

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

export async function startClashStream({ port = DEFAULT_PORT, onTraffic, onPing, onNodeChange } = {}) {
  await stopClashStream();
  // подписка на WS-event
  if (eventApi?.listen && onTraffic) {
    unlistenTraffic = await eventApi.listen("clash:traffic", (ev) => {
      const p = ev?.payload || {};
      const up = Number(p.up) || 0;
      const down = Number(p.down) || 0;
      onTraffic({ up, down });
    });
  }
  // запускаем Rust-таску WS-pump
  try { await invoke("clash_traffic_start", { port }); } catch (e) {
    console.warn("clash_traffic_start failed", e);
  }
  // параллельно — пинг-поллинг /proxies для location-card (Hiddify-style: 3с)
  if (onPing) {
    const pollOnce = async () => {
      try {
        const data = await getProxies(port);
        const effective = pickEffectiveNode(data);
        const obj = effective ? data?.proxies?.[effective] : null;
        let d = lastDelay(obj);
        // Авто-обновление: периодически форсим тёплый замер, чтобы число в
        // hero/location-card жило, а не зависало на старой записи history.
        // Мёртвое значение оживляем чаще, живое — освежаем раз в WARM_REFRESH_MS.
        const now = Date.now();
        const dead = !d || d <= 0 || d >= 65000;
        const due = effective && (now - lastForceTestTs) > (dead ? DEAD_RETEST_MS : WARM_REFRESH_MS);
        if (due) {
          lastForceTestTs = now;
          try {
            const r = await warmTestNode(effective, { port, timeoutMs: 4000, samples: dead ? 1 : 2 });
            const fresh = Number(r?.delay) || 0;
            if (fresh > 0 && fresh < 65000) d = fresh;
          } catch {}
        }
        if (effective && effective !== lastEffectiveTag) {
          lastEffectiveTag = effective;
          try { onNodeChange?.({ tag: effective }); } catch {}
        }
        onPing({ delay: d, nodeTag: effective });
      } catch {
        onPing({ delay: 0, nodeTag: null });
      }
    };
    pollOnce();
    pingTimer = setInterval(pollOnce, PING_POLL_MS);
  }
}

export async function stopClashStream() {
  if (unlistenTraffic) { try { unlistenTraffic(); } catch {} unlistenTraffic = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  lastEffectiveTag = null;
  lastForceTestTs = 0;
  try { await invoke("clash_traffic_stop"); } catch {}
}

// Bytes/sec → {value: string, unit: string} в КиБ/с или МиБ/с
export function formatRate(bytesPerSec) {
  const b = Math.max(0, Number(bytesPerSec) || 0);
  if (b < 1024) {
    return { value: b.toFixed(0), unit: "Б/с" };
  }
  const kib = b / 1024;
  if (kib < 1024) {
    return { value: kib < 10 ? kib.toFixed(1) : kib.toFixed(0), unit: "КиБ/с" };
  }
  const mib = kib / 1024;
  return { value: mib < 10 ? mib.toFixed(2) : mib.toFixed(1), unit: "МиБ/с" };
}
