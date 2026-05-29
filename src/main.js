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
import { toast } from "/lib/toast.js";

// ── Tauri 2 (withGlobalTauri:true) ───────────────────────────
const tauriWin = window.__TAURI__?.window?.getCurrentWindow?.()
  ?? window.__TAURI__?.window?.getCurrent?.();
const invoke = window.__TAURI__?.core?.invoke
  ?? ((cmd, args) => {
    console.warn("Tauri invoke недоступен:", cmd, args);
    return Promise.reject(new Error("Tauri invoke недоступен (web preview)"));
  });

// ── Theme switcher (Kurogane / Synthwave / Matrix / Mono) ──
const THEME_KEY = "ninety.theme";
const THEMES = ["kurogane", "synthwave", "matrix", "mono"];
const appRoot = document.getElementById("app-root");

export function getTheme() {
  const raw = localStorage.getItem(THEME_KEY);
  return THEMES.includes(raw) ? raw : "kurogane";
}
export function setTheme(t) {
  if (!THEMES.includes(t)) return;
  localStorage.setItem(THEME_KEY, t);
  if (appRoot) appRoot.dataset.theme = t;
  window.dispatchEvent(new CustomEvent("ninety:theme-changed", { detail: { theme: t } }));
}
// Применяем сохранённую тему сразу — до первого рендера остального
if (appRoot) appRoot.dataset.theme = getTheme();
window.__ninetySetTheme = setTheme;

// ── Hero targeting ticks (60 шт, каждые 6°, 12 major) ──────
(function generateHeroTicks() {
  const svg = document.getElementById("hero-ticks");
  if (!svg) return;
  const cx = 50, cy = 50, rOuter = 50;
  const parts = [];
  for (let i = 0; i < 60; i++) {
    const angle = (i * 6 - 90) * Math.PI / 180;
    const isMajor = i % 5 === 0;
    const len = isMajor ? 4 : 2;
    const r1 = rOuter - 0.5;
    const r2 = rOuter - 0.5 - len;
    const x1 = (cx + Math.cos(angle) * r1).toFixed(2);
    const y1 = (cy + Math.sin(angle) * r1).toFixed(2);
    const x2 = (cx + Math.cos(angle) * r2).toFixed(2);
    const y2 = (cy + Math.sin(angle) * r2).toFixed(2);
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${isMajor ? "tick tick--major" : "tick"}"/>`);
  }
  svg.innerHTML = parts.join("");
})();

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

// ── Mode segmented (3 режима как у Hiddify) ─────────────────
const modeSeg = document.getElementById("mode-seg");
const modeHint = document.getElementById("mode-hint");
const warpSwitch = document.getElementById("warp-switch");

const MODE_HINTS = {
  proxy:       `<b>Прокси.</b> sing-box слушает <code>127.0.0.1:7890</code> как mixed (HTTP+SOCKS5). Прописать прокси нужно вручную в браузере или приложении — остальной трафик идёт мимо.`,
  systemProxy: `<b>Системный.</b> То же, плюс автоматически прописываем системный прокси в HKCU Internet Settings и шлём WinINET notify. Работает «из коробки» для всего, что уважает системные настройки; UWP и приложения с hardcoded-сетью — нет.`,
  tun:         `<b>VPN · TUN.</b> Перехват всего трафика через службу <code>NinetyTunnelService</code> под LocalSystem. UAC — один раз при первом включении (служба ставится постоянно). Покрывает любые приложения, включая UWP.`,
};

