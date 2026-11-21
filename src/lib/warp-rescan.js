// Ninety · WARP auto-rescan + the hero endpoint badge + rotation history.
// Moved out of main.js. Every N minutes (warp.autoRescanIntervalMin) we poll the delay
// of the "warp" outbound via the clash API; if it's above the threshold we scan endpoints, set
// the best one and trigger an auto-reconnect. Active only with connected + warp.enabled +
// warp.autoRescan. Dependencies on main (current state, reconnect) are injected —
// the same pattern as /lib/dns-guard.js and /lib/wifi-guard.js.

import { loadOptions, updateOption } from "/lib/options.js";
import { STORAGE_KEYS } from "/lib/storage-policy.js";
import { testNode } from "/lib/clash-api.js";
import { toast } from "/lib/toast.js";
import { t } from "/lib/i18n/index.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const WARP_HISTORY_KEY = STORAGE_KEYS.warpHistory;
const WARP_HISTORY_LIMIT = 20;

// getState() — a getter of the current connection state from main ("idle"|"connecting"|
// "connected"); scheduleAutoReconnect — a debounced core reconnect after an endpoint change.
export function initWarpRescan({ getState, scheduleAutoReconnect, runtime }) {
  const locWarpRow = document.getElementById("loc-warp-row");
  const locWarpEndpoint = document.getElementById("loc-warp-endpoint");
  let timer = null;
  let inFlight = false;

  // The active WARP endpoint badge on the home screen — visible only with connected + enabled.
  function updateBadge() {
    if (!locWarpRow || !locWarpEndpoint) return;
    const o = loadOptions();
    const enabled = !o.privacy?.strictTunnel && !!o.warp?.enabled;
    const connected = getState() === "connected";
    if (!enabled || !connected) { locWarpRow.hidden = true; return; }
    locWarpEndpoint.textContent = o.warp?.endpoint || "—";
    locWarpRow.hidden = false;
  }

  // Rotation history in localStorage (settings-view reads it via the same key +
  // the ninety:warp-rotation event) — a link without an import, as it was in main.js.
  function recordRotation(from, to, oldDelay, newDelay) {
    try {
      const raw = localStorage.getItem(WARP_HISTORY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      list.unshift({ ts: Date.now(), from, to, oldDelay, newDelay });
      if (list.length > WARP_HISTORY_LIMIT) list.length = WARP_HISTORY_LIMIT;
      localStorage.setItem(WARP_HISTORY_KEY, JSON.stringify(list));
      window.dispatchEvent(new CustomEvent("ninety:warp-rotation"));
    } catch (e) { console.warn("warp history save failed", e); }
  }

  function startLoop() {
    stopLoop();
    const opts = loadOptions();
    if (opts.privacy?.strictTunnel || !opts.warp?.enabled || !opts.warp?.autoRescan) return;
    // In a chain WARP goes through the VPN server, while the scan measures the direct path from the PC:
    // its numbers say nothing about the chain, rotating by them is pointless.
    if (opts.warp?.mode === "chain") return;
    if (getState() !== "connected") return;
    const minutes = Math.max(5, Math.min(360, Number(opts.warp?.autoRescanIntervalMin) || 30));
    timer = setInterval(tick, minutes * 60_000);
  }

  function stopLoop() {
    if (timer) { clearInterval(timer); timer = null; }
    inFlight = false;
    invoke("warp_scan_cancel").catch(() => {});
  }

  async function tick() {
    if (inFlight) return;
    if (getState() !== "connected") return;
    const opts = loadOptions();
    if (opts.privacy?.strictTunnel || !opts.warp?.enabled || !opts.warp?.autoRescan) return;
    if (opts.warp?.mode === "chain") return;
    const threshold = Math.max(100, Number(opts.warp?.autoRescanThresholdMs) || 300);
    const token = runtime?.capture?.() || null;
    if (runtime && !runtime.isCurrent(token)) return;
    inFlight = true;
    try {
      let curDelay = 0;
      try {
        const r = await testNode("warp", { timeoutMs: 4000, url: "http://cp.cloudflare.com/generate_204" });
        if (runtime && !runtime.isCurrent(token)) return;
        curDelay = r?.delay || 0;
      } catch { curDelay = 0; }
      // 0 = timeout or not reachable, above the threshold — rotate.
      if (curDelay > 0 && curDelay <= threshold) return;
      toast(t("warpToast.searching", { delay: curDelay || "—" }), "info", 2200);
      let results = [];
      try {
        results = await invoke("warp_scan_endpoints", { topN: 5, deep: false, mode: "wg" });
      } catch { return; }
      if (runtime && !runtime.isCurrent(token)) return;
      if (getState() !== "connected" || loadOptions().privacy?.strictTunnel
        || !loadOptions().warp?.enabled) return;
      const best = Array.isArray(results) && results.length ? results[0] : null;
      if (!best) return;
      // We apply only if the new one is better by ≥50 ms, so as not to twitch from noise.
      if (curDelay > 0 && best.latency_ms + 50 >= curDelay) {
        toast(t("warpToast.alreadyOk", { best: best.latency_ms, cur: curDelay }), "info", 2400);
        return;
      }
      const newEndpoint = `${best.ip}:${best.port}`;
      const fromEndpoint = loadOptions().warp?.endpoint || "—";
      if (runtime && !runtime.isCurrent(token)) return;
      updateOption("warp.endpoint", newEndpoint);
      recordRotation(fromEndpoint, newEndpoint, curDelay, best.latency_ms);
      console.info("[WARP rescan]", { from: fromEndpoint, to: newEndpoint, oldDelay: curDelay, newDelay: best.latency_ms });
      toast(t("warpToast.rotated", { ep: newEndpoint, best: best.latency_ms, old: curDelay || "—" }), "success", 2400);
      updateBadge();
      scheduleAutoReconnect();
    } finally {
      inFlight = false;
    }
  }

  return { updateBadge, startLoop, stopLoop };
}
