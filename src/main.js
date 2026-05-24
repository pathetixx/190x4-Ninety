import { startMesh } from "/lib/mesh-background.js";
import {
  buildConfig,
  loadProfiles,
  getActiveProfileId,
  setActiveProfileId,
  removeProfile,
  getMode,
  setMode,
  getActiveKind,
  setActiveKind,
  getActiveSource,
  nodeTag,
} from "/lib/singbox.js";
import {
  loadSubscriptions,
  getActiveSubscriptionId,
  setActiveSubscriptionId,
  refreshSubscription,
  refreshAllSubscriptions,
  removeSubscription,
  subscriptionDaysLeft,
  subscriptionUsedBytes,
  formatGiB,
  relativeTime,
} from "/lib/subscriptions.js";
import { loadOptions, updateOption } from "/lib/options.js";
import { mountSettings } from "/lib/settings-view.js";
import { isAvailable as updaterAvailable, checkForUpdate } from "/lib/updater.js";
import { openUpdateModal } from "/lib/update-modal.js";
import { mountAddModal, openAddModal } from "/lib/add-modal.js";
import { openEditSubscription, openEditProfile } from "/lib/edit-modal.js";
import { copySubscriptionUrl, exportSingboxJson, openQRModal } from "/lib/share.js";
import { mountProxiesView, onProxiesViewEnter, onProxiesViewLeave } from "/lib/proxies-view.js";
import { startClashStream, stopClashStream, formatRate } from "/lib/clash-stream.js";
import { gradeDelay, pickEffectiveNode, getProxies, lastDelay, testNode } from "/lib/clash-api.js";
import { fetchPublicIp, maskIp, bindIpReveal } from "/lib/ip-info.js";
import { notify } from "/lib/notify.js";

// ── Tauri 2 (withGlobalTauri:true) ───────────────────────────
const tauriWin = window.__TAURI__?.window?.getCurrentWindow?.()
  ?? window.__TAURI__?.window?.getCurrent?.();
const invoke = window.__TAURI__?.core?.invoke
  ?? ((cmd, args) => {
    console.warn("Tauri invoke недоступен:", cmd, args);
    return Promise.reject(new Error("Tauri invoke недоступен (web preview)"));
  });

// ── Mesh-фон ────────────────────────────────────────────────
const canvas = document.getElementById("mesh-bg");
if (canvas) startMesh(canvas);

// ── Version (dynamic из Tauri) ─────────────────────────────
// ВАЖНО: НЕ использовать MutationObserver на settings-root — apply() меняет
// textContent #settings-version, это создаёт новую мутацию → бесконечный
// цикл → фриз WebView2 при входе в Settings/Общие (alpha14 bug).
let appVersionCached = "—";

function applySettingsVersion() {
  const el = document.getElementById("settings-version");
  if (el && el.textContent !== appVersionCached) el.textContent = appVersionCached;
}

async function fillAppVersion() {
  let v = "—";
  try {
    const app = window.__TAURI__?.app;
    if (app?.getVersion) v = await app.getVersion();
  } catch {}
  appVersionCached = v;
  const sidebar = document.getElementById("sidebar-version");
  if (sidebar) sidebar.textContent = `${v} · 190X4`;
  applySettingsVersion();
}
fillAppVersion();

// ── Toast ───────────────────────────────────────────────────
const toastEl = document.getElementById("toast");
let toastTimer = null;
function toast(msg, kind = "info", ms = 3000) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.dataset.kind = kind;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

// ── Titlebar ────────────────────────────────────────────────
document.querySelectorAll("[data-window-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!tauriWin) return;
    const action = btn.dataset.windowAction;
    try {
      if (action === "minimize") await tauriWin.minimize();
      else if (action === "maximize") await tauriWin.toggleMaximize();
      else if (action === "close") await tauriWin.close();
    } catch (e) {
      console.error("window action failed", action, e);
    }
  });
});

// ── Popovers ────────────────────────────────────────────────
const popovers = {
  mode: { btn: document.getElementById("mode-toggle"), el: document.getElementById("mode-popover") },
};

function closeAllPopovers(except) {
  for (const key of Object.keys(popovers)) {
    if (key === except) continue;
    const p = popovers[key];
    p.el.hidden = true;
    p.btn.setAttribute("aria-expanded", "false");
  }
}

function placePopover(p) {
  const r = p.btn.getBoundingClientRect();
  p.el.style.top = `${Math.round(r.bottom + 8)}px`;
  p.el.style.right = `${Math.round(window.innerWidth - r.right)}px`;
}

for (const key of Object.keys(popovers)) {
  const p = popovers[key];
  if (!p.btn || !p.el) continue;
  p.btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = p.el.hidden;
    closeAllPopovers(key);
    if (willOpen) {
      placePopover(p);
      p.el.hidden = false;
      p.btn.setAttribute("aria-expanded", "true");
    } else {
      p.el.hidden = true;
      p.btn.setAttribute("aria-expanded", "false");
    }
  });
  p.el.addEventListener("click", (e) => e.stopPropagation());
}

document.addEventListener("click", () => closeAllPopovers());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllPopovers(); });
window.addEventListener("resize", () => {
  for (const key of Object.keys(popovers)) {
    const p = popovers[key];
    if (!p.el.hidden) placePopover(p);
  }
});

// ── Mode segmented (proxy/tun, реальное состояние) ──────────
const modeSeg = document.getElementById("mode-seg");
function applyModeToUI(m) {
  if (!modeSeg) return;
  modeSeg.querySelectorAll(".seg__btn").forEach((x) => {
    const active = x.dataset.mode === m;
    x.classList.toggle("seg__btn--active", active);
    x.setAttribute("aria-selected", active ? "true" : "false");
  });
}
applyModeToUI(getMode());

modeSeg?.addEventListener("click", (e) => {
  const b = e.target.closest(".seg__btn");
  if (!b) return;
  const m = b.dataset.mode === "tun" ? "tun" : "proxy";
  setMode(m);
  applyModeToUI(m);
  updateHeroHint();
});

// ── Add Profile Modal — Hiddify-style ──────────────────────
const profilesSummary = document.getElementById("profiles-summary");

mountAddModal({
  onCommit: (res) => {
    toast(res.message, "success", 2000);
    refreshProfilesSummary();
  },
});

document.getElementById("add-sub")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAllPopovers();
  openAddModal();
});