function applyModeToUI(m) {
  if (modeSeg) {
    modeSeg.querySelectorAll(".seg__btn").forEach((x) => {
      const active = x.dataset.mode === m;
      x.dataset.on = active ? "true" : "false";
      x.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  if (modeHint) modeHint.innerHTML = MODE_HINTS[m] || MODE_HINTS.systemProxy;
}
applyModeToUI(getMode());

// WARP switch в popover'е
(function initWarpSwitch() {
  if (!warpSwitch) return;
  const opts = loadOptions();
  warpSwitch.dataset.on = String(!!opts.warp?.enabled);
  warpSwitch.addEventListener("click", async (e) => {
    e.stopPropagation();
    const newVal = warpSwitch.dataset.on !== "true";
    warpSwitch.dataset.on = String(newVal);
    updateOption("warp.enabled", newVal);
    if (state === "connected" || state === "connecting") scheduleAutoReconnect();
    updateWarpBadge();
  });
})();

modeSeg?.addEventListener("click", async (e) => {
  const b = e.target.closest(".seg__btn");
  if (!b) return;
  const requested = b.dataset.mode;
  if (!["proxy", "systemProxy", "tun"].includes(requested)) return;
  // При выборе TUN — гарантируем что NinetyTunnelService установлен.
  // Иначе start_singbox упадёт при первой попытке connect.
  if (requested === "tun") {
    const ok = await ensureTunnelServiceInstalled();
    if (!ok) return; // юзер отказался ставить или установка не удалась
  }
  const prevMode = getMode();
  setMode(requested);
  applyModeToUI(requested);
  updateHeroHint();
  // Режим меняет inbound (TUN vs mixed) и системный прокси — при поднятом VPN
  // надо пересобрать конфиг. reconnectForSourceChange сам уходит в idle (сбросит
  // системный прокси старого режима) и поднимается заново. Если не connected —
  // no-op, режим применится при следующем connect.
  if (requested !== prevMode) reconnectForSourceChange("Переключаю режим…");
});

// Проверяет статус NinetyTunnelService. Если не_installed — предлагает
// установить (с UAC). Возвращает true если сервис в Stopped/Running на выходе.
async function ensureTunnelServiceInstalled() {
  try {
    const full = await invoke("tunnel_full_status");
    const svc = full?.service || "other";
    if (svc !== "not_installed") return true;
    const yes = confirm(
      "Для VPN · TUN нужна служба NinetyTunnelService.\n\n" +
      "Установить сейчас? Windows запросит UAC ОДИН раз — дальше connect/disconnect без подтверждений."
    );
    if (!yes) return false;
    await invoke("tunnel_service_install");
    toast("Служба NinetyTunnelService установлена", "success", 1800);
    return true;
  } catch (e) {
    toast(`Установка службы не удалась: ${e?.message || e}`, "error", 3500);
    return false;
  }
}

// ── Add Profile Modal — Hiddify-style ──────────────────────
const profilesSummary = document.getElementById("profiles-summary");

mountAddModal({
  onCommit: (res) => {
    toast(res.message, "success", 2000);
    refreshProfilesSummary();
    // Wizard: после step 2 — переходим на «подключение»
    if (wizardActive && wizardStepNum <= 2) {
      showOnbStep(3);
      setTimeout(() => {
        try { heroDisc?.click(); } catch {}
      }, 450);
    }
  },
});

document.getElementById("add-sub")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAllPopovers();
  openAddModal();
});

function refreshProfilesSummary() {
  const profilesListLocal = loadProfiles();
  const subsList = loadSubscriptions();
  const src = getActiveSource();
  if (profilesSummary) {
    if (subsList.length) profilesSummary.textContent = String(subsList.length);
    else profilesSummary.textContent = "";
  }
  renderProfilesView();
  updateHeroForActive();
  refreshSubCardFromActive();
  syncEmptyState();
}

// Empty-state: нет ни подписки ни конфига → показываем onboarding wizard
// (если он ещё не пройден). Wizard также удерживает onboarding visible пока
// юзер не дошёл до step 4 — даже если empty уже false (подписка добавлена).
function syncEmptyState() {
  if (!appRoot) return;
  const empty = loadProfiles().length === 0 && loadSubscriptions().length === 0;
  appRoot.dataset.empty = String(empty);
  const onb = document.getElementById("onboarding-screen");
  if (empty && !isOnboardingDone() && !wizardActive) {
    openWizardAt(wizardStepNum || 1);
    return;
  }
  appRoot.dataset.wizard = String(wizardActive);
  if (onb) onb.hidden = !(wizardActive || empty);
  // empty + done — показываем шаг 1 (welcome) для повторного re-add, без wizardActive
  if (empty && !wizardActive && onb) showOnbStep(1);
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
const navItems = document.querySelectorAll(".nav__item[data-view]");
const views = document.querySelectorAll("section.screen[data-view]");

function switchView(target) {
  navItems.forEach((n) => n.classList.toggle("nav__item--active", n.dataset.view === target));
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
      // Badge с активным endpoint должен реагировать на любое изменение warp.*
      if (path === "warp.enabled" || path === "warp.endpoint") updateWarpBadge();
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

async function performAutoReconnect(reason = "Применяю новые настройки…") {
  pendingReconnectTimer = null;
  if (!needsReconnect) return;
  if (state !== "connected" && state !== "connecting") return;
  toast(reason, "info", 0, { group: "conn", connecting: true });
  try { await invoke("set_system_proxy", { enable: false }); } catch {}
  try { await invoke("stop_singbox"); } catch {}
  setState("idle");
  needsReconnect = false;
  applyReconnectUI();
  setTimeout(() => heroDisc?.click(), 60);
}

// ── health-watchdog ────────────────────────────────────────
// Пока connected — раз в 5с проверяем что ядра живы. Без этого краш sing-box/xray
// в середине сессии оставался невидимым: UI держал «Защищено», системный прокси
// указывал на мёртвый порт, трафик уходил в чёрную дыру. Логика:
//   sing-box упал  → туннель закрыт: снять прокси, idle, нотифай с причиной, логи.
//   xray упал      → жив sing-box, но xhttp-мост мёртв → авто-реконнект (пересоберёт
//                    конфиг и поднимет оба ядра заново).
const HEALTH_TICK_MS = 5000;
let healthTimer = null;
let healthBusy = false;

function startHealthWatchdog() {
  if (healthTimer) return;
  healthTimer = setInterval(healthTick, HEALTH_TICK_MS);
}
function stopHealthWatchdog() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

async function healthTick() {
  if (state !== "connected" || healthBusy) return;
  healthBusy = true;
  try {
    const ok = await invoke("singbox_running");
    if (!ok) {
      const why = await invoke("vpn_last_error").catch(() => null);
      try { await invoke("set_system_proxy", { enable: false }); } catch {}
      try { await invoke("stop_singbox"); } catch {}
      setState("idle");
      toast("Ядро остановилось", "error", 7000, {
        group: "conn",
        desc: "Туннель закрыт · sing-box завершился неожиданно",
      });
      notify("Ninety · туннель закрыт", "Ядро sing-box остановилось");
      if (why) console.warn("sing-box died:", why);
      switchView("logs");
      return;
    }
    // sing-box жив — проверяем xray-мост (xhttp).
    const xr = await invoke("xray_status").catch(() => "none");
    if (xr === "died") {
      toast("xhttp-ядро упало — переподключаюсь", "warn", 4000, { group: "conn", connecting: true });
      notify("Ninety", "xhttp-ядро перезапускается");
      // reconnectForSourceChange сам ставит needsReconnect и зовёт реконнект,
      // который поднимет sing-box И xray заново из свежего конфига.
      reconnectForSourceChange("Перезапуск xhttp-ядра…");
    }
  } catch (e) {
    console.warn("healthTick failed", e);
  } finally {
    healthBusy = false;
  }
}

function applyReconnectUI() {
  if (!hero) return;
  if (needsReconnect && (state === "connected" || state === "connecting")) {
    hero.classList.add("hero--reconnect");
    if (heroLabel) heroLabel.textContent = "Применить настройки";
    setHeroHintText("RECONNECT · APPLY NEW SETTINGS");
  } else {
    hero.classList.remove("hero--reconnect");
  }
}

// Сменился активный источник (подписка/профиль) при поднятом VPN — немедленно
// пересобираем конфиг с новыми нодами. Без дебаунса (явное действие юзера),
// в отличие от scheduleAutoReconnect для правок настроек. Реконнект уходит в
// idle (сбросит currentEffectiveNode) → buildConfig читает свежий getActiveSource()
// → AUTO-селектор по новым нодам, они пингуются URLTest'ом.
function reconnectForSourceChange(reason) {
  if (state !== "connected" && state !== "connecting") return false;
  needsReconnect = true;
  if (pendingReconnectTimer) { clearTimeout(pendingReconnectTimer); pendingReconnectTimer = null; }
  performAutoReconnect(reason);
  return true;
}

// Единая активация источника (подписка/профиль). Зовётся И из pmenu «Сделать
// активным», И из клика по телу карточки — раньше реконнект был только в pmenu,
// поэтому клик по карточке менял активный источник, а VPN оставался на старом
// конфиге. При поднятом VPN и реальной смене источника — немедленный реконнект.
function activateSource(kind, id) {
  const isSub = kind === "sub";
  const wasActive = isSub
    ? (getActiveKind() === "sub" && getActiveSubscriptionId() === id)
    : (getActiveKind() === "single" && getActiveProfileId() === id);
  if (isSub) {
    setActiveKind("sub");
    setActiveSubscriptionId(id);
  } else {
    setActiveProfileId(id);
    setActiveKind("single");
  }
  currentEffectiveNode = null;
  refreshProfilesSummary();
  const reason = isSub ? "Переключаюсь на новую подписку…" : "Переключаюсь на новый профиль…";
  if (wasActive || !reconnectForSourceChange(reason)) {
    toast(isSub ? "Подписка активирована" : "Профиль активирован", "success", 1800);
  }
}

// ── WARP UX (hero badge + история ротаций) ──────────────────
const WARP_HISTORY_KEY = "ninety.warp.history";
const WARP_HISTORY_LIMIT = 20;
const locWarpRow = document.getElementById("loc-warp-row");
const locWarpEndpoint = document.getElementById("loc-warp-endpoint");

function updateWarpBadge() {
  if (!locWarpRow || !locWarpEndpoint) return;
  const o = loadOptions();
  const enabled = !!o.warp?.enabled;
  const connected = state === "connected";
  if (!enabled || !connected) { locWarpRow.hidden = true; return; }
  locWarpEndpoint.textContent = o.warp?.endpoint || "—";
  locWarpRow.hidden = false;
}

function recordWarpRotation(from, to, oldDelay, newDelay) {
  try {
    const raw = localStorage.getItem(WARP_HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift({ ts: Date.now(), from, to, oldDelay, newDelay });
    if (list.length > WARP_HISTORY_LIMIT) list.length = WARP_HISTORY_LIMIT;
    localStorage.setItem(WARP_HISTORY_KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent("ninety:warp-rotation"));
  } catch (e) { console.warn("warp history save failed", e); }
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
    const fromEndpoint = loadOptions().warp?.endpoint || "—";
    updateOption("warp.endpoint", newEndpoint);
    recordWarpRotation(fromEndpoint, newEndpoint, curDelay, best.latency_ms);
    console.info("[WARP rescan]", { from: fromEndpoint, to: newEndpoint, oldDelay: curDelay, newDelay: best.latency_ms });
    toast(`WARP → ${newEndpoint} (${best.latency_ms}мс, было ${curDelay || "—"})`, "success", 2400);
    updateWarpBadge();
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

// sing-box stdout: `+0300 2025-01-01 12:34:56 INFO [tag] message`
//                  `12:34:56.123 INFO message`           (timestamp без даты)
//                  `INFO message`                        (timestamp выключен)
//                  `+0300 INFO message`                  (offset без timestamp)
// Группы: 1=offset, 2=date, 3=time, 4=level, 5=rest
const LOG_LINE_RE = /^(?:([+-]\d{4})\s+)?(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)?\s*(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\s+(.*)$/i;

function levelGrade(lvl) {
  const l = lvl.toUpperCase();
  if (l === "ERROR" || l === "FATAL" || l === "PANIC") return "err";
  if (l === "WARN" || l === "WARNING") return "warn";
  if (l === "TRACE" || l === "DEBUG") return "ok";
  return "info";
}

function escapeLog(s) {
  return s.replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

function highlightMessage(msg) {
  const safe = escapeLog(msg);
  // tag в [скобках] подсветить
  return safe
    .replace(/\[([^\]]+)\]/g, '<b>[$1]</b>')
    .replace(/\b(\d+\.\d+\.\d+\.\d+)(?::\d+)?\b/g, '<span class="acc">$&</span>')
    .replace(/\b(?:wss?|https?):\/\/[^\s]+/gi, '<span class="acc">$&</span>');
}

const LOG_RENDER_MAX_LINES = 800;
function renderLogsHtml(text) {
  if (!text) return '';
  // Ограничиваем DOM последними N строками — 256КБ хвоста дают тысячи строк
  // (простыня + тормоза рендера). Свежие строки внизу, как в консоли.
  const lines = text.split(/\r?\n/).slice(-LOG_RENDER_MAX_LINES);
  const out = [];
  let buffer = []; // продолжения многострочного сообщения
  let lastIdx = -1;
  for (const raw of lines) {
    if (!raw) {
      if (lastIdx >= 0) buffer.push(''); // пустые строки прилеплены к предыдущей
      continue;
    }
    const m = LOG_LINE_RE.exec(raw);
    if (m) {
      // финализировать предыдущую если был мульти-line
      if (lastIdx >= 0 && buffer.length) {
        out[lastIdx] = out[lastIdx].replace('</span></div>', escapeLog('\n' + buffer.join('\n')) + '</span></div>');
        buffer = [];
      }
      const [, , date, time, level, rest] = m;
      const t = time || (date ? date.slice(5) : '—');
      const lvl = level.toUpperCase();
      const grade = levelGrade(lvl);
      out.push(`<div class="log-line"><span class="log-line__t">${escapeLog(t)}</span><span class="log-line__l log-line__l--${grade}">${lvl}</span><span class="log-line__m">${highlightMessage(rest)}</span></div>`);
      lastIdx = out.length - 1;
    } else {
      // без timestamp и без уровня → продолжение или plain
      if (lastIdx >= 0) {
        buffer.push(raw);
      } else {
        out.push(`<div class="log-line"><span class="log-line__t">—</span><span class="log-line__l log-line__l--info">···</span><span class="log-line__m">${escapeLog(raw)}</span></div>`);
        lastIdx = out.length - 1;
      }
    }
  }
  if (lastIdx >= 0 && buffer.length) {
    out[lastIdx] = out[lastIdx].replace('</span></div>', escapeLog('\n' + buffer.join('\n')) + '</span></div>');
  }
  return out.join('');
}

async function refreshLogs({ keepScroll = false } = {}) {
  if (!logsView) return;
  try {
    const text = await invoke("read_singbox_log", { tailBytes: 256 * 1024 });
    if (text === logsLastValue) return;
    logsLastValue = text;
    const atBottom = !keepScroll || (logsView.scrollTop + logsView.clientHeight >= logsView.scrollHeight - 24);
    if (!text) {
      logsView.innerHTML = '<div class="log-line"><span class="log-line__t">—</span><span class="log-line__l log-line__l--info">···</span><span class="log-line__m" style="font-style:italic;color:var(--text-faint)">Лог пуст. Запустите подключение — sing-box stdout/stderr будут писаться сюда.</span></div>';
    } else {
      logsView.innerHTML = renderLogsHtml(text);
    }
    if (atBottom) logsView.scrollTop = logsView.scrollHeight;
    if (logsSize) {
      const bytes = new TextEncoder().encode(text || "").length;
      logsSize.textContent = text ? formatBytes(bytes) : "пусто";
    }
  } catch (e) {
    if (logsView) {
      logsView.innerHTML = `<div class="log-line"><span class="log-line__t">—</span><span class="log-line__l log-line__l--err">ERR</span><span class="log-line__m">${escapeLog(`Ошибка чтения лога: ${e?.message || e}`)}</span></div>`;
    }
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
  const text = logsLastValue || "";
  if (!text) { toast("Лог пуст", "info", 1400); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast("Лог скопирован в буфер", "success", 1600);
  } catch {
    toast("Не удалось скопировать — попробуйте выделить мышью и Ctrl+C", "error", 3000);
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
const profilesView = document.querySelector('section.screen[data-view="profiles"]');
const profilesList = document.getElementById("profiles-list");

const ICON_DOTS    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>`;
const ICON_PLUS    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;
const ICON_REFRESH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/></svg>`;
const ICON_EDIT    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
const ICON_TRASH   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 6h18"/><path d="m19 6-1.5 14a2 2 0 0 1-2 1.8h-7a2 2 0 0 1-2-1.8L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const ICON_CHECK   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="m5 12 5 5L20 7"/></svg>`;
const ICON_COPY    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_QR      = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14v3"/><path d="M14 20h3"/><path d="M17 17v4"/><path d="M21 21h-1"/></svg>`;
const ICON_GLOBE   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>`;
const ICON_FILE    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></svg>`;

function renderProfilesView() {
  if (!profilesList) return;
  const profsList = loadProfiles();
  const subsList = loadSubscriptions();
  const activeProfileId = getActiveProfileId();
  const activeKind = getActiveKind();
  const activeSubId = getActiveSubscriptionId();

  if (profsList.length === 0 && subsList.length === 0) {
    profilesList.innerHTML = `
      <div class="onb" style="margin: 32px auto 0; text-align: center;">
        <div class="onb__kicker">SUBSCRIPTIONS · EMPTY</div>
        <h2 class="onb__title" style="font-size:20px">Нет профилей</h2>
        <p class="onb__sub">Добавьте подписку по URL или одиночный vless:// — кнопкой «+» сверху, плюс-кнопкой на главном или в меню.</p>
      </div>
    `;
    return;
  }

  const subItems = subsList.map(s => {
    const isActive = activeKind === "sub" && s.id === activeSubId;
    const days = subscriptionDaysLeft(s);
    const used = subscriptionUsedBytes(s);
    const total = s.total ?? null;
    const updated = relativeTime(s.lastUpdate) || "—";
    const nodesCount = s.profiles?.length || 0;
    const trafficUsed = used != null ? formatGiB(used) : "—";
    const trafficTotal = total != null ? `/${formatGiB(total)}` : "";
    return `
      <article class="prof-card" data-active="${isActive}" data-sub-id="${s.id}">
        <div class="prof-card__icon">${ICON_GLOBE}</div>
        <div class="prof-card__main" data-sub-activate="${s.id}">
          <div class="prof-card__head">
            <span class="prof-card__name">${escapeHtml(s.name)}</span>
            ${isActive ? `<span class="prof-card__badge">АКТИВНЫЙ</span>` : ""}
          </div>
          <div class="prof-card__url">${escapeHtml(s.url || "")}</div>
        </div>
        <div class="prof-card__stats">
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${nodesCount}</span>
            <span class="prof-card__stat-lbl">УЗЛОВ</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${trafficUsed}${trafficTotal}<span style="color:var(--text-faint);font-size:9px;margin-left:3px;">ГиБ</span></span>
            <span class="prof-card__stat-lbl">ТРАФИК</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${days == null ? "—" : days}${days != null ? `<span style="color:var(--text-faint);font-size:9px;margin-left:3px;">дн</span>` : ""}</span>
            <span class="prof-card__stat-lbl">ИСТЕКАЕТ</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val" style="font-size:11px;color:var(--text-mid);">${escapeHtml(updated)}</span>
            <span class="prof-card__stat-lbl">ОБНОВЛЕНО</span>
          </div>
        </div>
        <button class="prof-card__menu" data-menu-sub="${s.id}" type="button" aria-label="Меню">${ICON_DOTS}</button>
      </article>
    `;
  }).join("");

  const profileItems = profsList.map(p => {
    const isActive = activeKind === "single" && p.id === activeProfileId;
    const proto = (p.proto || "vless").toUpperCase();
    const security = (p.security || "tcp").toUpperCase();
    return `
      <article class="prof-card" data-active="${isActive}" data-id="${p.id}">
        <div class="prof-card__icon">${ICON_FILE}</div>
        <div class="prof-card__main" data-profile-activate="${p.id}">
          <div class="prof-card__head">
            <span class="prof-card__name">${escapeHtml(p.name)}</span>
            ${isActive ? `<span class="prof-card__badge">АКТИВНЫЙ</span>` : ""}
          </div>
          <div class="prof-card__url">${escapeHtml(`${p.host}:${p.port}`)}</div>
        </div>
        <div class="prof-card__stats">
          <div class="prof-card__stat">
            <span class="prof-card__stat-val" style="font-size:11px;">${escapeHtml(proto)}</span>
            <span class="prof-card__stat-lbl">ПРОТОКОЛ</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val" style="font-size:11px;">${escapeHtml(security)}</span>
            <span class="prof-card__stat-lbl">TLS</span>
          </div>
        </div>
        <button class="prof-card__menu" data-menu-profile="${p.id}" type="button" aria-label="Меню">${ICON_DOTS}</button>
      </article>
    `;
  }).join("");

  profilesList.innerHTML = `${subItems}${profileItems}`;
}

// Кнопки header'а profiles экрана
document.getElementById("profiles-add")?.addEventListener("click", () => openAddModal());

// ── Onboarding wizard (4 шага) ─────────────────────────────
const ONB_STEP_KEY = "ninety.onboarding.step";
const ONB_DONE_KEY = "ninety.onboarding.done";
let wizardActive = false;
let wizardStepNum = parseInt(localStorage.getItem(ONB_STEP_KEY) || "1", 10) || 1;

function isOnboardingDone() {
  return localStorage.getItem(ONB_DONE_KEY) === "1";
}
function markOnboardingDone() {
  localStorage.setItem(ONB_DONE_KEY, "1");
  localStorage.removeItem(ONB_STEP_KEY);
}
function showOnbStep(n) {
  wizardStepNum = Math.max(1, Math.min(4, n));
  localStorage.setItem(ONB_STEP_KEY, String(wizardStepNum));
  const onb = document.getElementById("onboarding-screen");
  if (!onb) return;
  onb.dataset.step = String(wizardStepNum);
  onb.querySelectorAll(".onb-step").forEach(s => {
    s.hidden = s.dataset.step !== String(wizardStepNum);
  });
}
function openWizardAt(step = 1) {
  wizardActive = true;
  if (appRoot) appRoot.dataset.wizard = "true";
  const onb = document.getElementById("onboarding-screen");
  if (onb) onb.hidden = false;
  showOnbStep(step);
}
function closeWizard() {
  markOnboardingDone();
  wizardActive = false;
  if (appRoot) appRoot.dataset.wizard = "false";
  syncEmptyState();
}

// Делегированные обработчики кнопок wizard
document.getElementById("onboarding-screen")?.addEventListener("click", async (e) => {
  const next = e.target.closest("[data-onb-next]");
  if (next) {
    const n = parseInt(next.dataset.onbNext, 10);
    if (!wizardActive) openWizardAt(n);
    else showOnbStep(n);
    return;
  }
  const back = e.target.closest("[data-onb-back]");
  if (back) { showOnbStep(parseInt(back.dataset.onbBack, 10)); return; }
  if (e.target.closest("[data-onb-skip]")) { closeWizard(); return; }
  if (e.target.closest("[data-onb-finish]")) { closeWizard(); return; }
  const action = e.target.closest("[data-onb-action]")?.dataset.onbAction;
  if (action === "clipboard") {
    if (!wizardActive) openWizardAt(2); // на всякий случай — фиксируем wizard-state
    try {
      const text = await navigator.clipboard.readText();
      openAddModal({ prefillUrl: (text || "").trim() });
    } catch { openAddModal(); }
  } else if (action === "manual") {
    if (!wizardActive) openWizardAt(2);
    openAddModal();
  }
});
document.getElementById("profiles-refresh-all")?.addEventListener("click", async () => {
  try {
    await refreshAllSubscriptions();
    refreshSubCardFromActive();
    refreshProfilesSummary();
    toast("Подписки обновлены", "success", 1800);
  } catch (e) {
    toast(`Ошибка: ${e?.message || e}`, "error", 2800);
  }
});

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
        activateSource("sub", id);
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
        activateSource("single", id);
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
    activateSource("sub", subActivate.dataset.subActivate);
    return;
  }
  const profileActivate = e.target.closest("[data-profile-activate]");
  if (profileActivate) {
    activateSource("single", profileActivate.dataset.profileActivate);
    return;
  }
});

// ── HERO ───────────────────────────────────────────────────
const hero = document.getElementById("hero");
const heroBurst = document.getElementById("hero-burst");
const heroLock = document.getElementById("hero-lock");
const heroDisc = document.getElementById("hero-disc");
const heroMask = document.getElementById("hero-mask");
const heroLabel = document.getElementById("hero-label");
const heroHint = document.getElementById("hero-hint");
const heroHintText = document.getElementById("hero-hint-text");
const heroPing = document.getElementById("hero-ping");
const heroPingValue = document.getElementById("hero-ping-value");
const tfDown = document.getElementById("tf-down");
const tfUp = document.getElementById("tf-up");
const tfDownUnit = document.getElementById("tf-down-unit");
const tfUpUnit = document.getElementById("tf-up-unit");
const locCard = document.getElementById("location-card");
const statsStrip = document.getElementById("stats-strip");
const statsServer = document.getElementById("stats-server");
const statsFlag = document.getElementById("stats-flag");
const statsDown = document.getElementById("stats-down");
const statsUp = document.getElementById("stats-up");
const statsDownUnit = document.getElementById("stats-down-unit");
const statsUpUnit = document.getElementById("stats-up-unit");
const statsMode = document.getElementById("stats-mode");
const locPing = document.getElementById("loc-ping");
const locIpRow = document.getElementById("loc-ip-row");
const locIp = document.getElementById("loc-ip");

// Мап-имена для CSS data-state (handoff terminology)
const STATE_HERO = { idle: "standby", connecting: "linking", connected: "secured" };
const STATE_KICKER = {
  idle:       "STAND-BY · DISCONNECTED",
  connecting: "LINKING · NEGOTIATING",
  connected:  "SECURED · TUNNEL ACTIVE",
};
const MODE_LABEL = { proxy: "ПРОКСИ", systemProxy: "СИСТЕМНЫЙ ПРОКСИ", tun: "VPN · TUN" };

// Remount-приём: заменить элемент копией → CSS-анимация перезапускается с нуля.
// Используется для .hero__burst, .hero__lock (они анимируются один раз на смену).
function remountByClone(el) {
  if (!el) return null;
  const clone = el.cloneNode(false);
  el.replaceWith(clone);
  return clone;
}

let heroBurstEl = heroBurst;
let heroLockEl = heroLock;

function applyHeroState(internalState) {
  if (!hero) return;
  const ds = STATE_HERO[internalState] || "standby";
  hero.dataset.state = ds;
  // Remount transition layers — CSS @keyframes на data-state перезапускается с нуля
  heroBurstEl = remountByClone(heroBurstEl);
  if (heroBurstEl) heroBurstEl.dataset.state = ds;
  heroLockEl = remountByClone(heroLockEl);
  if (heroLockEl) heroLockEl.dataset.state = ds;
}

// Stats-strip vs Location-card: connected → stats, иначе → loc
function applyHomeBottom(internalState) {
  if (!locCard || !statsStrip) return;
  if (internalState === "connected") {
    locCard.hidden = true;
    statsStrip.hidden = false;
  } else {
    locCard.hidden = false;
    statsStrip.hidden = true;
  }
}

// Активный сервер в stats-strip — обновляется при connect и смене effective-ноды.
function updateStatsServer() {
  if (!statsServer) return;
  const p = activeNodeForDisplay();
  const label = p?.name || p?.host || "—";
  statsServer.textContent = label;
  statsServer.title = label;
  if (statsFlag) {
    const iso = p ? (isoFromNodeName(p.name) || isoFromNodeName(p.host)) : null;
    statsFlag.innerHTML = iso ? `<img src="${FLAGS_BASE}/${iso}.svg" alt="">` : "";
    statsFlag.hidden = !iso;
  }
}

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
const locName = document.querySelector(".loc-card__name");
const locProto = document.querySelector(".loc-card__sub b");
const locFlag = document.querySelector(".loc-card__flag");

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

if (heroMask) heroMask.playbackRate = 0.7;

// Initial home-bottom + hero-state (standby)
applyHomeBottom("idle");
applyHeroState("idle");

let state = "idle";
let needsReconnect = false;
let publicIpTimer = null;

function setHeroHintText(text) {
  if (heroHintText) heroHintText.textContent = text;
  else if (heroHint) heroHint.textContent = text;
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
    setHeroHintText("ИМПОРТИРУЙТЕ КОНФИГ ИЛИ ПОДПИСКУ");
    if (heroDisc) {
      heroDisc.disabled = true;
      heroDisc.setAttribute("aria-disabled", "true");
    }
  } else {
    setHeroHintText(STATE_KICKER.idle);
    if (heroDisc) {
      heroDisc.disabled = false;
      heroDisc.removeAttribute("aria-disabled");
    }
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
  updateStatsServer();
  if (state === "idle") updateHeroHint();
}

function setState(next, opts = {}) {
  state = next;
  applyHeroState(next);
  applyHomeBottom(next);

  if (next === "idle") {
    needsReconnect = false;
    if (pendingReconnectTimer) { clearTimeout(pendingReconnectTimer); pendingReconnectTimer = null; }
    stopHealthWatchdog();
    stopWarpRescanLoop();
    applyReconnectUI();
    if (heroLabel) heroLabel.textContent = "Не подключено";
    showPing(false);
    if (heroDisc) heroDisc.setAttribute("aria-label", "Подключиться");
    if (tfDown) tfDown.textContent = "0";
    if (tfUp) tfUp.textContent = "0";
    if (tfDownUnit) tfDownUnit.textContent = "КБ/с";
    if (tfUpUnit) tfUpUnit.textContent = "КБ/с";
    if (heroMask) heroMask.playbackRate = 0.7;
    stopClashStream();
    if (publicIpTimer) { clearInterval(publicIpTimer); publicIpTimer = null; }
    lastPublicIp = null;
    if (locIpRow) locIpRow.hidden = true;
    currentEffectiveNode = null;
    if (heroHint) heroHint.hidden = false;
    updateHeroHint();
  } else if (next === "connecting") {
    if (heroLabel) heroLabel.textContent = "Подключение…";
    if (heroHint) heroHint.hidden = false;
    setHeroHintText(STATE_KICKER.connecting);
    showPing(false);
    if (heroDisc) heroDisc.setAttribute("aria-label", "Отменить подключение");
    if (heroMask) heroMask.playbackRate = 1.4;
  } else if (next === "connected") {
    if (heroLabel) heroLabel.textContent = "Защищено";
    if (heroHint) heroHint.hidden = false;
    setHeroHintText(STATE_KICKER.connected);
    applyPingDisplay(opts.ping ?? null);
    showPing(true);
    if (heroDisc) heroDisc.setAttribute("aria-label", "Отключиться");
    if (heroMask) heroMask.playbackRate = 1.0;
    if (statsMode) statsMode.textContent = MODE_LABEL[getMode()] || "—";
    updateStatsServer();
    startTrafficStream();
    startWarpRescanLoop();
    startHealthWatchdog();
    updateWarpBadge();
    // Wizard: подключились — переходим на финальный шаг
    if (wizardActive && wizardStepNum === 3) showOnbStep(4);
  }
}

// Единый рендерер пинга в hero и location-card.
// delay > 0 && < 65000 → число + grade; 0/null → "— мс"; >= 65000 → "Тайм-аут"
function applyPingDisplay(delay) {
  const num = Number(delay);
  let text, grade, valOnly;
  if (!num || num <= 0) { text = "— мс"; grade = "dead"; valOnly = "—"; }
  else if (num >= 65000) { text = "Тайм-аут"; grade = "dead"; valOnly = "—"; }
  else { text = `${num} мс`; grade = gradeDelay(num); valOnly = String(num); }

  if (heroPingValue) heroPingValue.textContent = valOnly;
  if (heroPing) heroPing.dataset.grade = grade;
  if (locPing) locPing.textContent = text;
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
  // Дублируем в stats-strip на главной (когда secured)
  if (statsDown) statsDown.textContent = d.value;
  if (statsUp) statsUp.textContent = u.value;
  if (statsDownUnit) statsDownUnit.textContent = d.unit;
  if (statsUpUnit) statsUpUnit.textContent = u.unit;
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
  // Click ripple — расходится от центра диска (handoff anim 520ms)
  const stage = heroDisc.closest(".hero__stage");
  if (stage) {
    const ripple = document.createElement("div");
    ripple.className = "hero__ripple";
    stage.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }
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
    // Two-core: xhttp-ноды уходят в xray-мост (config.xray), в sing-box —
    // socks-перенаправление. xray=null когда xhttp в источнике нет.
    const { config, xray } = buildConfig({ source: src, mode, options, warpInfo, xray: true });
    setState("connecting");
    try {
      await invoke("start_singbox", {
        configJson: JSON.stringify(config),
        mode,
        xrayJson: xray ? JSON.stringify(xray) : null,
      });
      // Системный прокси выставляем ТОЛЬКО для mode=systemProxy. Для голого
      // "proxy" юзер настраивает HTTP/SOCKS клиента сам, для "tun" уже идёт
      // полный intercept через TUN-интерфейс.
      if (mode === "systemProxy") {
        await invoke("set_system_proxy", { enable: true, hostPort: `127.0.0.1:${options.inbound.mixedPort || 7890}` });
      }
      setState("connected", { ping: "— мс" });
      toast("Защищено", "connected", 2200, {
        group: "conn",
        desc: (activeNodeForDisplay()?.host) ? `Через ${activeNodeForDisplay().host}` : "Туннель поднят",
      });
      // Через 800мс синхронизируем effective node через clash — URLTest уже выбрал ноду
      setTimeout(syncEffectiveFromClash, 800);
      const p2 = activeNodeForDisplay();
      notify("Ninety · подключено", p2 ? `Через ${p2.host}` : "Туннель поднят");
    } catch (e) {
      console.error("start failed", e);
      setState("idle");
      toast("Не удалось запустить", "error", 4500, { desc: "Открываю логи — sing-box не стартовал" });
      try { await invoke("stop_singbox"); } catch {}
      try { await invoke("set_system_proxy", { enable: false }); } catch {}
      switchView("logs");
    }
  } else if (state === "connecting" || state === "connected") {
    try { await invoke("set_system_proxy", { enable: false }); } catch {}
    try { await invoke("stop_singbox"); } catch (e) { console.warn("stop failed", e); }
    setState("idle");
    toast("Отключено", "info", 2000, { group: "conn", desc: "Туннель закрыт · системный прокси снят" });
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
