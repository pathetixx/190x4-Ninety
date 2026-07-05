// Ninety · WARP auto-rescan + hero-бейдж endpoint'а + история ротаций.
// Вынесено из main.js. Раз в N минут (warp.autoRescanIntervalMin) опрашиваем delay
// outbound "warp" через clash-API; если выше порога — сканируем эндпоинты, ставим
// лучший и дёргаем auto-reconnect. Активно только при connected + warp.enabled +
// warp.autoRescan. Зависимости от main (текущее состояние, реконнект) инжектятся —
// тот же паттерн, что у /lib/dns-guard.js и /lib/wifi-guard.js.

import { loadOptions, updateOption } from "/lib/options.js";
import { testNode } from "/lib/clash-api.js";
import { toast } from "/lib/toast.js";
import { t } from "/lib/i18n/index.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const WARP_HISTORY_KEY = "ninety.warp.history";
const WARP_HISTORY_LIMIT = 20;

// getState() — геттер текущего состояния соединения из main ("idle"|"connecting"|
// "connected"); scheduleAutoReconnect — дебаунс-реконнект ядра после смены endpoint.
export function initWarpRescan({ getState, scheduleAutoReconnect }) {
  const locWarpRow = document.getElementById("loc-warp-row");
  const locWarpEndpoint = document.getElementById("loc-warp-endpoint");
  let timer = null;
  let inFlight = false;

  // Бейдж активного WARP-endpoint на главной — виден только при connected + enabled.
  function updateBadge() {
    if (!locWarpRow || !locWarpEndpoint) return;
    const o = loadOptions();
    const enabled = !!o.warp?.enabled;
    const connected = getState() === "connected";
    if (!enabled || !connected) { locWarpRow.hidden = true; return; }
    locWarpEndpoint.textContent = o.warp?.endpoint || "—";
    locWarpRow.hidden = false;
  }

  // История ротаций в localStorage (читает settings-view через тот же ключ +
  // событие ninety:warp-rotation) — связь без импорта, как было в main.js.
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
    if (!opts.warp?.enabled || !opts.warp?.autoRescan) return;
    if (getState() !== "connected") return;
    const minutes = Math.max(5, Math.min(360, Number(opts.warp?.autoRescanIntervalMin) || 30));
    timer = setInterval(tick, minutes * 60_000);
  }

  function stopLoop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  async function tick() {
    if (inFlight) return;
    if (getState() !== "connected") return;
    const opts = loadOptions();
    if (!opts.warp?.enabled || !opts.warp?.autoRescan) return;
    const threshold = Math.max(100, Number(opts.warp?.autoRescanThresholdMs) || 300);
    inFlight = true;
    try {
      let curDelay = 0;
      try {
        const r = await testNode("warp", { timeoutMs: 4000, url: "http://cp.cloudflare.com/generate_204" });
        curDelay = r?.delay || 0;
      } catch { curDelay = 0; }
      // 0 = таймаут или not-reachable, выше порога — ротируем.
      if (curDelay > 0 && curDelay <= threshold) return;
      toast(t("warpToast.searching", { delay: curDelay || "—" }), "info", 2200);
      let results = [];
      try {
        results = await invoke("warp_scan_endpoints", { topN: 5, deep: false, mode: "wg" });
      } catch { return; }
      const best = Array.isArray(results) && results.length ? results[0] : null;
      if (!best) return;
      // Применяем только если новый лучше на ≥50мс, чтобы не дёргаться от шума.
      if (curDelay > 0 && best.latency_ms + 50 >= curDelay) {
        toast(t("warpToast.alreadyOk", { best: best.latency_ms, cur: curDelay }), "info", 2400);
        return;
      }
      const newEndpoint = `${best.ip}:${best.port}`;
      const fromEndpoint = loadOptions().warp?.endpoint || "—";
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