function refreshProfilesSummary() {
  if (!profilesSummary) return;
  const profilesList = loadProfiles();
  const subsList = loadSubscriptions();
  const src = getActiveSource();
  if (!src) {
    profilesSummary.textContent = "Ничего не выбрано — импортируйте конфиг или подписку.";
  } else if (src.kind === "sub") {
    const n = src.nodes.length;
    profilesSummary.textContent = `Подписка: ${src.subscription.name} (${n} ${plural(n, ["нода", "ноды", "нод"])})`;
  } else {
    profilesSummary.textContent = `Активный: ${src.profile.name || "—"} (${profilesList.length} ${plural(profilesList.length, ["профиль", "профиля", "профилей"])}${subsList.length ? `, подписок ${subsList.length}` : ""})`;
  }
  renderProfilesView();
  updateHeroForActive();
  refreshSubCardFromActive();
}

// ── sub-card sync с активной подпиской ─────────────────────
const subName = document.querySelector(".sub-card__name");
const subExpire = document.getElementById("sub-expire");
const subExpireUnit = document.querySelector(".sub-card__expire");
const subProgressFill = document.getElementById("sub-progress-fill");
const subTrafficUsed = document.getElementById("sub-traffic-used");
const subTrafficTotal = document.getElementById("sub-traffic-total");
const subUpdated = document.getElementById("sub-updated");

function refreshSubCardFromActive() {
  const src = getActiveSource();
  if (src?.kind === "sub") {
    const sub = src.subscription;
    if (subName) subName.textContent = sub.name?.toUpperCase() || "ПОДПИСКА";
    const days = subscriptionDaysLeft(sub);
    if (subExpire) subExpire.textContent = days != null ? String(days) : "—";
    if (subExpireUnit) subExpireUnit.style.display = days != null ? "" : "none";
    const used = subscriptionUsedBytes(sub);
    const total = sub.total ?? null;
    if (subTrafficUsed) subTrafficUsed.textContent = formatGiB(used);
    if (subTrafficTotal) subTrafficTotal.textContent = total != null ? formatGiB(total) : "—";
    if (subProgressFill && total) {
      const pct = Math.min(100, (used / total) * 100);
      subProgressFill.style.width = `${pct.toFixed(1)}%`;
    } else if (subProgressFill) {
      subProgressFill.style.width = "0%";
    }
    if (subUpdated) subUpdated.textContent = relativeTime(sub.lastUpdate);
  } else if (src?.kind === "single") {
    if (subName) subName.textContent = "ЛОКАЛЬНЫЙ КОНФИГ";
    if (subExpire) subExpire.textContent = "—";
    if (subExpireUnit) subExpireUnit.style.display = "none";
    if (subTrafficUsed) subTrafficUsed.textContent = "—";
    if (subTrafficTotal) subTrafficTotal.textContent = "—";
    if (subProgressFill) subProgressFill.style.width = "0%";
    if (subUpdated) subUpdated.textContent = "—";
  } else {
    if (subName) subName.textContent = "НЕТ ПОДПИСКИ";
    if (subExpire) subExpire.textContent = "—";
    if (subExpireUnit) subExpireUnit.style.display = "none";
    if (subTrafficUsed) subTrafficUsed.textContent = "—";
    if (subTrafficTotal) subTrafficTotal.textContent = "—";
    if (subProgressFill) subProgressFill.style.width = "0%";
    if (subUpdated) subUpdated.textContent = "—";
  }
}

function plural(n, forms) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}


// ── Навигация ───────────────────────────────────────────────
const navItems = document.querySelectorAll(".menu__item[data-view]");
const views = document.querySelectorAll("section.view[data-view]");

function switchView(target) {
  navItems.forEach((n) => n.classList.toggle("menu__item--active", n.dataset.view === target));
  views.forEach((v) => { v.hidden = v.dataset.view !== target; });
  if (typeof onLogsViewLeave === "function" && typeof onLogsViewEnter === "function") {
    if (target === "logs") onLogsViewEnter();
    else onLogsViewLeave();
  }
  if (target === "proxies") onProxiesViewEnter();
  else onProxiesViewLeave();
  if (target === "settings") setTimeout(applySettingsVersion, 0);
}

navItems.forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

document.getElementById("location-card")?.addEventListener("click", (e) => {
  if (e.target.closest(".hero__disc")) return;
  // Hiddify-логика: список нод доступен только при активном VPN.
  if (state !== "connected") {
    toast("Сначала подключитесь", "info", 1400);
    return;
  }
  switchView("proxies");
});

// Mount Proxies view (FAB-молния → перетест группы)
mountProxiesView({ onToast: toast });

// ── Settings view ──────────────────────────────────────────
const settingsRoot = document.getElementById("settings-root");
let settingsCtl = null;
if (settingsRoot) {
  settingsCtl = mountSettings(settingsRoot, {
    onChange: (path) => {
      // Тогглы periodic re-scan и его интервал — не трогают sing-box, только
      // фоновый JS-loop. Пересоздаём loop сразу, реконнект не нужен.
      if (path === "warp.autoRescan" || path === "warp.autoRescanIntervalMin" || path === "warp.autoRescanThresholdMs") {
        startWarpRescanLoop();
        return;
      }
      if (!pathNeedsRestart(path)) return;
      if (state === "connected" || state === "connecting") {
        scheduleAutoReconnect();
      }
      if (state === "idle") updateHeroHint();
    },
    onRender: () => applySettingsVersion(),
  });
}

// Какие настройки реально приводят к изменению sing-box конфига и требуют
// рестарта ядра. Всё остальное (Windows-state, неактивные ветки config'а) —
// применяется мгновенно, без переподключения.
function pathNeedsRestart(path) {
  if (!path) return true;
  // Windows-сторона, sing-box не трогает
  if (path === "general.autostart") return false;
  if (path === "general.startMinimized") return false;
  if (path.startsWith("general.urlSchemes")) return false;
  // balancerStrategy сейчас не передаётся в config (strategy захардкожена в singbox.js)
  if (path === "route.balancerStrategy") return false;
  const opts = loadOptions();
  // WARP register/reset — переразложить config нужно только если WARP активен
  if (path === "warp.registered") return !!opts.warp?.enabled;
  // warp.deepScan и warp.autoRescan* — не идут в config sing-box, только в UI/JS-loop
  if (path === "warp.deepScan") return false;
  if (path.startsWith("warp.autoRescan")) return false;
  // customNoise активна только при noisePreset=="custom"; если другой — игнор
  if (path.startsWith("warp.customNoise.") && opts.warp?.noisePreset !== "custom") return false;
  // WARP-настройки при выключенном WARP в config не попадают
  if (path.startsWith("warp.") && path !== "warp.enabled" && !opts.warp?.enabled) return false;
  // TUN-only поля в proxy-режиме не используются (см. inbound в singbox.js)
  if (path === "inbound.mtu" || path === "inbound.tunStack" || path === "inbound.strictRoute") {
    return getMode() === "tun";
  }
  return true;
}

const RECONNECT_DEBOUNCE_MS = 1200;
let pendingReconnectTimer = null;

function scheduleAutoReconnect() {
  if (state !== "connected" && state !== "connecting") return;
  needsReconnect = true;
  applyReconnectUI();
  if (pendingReconnectTimer) clearTimeout(pendingReconnectTimer);
  pendingReconnectTimer = setTimeout(performAutoReconnect, RECONNECT_DEBOUNCE_MS);
}

async function performAutoReconnect() {
  pendingReconnectTimer = null;
  if (!needsReconnect) return;
  if (state !== "connected" && state !== "connecting") return;
  toast("Применяю новые настройки…", "info", 1400);
  try { await invoke("set_system_proxy", { enable: false }); } catch {}
  try { await invoke("stop_singbox"); } catch {}
  setState("idle");
  needsReconnect = false;
  applyReconnectUI();
  setTimeout(() => heroDisc?.click(), 60);
}

function applyReconnectUI() {
  if (!hero) return;
  if (needsReconnect && (state === "connected" || state === "connecting")) {
    hero.classList.add("hero--reconnect");
    if (heroLabel) heroLabel.textContent = "RECONNECT";
    if (heroHint) heroHint.textContent = "Применяю новые настройки…";
  } else {
    hero.classList.remove("hero--reconnect");
  }
}

// ── WARP periodic re-scan ───────────────────────────────────
// Раз в N минут (warp.autoRescanIntervalMin) опрашиваем delay outbound "warp"
// через clash-API. Если выше порога — запускаем scan, ставим лучший endpoint
// и дёргаем auto-reconnect. Активно только при state=connected + warp.enabled
// + warp.autoRescan.
let warpRescanTimer = null;
let warpRescanInFlight = false;

function startWarpRescanLoop() {
  stopWarpRescanLoop();
  const opts = loadOptions();
  if (!opts.warp?.enabled || !opts.warp?.autoRescan) return;
  if (state !== "connected") return;
  const minutes = Math.max(5, Math.min(360, Number(opts.warp?.autoRescanIntervalMin) || 30));
  warpRescanTimer = setInterval(warpRescanTick, minutes * 60_000);
}

function stopWarpRescanLoop() {
  if (warpRescanTimer) { clearInterval(warpRescanTimer); warpRescanTimer = null; }
}

async function warpRescanTick() {
  if (warpRescanInFlight) return;
  if (state !== "connected") return;
  const opts = loadOptions();
  if (!opts.warp?.enabled || !opts.warp?.autoRescan) return;
  const threshold = Math.max(100, Number(opts.warp?.autoRescanThresholdMs) || 300);
  warpRescanInFlight = true;
  try {
    let curDelay = 0;
    try {
      const r = await testNode("warp", { timeoutMs: 4000, url: "http://cp.cloudflare.com/generate_204" });
      curDelay = r?.delay || 0;
    } catch { curDelay = 0; }
    // 0 = таймаут или not-reachable, выше порога — ротируем.
    if (curDelay > 0 && curDelay <= threshold) return;
    toast(`WARP delay ${curDelay || "—"}мс — ищу лучший endpoint`, "info", 2200);
    let results = [];
    try {
      results = await invoke("warp_scan_endpoints", { topN: 5, deep: false, mode: "wg" });
    } catch { return; }
    const best = Array.isArray(results) && results.length ? results[0] : null;
    if (!best) return;
    // Применяем только если новый лучше на ≥50мс, чтобы не дёргаться от шума.
    if (curDelay > 0 && best.latency_ms + 50 >= curDelay) {
      toast(`WARP: лучший найденный ${best.latency_ms}мс — текущий ${curDelay}мс уже норм`, "info", 2400);
      return;
    }
    const newEndpoint = `${best.ip}:${best.port}`;
    updateOption("warp.endpoint", newEndpoint);
    toast(`WARP → ${newEndpoint} (${best.latency_ms}мс)`, "success", 2400);
    scheduleAutoReconnect();
  } finally {
    warpRescanInFlight = false;
  }
}

navItems.forEach((item) => {
  if (item.dataset.view !== "settings") return;
  item.addEventListener("click", () => {
    if (settingsCtl) settingsCtl.goMenu();
  });
});

// ── Logs view ──────────────────────────────────────────────
const logsView = document.getElementById("logs-view");
const logsPath = document.getElementById("logs-path");
const logsSize = document.getElementById("logs-size");
const logsAuto = document.getElementById("logs-auto");
const logsRefreshBtn = document.getElementById("logs-refresh");
const logsCopyBtn = document.getElementById("logs-copy");
const logsClearBtn = document.getElementById("logs-clear");
const logsOpenBtn = document.getElementById("logs-open");

let logsTimer = null;
let logsActive = false;
let logsLastValue = "";

function formatBytes(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КиБ`;
  return `${(n / 1024 / 1024).toFixed(2)} МиБ`;
}

async function refreshLogs({ keepScroll = false } = {}) {
  if (!logsView) return;
  try {
    const text = await invoke("read_singbox_log", { tailBytes: 256 * 1024 });
    if (text === logsLastValue) return;
    logsLastValue = text;
    const atBottom = !keepScroll || (logsView.scrollTop + logsView.clientHeight >= logsView.scrollHeight - 8);
    logsView.value = text || "";
    if (atBottom) logsView.scrollTop = logsView.scrollHeight;
    if (logsSize) {
      const bytes = new TextEncoder().encode(text || "").length;
      logsSize.textContent = text ? formatBytes(bytes) : "пусто";
    }
  } catch (e) {
    if (logsView) logsView.value = `Ошибка чтения лога: ${e?.message || e}`;
  }
}

async function refreshLogsPath() {
  if (!logsPath) return;
  try {
    const path = await invoke("singbox_log_path");
    logsPath.textContent = path;
    logsPath.title = path;
  } catch {
    logsPath.textContent = "—";
  }
}

function startLogsAuto() {
  stopLogsAuto();
  if (!logsAuto?.checked) return;
  logsTimer = setInterval(() => refreshLogs({ keepScroll: true }), 2000);
}

function stopLogsAuto() {
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
}

logsAuto?.addEventListener("change", () => {
  if (logsActive && logsAuto.checked) startLogsAuto();
  else stopLogsAuto();
});

logsRefreshBtn?.addEventListener("click", () => refreshLogs());

logsCopyBtn?.addEventListener("click", async () => {
  const text = logsView?.value || "";
  if (!text) { toast("Лог пуст", "info", 1400); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast("Лог скопирован в буфер", "success", 1600);
  } catch {
    logsView.focus();
    logsView.select();
    try {
      document.execCommand("copy");
      toast("Лог скопирован", "success", 1600);
    } catch {
      toast("Не удалось скопировать — выделите вручную (Ctrl+A, Ctrl+C)", "error", 3000);
    }
  }
});

logsClearBtn?.addEventListener("click", async () => {
  try {
    await invoke("clear_singbox_log");
    logsLastValue = "__force__";
    await refreshLogs();
    toast("Лог очищен", "info", 1400);
  } catch (e) {
    toast(`Не удалось очистить: ${e?.message || e}`, "error", 2500);
  }
});

logsOpenBtn?.addEventListener("click", async () => {
  try { await invoke("open_log_dir"); }
  catch (e) { toast(`Не удалось открыть папку: ${e?.message || e}`, "error", 2500); }
});

function onLogsViewEnter() {
  logsActive = true;
  refreshLogsPath();
  refreshLogs();
  startLogsAuto();
}

function onLogsViewLeave() {
  logsActive = false;
  stopLogsAuto();
}

// ── Profiles view ──────────────────────────────────────────
const profilesView = document.querySelector('section.view[data-view="profiles"]');

const ICON_DOTS = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const ICON_REFRESH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
const ICON_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICON_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_QR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3"/><path d="M20 14v3"/><path d="M14 20h3"/><path d="M17 17h4v4h-4z"/></svg>`;

function renderProfilesView() {
  if (!profilesView) return;
  const profilesList = loadProfiles();
  const subsList = loadSubscriptions();
  const activeProfileId = getActiveProfileId();
  const activeKind = getActiveKind();
  const activeSubId = getActiveSubscriptionId();

  if (profilesList.length === 0 && subsList.length === 0) {
    profilesView.innerHTML = `
      <div class="profiles-empty">
        <div class="profiles-empty__title">Нет профилей</div>
        <div class="profiles-empty__sub">Добавьте подписку по URL или одиночный vless:// — кнопка «+» снизу справа или на главном экране.</div>
      </div>
      <button class="profiles-fab" id="profiles-fab" type="button">${ICON_PLUS}<span>Добавить профиль</span></button>
    `;
    return;
  }

  const subItems = subsList.map(s => {
    const isActive = activeKind === "sub" && s.id === activeSubId;
    const days = subscriptionDaysLeft(s);
    const used = subscriptionUsedBytes(s);
    const total = s.total ?? null;
    const pct = total ? Math.min(100, (used / total) * 100) : 0;
    const expired = days === 0;
    const traffic = total != null
      ? `${formatGiB(used)} / ${formatGiB(total)} ГиБ`
      : `${formatGiB(used)} ГиБ`;
    const daysText = days == null ? "—" : (expired ? "Истекла" : `осталось ${days} дн`);
    return `
      <div class="ptile${isActive ? " ptile--active" : ""}" data-sub-id="${s.id}">
        <button class="ptile__menu" data-menu-sub="${s.id}" type="button" aria-label="Меню">${ICON_DOTS}</button>
        <div class="ptile__body" data-sub-activate="${s.id}">
          <div class="ptile__head">
            <span class="ptile__name">${escapeHtml(s.name)}</span>
            <span class="ptile__chip">${s.profiles?.length || 0} нод</span>
          </div>
          <div class="ptile__progress"><div class="ptile__progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="ptile__info${expired ? " ptile__info--expired" : ""}">
            <span>${escapeHtml(traffic)}</span>
            <span>${escapeHtml(daysText)}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");

  const profileItems = profilesList.map(p => {
    const isActive = activeKind === "single" && p.id === activeProfileId;
    return `
      <div class="ptile${isActive ? " ptile--active" : ""}" data-id="${p.id}">
        <button class="ptile__menu" data-menu-profile="${p.id}" type="button" aria-label="Меню">${ICON_DOTS}</button>
        <div class="ptile__body" data-profile-activate="${p.id}">
          <div class="ptile__head">
            <span class="ptile__name">${escapeHtml(p.name)}</span>
            <span class="ptile__chip">${escapeHtml((p.security || "tcp").toUpperCase())}</span>
          </div>
          <div class="ptile__info">
            <span>${escapeHtml(`${p.host}:${p.port}`)}</span>
            <span>${escapeHtml((p.type || "tcp").toUpperCase())}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");

  profilesView.innerHTML = `
    <div class="profiles-list">
      ${subsList.length ? `<h2 class="profiles-list__title">Подписки</h2>${subItems}` : ""}
      ${profilesList.length ? `<h2 class="profiles-list__title">Конфиги</h2>${profileItems}` : ""}
    </div>
    <button class="profiles-fab" id="profiles-fab" type="button">${ICON_PLUS}<span>Добавить профиль</span></button>
  `;
}

// Popup-меню действий
let openMenu = null;
function closePMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener("click", onDocClickClosePMenu); }
}
function onDocClickClosePMenu(e) {
  if (openMenu && !openMenu.contains(e.target)) closePMenu();
}
function openPMenu(anchor, items) {
  closePMenu();
  const menu = document.createElement("div");
  menu.className = "pmenu";
  menu.innerHTML = items.map(it => `
    <button class="pmenu__item${it.danger ? " pmenu__item--danger" : ""}" data-act="${it.id}" type="button">
      ${it.icon || ""}<span>${escapeHtml(it.label)}</span>
    </button>
  `).join("");
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left;
  if (top + m.height > window.innerHeight - 12) top = rect.top - m.height - 6;
  if (left + m.width > window.innerWidth - 12) left = window.innerWidth - m.width - 12;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  openMenu = menu;
  setTimeout(() => document.addEventListener("click", onDocClickClosePMenu), 10);
  return menu;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

profilesView?.addEventListener("click", async (e) => {
  // FAB → открыть add-modal
  if (e.target.closest("#profiles-fab")) {
    openAddModal();
    return;
  }

  // Меню (3 точки) подписки
  const subMenuBtn = e.target.closest("[data-menu-sub]");
  if (subMenuBtn) {
    e.stopPropagation();
    const id = subMenuBtn.dataset.menuSub;
    const menu = openPMenu(subMenuBtn, [
      { id: "refresh",  label: "Обновить",  icon: ICON_REFRESH },
      { id: "edit",     label: "Редактировать", icon: ICON_EDIT },
      { id: "copy",     label: "Копировать URL", icon: ICON_COPY },
      { id: "qr",       label: "Показать QR", icon: ICON_QR },
      { id: "export",   label: "Экспорт sing-box JSON", icon: ICON_COPY },
      { id: "activate", label: "Сделать активной", icon: ICON_CHECK },
      { id: "remove",   label: "Удалить",   icon: ICON_TRASH, danger: true },
    ]);
    menu.addEventListener("click", async (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      closePMenu();
      if (act === "edit") {
        const sub = loadSubscriptions().find(s => s.id === id);
        if (sub) openEditSubscription(sub, { onSaved: () => { refreshProfilesSummary(); }, onToast: toast });
        return;
      }
      if (act === "refresh") {
        try {
          const r = await refreshSubscription(id);
          toast(`Обновлено: ${r.profiles.length} нод`, "success", 1800);
        } catch (err) {
          toast(`Ошибка: ${err?.message || err}`, "error", 2800);
        }
        renderProfilesView();
        refreshSubCardFromActive();
      } else if (act === "copy") {
        const sub = loadSubscriptions().find(s => s.id === id);
        await copySubscriptionUrl(sub, toast);
      } else if (act === "qr") {
        const sub = loadSubscriptions().find(s => s.id === id);
        if (sub) openQRModal(sub);
      } else if (act === "export") {
        const sub = loadSubscriptions().find(s => s.id === id);
        if (sub) await exportSingboxJson({ kind: "sub", subscription: sub, nodes: sub.profiles }, toast);
      } else if (act === "activate") {
        setActiveKind("sub");
        setActiveSubscriptionId(id);
        refreshProfilesSummary();
        toast("Подписка активирована", "success", 1800);
      } else if (act === "remove") {
        removeSubscription(id);
        if (getActiveKind() === "sub" && !getActiveSubscriptionId()) setActiveKind("single");
        refreshProfilesSummary();
        toast("Подписка удалена", "info", 1800);
      }
    });
    return;
  }

  // Меню (3 точки) одиночного профиля
  const profileMenuBtn = e.target.closest("[data-menu-profile]");
  if (profileMenuBtn) {
    e.stopPropagation();
    const id = profileMenuBtn.dataset.menuProfile;
    const menu = openPMenu(profileMenuBtn, [
      { id: "edit",     label: "Редактировать",    icon: ICON_EDIT },
      { id: "activate", label: "Сделать активным", icon: ICON_CHECK },
      { id: "remove",   label: "Удалить",          icon: ICON_TRASH, danger: true },
    ]);
    menu.addEventListener("click", (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      closePMenu();
      if (act === "edit") {
        const p = loadProfiles().find(x => x.id === id);
        if (p) openEditProfile(p, { onSaved: () => { refreshProfilesSummary(); }, onToast: toast });
        return;
      }
      if (act === "activate") {
        setActiveProfileId(id);
        setActiveKind("single");
        refreshProfilesSummary();
        toast("Профиль активирован", "success", 1800);
      } else if (act === "remove") {
        removeProfile(id);
        refreshProfilesSummary();
        toast("Профиль удалён", "info", 1800);
      }
    });
    return;
  }

  // Клик по телу карточки → активация (Hiddify-стиль)
  const subActivate = e.target.closest("[data-sub-activate]");
  if (subActivate) {
    const id = subActivate.dataset.subActivate;
    setActiveKind("sub");
    setActiveSubscriptionId(id);
    refreshProfilesSummary();
    toast("Подписка активирована", "success", 1500);
    return;
  }
  const profileActivate = e.target.closest("[data-profile-activate]");
  if (profileActivate) {
    const id = profileActivate.dataset.profileActivate;
    setActiveProfileId(id);
    setActiveKind("single");
    refreshProfilesSummary();
    toast("Профиль активирован", "success", 1500);
    return;
  }
});

// ── HERO ───────────────────────────────────────────────────
const hero = document.getElementById("hero");
const heroDisc = document.getElementById("hero-disc");
const heroMask = document.getElementById("hero-mask");
const heroLabel = document.getElementById("hero-label");
const heroHint = document.getElementById("hero-hint");
const heroPing = document.getElementById("hero-ping");
const heroPingValue = document.getElementById("hero-ping-value");
const tfDown = document.getElementById("tf-down");
const tfUp = document.getElementById("tf-up");
const tfDownUnit = document.getElementById("tf-down-unit");
const tfUpUnit = document.getElementById("tf-up-unit");
const locPing = document.getElementById("loc-ping");
const locPingDot = document.querySelector(".location-card__ping .status-dot");
const locIpRow = document.getElementById("loc-ip-row");
const locIp = document.getElementById("loc-ip");

let lastPublicIp = null;
if (locIp) bindIpReveal(locIp, () => lastPublicIp);

async function refreshPublicIp() {
  if (state !== "connected") return;
  const m = getMode();
  const port = loadOptions().inbound.mixedPort || 7890;
  const proxyHostPort = m === "proxy" ? `127.0.0.1:${port}` : null;
  try {
    const info = await fetchPublicIp({ proxyHostPort });
    if (!info?.success && info?.ip == null) {
      // ipwho.is при ошибке отдаёт { success: false, message }
      throw new Error(info?.message || "no ip");
    }
    lastPublicIp = info.ip;
    if (locIpRow) locIpRow.hidden = false;
    if (locIp) {
      locIp.textContent = maskIp(info.ip);
      locIp.dataset.revealed = "false";
      const flag = info.country_code?.toLowerCase();
      const country = info.country || info.country_code || "";
      if (flag) locIp.title = `${country} · кликните, чтобы показать IP на 20 сек`;
    }
  } catch (e) {
    if (locIpRow) locIpRow.hidden = false;
    if (locIp) locIp.textContent = "— · —";
    console.warn("public ip failed", e?.message || e);
  }
}
const locName = document.querySelector(".location-card__name");
const locProto = document.querySelector(".location-card__proto");
const locFlag = document.querySelector(".location-card__flag");

const FLAGS_BASE = "/assets/flags";
const FLAG_NON_ISO_ALIAS = { uk: "gb", en: "gb", uae: "ae", usa: "us", rus: "ru" };

function isoFromNodeName(name) {
  if (!name) return null;
  const cps = Array.from(name);
  for (let i = 0; i < cps.length - 1; i++) {
    const a = cps[i].codePointAt(0);
    const b = cps[i + 1].codePointAt(0);
    if (a >= 0x1F1E6 && a <= 0x1F1FF && b >= 0x1F1E6 && b <= 0x1F1FF) {
      return String.fromCharCode(97 + (a - 0x1F1E6)) + String.fromCharCode(97 + (b - 0x1F1E6));
    }
  }
  const m = String(name).match(/(?:^|[\s|·,])([A-Za-z]{2,3})\b/);
  if (m) {
    const tok = m[1].toLowerCase();
    if (FLAG_NON_ISO_ALIAS[tok]) return FLAG_NON_ISO_ALIAS[tok];
    if (tok.length === 2) return tok;
  }
  return null;
}

function setLocationFlag(iso) {
  if (!locFlag) return;
  if (iso) {
    locFlag.innerHTML = `<img src="${FLAGS_BASE}/${iso}.svg" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
  }
}

if (heroMask) heroMask.playbackRate = 0.6;

// Изначально data-attr "idle" — чтобы CSS прятал location-card до коннекта
{
  const v = document.querySelector('.view--connect');
  if (v) v.dataset.connState = "idle";
}

let state = "idle";
let needsReconnect = false;
let publicIpTimer = null;

function setHeroClass(cls) {
  hero.classList.remove("hero--connecting", "hero--connected");
  if (cls) hero.classList.add(cls);
}

function showPing(show) {
  if (!heroPing) return;
  if (show) heroPing.removeAttribute("hidden");
  else heroPing.setAttribute("hidden", "");
}

function updateHeroHint() {
  if (state !== "idle") return;
  const src = getActiveSource();
  if (!src) {
    heroHint.textContent = "Импортируйте конфиг или подписку через кнопку «+»";
    heroDisc.disabled = true;
    heroDisc.setAttribute("aria-disabled", "true");
  } else {
    const mode = getMode() === "tun" ? "VPN-туннель" : "системный прокси";
    heroHint.textContent = `Нажмите, чтобы поднять ${mode}`;
    heroDisc.disabled = false;
    heroDisc.removeAttribute("aria-disabled");
  }
}

// Текущая нода через которую реально идёт трафик — приходит из clash-API
// event'ом ninety:node-changed. Когда null — fallback на nodes[0]/profile.
let currentEffectiveNode = null;

function activeNodeForDisplay() {
  if (currentEffectiveNode) return currentEffectiveNode;
  const src = getActiveSource();
  return src?.kind === "sub" ? src.nodes[0] : src?.profile;
}

function updateHeroForActive() {
  const src = getActiveSource();
  const p = activeNodeForDisplay();
  if (locName) {
    if (src?.kind === "sub") {
      const nodeLabel = p?.name || p?.host || "—";
      locName.textContent = `${src.subscription.name} · ${nodeLabel}`;
    } else if (p) {
      locName.textContent = p.name || p.host;
    }
  }
  if (locProto && p) {
    const proto = (p.proto || "vless").toUpperCase();
    const parts = [proto];
    const sec = p.security || p.tlsMode;
    if (sec && sec !== "none") parts.push(sec);
    if (p.type) parts.push(p.type.toUpperCase());
    locProto.textContent = parts.join(" · ");
  }
  if (p) {
    const iso = isoFromNodeName(p.name) || isoFromNodeName(p.host);
    setLocationFlag(iso);
  }
  if (state === "idle") updateHeroHint();
}

function setState(next, opts = {}) {
  state = next;
  // Сигнал для CSS — скрытие location-card снизу когда idle/connecting
  const view = document.querySelector('.view--connect');
  if (view) view.dataset.connState = next;

  if (next === "idle") {
    needsReconnect = false;
    if (pendingReconnectTimer) { clearTimeout(pendingReconnectTimer); pendingReconnectTimer = null; }
    stopWarpRescanLoop();
    applyReconnectUI();
    setHeroClass(null);
    heroLabel.textContent = "Не подключено";
    showPing(false);
    heroDisc.setAttribute("aria-label", "Подключиться");
    tfDown.textContent = "0";
    tfUp.textContent = "0";
    if (tfDownUnit) tfDownUnit.textContent = "КиБ/с";
    if (tfUpUnit) tfUpUnit.textContent = "КиБ/с";
    if (heroMask) heroMask.playbackRate = 0.6;
    stopClashStream();
    if (publicIpTimer) { clearInterval(publicIpTimer); publicIpTimer = null; }
    lastPublicIp = null;
    if (locIpRow) locIpRow.hidden = true;
    currentEffectiveNode = null;
    if (heroHint) heroHint.hidden = false;
    updateHeroHint();
  } else if (next === "connecting") {
    setHeroClass("hero--connecting");
    heroLabel.textContent = "Подключаюсь…";
    // Без хардкода хоста — Hiddify тоже не показывает в этом состоянии.
    if (heroHint) { heroHint.textContent = "Поднимаю туннель"; heroHint.hidden = false; }
    showPing(false);
    heroDisc.setAttribute("aria-label", "Отменить подключение");
    if (heroMask) heroMask.playbackRate = 1.6;
  } else if (next === "connected") {
    setHeroClass("hero--connected");
    heroLabel.textContent = "Подключено";
    // Никаких "Трафик идёт через …" — это был хардкод. Пинг — единственный
    // признак ниже label, как в Hiddify (Wi-Fi + значение).
    if (heroHint) heroHint.hidden = true;
    applyPingDisplay(opts.ping ?? null);
    showPing(true);
    heroDisc.setAttribute("aria-label", "Отключиться");
    if (heroMask) heroMask.playbackRate = 1.0;
    startTrafficStream();
    startWarpRescanLoop();
  }
}

// Единый рендерер пинга в hero и location-card.
// delay > 0 && < 65000 → число + grade; 0/null → "— мс"; >= 65000 → "Тайм-аут"
function applyPingDisplay(delay) {
  const num = Number(delay);
  let text, grade;
  if (!num || num <= 0) { text = "— мс"; grade = "dead"; }
  else if (num >= 65000) { text = "Тайм-аут"; grade = "dead"; }
  else { text = `${num} мс`; grade = gradeDelay(num); }

  if (heroPingValue) heroPingValue.textContent = text;
  if (heroPing) heroPing.dataset.grade = grade;
  if (locPing) locPing.textContent = text;
  if (locPingDot) locPingDot.dataset.state = grade === "good" ? "online" : (grade === "mid" ? "warn" : "offline");
}

// ── real-time WS-стрим из clash-API ────────────────────────
function applyTrafficValues({ up, down }) {
  if (state !== "connected") return;
  const d = formatRate(down);
  const u = formatRate(up);
  if (tfDown) tfDown.textContent = d.value;
  if (tfUp) tfUp.textContent = u.value;
  if (tfDownUnit) tfDownUnit.textContent = d.unit;
  if (tfUpUnit) tfUpUnit.textContent = u.unit;
}

function applyPingValue({ delay }) {
  if (state !== "connected") return;
  applyPingDisplay(delay);
}

// Клик по ping-пилюле = принудительный force-test задержки текущей ноды.
// При timeout/недоступности — показываем «Тайм-аут».
let manualTestInFlight = false;
heroPing?.addEventListener("click", async () => {
  if (state !== "connected") return;
  if (manualTestInFlight) return;
  manualTestInFlight = true;
  heroPing.dataset.testing = "true";
  try {
    let target = null;
    try {
      const data = await getProxies();
      target = pickEffectiveNode(data);
    } catch {}
    if (!target) {
      applyPingDisplay(0);
      return;
    }
    try {
      const r = await testNode(target, { timeoutMs: 5000 });
      const fresh = Number(r?.delay) || 0;
      applyPingDisplay(fresh > 0 && fresh < 65000 ? fresh : 65000);
    } catch {
      applyPingDisplay(65000); // → «Тайм-аут»
    }
  } finally {
    delete heroPing.dataset.testing;
    manualTestInFlight = false;
  }
});

async function startTrafficStream() {
  try {
    await startClashStream({
      onTraffic: applyTrafficValues,
      onPing: applyPingValue,
      onNodeChange: ({ tag }) => {
        // Эффективная нода реально поменялась (URLTest перевыбрал или юзер выбрал)
        syncEffectiveFromClash({ knownTag: tag });
      },
    });
  } catch (e) {
    console.warn("startClashStream failed", e);
  }
  // Публичный IP — отложенно (sing-box секунду стартует), потом раз в 5 мин
  setTimeout(refreshPublicIp, 2500);
  if (publicIpTimer) clearInterval(publicIpTimer);
  publicIpTimer = setInterval(refreshPublicIp, 5 * 60_000);
}

// Подтягивает effective node через clash → обновляет hero/location/IP.
// Если knownTag передан — используем его (без лишнего запроса в clash).
async function syncEffectiveFromClash({ knownTag } = {}) {
  let tag = knownTag || null;
  if (!tag) {
    try {
      const data = await getProxies();
      tag = pickEffectiveNode(data);
    } catch { return; }
  }
  if (!tag) return;
  const src = getActiveSource();
  if (!src || src.kind !== "sub") return;
  // Тэг outbound'а — единая формула из singbox.js (nodeTag), чтобы не разъезжалось.
  const node = src.nodes.find((n, i) => nodeTag(i, n) === tag);
  if (!node) return;
  const prevHost = currentEffectiveNode?.host;
  currentEffectiveNode = node;
  updateHeroForActive();
  if (state === "connected" && prevHost && prevHost !== node.host) {
    // Сервер реально сменился — IP надо перечитать
    if (locIp) locIp.textContent = "— · —";
    setTimeout(refreshPublicIp, 600);
  }
}

// Слушаем событие из proxies-view: юзер кликнул ноду / URLTest переключился
window.addEventListener("ninety:node-changed", (ev) => {
  const tag = ev.detail?.tag;
  syncEffectiveFromClash({ knownTag: tag });
});

heroDisc?.addEventListener("click", async () => {
  if (heroDisc.disabled) return;
  // RECONNECT-режим: рестарт ядра с новыми опциями
  if (needsReconnect && (state === "connected" || state === "connecting")) {
    try { await invoke("set_system_proxy", { enable: false }); } catch {}
    try { await invoke("stop_singbox"); } catch {}
    setState("idle");
    needsReconnect = false;
    applyReconnectUI();
    // мгновенно стартуем заново
    setTimeout(() => heroDisc.click(), 60);
    return;
  }
  if (state === "idle") {
    const src = getActiveSource();
    if (!src) { toast("Сначала импортируйте конфиг или подписку", "error"); return; }
    const mode = getMode();
    const options = loadOptions();
    // Если WARP включён — тянем регистрацию из app_config_dir/warp.json
    // и передаём в builder. Без warpInfo builder тихо пропустит warp endpoint.
    let warpInfo = null;
    if (options.warp?.enabled) {
      try { warpInfo = await invoke("warp_status"); } catch {}
      if (!warpInfo) {
        toast("WARP включён, но не зарегистрирован — Settings → WARP → «Зарегистрировать»", "error", 3500);
        return;
      }
    }
    const config = buildConfig({ source: src, mode, options, warpInfo });
    setState("connecting");
    try {
      await invoke("start_singbox", { configJson: JSON.stringify(config), mode });
      if (mode === "proxy") {
        await invoke("set_system_proxy", { enable: true, hostPort: `127.0.0.1:${options.inbound.mixedPort || 7890}` });
      }
      setState("connected", { ping: "— мс" });
      toast("Подключено", "success", 1600);
      // Через 800мс синхронизируем effective node через clash — URLTest уже выбрал ноду
      setTimeout(syncEffectiveFromClash, 800);
      const p2 = activeNodeForDisplay();
      notify("Ninety · подключено", p2 ? `Через ${p2.host}` : "Туннель поднят");
    } catch (e) {
      console.error("start failed", e);
      setState("idle");
      toast(`Не удалось запустить — открываю логи`, "error", 3500);
      try { await invoke("stop_singbox"); } catch {}
      try { await invoke("set_system_proxy", { enable: false }); } catch {}
      switchView("logs");
    }
  } else if (state === "connecting" || state === "connected") {
    try { await invoke("set_system_proxy", { enable: false }); } catch {}
    try { await invoke("stop_singbox"); } catch (e) { console.warn("stop failed", e); }
    setState("idle");
    toast("Отключено", "info", 1400);
    notify("Ninety · отключено", "Туннель закрыт");
  }
});

// ── Bootstrap ──────────────────────────────────────────────
if (locPing) locPing.textContent = "— мс";
refreshProfilesSummary();
updateHeroHint();

// При старте app — синхронизируем UI с реальным состоянием sing-box
(async () => {
  try {
    const running = await invoke("singbox_running");
    if (running) {
      setState("connected", { ping: "— мс" });
    }
  } catch {}
})();

// startMinimized: на ручном запуске скрыть окно если опция включена.
// (При --autostarted Rust уже скрыл окно в setup() — здесь повтор без вреда.)
(async () => {
  try {
    const opts = loadOptions();
    if (opts.general?.startMinimized && tauriWin?.hide) {
      await tauriWin.hide();
    }
  } catch {}
})();

// Автостарт через Windows login: после bootstrap'а сразу поднимаем VPN
// с последним выбранным сервером. Если sing-box уже работает (например
// перезапуск UI поверх живого ядра) — не дёргаем. Без активного source
// тоже ничего не делаем (heroDisc был бы disabled).
(async () => {
  try {
    const autostarted = await invoke("is_autostarted");
    if (!autostarted) return;
    const running = await invoke("singbox_running");
    if (running) return;
    if (!getActiveSource()) return;
    // Дать UI смонтироваться (heroDisc обвешан обработчиком в самом конце)
    await new Promise(r => setTimeout(r, 600));
    if (state === "idle" && !heroDisc.disabled) {
      heroDisc.click();
    }
  } catch (e) {
    console.warn("autostart-connect failed", e);
  }
})();

// Синхронизация флага autostart с реальным registry-state Windows.
// Если юзер выключил автозапуск через Диспетчер задач / Параметры —
// тут подтянем актуальное состояние в options.
(async () => {
  try {
    const enabled = await invoke("plugin:autostart|is_enabled");
    const opts = loadOptions();
    if (typeof enabled === "boolean" && opts.general?.autostart !== enabled) {
      // updateOption ленивый импорт — путь из options.js
      const { updateOption } = await import("/lib/options.js");
      updateOption("general.autostart", enabled);
    }
  } catch {}
})();

// Синхронизация списка зарегистрированных URL-схем с реальным HKCU.
// Юзер мог удалить ключи руками / переинсталлировать Ninety в другую папку,
// тогда наш path в реестре устарел — is_url_handler_registered вернёт false,
// и мы синхронизируем options.general.urlSchemes под реальное состояние.
(async () => {
  try {
    const { URL_HANDLER_SCHEMES, updateOption } = await import("/lib/options.js");
    const actual = [];
    for (const scheme of URL_HANDLER_SCHEMES) {
      try {
        const ok = await invoke("is_url_handler_registered", { scheme });
        if (ok) actual.push(scheme);
      } catch {}
    }
    const opts = loadOptions();
    const current = opts.general?.urlSchemes || [];
    const sameLen = current.length === actual.length;
    const sameSet = sameLen && current.every(s => actual.includes(s));
    if (!sameSet) updateOption("general.urlSchemes", actual);
  } catch {}
})();

// ── Auto-update ────────────────────────────────────────────
async function runUpdateCheck({ silent = true } = {}) {
  if (!updaterAvailable()) {
    if (!silent) toast("Updater недоступен", "error", 2500);
    return;
  }
  const update = await checkForUpdate();
  if (!update) {
    if (!silent) toast("Обновлений нет — у вас актуальная версия", "info", 2400);
    return;
  }
  // silent=true (автопроверка на старте) — уважаем "Позже" по этой версии;
  // silent=false (юзер сам нажал) — игнорируем skip, показываем всё равно.
  await openUpdateModal(update, { respectSkip: silent });
}

// Проверка при старте — через 3 сек после bootstrap
setTimeout(() => runUpdateCheck({ silent: true }), 3000);

// Глобальная функция для кнопки «Проверить обновления» в settings
window.__ninetyUpdateCheck = () => runUpdateCheck({ silent: false });

// ── Subscriptions auto-refresh ─────────────────────────────
// Стартовый рефреш через 60 сек после bootstrap (чтобы не тормозить старт),
// дальше каждые 30 минут. Ошибки не показываем — это фоновая задача.
async function silentRefreshSubs() {
  const list = loadSubscriptions();
  if (!list.length) return;
  try {
    await refreshAllSubscriptions();
    refreshSubCardFromActive();
    refreshProfilesSummary();
  } catch (e) {
    console.warn("subs auto-refresh failed", e);
  }
}
setTimeout(silentRefreshSubs, 60_000);
setInterval(silentRefreshSubs, 30 * 60_000);

// «Только что» / «N мин назад» обновляем каждые 30 сек
setInterval(refreshSubCardFromActive, 30_000);

// ── Deep links ──────────────────────────────────────────────
// Поддерживаемые форматы:
//   ninety://import/<encoded-url>             — подписка (legacy, оставлено)
//   ninety://import?url=...&name=...          — подписка (query-style)
//   ninety://config/<encoded-link>            — одиночный конфиг (vless/vmess/...)
//   ninety://add/<base64-url>                 — подписка (Happ-style, base64 URL)
//   <proto>://...                             — top-level link (vless/vmess/ss/
//                                               trojan/hysteria2/tuic/sub), если юзер
//                                               включил opt-in регистрацию схем в
//                                               Settings → Общие
// Windows запускает Ninety с argv, single-instance plugin перехватывает и
// emit'ит onOpenUrl в первый процесс. Авто-импорта нет — юзер видит prefilled
// URL в add-modal и подтверждает (защита от malicious links).
const NINETY_RE = /^ninety:\/\/([a-z]+)(?:\/(.*))?$/i;
const TOP_LEVEL_PROTOS = ["vless", "vmess", "ss", "trojan", "hysteria2", "hy2", "tuic", "sub"];

function safeAtobUrl(s) {
  try {
    const cleaned = String(s).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = cleaned + "=".repeat((4 - cleaned.length % 4) % 4);
    return atob(padded);
  } catch { return ""; }
}

function handleDeepLinkUrl(rawUrl) {
  try {
    const raw = String(rawUrl || "").trim();
    if (!raw) return;

    // top-level proto:// (vless/vmess/...) — opt-in
    const protoIdx = raw.indexOf("://");
    if (protoIdx > 0) {
      const proto = raw.slice(0, protoIdx).toLowerCase();
      if (TOP_LEVEL_PROTOS.includes(proto)) {
        if (proto === "sub") {
          // sub://<base64-url> → раскрываем и шлём как подписку
          const decoded = safeAtobUrl(raw.slice(protoIdx + 3));
          if (decoded) {
            openAddModal({ prefillUrl: decoded });
            return;
          }
        }
        openAddModal({ prefillUrl: raw });
        return;
      }
    }

    // ninety://<action>/<rest>
    const m = raw.match(NINETY_RE);
    if (!m) return;
    const action = m[1].toLowerCase();
    let rest = m[2] || "";

    // Хвост ?name=... — общий для import/config
    let prefillName = "";
    let queryUrl = "";
    const qIdx = rest.indexOf("?");
    if (qIdx >= 0) {
      const tail = rest.slice(qIdx + 1);
      rest = rest.slice(0, qIdx);
      try {
        const params = new URLSearchParams(tail);
        const n = params.get("name");
        if (n) prefillName = n;
        const u = params.get("url");
        if (u) queryUrl = u;
      } catch {}
    }
    // ninety://import?url=... — путь пустой, URL пришёл в query
    if (!rest && queryUrl) rest = queryUrl;

    try { rest = decodeURIComponent(rest); } catch {}

    if (!rest) return;

    if (action === "add") {
      // ninety://add/<base64-url> — раскрываем base64
      const decoded = safeAtobUrl(rest);
      if (decoded) {
        openAddModal({ prefillUrl: decoded, prefillName });
        return;
      }
    }

    // import / config / add (если base64 не распознали) — кидаем сырой URL
    openAddModal({ prefillUrl: rest, prefillName });
  } catch (e) {
    console.warn("deeplink handle failed", e);
  }
}

(async () => {
  const dl = window.__TAURI__?.deepLink;
  if (!dl?.onOpenUrl) return;
  try {
    // onOpenUrl получает URL'ы и при cold-start (если Windows запустил Ninety
    // самим ninety://...), и при warm second-instance через single-instance.
    await dl.onOpenUrl((urls) => {
      if (!Array.isArray(urls)) return;
      for (const u of urls) handleDeepLinkUrl(u);
    });
    // Также проверяем getCurrent на случай если URL был передан до того
    // как мы подписались (cold-start race).
    if (dl.getCurrent) {
      try {
        const initial = await dl.getCurrent();
        if (Array.isArray(initial)) for (const u of initial) handleDeepLinkUrl(u);
      } catch {}
    }
  } catch (e) {
    console.warn("deeplink subscribe failed", e);
  }
})();
