import {
  buildConfig,
  bridgeNeeds,
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
  subscriptionLimitBytes,
  formatBytes as fmtTraffic,
  relativeTime,
  setSubscriptionProxy,
} from "/lib/subscriptions.js";
import { loadOptions, updateOption, REGIONS } from "/lib/options.js";
import { backupNow, backupSoon, restoreIfEmpty } from "/lib/state-backup.js";
import { mountSettings } from "/lib/settings-view.js";
import { escapeHtml } from "/lib/esc.js";
import { isAvailable as updaterAvailable, checkForUpdate } from "/lib/updater.js";
import { openUpdateModal, shouldSkip as updateShouldSkip } from "/lib/update-modal.js";
import { mountAddModal, openAddModal } from "/lib/add-modal.js";
import { openEditSubscription, openEditProfile } from "/lib/edit-modal.js";
import { copySubscriptionUrl, exportSingboxJson, openQRModal } from "/lib/share.js";
import { mountProxiesView, onProxiesViewEnter, onProxiesViewLeave, rerenderProxiesView } from "/lib/proxies-view.js";
import { mountDpiView, setDpiVpnMode, excludeVpnNode, autostartDpiIfEnabled, rerenderDpiView } from "/lib/dpi-view.js";
import { mountLogsView, onLogsViewEnter, onLogsViewLeave, rerenderLogsView } from "/lib/logs-view.js";
import { initTray, syncTrayMenu } from "/lib/tray.js";
import { startClashStream, stopClashStream, formatRate } from "/lib/clash-stream.js";
import { gradeDelay, pickEffectiveNode, getProxies, lastDelay, selectProxy, refreshEffectiveDelay } from "/lib/clash-api.js";
import { fetchPublicIp, maskIp, bindIpReveal } from "/lib/ip-info.js";
import { notify } from "/lib/notify.js";
import { toast } from "/lib/toast.js";
import { FLAGS_BASE, flagIsoFromName as isoFromNodeName, stripFlag } from "/lib/flags.js";
import { startMeter, stopMeter, getMeasured, resetMeasured, sourceKeyOf } from "/lib/traffic-meter.js";
import { createQualityEngine } from "/lib/quality-engine.js";
import { bus } from "/lib/bus.js";
import { openQualityScope } from "/lib/quality-scope.js";
import { initHeroHud } from "/lib/hero-hud.js";
import { parseDeepLink } from "/lib/deeplink.js";
import { applyKillSwitch, maybeWarnKillSwitchProxy } from "/lib/kill-switch.js";
import { initWifiGuard, forgetWifiAutoRestore } from "/lib/wifi-guard.js";
import { initWarpRescan } from "/lib/warp-rescan.js";
import { ensureWorkingDirectDns, startDnsGuard, stopDnsGuard } from "/lib/dns-guard.js";
import { initI18n, setLang, getLang, onLangChange, applyDom, availableLangs, t } from "/lib/i18n/index.js";
import { detectRegion } from "/lib/i18n/region-detect.js";

// ── Tauri 2 (withGlobalTauri:true) ───────────────────────────
const tauriWin = window.__TAURI__?.window?.getCurrentWindow?.()
  ?? window.__TAURI__?.window?.getCurrent?.();
const invoke = window.__TAURI__?.core?.invoke
  ?? ((cmd, args) => {
    console.warn("Tauri invoke недоступен:", cmd, args);
    return Promise.reject(new Error("Tauri invoke недоступен (web preview)"));
  });

// ── Восстановление состояния из бэкапа ──────────────────────
// Профиль WebView2 (EBWebView) могли снести чистилки диска/антивирус: если
// localStorage пуст, а снапшот в app_config_dir есть — возвращаем ключи и
// перезагружаем webview, чтобы все модули перечитали хранилище с нуля
// (тема/язык/опции уже прочитаны дефолтами к этому моменту).
(async () => {
  try { if (await restoreIfEmpty()) location.reload(); } catch {}
})();

// ── Theme switcher (Kurogane / Cyan / Synthwave / Matrix / Command / Mono) ──
const THEME_KEY = "ninety.theme";
const THEMES = ["kurogane", "cyan", "synthwave", "matrix", "mono", "command"];
const appRoot = document.getElementById("app-root");

export function getTheme() {
  const raw = localStorage.getItem(THEME_KEY);
  return THEMES.includes(raw) ? raw : "kurogane";
}
// data-theme вешаем на <html> (documentElement), а НЕ только на #app-root: иначе
// портал-UI вне #app-root (модалки/тосты/контекст-меню, аппендятся в body) берёт
// :root-дефолт (kurogane) вместо активной темы. #app-root держим в синхроне тем же
// значением — его собственный [data-theme] иначе перебьёт наследование для app-поддерева.
function applyThemeAttr(t) {
  document.documentElement.dataset.theme = t;
  if (appRoot) appRoot.dataset.theme = t;
}
export function setTheme(t) {
  if (!THEMES.includes(t)) return;
  localStorage.setItem(THEME_KEY, t);
  applyThemeAttr(t);
  window.dispatchEvent(new CustomEvent("ninety:theme-changed", { detail: { theme: t } }));
}
// Применяем сохранённую тему сразу — до первого рендера остального
applyThemeAttr(getTheme());
window.__ninetySetTheme = setTheme;

// ── i18n: язык применяется ДО первого показа (каталог уже в памяти, синхронно).
// Module-script отложен → DOM готов, applyDom внутри initI18n находит элементы.
initI18n();

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

// Подсказки режимов живут в каталоге i18n (mode.hint.*) — берутся t() при apply.
const MODE_KEYS = ["proxy", "systemProxy", "tun"];

function applyModeToUI(m) {
  if (modeSeg) {
    modeSeg.querySelectorAll(".seg__btn").forEach((x) => {
      const active = x.dataset.mode === m;
      x.dataset.on = active ? "true" : "false";
      x.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  if (modeHint) modeHint.innerHTML = t("mode.hint." + (MODE_KEYS.includes(m) ? m : "systemProxy"));
  // DPI-обход слушает режим: вход в TUN → пауза, выход → восстановление.
  setDpiVpnMode(m);
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
  await changeMode(b.dataset.mode);
});

// Единая смена режима подключения — из сегмента на главной И из меню трея.
// auto=true — переключение сделала Wi-Fi-авто-защита (см. /lib/wifi-guard.js);
// ручной выбор юзера отменяет её авто-возврат прежнего режима.
async function changeMode(requested, { auto = false } = {}) {
  if (!["proxy", "systemProxy", "tun"].includes(requested)) return;
  if (!auto) forgetWifiAutoRestore();
  // TUN (Throne-style) требует чтобы всё приложение было запущено от админа.
  // Если мы не elevated — ensureElevatedForTun перезапустит Ninety с UAC
  // (и вернёт false: текущий процесс умирает, дальше идти незачем).
  if (requested === "tun") {
    const ok = await ensureElevatedForTun();
    if (!ok) return;
  }
  const prevMode = getMode();
  setMode(requested);
  applyModeToUI(requested);
  updateHeroHint();
  syncTrayMenu();
  // Режим меняет inbound (TUN vs mixed) и системный прокси — при поднятом VPN
  // надо пересобрать конфиг. reconnectForSourceChange сам уходит в idle (сбросит
  // системный прокси старого режима) и поднимается заново. Если не connected —
  // no-op, режим применится при следующем connect.
  if (requested !== prevMode) reconnectForSourceChange(t("conn.switchMode"));
}

// ── Авто-защита на чужих Wi-Fi (III.3) — /lib/wifi-guard.js ──
// changeMode инжектится (замыкает setMode/UI/реконнект); forgetWifiAutoRestore
// зовётся из changeMode при ручной смене режима, отменяя авто-возврат.
initWifiGuard({ changeMode });

// ── Kill Switch (I.2) — /lib/kill-switch.js ─────────────────
// applyKillSwitch(connected) зовётся из setState; maybeWarnKillSwitchProxy — из
// settings onChange при включении опции в режиме «Прокси».

// TUN поднимает сетевой интерфейс — для этого sing-box (наш child) должен
// работать от админа, значит и всё приложение тоже. Если уже elevated — ок,
// продолжаем. Иначе перезапускаем Ninety от админа через UAC: перезапущенный
// инстанс читает mode=tun из localStorage и авто-подключается (--elevated).
// Возврат: true — можно продолжать в текущем (уже admin) процессе; false —
// идёт перезапуск ИЛИ юзер отказался от UAC.
async function ensureElevatedForTun() {
  try {
    if (await invoke("is_elevated")) return true;
    const yes = confirm(t("elev.tunConfirm"));
    if (!yes) return false;
    // Запоминаем режим заранее — перезапущенный admin-инстанс поднимется в TUN.
    setMode("tun");
    const started = await invoke("relaunch_elevated");
    if (!started) {
      toast(t("elev.tunCancelled"), "error", 3000);
      return false;
    }
    toast(t("elev.relaunching"), "info", 2500);
    return false; // текущий процесс вот-вот завершится — не продолжаем
  } catch (e) {
    toast(t("elev.failed", { err: e?.message || e }), "error", 3500);
    return false;
  }
}

// DPI-обход: winws грузит kernel-драйвер WinDivert → нужны админ-права. Та же
// схема, что у TUN, но без смены режима: уже elevated → продолжаем; иначе
// перезапуск с UAC (текущий процесс умрёт, вернём false).
async function ensureElevatedForDpi() {
  try {
    if (await invoke("is_elevated")) return true;
    const yes = confirm(t("elev.dpiConfirm"));
    if (!yes) return false;
    const started = await invoke("relaunch_elevated");
    if (!started) {
      toast(t("elev.dpiCancelled"), "error", 3000);
      return false;
    }
    toast(t("elev.relaunching"), "info", 2500);
    return false; // процесс вот-вот завершится
  } catch (e) {
    toast(t("elev.failed", { err: e?.message || e }), "error", 3500);
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
  const subsList = loadSubscriptions();
  if (profilesSummary) {
    if (subsList.length) profilesSummary.textContent = String(subsList.length);
    else profilesSummary.textContent = "";
  }
  renderProfilesView();
  updateHeroForActive();
  refreshSubCardFromActive();
  syncEmptyState();
  backupSoon(); // профили/подписки изменились — обновить снапшот-бэкап
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
const subTraffic = document.getElementById("sub-traffic");
const subBar = document.getElementById("sub-bar");
const subUpdated = document.getElementById("sub-updated");

function refreshSubCardFromActive() {
  const src = getActiveSource();
  if (src?.kind === "sub") {
    const sub = src.subscription;
    if (subName) subName.textContent = sub.name?.toUpperCase() || t("home.subDefault");
    const days = subscriptionDaysLeft(sub);
    if (subExpire) subExpire.textContent = days != null ? String(days) : "—";
    if (subExpireUnit) subExpireUnit.style.display = days != null ? "" : "none";
    const used = subscriptionUsedBytes(sub);
    const limit = subscriptionLimitBytes(sub); // null = безлимит/не метится (total=0)
    if (subTraffic) {
      // Гибрид: есть реальный лимит провайдера → квота used/total. Иначе показываем
      // наш измеренный трафик (заголовок провайдера ненадёжен/0).
      subTraffic.innerHTML = limit != null
        ? `<b>${fmtTraffic(used)}</b> / <b>${fmtTraffic(limit)}</b>`
        : `<b>${fmtTraffic(getMeasured(`sub:${sub.id}`).total)}</b> · ${t("home.unlimited")}`;
    }
    // Прогресс-бар: при лимите ГБ — расход квоты (used/total); при безлимите — доля
    // ОСТАВШЕГОСЯ СРОКА подписки. Период провайдер не отдаёт → самокалибровка по пику
    // виденных дней (= длина периода/последнего продления): полный при продлении,
    // убывает к концу. Без срока и без лимита показывать нечего — прячем.
    let barPct = null;
    if (limit != null) {
      barPct = Math.min(100, (used / limit) * 100);
    } else if (days != null) {
      const key = `ninety.sub.${sub.id}.peakDays`;
      let peak = 0;
      try { peak = Number(localStorage.getItem(key)) || 0; } catch {}
      if (days > peak) { peak = days; try { localStorage.setItem(key, String(peak)); } catch {} }
      barPct = peak > 0 ? Math.max(0, Math.min(100, (days / peak) * 100)) : 100;
    }
    if (subBar) subBar.style.display = barPct != null ? "" : "none";
    if (subProgressFill) subProgressFill.style.width = barPct != null ? `${barPct.toFixed(1)}%` : "0%";
    if (subUpdated) subUpdated.textContent = relativeTime(sub.lastUpdate);
  } else if (src?.kind === "single") {
    if (subName) subName.textContent = t("home.localConfig");
    if (subExpire) subExpire.textContent = "—";
    if (subExpireUnit) subExpireUnit.style.display = "none";
    // У одиночного профиля (hysteria/naive/tt) нет квоты — показываем измеренный трафик.
    if (subTraffic) subTraffic.innerHTML = `<b>${fmtTraffic(getMeasured(`profile:${src.profile.id}`).total)}</b>`;
    if (subBar) subBar.style.display = "none";
    if (subProgressFill) subProgressFill.style.width = "0%";
    if (subUpdated) subUpdated.textContent = "—";
  } else {
    if (subName) subName.textContent = t("home.noSub");
    if (subExpire) subExpire.textContent = "—";
    if (subExpireUnit) subExpireUnit.style.display = "none";
    if (subTraffic) subTraffic.textContent = "—";
    if (subBar) subBar.style.display = "none";
    if (subProgressFill) subProgressFill.style.width = "0%";
    if (subUpdated) subUpdated.textContent = "—";
  }
}

// ── Навигация ───────────────────────────────────────────────
const navItems = document.querySelectorAll(".nav__item[data-view]");
const views = document.querySelectorAll("section.screen[data-view]");

function switchView(target) {
  navItems.forEach((n) => n.classList.toggle("nav__item--active", n.dataset.view === target));
  views.forEach((v) => { v.hidden = v.dataset.view !== target; });
  // Видео-маска декодится только пока главный экран виден — оффскрин обнуляем декод.
  if (heroMask) { if (target === "home") heroMask.play?.().catch(() => {}); else heroMask.pause?.(); }
  if (target === "logs") onLogsViewEnter();
  else onLogsViewLeave();
  if (target === "proxies") onProxiesViewEnter();
  else onProxiesViewLeave();
  if (target === "settings") setTimeout(applySettingsVersion, 0);
}

navItems.forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

// Карточка активной подписки на главной → открыть «Профили» (как в hiddify):
// явная кнопка-шеврон + клик/Enter по самой карточке.
const subCardEl = document.querySelector(".sub-card");
const subOpenBtn = document.getElementById("sub-open-profiles");
subOpenBtn?.addEventListener("click", (e) => { e.stopPropagation(); switchView("profiles"); });
subCardEl?.addEventListener("click", () => switchView("profiles"));
subCardEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchView("profiles"); }
});

// Mount Proxies view (FAB-молния → перетест группы)
mountProxiesView({ onToast: toast });

// Mount DPI-обход (экран + чип на главной). Синхронизируем режим VPN сразу:
// в TUN обход авто-паузится (см. dpi-view.js::effState).
mountDpiView({ onToast: toast, switchView, ensureElevated: ensureElevatedForDpi });
setDpiVpnMode(getMode());

// ── Settings view ──────────────────────────────────────────
const settingsRoot = document.getElementById("settings-root");
let settingsCtl = null;
if (settingsRoot) {
  settingsCtl = mountSettings(settingsRoot, {
    onChange: (path) => {
      backupSoon(); // настройки изменились — обновить снапшот-бэкап состояния
      // Kill switch — чистый WFP-фильтр, конфиг sing-box не трогает: применяем
      // вживую (arm/disarm по текущему состоянию), БЕЗ реконнекта туннеля (прежде
      // тоггл ронял и поднимал VPN зря). В режиме «Прокси» — разовое предупреждение.
      if (path === "general.killSwitch") {
        maybeWarnKillSwitchProxy();
        applyKillSwitch(state === "connected");
        return;
      }
      // Тогглы periodic re-scan и его интервал — не трогают sing-box, только
      // фоновый JS-loop. Пересоздаём loop сразу, реконнект не нужен.
      if (path === "warp.autoRescan" || path === "warp.autoRescanIntervalMin" || path === "warp.autoRescanThresholdMs") {
        startWarpRescanLoop();
        return;
      }
      // Badge с активным endpoint должен реагировать на любое изменение warp.*
      if (path === "warp.enabled" || path === "warp.endpoint") updateWarpBadge();
      // Качество связи — опции читает движок, ядро не трогаем. Применяем вживую
      // через setOptions; вкл/выкл прячет/показывает индикатор «КАНАЛ».
      if (path.startsWith("quality.")) {
        qualityEngine.setOptions(loadOptions().quality);
        if (path === "quality.enabled" && state === "connected") {
          showQualityChip(loadOptions().quality?.enabled !== false);
        }
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
  // Kill switch — WFP-фильтр, применяется вживую (см. onChange); ядро не трогает.
  if (path === "general.killSwitch") return false;
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
  // split-routing Discord влияет только на TUN-маршруты
  if (path === "route.tunSplitDiscord") return getMode() === "tun";
  return true;
}

const RECONNECT_DEBOUNCE_MS = 1200;
let pendingReconnectTimer = null;

// Единое гашение ядра: системный прокси → ядро → UI в idle. Все пути
// отключения (ручное, авто-реконнект, watchdog, отказ моста, фейл старта)
// идут через него, чтобы сброс системного прокси не потерялся ни в одном.
async function shutdownCore() {
  try { await invoke("set_system_proxy", { enable: false }); } catch {}
  try { await invoke("stop_singbox"); } catch (e) { console.warn("stop failed", e); }
  setState("idle");
}

function scheduleAutoReconnect() {
  if (state !== "connected" && state !== "connecting") return;
  needsReconnect = true;
  applyReconnectUI();
  if (pendingReconnectTimer) clearTimeout(pendingReconnectTimer);
  pendingReconnectTimer = setTimeout(performAutoReconnect, RECONNECT_DEBOUNCE_MS);
}

async function performAutoReconnect(reason = t("conn.applyingSettings")) {
  pendingReconnectTimer = null;
  if (!needsReconnect) return;
  if (state !== "connected" && state !== "connecting") return;
  connectEpoch++; // инвалидировать возможный start_singbox в полёте
  toast(reason, "info", 0, { group: "conn", connecting: true });
  await shutdownCore();
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

// Кап догоняющих реконнектов мостов (xray / naive / TT). Смерть моста сразу на
// старте теперь фейлит start_singbox (fail-fast в Rust), но смерть в середине
// сессии по-прежнему лечится реконнектом — без капа стабильно падающий мост
// зациклил бы «упал → реконнект → упал» с тостами каждые ~10 секунд навсегда.
const BRIDGE_RECONNECT_MAX = 3;
const BRIDGE_RECONNECT_WINDOW_MS = 10 * 60_000;
let bridgeReconnects = [];
function bridgeReconnectAllowed() {
  const cut = Date.now() - BRIDGE_RECONNECT_WINDOW_MS;
  bridgeReconnects = bridgeReconnects.filter((ts) => ts > cut);
  if (bridgeReconnects.length >= BRIDGE_RECONNECT_MAX) return false;
  bridgeReconnects.push(Date.now());
  return true;
}

// Бюджет исчерпан — мост падает системно, реконнекты не лечат. Закрываем
// туннель целиком (как при смерти sing-box): честная ошибка вместо вечного цикла.
async function stopForBridgeLoop() {
  await shutdownCore();
  toast(t("conn.bridgeLoop"), "error", 8000, {
    group: "conn",
    desc: t("conn.bridgeLoopDesc"),
  });
  notify(t("conn.notifyClosedTitle"), t("conn.bridgeLoopDesc"));
  switchView("logs");
}

function startHealthWatchdog() {
  if (healthTimer) return;
  healthTimer = setInterval(healthTick, HEALTH_TICK_MS);
}
function stopHealthWatchdog() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

async function healthTick() {
  // updateInstalling: модалка апдейта сама гасит ядра перед установкой —
  // watchdog иначе находил «труп» и слал ложный «соединение закрыто» + логи.
  if (state !== "connected" || healthBusy || updateInstalling) return;
  healthBusy = true;
  try {
    // Один агрегирующий вызов вместо четырёх (singbox_running/vpn_last_error/
    // xray_status/sidecar_status) — снимает лишний IPC-трафик на каждом тике.
    const snap = await invoke("health_snapshot");
    if (!snap.singbox_running) {
      // Причину смерти snapshot читает синхронно с running-статусом (до
      // shutdownCore, который сбрасывает флаги).
      const why = snap.last_error;
      await shutdownCore();
      toast(t("conn.coreStopped"), "error", 7000, {
        group: "conn",
        desc: t("conn.coreStoppedDesc"),
      });
      notify(t("conn.notifyClosedTitle"), t("conn.notifyClosedBody"));
      if (why) console.warn("sing-box died:", why);
      switchView("logs");
      return;
    }
    // sing-box жив — проверяем xray-мост (xhttp).
    if (snap.xray === "died") {
      if (!bridgeReconnectAllowed()) { await stopForBridgeLoop(); return; }
      toast(t("conn.xhttpDown"), "warn", 4000, { group: "conn", connecting: true });
      notify("Ninety", t("conn.xhttpNotify"));
      // reconnectForSourceChange сам ставит needsReconnect и зовёт реконнект,
      // который поднимет sing-box И xray заново из свежего конфига.
      reconnectForSourceChange(t("conn.xhttpReconnect"));
      return;
    }
    // sidecar-клиенты naive/trusttunnel — та же логика, что у xray-моста.
    if (snap.sidecar === "died") {
      if (!bridgeReconnectAllowed()) { await stopForBridgeLoop(); return; }
      toast(t("conn.clientDown"), "warn", 4000, { group: "conn", connecting: true });
      notify("Ninety", t("conn.clientNotify"));
      reconnectForSourceChange(t("conn.clientReconnect"));
      return;
    }
    // Liveness OK — отдаём ход движку качества (детект троттла/деградации).
    // Fire-and-forget: проба до 4с не должна держать healthBusy и тормозить
    // следующий liveness-тик; у движка свои guard'ы probing/remediating.
    qualityEngine.tick().catch(() => {});
  } catch (e) {
    console.warn("healthTick failed", e);
  } finally {
    healthBusy = false;
  }
}

// ── Движок качества связи ──────────────────────────────────
// Декаплинг: движок не знает про DOM/main.js, все «руки» инжектим здесь.
// Ступени лесенки, которых пока нет (R2 exclude-node, R5 switch-transport),
// просто не передаём в actions — движок их пропускает.
const qualityEngine = createQualityEngine({
  invoke,
  actions: {
    // R1 — перевыбор ноды балансером без реконнекта: форсим re-test группы
    // lowest, urltest переберёт живые задержки и подвинет эффективную ноду.
    selectNextNode: async () => {
      try { await refreshEffectiveDelay({ timeoutMs: 5000 }); return true; }
      catch { return false; }
    },
    // R2 — увести с конкретной плохой ноды: текущую кладём на cooldown и вручную
    // выбираем лучшую из оставшихся (selectProxy). Селектор "proxy" собран с
    // interrupt_exist_connections=true → застрявшие соединения рвутся сами. Без
    // реконнекта. false (ступень пропускается) если альтернатив нет.
    excludeWorstNode: async () => {
      const nodes = qualityNodesFromSource();
      if (nodes.length < 2) return false;
      let proxies = {};
      try { proxies = (await getProxies())?.proxies || {}; } catch {}
      const now = Date.now();
      for (const [tag, exp] of qualityExcluded) if (exp <= now) qualityExcluded.delete(tag);
      const cur = currentEffectiveTag;
      if (cur && cur !== "auto") qualityExcluded.set(cur, now + QUALITY_EXCLUDE_MS);
      const avail = nodes.filter(n => n.clashTag && n.clashTag !== cur && !qualityExcluded.has(n.clashTag));
      const pick = rankByDelay(avail, proxies)[0]?.clashTag;
      if (!pick) return false;
      try { await selectProxy("proxy", pick); return true; }
      catch { return false; }
    },
    // R3 — маскировка трафика фрагментацией TLS (реконнект). Если выключена —
    // включаем; если уже включена — эскалируем сменой режима record↔tcp.
    applyFragmentation: async () => {
      // НЕ называть локальную переменную t: затенение i18n-функции здесь уже
      // ломало R3 (TypeError после updateOption → настройки мутировали без
      // реконнекта, лесенка щёлкала record↔tcp вхолостую).
      const tricks = loadOptions().tlsTricks;
      if (!tricks.enableFragment) {
        updateOption("tlsTricks.enableFragment", true);
      } else {
        updateOption("tlsTricks.fragmentMode", tricks.fragmentMode === "record" ? "tcp" : "record");
      }
      return reconnectForSourceChange(t("qToast.masking"));
    },
    // R4 — пересканировать WARP-endpoint и применить лучший (реконнект). Только
    // если WARP включён, иначе ступень неприменима → false (движок пропустит).
    rescanWarp: async () => {
      if (!loadOptions().warp.enabled) return false;
      try {
        // warp_scan_endpoints отдаёт ScanResult[] с полями ip/port (scanner.rs) —
        // прежний код ждал endpoint/host, всегда получал null и ступень
        // молча пропускалась (R4 был мёртв).
        const res = await invoke("warp_scan_endpoints", { topN: 5, deep: false, mode: "auto" });
        const best = Array.isArray(res) ? res[0] : null;
        if (!best?.ip || !best?.port) return false;
        updateOption("warp.endpoint", `${best.ip}:${best.port}`);
        return reconnectForSourceChange(t("qToast.backup"));
      } catch { return false; }
    },
    // R5 — перейти на ноду ДРУГОГО транспорта/протокола (proto:type), лучшую по
    // пингу: меняет саму сигнатуру трафика на проводе. selectProxy + interrupt →
    // застрявшие соединения рвутся, реконнект ядра не нужен. false если ноды
    // другого транспорта в источнике нет.
    switchTransport: async () => {
      const nodes = qualityNodesFromSource();
      if (nodes.length < 2) return false;
      const cur = currentEffectiveTag;
      const curNode = nodes.find(n => n.clashTag === cur) || currentEffectiveNode;
      const curClass = curNode ? transportClass(curNode) : null;
      let proxies = {};
      try { proxies = (await getProxies())?.proxies || {}; } catch {}
      const alt = nodes.filter(n => n.clashTag && n.clashTag !== cur && transportClass(n) !== curClass);
      const pick = rankByDelay(alt, proxies)[0]?.clashTag;
      if (!pick) return false;
      try { await selectProxy("proxy", pick); return true; }
      catch { return false; }
    },
    // Гибрид-гейт перед реконнект-ступенью (когда aggressive=false). Простым языком.
    // Окно в трее → нативный confirm повис бы невидимым и заблокировал лесенку
    // (remediating не снимается, пока промис висит). Вместо этого OS-уведомление
    // и отказ от дорогой ступени: юзер вернётся к окну — следующий прогон
    // лесенки спросит нормально.
    confirmReconnect: async (label) => {
      if (!(await windowIsForeground())) {
        notify(t("qToast.hiddenNotifyTitle"), t("qToast.hiddenNotifyBody"));
        return false;
      }
      return confirm(t("qToast.confirmSpeedup", { label }));
    },
    // R6 — сдаёмся честно, без жаргона.
    giveUp: (st) => {
      toast(t("qToast.giveUp"), "error", 8000, {
        group: "quality",
        desc: t("qToast.giveUpDesc"),
      });
      notify(t("qToast.giveUpNotifyTitle"), t("qToast.giveUpNotifyBody"));
    },
    // Контекст для обучения (что было активно в момент успеха).
    getContext: () => {
      const o = loadOptions();
      return {
        node: currentEffectiveNode?.name || currentEffectiveNode?.host || null,
        tlsTrick: o.tlsTricks.enableFragment ? o.tlsTricks.fragmentMode : null,
        warpEndpoint: o.warp.enabled ? o.warp.endpoint : null,
      };
    },
    // ASN локального ISP (не exit'а): ip-info БЕЗ proxy-арга → напрямую. Даже в
    // TUN этот запрос идёт мимо туннеля (собственный трафик Ninety.exe уходит в
    // direct bypass-правилом), поэтому вернётся именно локальный ISP — то, что
    // нужно для ключа обучения ISP×час. Фолбэк "unknown".
    localAsn: async () => {
      // Приватность: этот запрос идёт НАПРЯМУЮ (мимо туннеля) и раскрыл бы
      // реальный IP geo-сервису. Если юзер отключил geo-lookup — не ходим,
      // движок качества обучается по глобальному профилю (ASN "unknown").
      if (loadOptions().general?.disableGeoLookup) return "unknown";
      try {
        const info = await invoke("fetch_public_ip", {});
        const asn = info?.connection?.asn ?? info?.asn;
        return asn != null ? String(asn) : "unknown";
      } catch { return "unknown"; }
    },
    onState: (st) => {
      if (!qualityDot) return;
      setChannelState(st);
      if (qualityDot.dataset.active !== "true") qualityDot.dataset.active = "true";
    },
    // Каждая проба → в шину; осциллограмма канала (раскрытый чип) подписана на неё.
    onSample: (s) => bus.emit("quality:sample", s),
    toast, notify,
    log: (m) => console.info("[quality]", m),
  },
});

// ── Хелперы лесенки качества (R2/R5) ───────────────────────
// Cooldown нод, забракованных R2 — чтобы не выбирать их снова сразу.
const QUALITY_EXCLUDE_MS = 5 * 60_000;
const qualityExcluded = new Map(); // clashTag → expiry ts
// Ноды активного источника с clash-тэгами (зеркало proxies-view.nodesFromSource).
function qualityNodesFromSource() {
  const src = getActiveSource();
  if (!src) return [];
  const raw = src.kind === "sub" ? (src.nodes || []) : [src.profile];
  const list = raw.filter(Boolean);
  return list.map((n, i) => ({ ...n, clashTag: list.length >= 2 ? nodeTag(i, n) : "proxy" }));
}
// Класс транспорта ноды (протокол + сеть). R5 ищет ноду с ДРУГИМ классом.
function transportClass(n) {
  return `${n?.proto || "vless"}:${n?.type || "-"}`;
}
// Сортировка нод по живому пингу (без пинга — в конец).
function rankByDelay(nodes, proxies) {
  return nodes
    .map(n => ({ ...n, _d: lastDelay(proxies[n.clashTag]) }))
    .sort((a, b) => {
      const da = Number.isFinite(a._d) && a._d > 0 ? a._d : Infinity;
      const db = Number.isFinite(b._d) && b._d > 0 ? b._d : Infinity;
      return da - db;
    });
}

// ── Индикатор качества канала (ячейка «Канал» в телеметрии-полосе) ──
// Состояние правит движок через onState; ячейка живёт в stats-strip (secured),
// показывается/прячается вместе с полосой. Человеческий язык, без техножаргона.
const qChannelLabel = (st) => t("qToast.channel." + String(st).toLowerCase());
const qualityDot = document.getElementById("tele-channel"); // #tele-channel (data-q/data-active)
const qualityState = document.getElementById("stats-channel");
let lastChannelState = "UNKNOWN";
function setChannelState(st) {
  lastChannelState = st;
  if (qualityDot) qualityDot.dataset.q = st;
  if (qualityState) qualityState.textContent = qChannelLabel(st);
}
function showQualityChip(on) {
  if (!qualityDot) return;
  if (on) setChannelState("UNKNOWN");
  qualityDot.dataset.active = on ? "true" : "false";
}
// Клик по ячейке «Канал» при активном мониторинге → осциллограмма goodput-проб.
qualityDot?.addEventListener("click", (e) => {
  if (qualityDot.dataset.active !== "true") return;
  e.stopPropagation();
  openQualityScope({
    anchor: qualityDot,
    getSamples: () => qualityEngine.getSamples(),
    goodBps: Number(loadOptions().quality?.goodBps) || 1_500_000,
  });
});

function applyReconnectUI() {
  if (!hero) return;
  if (needsReconnect && (state === "connected" || state === "connecting")) {
    hero.classList.add("hero--reconnect");
    if (heroLabel) heroLabel.textContent = t("hero.apply");
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
  currentEffectiveTag = null;
  refreshProfilesSummary();
  syncTrayMenu();
  const reason = isSub ? t("conn.switchSub") : t("conn.switchProfile");
  if (wasActive || !reconnectForSourceChange(reason)) {
    toast(isSub ? t("conn.subActivated") : t("conn.profileActivated"), "success", 1800);
  }
}

// ── WARP UX (hero badge + авто-ротация + история) — /lib/warp-rescan.js ──
// Подсистема вынесена в модуль; здесь только инстанс с инжектом состояния/реконнекта.
// Алиасы сохраняют прежние имена вызовов (updateWarpBadge/start/stopWarpRescanLoop),
// разбросанные по setState/onChange/warp-switch — их не трогаем.
const warpRescan = initWarpRescan({ getState: () => state, scheduleAutoReconnect });
const updateWarpBadge = warpRescan.updateBadge;
const startWarpRescanLoop = warpRescan.startLoop;
const stopWarpRescanLoop = warpRescan.stopLoop;

navItems.forEach((item) => {
  if (item.dataset.view !== "settings") return;
  item.addEventListener("click", () => {
    if (settingsCtl) settingsCtl.goMenu();
  });
});

// ── Logs view — вынесен в /lib/logs-view.js ────────────────
mountLogsView();

// ── Profiles view ──────────────────────────────────────────
const profilesView = document.querySelector('section.screen[data-view="profiles"]');
const profilesList = document.getElementById("profiles-list");

const ICON_DOTS    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>`;
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
        <h2 class="onb__title" style="font-size:20px">${t("prof.emptyTitle")}</h2>
        <p class="onb__sub">${t("prof.emptySub")}</p>
      </div>
    `;
    return;
  }

  const subItems = subsList.map(s => {
    const isActive = activeKind === "sub" && s.id === activeSubId;
    const days = subscriptionDaysLeft(s);
    const used = subscriptionUsedBytes(s);
    const limit = subscriptionLimitBytes(s); // null = безлимит (total=0)
    const updated = relativeTime(s.lastUpdate) || "—";
    const nodesCount = s.profiles?.length || 0;
    const trafficStr = limit != null
      ? `${fmtTraffic(used)} / ${fmtTraffic(limit)}`
      : `${fmtTraffic(getMeasured(`sub:${s.id}`).total)} · ∞`;
    return `
      <article class="prof-card" data-active="${isActive}" data-sub-id="${s.id}">
        <div class="prof-card__icon">${ICON_GLOBE}</div>
        <div class="prof-card__main" data-sub-activate="${s.id}">
          <div class="prof-card__head">
            <span class="prof-card__name">${escapeHtml(s.name)}</span>
            ${isActive ? `<span class="prof-card__badge">${t("prof.badgeActive")}</span>` : ""}
          </div>
          <div class="prof-card__url">${escapeHtml(s.url || "")}</div>
        </div>
        <div class="prof-card__stats">
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${nodesCount}</span>
            <span class="prof-card__stat-lbl">${t("prof.statNodes")}</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${trafficStr}</span>
            <span class="prof-card__stat-lbl">${t("prof.statTraffic")}</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${days == null ? "—" : days}${days != null ? `<span style="color:var(--text-faint);font-size:9px;margin-left:3px;">${t("prof.daysUnit")}</span>` : ""}</span>
            <span class="prof-card__stat-lbl">${t("prof.statExpires")}</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val" style="font-size:11px;color:var(--text-mid);">${escapeHtml(updated)}</span>
            <span class="prof-card__stat-lbl">${t("prof.statUpdated")}</span>
          </div>
        </div>
        <button class="prof-card__menu" data-menu-sub="${s.id}" type="button" aria-label="${t("prof.menuAria")}">${ICON_DOTS}</button>
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
            ${isActive ? `<span class="prof-card__badge">${t("prof.badgeActive")}</span>` : ""}
          </div>
          <div class="prof-card__url">${escapeHtml(`${p.host}:${p.port}`)}</div>
        </div>
        <div class="prof-card__stats">
          <div class="prof-card__stat">
            <span class="prof-card__stat-val" style="font-size:11px;">${escapeHtml(proto)}</span>
            <span class="prof-card__stat-lbl">${t("prof.statProto")}</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val" style="font-size:11px;">${escapeHtml(security)}</span>
            <span class="prof-card__stat-lbl">TLS</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${fmtTraffic(getMeasured(`profile:${p.id}`).total)}</span>
            <span class="prof-card__stat-lbl">${t("prof.statTraffic")}</span>
          </div>
        </div>
        <button class="prof-card__menu" data-menu-profile="${p.id}" type="button" aria-label="${t("prof.menuAria")}">${ICON_DOTS}</button>
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
  populateOnbPrefs();
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
// ── Онбординг · пикеры язык/регион/тема (Hiddify-style welcome) ──────────────
// Подписи локализованы (t / availableLangs), тема и регион применяются сразу.
function populateOnbPrefs() {
  const swatches = {
    kurogane: "#DE5772", cyan: "#6CF2F2", synthwave: "#E0A6FF",
    matrix: "#5CEE92", mono: "#FFFFFF", command: "#FF3355",
  };
  const langSel = document.getElementById("onb-lang");
  const regionSel = document.getElementById("onb-region");
  const themesWrap = document.getElementById("onb-themes");
  if (langSel) {
    langSel.innerHTML = availableLangs()
      .map(l => `<option value="${l.code}"${l.code === getLang() ? " selected" : ""}>${l.name}</option>`)
      .join("");
  }
  if (regionSel) {
    const cur = loadOptions().region;
    regionSel.innerHTML = REGIONS
      .map(r => `<option value="${r}"${r === cur ? " selected" : ""}>${t("region." + r)}</option>`)
      .join("");
  }
  if (themesWrap) {
    const cur = getTheme();
    themesWrap.innerHTML = Object.entries(swatches)
      .map(([id, c]) => `<button type="button" class="onb-theme${id === cur ? " onb-theme--on" : ""}" data-onb-theme="${id}" title="${id}" style="--sw:${c}"></button>`)
      .join("");
  }
}

// Первый запуск: регион предвыбран по таймзоне (один раз; выбор вернувшегося юзера не трогаем).
if (!localStorage.getItem("ninety.region.detected") && !isOnboardingDone()) {
  updateOption("region", detectRegion());
  localStorage.setItem("ninety.region.detected", "1");
}

document.getElementById("onb-lang")?.addEventListener("change", (e) => { setLang(e.target.value); });
document.getElementById("onb-region")?.addEventListener("change", (e) => {
  updateOption("region", e.target.value);
  localStorage.setItem("ninety.region.detected", "1");
});
document.getElementById("onb-themes")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-onb-theme]");
  if (!b) return;
  setTheme(b.dataset.onbTheme);
  populateOnbPrefs();
});

// Живой ре-рендер при смене языка: static-строки index.html + подписи пикеров + динамика главной.
onLangChange(() => {
  applyDom(document);
  populateOnbPrefs();
  refreshDynamicText();
  settingsCtl?.refresh();
  syncTrayMenu(); // меню/tooltip трея — на новый язык
  rerenderDpiView();
  rerenderProxiesView();
  renderProfilesView();
  refreshSubCardFromActive();
  setChannelState(lastChannelState);
  updateHeroHint();
  applyPingDisplay(lastPingDelay);
  if (state === "connected") paintSession();
  else {
    if (tfDownUnit) tfDownUnit.textContent = t("units.rateKiB");
    if (tfUpUnit) tfUpUnit.textContent = t("units.rateKiB");
  }
  rerenderLogsView(); // no-op, если экран Логи не активен
});

// Перерисовать динамические подписи главной (статус hero, подсказка режима, режим в
// телеметрии) без побочных эффектов — сессии/таймеры/ядро не трогаем.
function refreshDynamicText() {
  if (heroLabel) {
    heroLabel.textContent =
      state === "connected"  ? t("hero.secured")
      : state === "connecting" ? t("hero.connecting")
      : t("hero.notConnected");
  }
  if (modeHint) {
    const m = getMode();
    modeHint.innerHTML = t("mode.hint." + (MODE_KEYS.includes(m) ? m : "systemProxy"));
  }
  if (statsMode && state === "connected") statsMode.textContent = modeLabel(getMode());
}

populateOnbPrefs();

document.getElementById("profiles-refresh-all")?.addEventListener("click", async () => {
  try {
    await refreshAllSubscriptions();
    refreshSubCardFromActive();
    refreshProfilesSummary();
    toast(t("prof.subsRefreshed"), "success", 1800);
  } catch (e) {
    toast(t("prof.toastErr", { err: e?.message || e }), "error", 2800);
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
      { id: "refresh",  label: t("prof.menu.refresh"),  icon: ICON_REFRESH },
      { id: "edit",     label: t("prof.menu.edit"), icon: ICON_EDIT },
      { id: "copy",     label: t("prof.menu.copyUrl"), icon: ICON_COPY },
      { id: "qr",       label: t("prof.menu.qr"), icon: ICON_QR },
      { id: "export",   label: t("prof.menu.export"), icon: ICON_COPY },
      { id: "activate", label: t("prof.menu.activateSub"), icon: ICON_CHECK },
      { id: "reset-traffic", label: t("prof.menu.resetTraffic"), icon: ICON_REFRESH },
      { id: "remove",   label: t("prof.menu.remove"),   icon: ICON_TRASH, danger: true },
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
          toast(t("prof.toastUpdated", { n: r.profiles.length }), "success", 1800);
        } catch (err) {
          toast(t("prof.toastErr", { err: err?.message || err }), "error", 2800);
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
      } else if (act === "reset-traffic") {
        resetMeasured(`sub:${id}`);
        renderProfilesView();
        refreshSubCardFromActive();
        toast(t("prof.toastTrafficReset"), "info", 1600);
      } else if (act === "remove") {
        removeSubscription(id);
        if (getActiveKind() === "sub" && !getActiveSubscriptionId()) setActiveKind("single");
        refreshProfilesSummary();
        toast(t("prof.toastSubRemoved"), "info", 1800);
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
      { id: "edit",     label: t("prof.menu.edit"),    icon: ICON_EDIT },
      { id: "activate", label: t("prof.menu.activateProfile"), icon: ICON_CHECK },
      { id: "reset-traffic", label: t("prof.menu.resetTraffic"), icon: ICON_REFRESH },
      { id: "remove",   label: t("prof.menu.remove"),          icon: ICON_TRASH, danger: true },
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
      } else if (act === "reset-traffic") {
        resetMeasured(`profile:${id}`);
        renderProfilesView();
        refreshSubCardFromActive();
        toast(t("prof.toastTrafficReset"), "info", 1600);
      } else if (act === "remove") {
        removeProfile(id);
        refreshProfilesSummary();
        toast(t("prof.toastProfileRemoved"), "info", 1800);
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
const heroDisc = document.getElementById("hero-disc");
const heroMask = document.getElementById("hero-mask");
const heroLabel = document.getElementById("hero-label");
const heroHint = document.getElementById("hero-hint");
const heroHintText = document.getElementById("hero-hint-text");
const tfDown = document.getElementById("tf-down");
const tfUp = document.getElementById("tf-up");
const tfDownUnit = document.getElementById("tf-down-unit");
const tfUpUnit = document.getElementById("tf-up-unit");
const tfDot = document.getElementById("tf-dot");
const locCard = document.getElementById("location-card");
const statsStrip = document.getElementById("stats-strip");
const statsServer = document.getElementById("stats-server");
const statsFlag = document.getElementById("stats-flag");
const statsMode = document.getElementById("stats-mode");
// Телеметрия-полоса (secured): Пинг · Канал · Сессия
const telePing = document.getElementById("tele-ping");
const statsPing = document.getElementById("stats-ping");
const statsUptime = document.getElementById("stats-uptime");
const statsTotal = document.getElementById("stats-total");
const locPing = document.getElementById("loc-ping");
const locIpRow = document.getElementById("loc-ip-row");
const locIp = document.getElementById("loc-ip");

// Мап-имена для CSS data-state
const STATE_HERO = { idle: "standby", connecting: "linking", connected: "secured" };
const STATE_KICKER = {
  idle:       "STAND-BY · DISCONNECTED",
  connecting: "LINKING · NEGOTIATING",
  connected:  "SECURED · TUNNEL ACTIVE", // дефолт; в connected берём connectedKicker() по режиму
};
// Kicker в состоянии connected зависит от режима: TUNNEL ACTIVE только в TUN,
// системный прокси → SYSTEM PROXY, прокси → PROXY ACTIVE (раньше всегда «TUNNEL ACTIVE»).
const CONNECTED_KICKER = {
  tun:         "SECURED · TUNNEL ACTIVE",
  systemProxy: "SECURED · SYSTEM PROXY",
  proxy:       "SECURED · PROXY ACTIVE",
};
function connectedKicker() { return CONNECTED_KICKER[getMode()] || STATE_KICKER.connected; }
const modeLabel = (m) => t("mode." + m);

// Кибер-HUD вокруг маски (lib/hero-hud.js). Инициализируется ниже, после
// объявления `state` — getState читает его лениво из замыкания.
let heroHud = null;

function applyHeroState(internalState) {
  if (!hero) return;
  const ds = STATE_HERO[internalState] || "standby";
  hero.dataset.state = ds;
  heroHud?.sync(); // обновить SYSTEM STATUS / TARGET / INTEGRITY / ERR под состояние
}

// Stats-strip vs Location-card: connected → stats-strip с live-метриками.
// Когда VPN выключен (idle/connecting) — нижняя плитка сервера не нужна,
// прячем обе (раньше показывали loc-card в standby — лишний шум).
function applyHomeBottom(internalState) {
  if (!locCard || !statsStrip) return;
  locCard.hidden = true;
  // Stats-strip ВСЕГДА в потоке (держит высоту), видимой делаем только в connected.
  // Иначе её появление при connect сжимает .hero снизу → центрированная сцена/маска
  // уезжает вверх (а при disconnect — обратно вниз). Резерв места = сцена не двигается.
  statsStrip.hidden = false;
  statsStrip.classList.toggle("stats--reserved", internalState !== "connected");
}

// Активный сервер в stats-strip — обновляется при connect и смене effective-ноды.
function updateStatsServer() {
  if (!statsServer) return;
  const p = activeNodeForDisplay();
  // Имя без флаг-эмодзи: страну уже показывает SVG-флаг в ячейке (иначе дубль флага).
  const label = stripFlag(p?.name) || p?.host || "—";
  statsServer.textContent = label;
  statsServer.title = label;
  if (statsFlag) {
    const iso = p ? (isoFromNodeName(p.name) || isoFromNodeName(p.host)) : null;
    statsFlag.innerHTML = iso ? `<img src="${FLAGS_BASE}/${iso}.svg" alt="">` : "";
    statsFlag.hidden = !iso;
  }
  heroHud?.sync(); // эффективная нода сменилась → перечитать TARGET LOCKED в HUD
}

let lastPublicIp = null;
if (locIp) bindIpReveal(locIp, () => lastPublicIp);

async function refreshPublicIp() {
  if (state !== "connected") return;
  // Приватность: юзер отключил geo-запросы → не дёргаем внешние IP-сервисы
  // вовсе, IP-плитка гаснет с поясняющим тултипом.
  if (loadOptions().general?.disableGeoLookup) {
    lastPublicIp = null;
    if (locIpRow) locIpRow.hidden = false;
    if (locIp) {
      locIp.textContent = "—";
      locIp.dataset.revealed = "false";
      locIp.title = t("hero.ipGeoOff");
    }
    return;
  }
  // IP всегда тянем ЧЕРЕЗ локальный inbound sing-box, во всех режимах:
  //   proxy/systemProxy — mixed-in (reqwest системный прокси не чтит, поэтому
  //     даже в systemProxy без явного адреса запрос ушёл бы напрямую → мимо
  //     туннеля и показывал бы реальный IP юзера);
  //   tun — probe-in слушает тот же порт; «напрямую» нельзя, т.к. собственный
  //     трафик Ninety.exe в TUN уходит в direct bypass-правилом (защита от петли)
  //     и IP-сервис увидел бы реальный IP, а не exit.
  const port = loadOptions().inbound.mixedPort || 7890;
  const proxyHostPort = `127.0.0.1:${port}`;
  try {
    const info = await fetchPublicIp({ proxyHostPort });
    if (!info?.success && info?.ip == null) {
      // Rust нормализует ответ (fetch_public_ip перебирает провайдеров); при
      // неуспехе всех обычно летит Err → catch, эта ветка — страховка.
      throw new Error(info?.message || "no ip");
    }
    lastPublicIp = info.ip;
    if (locIpRow) locIpRow.hidden = false;
    if (locIp) {
      locIp.textContent = maskIp(info.ip);
      locIp.dataset.revealed = "false";
      const flag = info.country_code?.toLowerCase();
      const country = info.country || info.country_code || "";
      if (flag) locIp.title = t("hero.ipTooltip", { country });
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

// флаги: FLAGS_BASE + isoFromNodeName импортированы из /lib/flags.js
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
// Поколение попытки подключения: «Отключить» во время старта ядра инкрементит
// его, и завершившийся start_singbox видит отмену (см. heroDisc-обработчик) —
// раньше быстрый connect→cancel всё равно заканчивался «Защищено».
let connectEpoch = 0;

// Запускаем HUD после объявления state. TARGET читает фактический сервер.
function hudTarget() {
  // Тот же источник, что ячейка «Сервер» телеметрии (activeNodeForDisplay) — HUD-таргет
  // всегда совпадает с реально выбранной нодой. Балансировщик подписки выбирает сервер
  // уже ПОСЛЕ старта ядра, поэтому при коннекте сюда раньше попадал nodes[0] (Germany #1),
  // а телеметрия позже показывала фактический (Latvia #2) — теперь оба тянут одно и то же.
  const p = activeNodeForDisplay();
  const l = stripFlag(p?.name) || p?.host || "190X4";
  return l.toUpperCase().replace(/\s+/g, "-").slice(0, 16);
}
heroHud = initHeroHud(document.getElementById("hero-hud"), {
  getState: () => STATE_HERO[state] || "standby",
  getTarget: hudTarget,
});

function setHeroHintText(text) {
  if (heroHintText) heroHintText.textContent = text;
  else if (heroHint) heroHint.textContent = text;
}

function updateHeroHint() {
  if (state !== "idle") return;
  const src = getActiveSource();
  if (!src) {
    setHeroHintText(t("home.importHint"));
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
let currentEffectiveTag = null;

function activeNodeForDisplay() {
  if (currentEffectiveNode) return currentEffectiveNode;
  const src = getActiveSource();
  return src?.kind === "sub" ? src.nodes[0] : src?.profile;
}

// Имя ноды как в списке нод (не адрес). host — запасной вариант.
function nodeDisplayLabel(n) {
  return n?.name || n?.host || "";
}

// Гарантированно непустое имя сервера для тоста/уведомления. Цепочка фолбэков:
// фактическая нода из clash → первая нода/профиль источника → имя подписки.
// Возвращает "" только если активного источника вообще нет.
function resolveServerLabel() {
  const eff = currentEffectiveNode;
  if (eff?.name || eff?.host) return eff.name || eff.host;
  const src = getActiveSource();
  if (src?.kind === "sub") {
    const n0 = src.nodes?.[0];
    if (n0?.name || n0?.host) return n0.name || n0.host;
    return src.subscription?.name || "";
  }
  const p = src?.profile;
  return p?.name || p?.host || "";
}

// OS-уведомление + догоняющий тост о подключении с ИМЕНЕМ реально выбранной
// ноды. Для подписки из >=2 нод балансировщик выбирает сервер уже ПОСЛЕ старта
// ядра — опрашиваем clash, пока не появится фактический сервер (до ~3.5с),
// иначе показали бы nodes[0] (первый в списке), а не фактический. Для одиночного
// профиля нода одна — ждать нечего.
async function notifyConnectedWithRealNode(isMultiSub) {
  if (isMultiSub) {
    for (let i = 0; i < 7; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (state !== "connected") return; // успели отключиться
      try { await syncEffectiveFromClash(); } catch {}
      if (currentEffectiveNode) break;
    }
  }
  if (state !== "connected") return;
  const label = resolveServerLabel();
  // Для подписки стартовый тост был обобщённым (балансировщик ещё не выбрал) —
  // догоняем реальным сервером, когда он стал известен.
  if (label && isMultiSub) {
    toast(t("conn.protected"), "connected", 2000, { group: "conn", desc: t("conn.serverDesc", { label }) });
  }
  notify(t("conn.notifyConnected"), label ? t("conn.serverDesc", { label }) : t("conn.tunnelUp"));
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
    stopDnsGuard();
    applyKillSwitch(false); // снять WFP-блок при отключении
    qualityEngine.onIdle();
    showQualityChip(false);
    applyReconnectUI();
    if (heroLabel) heroLabel.textContent = t("hero.notConnected");
    stopSession();
    if (heroDisc) heroDisc.setAttribute("aria-label", t("heroAria.connect"));
    if (tfDown) tfDown.textContent = "0";
    if (tfUp) tfUp.textContent = "0";
    if (tfDownUnit) tfDownUnit.textContent = t("units.rateKiB");
    if (tfUpUnit) tfUpUnit.textContent = t("units.rateKiB");
    if (tfDot) tfDot.dataset.live = "false";
    if (heroMask) heroMask.playbackRate = 0.7;
    stopClashStream();
    stopMeter();
    if (publicIpTimer) { clearInterval(publicIpTimer); publicIpTimer = null; }
    lastPublicIp = null;
    if (locIpRow) locIpRow.hidden = true;
    currentEffectiveNode = null;
    currentEffectiveTag = null;
    if (heroHint) heroHint.hidden = false;
    updateHeroHint();
  } else if (next === "connecting") {
    if (heroLabel) heroLabel.textContent = t("hero.connecting");
    if (heroHint) heroHint.hidden = false;
    setHeroHintText(STATE_KICKER.connecting);
    if (heroDisc) heroDisc.setAttribute("aria-label", t("heroAria.cancelConnect"));
    if (heroMask) heroMask.playbackRate = 1.4;
  } else if (next === "connected") {
    if (heroLabel) heroLabel.textContent = t("hero.secured");
    if (heroHint) heroHint.hidden = false;
    setHeroHintText(connectedKicker());
    applyPingDisplay(opts.ping ?? null);
    startSession();
    if (tfDot) tfDot.dataset.live = "true";
    if (heroDisc) heroDisc.setAttribute("aria-label", t("heroAria.disconnect"));
    if (heroMask) heroMask.playbackRate = 1.0;
    if (statsMode) statsMode.textContent = modeLabel(getMode());
    updateStatsServer();
    startTrafficStream();
    // Учёт реально измеренного трафика активного источника (для гибрид-плитки).
    startMeter({ sourceKey: sourceKeyOf(getActiveSource()), onUpdate: refreshSubCardFromActive });
    startWarpRescanLoop();
    startHealthWatchdog();
    // DNS-watchdog: если direct-DNS ляжет в середине сессии — переключит на резерв
    // и реконнектит (sing-box перечитает DNS из свежего конфига).
    startDnsGuard({
      toast,
      isConnected: () => state === "connected",
      onDnsSwitched: () => reconnectForSourceChange(t("dns.reconnect")),
    });
    applyKillSwitch(true); // поднять WFP-блок (proxy/systemProxy + elevated)
    // Проба всегда через локальный инбаунд sing-box: mixed-in (proxy/systemProxy)
    // либо probe-in (TUN, тот же порт). «Напрямую» в TUN нельзя — bypass-правило
    // Ninety.exe увело бы пробу в direct, и мерился бы голый канал, а не туннель.
    qualityEngine.onConnected({
      port: loadOptions().inbound.mixedPort || 7890,
      ...loadOptions().quality,
    });
    showQualityChip(loadOptions().quality?.enabled !== false);
    updateWarpBadge();
    // DPI-обход: вносим сервер активной ноды в исключения winws, чтобы он не
    // трогал зашифрованный трафик к VPN-серверу (главный риск из спайка).
    try { excludeVpnNode(activeNodeForDisplay()?.host); } catch {}
    // Эндпоинты апдейта стали достижимы через туннель — дочекать, если прямые
    // проверки не проходили (у части провайдеров gitlab/github режутся напрямую).
    updateCheckIfStale();
    // Wizard: подключились — переходим на финальный шаг
    if (wizardActive && wizardStepNum === 3) showOnbStep(4);
  }

  syncTrayMenu();
}

// Единый рендерер пинга: ячейка «Пинг» телеметрии + location-card.
// delay > 0 && < 65000 → число + grade; 0/null → "— мс"; >= 65000 → "Тайм-аут"
let lastPingDelay = null;
function applyPingDisplay(delay) {
  lastPingDelay = delay;
  const num = Number(delay);
  let text, grade, valOnly;
  if (!num || num <= 0) { text = `— ${t("units.ms")}`; grade = "dead"; valOnly = "—"; }
  else if (num >= 65000) { text = t("units.timeout"); grade = "dead"; valOnly = "—"; }
  else { text = `${num} ${t("units.ms")}`; grade = gradeDelay(num); valOnly = String(num); }

  if (statsPing) statsPing.textContent = valOnly;
  if (telePing) telePing.dataset.grade = grade;
  if (locPing) locPing.textContent = text;
}

// ── Сессия (телеметрия secured): аптайм + накопленные тоталы ──
// Мгновенная скорость живёт в сайдбаре; здесь — суммарный объём за сессию.
let sessionTimer = null, sessionStart = 0, sessionDownBytes = 0, sessionUpBytes = 0;
function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}${t("units.hour")} ${String(m).padStart(2, "0")}${t("units.min")}`;
  return `${m}${t("units.min")} ${String(sec).padStart(2, "0")}${t("units.sec")}`;
}
function paintSession() {
  if (statsUptime) statsUptime.textContent = fmtUptime(Math.floor((Date.now() - sessionStart) / 1000));
  if (statsTotal) statsTotal.textContent = `↓ ${fmtTraffic(sessionDownBytes)} · ↑ ${fmtTraffic(sessionUpBytes)}`;
}
function startSession() {
  sessionStart = Date.now();
  sessionDownBytes = 0;
  sessionUpBytes = 0;
  paintSession();
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = setInterval(paintSession, 1000);
}
function stopSession() {
  if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
  if (statsUptime) statsUptime.textContent = "—";
  if (statsTotal) statsTotal.textContent = "↓ 0 · ↑ 0";
  if (statsPing) statsPing.textContent = "—";
  setChannelState("UNKNOWN");
}

// ── real-time WS-стрим из clash-API ────────────────────────
function applyTrafficValues({ up, down }) {
  if (state !== "connected") return;
  qualityEngine.updatePassive({ down });
  // down/up — байт/сек; интегрируем в session-тоталы (тик ≈ 1с).
  sessionDownBytes += Math.max(0, down) || 0;
  sessionUpBytes += Math.max(0, up) || 0;
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

// Клик по ячейке «Пинг» = принудительный force-test задержки текущей ноды.
// При timeout/недоступности — показываем «Тайм-аут».
let manualTestInFlight = false;
telePing?.addEventListener("click", async () => {
  if (state !== "connected") return;
  if (manualTestInFlight) return;
  manualTestInFlight = true;
  telePing.dataset.testing = "true";
  if (statsPing) statsPing.textContent = "···";
  try {
    // Hiddify-style: клик = тест URLTest-ГРУППЫ (как urlTest("")), а не одиночный
    // /proxies/{name}/delay. Число читается из history эффективной ноды → совпадает
    // со списком нод. Подробности в refreshEffectiveDelay.
    const { delay } = await refreshEffectiveDelay({ timeoutMs: 5000 });
    applyPingDisplay(delay > 0 ? delay : 65000);
  } finally {
    delete telePing.dataset.testing;
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
  currentEffectiveTag = tag;
  updateHeroForActive();
  syncTrayMenu();
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

// DPI-обход переключили из UI → обновить статус/подпись в трее.
window.addEventListener("ninety:dpi-changed", () => syncTrayMenu());

// ── Трей — вынесен в /lib/tray.js; здесь только контекст main-состояния ──
// Объявлено заранее (до initTray и бутстрапа): getUpdateVersion читает
// pendingUpdate уже на старте — если оставить let в секции Auto-update ниже,
// первый syncTrayMenu падает в TDZ.
let pendingUpdate = null;
initTray({
  getState: () => state,
  getEffectiveTag: () => currentEffectiveTag,
  getUpdateVersion: () => pendingUpdate?.version || null,
  onSetMode: (m) => changeMode(m),
  onToggleVpn: () => heroDisc?.click(),
  onUpdateClick: () => flushPendingUpdate(),
  // Успешный выбор сервера из трея: обновить эффективную ноду + hero/локацию.
  onServerSelected: (tag, node) => {
    currentEffectiveTag = tag;
    if (node) { currentEffectiveNode = node; updateHeroForActive(); }
  },
});

heroDisc?.addEventListener("click", async () => {
  if (heroDisc.disabled) return;
  // Click ripple — расходится от центра диска (anim 520ms)
  const stage = heroDisc.closest(".hero__stage");
  if (stage) {
    const ripple = document.createElement("div");
    ripple.className = "hero__ripple";
    stage.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }
  // RECONNECT-режим: рестарт ядра с новыми опциями
  if (needsReconnect && (state === "connected" || state === "connecting")) {
    connectEpoch++; // инвалидировать возможный start_singbox в полёте
    await shutdownCore();
    needsReconnect = false;
    applyReconnectUI();
    // мгновенно стартуем заново
    setTimeout(() => heroDisc.click(), 60);
    return;
  }
  if (state === "idle") {
    const src = getActiveSource();
    if (!src) { toast(t("conn.needSource"), "error"); return; }
    const mode = getMode();
    // DNS-watchdog: имя сервера ноды резолвится через direct-DNS ДО туннеля —
    // если он мёртв (Google/Cloudflare DoH в РФ), старт падает с невнятным
    // «i/o timeout». Пробуем и при отказе переключаем на резерв ДО buildConfig,
    // чтобы конфиг собрался уже с рабочим резолвером. Только пока юзер не ушёл.
    await ensureWorkingDirectDns({ toast, onlyIf: () => state === "idle" });
    const options = loadOptions();
    // Если WARP включён — тянем регистрацию из app_config_dir/warp.json
    // и передаём в builder. Без warpInfo builder тихо пропустит warp endpoint.
    let warpInfo = null;
    if (options.warp?.enabled) {
      try { warpInfo = await invoke("warp_status"); } catch {}
      if (!warpInfo) {
        toast(t("conn.warpUnreg"), "error", 3500);
        return;
      }
    }
    // Порты loopback-мостов (xhttp/naive/TT): дефолтные базы 31100+ может
    // занять чужой процесс — Rust подбирает свободные диапазоны bind-пробой.
    // Ошибка планирования не блокирует старт: билдер упадёт на статические
    // дефолты, а занятый порт поймает fail-fast в start_singbox.
    let bridgePorts = null;
    const needs = bridgeNeeds(src.kind === "sub" ? src.nodes : [src.profile]);
    if (needs.xray || needs.naive || needs.trusttunnel) {
      try { bridgePorts = await invoke("plan_bridge_ports", { needs }); }
      catch (e) { console.warn("plan_bridge_ports failed", e); }
    }
    // Two-core: xhttp-ноды уходят в xray-мост (config.xray), в sing-box —
    // socks-перенаправление. xray=null когда xhttp в источнике нет.
    const { config, xray, sidecars } = buildConfig({ source: src, mode, options, warpInfo, xray: true, bridgePorts });
    const epoch = ++connectEpoch;
    setState("connecting");
    try {
      await invoke("start_singbox", {
        configJson: JSON.stringify(config),
        mode,
        xrayJson: xray ? JSON.stringify(xray) : null,
        // naive/trusttunnel клиенты (по одному на ноду); null когда таких нод нет.
        sidecarsJson: sidecars && sidecars.length ? JSON.stringify(sidecars) : null,
        // «Полностью отключить логи» → Rust не пишет файлы ни одного компонента.
        logsDisabled: !!options.log?.disabled,
      });
      // Пока ядро стартовало (settle-паузы мостов), юзер мог нажать «Отключить»:
      // тот клик застаёт child=None и глушить ему нечего. Ловим отмену по epoch
      // и гасим только что поднятое ядро — иначе UI мигал «отключено» и
      // возвращался в «Защищено».
      if (epoch !== connectEpoch) {
        try { await invoke("stop_singbox"); } catch {}
        try { await invoke("set_system_proxy", { enable: false }); } catch {}
        return;
      }
      // Системный прокси выставляем ТОЛЬКО для mode=systemProxy. Для голого
      // "proxy" юзер настраивает HTTP/SOCKS клиента сам, для "tun" уже идёт
      // полный intercept через TUN-интерфейс.
      if (mode === "systemProxy") {
        await invoke("set_system_proxy", { enable: true, hostPort: `127.0.0.1:${options.inbound.mixedPort || 7890}` });
      }
      setState("connected", { ping: null });
      const src0 = getActiveSource();
      const isMultiSub = src0?.kind === "sub" && Array.isArray(src0.nodes) && src0.nodes.length >= 2;
      // In-app тост сразу. Для подписки нода ещё не выбрана балансировщиком —
      // показываем имя подписки (не врём конкретным сервером), затем
      // notifyConnectedWithRealNode догонит тост фактическим сервером. Для
      // одиночного профиля сразу его имя.
      const initLabel = isMultiSub
        ? (src0.subscription?.name || t("conn.subFallback"))
        : nodeDisplayLabel(activeNodeForDisplay());
      toast(t("conn.protected"), "connected", 2200, {
        group: "conn",
        desc: initLabel || t("conn.tunnelUp"),
      });
      syncTrayMenu(); // трей → «Отключиться» (для sub ещё раз обновится после sync)
      // Effective node + OS-уведомление с именем фактического сервера (внутри
      // делает syncEffectiveFromClash → обновляет hero/локацию/трей).
      notifyConnectedWithRealNode(isMultiSub);
    } catch (e) {
      if (epoch !== connectEpoch) {
        // Юзер уже отменил подключение — состояние/тосты выставил его клик,
        // здесь только страховочный стоп без перетирания UI.
        try { await invoke("stop_singbox"); } catch {}
        return;
      }
      console.error("start failed", e);
      await shutdownCore();
      toast(t("conn.startFail"), "error", 4500, { desc: t("conn.startFailDesc") });
      switchView("logs");
    }
  } else if (state === "connecting" || state === "connected") {
    connectEpoch++; // отмена/дисконнект: инвалидировать возможный start в полёте
    await shutdownCore();
    toast(t("conn.disconnected"), "info", 2000, { group: "conn", desc: t("conn.disconnectedDesc") });
    notify(t("conn.notifyDisconnected"), t("conn.notifyDisconnectedBody"));
  }
});

// ── Bootstrap ──────────────────────────────────────────────
if (locPing) locPing.textContent = `— ${t("units.ms")}`;
refreshProfilesSummary();
updateHeroHint();
syncTrayMenu();

// Обновление подписок — через туннель, когда он поднят (mixed-in, в TUN —
// probe-in на том же порту): панель не видит реальный IP. Если через прокси
// не вышло, subscriptions.js повторяет напрямую.
setSubscriptionProxy(() =>
  state === "connected" ? `http://127.0.0.1:${loadOptions().inbound.mixedPort || 7890}` : null
);

// ── Бэкап состояния (localStorage → app_config_dir) ─────────
// Мутации бэкапятся точечно (backupSoon в refreshProfilesSummary/settings);
// периодический тик подстраховывает ключи, меняющиеся мимо этих точек
// (traffic-meter, обучение движка качества и т.п.).
setTimeout(backupNow, 15_000);
setInterval(backupNow, 10 * 60_000);

// При старте app — синхронизируем UI с реальным состоянием sing-box
(async () => {
  try {
    const running = await invoke("singbox_running");
    if (running) {
      setState("connected", { ping: null });
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

// Авто-запуск после bootstrap: при автостарте через Windows login
// (--autostarted) ИЛИ при перезапуске от админа (--elevated) поднимаем VPN с
// последним сервером И DPI-обход, если он был включён. Элевация — ОДНИМ
// перезапуском: TUN-режим и DPI требуют admin-прав; если процесс ещё не
// elevated и что-то из них нужно — тихо relaunch_elevated (перезапущенный
// --elevated процесс снова попадёт сюда уже с правами и поднимет всё без UAC).
// proxy/systemProxy прав не требуют, поэтому в не-TUN элевация только ради DPI.
(async () => {
  try {
    // После OTA-апдейта процесс перезапускается БЕЗ --autostarted/--elevated, и
    // should_autoconnect=false → блок бы не вошёл. update-modal перед установкой
    // пишет, что было поднято (ninety.update.resume = {vpn,dpi}) — по нему
    // возвращаем сессию. Легаси-ключ ninety.dpi.resumeAfterUpdate писали версии
    // ≤0.1.88 (только DPI); читаем ещё релиз-другой с прежней семантикой.
    const resume = (() => {
      try {
        const raw = localStorage.getItem("ninety.update.resume");
        if (raw) return JSON.parse(raw);
        return localStorage.getItem("ninety.dpi.resumeAfterUpdate") === "1"
          ? { vpn: true, dpi: true }
          : null;
      } catch { return null; }
    })();
    if (resume) {
      try {
        localStorage.removeItem("ninety.update.resume");
        localStorage.removeItem("ninety.dpi.resumeAfterUpdate");
      } catch {}
    }

    const autoconnect = await invoke("should_autoconnect");
    if (!autoconnect && !resume) return;
    // VPN возвращаем при автостарте всегда; после OTA — только если он был
    // поднят в момент установки (раньше юзер с выключенным DPI после апдейта
    // оставался отключённым, пока не нажмёт руками).
    const vpnWanted = autoconnect || !!resume?.vpn;

    const tunWanted = getMode() === "tun";
    // DPI нужен вне TUN, либо в TUN при split-Discord (winws десинхрит direct-Discord).
    const splitDiscord = tunWanted && !!loadOptions()?.route?.tunSplitDiscord;
    const dpiWanted = localStorage.getItem("ninety.dpi.enabled") === "true" && (!tunWanted || splitDiscord);
    // Элевация ради TUN — только если VPN реально будем поднимать.
    if (((tunWanted && vpnWanted) || dpiWanted) && !(await invoke("is_elevated"))) {
      if (tunWanted) setMode("tun"); // перезапущенный admin-инстанс поднимется в TUN
      const started = await invoke("relaunch_elevated");
      if (started) return; // текущий процесс вот-вот завершится
      // элевация не удалась — продолжаем тем, что доступно без прав (VPN proxy)
    }

    // VPN: не дёргаем, если ядро уже живо (перезапуск UI) или нет source.
    const running = await invoke("singbox_running");
    if (vpnWanted && !running && getActiveSource()) {
      await new Promise(r => setTimeout(r, 600)); // дать UI домонтироваться
      if (state === "idle" && !heroDisc.disabled) heroDisc.click();
    }
    // DPI: поднять движок, если был включён (мы здесь уже elevated либо UAC отклонён).
    if (dpiWanted) await autostartDpiIfEnabled();
  } catch (e) {
    console.warn("autostart failed", e);
  }
})();

// Синхронизация флага autostart с реальным состоянием Windows (задача
// Планировщика). Если юзер удалил задачу через Планировщик / Параметры —
// тут подтянем актуальное состояние в options.
(async () => {
  try {
    const enabled = await invoke("autostart_is_enabled");
    const opts = loadOptions();
    if (typeof enabled === "boolean" && opts.general?.autostart !== enabled) {
      updateOption("general.autostart", enabled);
    }
  } catch {}
})();

// ── Auto-update ────────────────────────────────────────────
// Обновление, найденное фоновой проверкой пока окно свёрнуто в трей, копится в
// pendingUpdate (объявлен выше, до syncTrayMenu). Окно модалкой не выдёргиваем —
// показываем когда юзер вернётся (фокус окна / клик по пункту трея).
let updateModalShowing = false;
// Идёт скачивание/установка апдейта (модалка) — health-watchdog молчит.
let updateInstalling = false;
// OS-уведомление об апдейте — один раз на версию за сессию: фоновые проверки
// повторяются, без дедупа юзер в трее ловил бы тост о той же версии каждый тик.
let lastNotifiedUpdateVersion = null;

// Окно «на виду»? (видимо и не свёрнуто). В трее hide() → isVisible()=false.
async function windowIsForeground() {
  if (!tauriWin) return true;
  try {
    const visible = await tauriWin.isVisible?.();
    if (visible === false) return false;
    const min = await tauriWin.isMinimized?.();
    return !min;
  } catch { return true; }
}

async function showUpdateModal(update, opts = {}) {
  updateModalShowing = true;
  try {
    await openUpdateModal(update, { ...opts, onInstalling: (v) => { updateInstalling = v; } });
  } finally {
    updateModalShowing = false;
    updateInstalling = false;
  }
}

// Показать отложенное обновление (юзер вернулся к окну). respectSkip=false —
// он сам открыл приложение, значит готов смотреть; «Позже» внутри модалки.
async function flushPendingUpdate() {
  if (!pendingUpdate || updateModalShowing) return;
  const u = pendingUpdate;
  pendingUpdate = null;
  syncTrayMenu(); // снять пункт «Обновить» из трея
  await showUpdateModal(u, { respectSkip: false });
}

// Прокси для проверки/скачивания апдейта: при поднятом VPN — свой локальный
// инбаунд (как рефреш подписок). Без него проверка ВСЕГДА идёт «напрямую»
// (reqwest не чтит системный прокси, в TUN трафик Ninety.exe уходит в direct
// bypass-правилом) — у части провайдеров эндпоинты так недоступны вовсе.
function updaterProxy() {
  return state === "connected" ? `http://127.0.0.1:${loadOptions().inbound.mixedPort || 7890}` : null;
}

// true — проверка ДОСТИГЛА сервера (апдейт есть или его нет); false — не смогли
// проверить (нет сети / эндпоинты недоступны) → скедулер уходит в бэкоф-ретрай.
async function runUpdateCheck({ silent = true } = {}) {
  if (!updaterAvailable()) {
    if (!silent) toast(t("update.unavailable"), "error", 2500);
    return false;
  }
  let update;
  try {
    const proxy = updaterProxy();
    try {
      update = await checkForUpdate({ proxy });
    } catch (e) {
      if (!proxy) throw e;
      // Туннель мог умереть в момент проверки — повтор напрямую.
      update = await checkForUpdate();
    }
  } catch (e) {
    console.warn("update check failed", e);
    if (!silent) toast(t("update.checkFailed"), "error", 4000);
    return false;
  }
  if (!update) {
    if (!silent) toast(t("update.none"), "info", 2400);
    return true;
  }
  // Юзер сам нажал «Проверить» → показываем модалку немедленно, skip игнорим.
  if (!silent) { await showUpdateModal(update, { respectSkip: false }); return true; }
  // Фоновая проверка: уважаем «Позже» по этой версии — не навязываемся.
  if (updateShouldSkip(update.version)) return true;
  // Окно на виду → обычная модалка. Свёрнуто в трей → не выдёргиваем: OS-
  // уведомление + пункт в трее, модалка откроется когда юзер вернётся.
  if (await windowIsForeground()) {
    await showUpdateModal(update, { respectSkip: true });
  } else {
    pendingUpdate = update;
    syncTrayMenu();
    if (lastNotifiedUpdateVersion !== update.version) {
      lastNotifiedUpdateVersion = update.version;
      notify(t("update.notifyTitle"),
        t("update.notifyBody", { version: update.version }));
    }
  }
  return true;
}

// ── Расписание проверок — по таймстампам, не по setInterval ──
// Прежний setInterval(6ч) ломался о два сценария: (1) автозапуск с Windows —
// первая проверка через 3с стабильно умирала об ещё не поднятую сеть, и до
// следующей было 6 часов тишины; (2) сон/гибернация — интервальный таймер не
// тикает во сне, реальный период уплывал далеко за 6ч. Теперь:
//   успех  → следующая через 2ч (проверка = один JSON ~1КБ, дёшево);
//   провал → бэкоф 30с → 2м → 5м → 15м (дальше по 15м) до первого успеха;
//   лёгкий тик раз в 60с сравнивает часы (переживает сон и троттлинг скрытого
//   окна — Chromium в трее коалесцирует таймеры как раз до 1/мин);
//   внеплановые триггеры: появилась сеть (online), развернули окно, поднялся
//   VPN (эндпоинты станут доступны через туннель). Всё это работает и в трее:
//   апдейт доедет OS-уведомлением + пунктом «Обновить до vX» в меню трея.
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const UPDATE_RETRY_STEPS_MS = [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];
const UPDATE_STALE_MS = 30 * 60_000; // «давно не проверялись» для focus/connect
let updateNextCheckAt = Date.now() + 3000; // первая — через 3с после старта
let updateLastSuccessAt = 0;
let updateRetryIdx = 0;
let updateCheckBusy = false;

function updateCheckSucceeded() {
  updateLastSuccessAt = Date.now();
  updateRetryIdx = 0;
  updateNextCheckAt = Date.now() + UPDATE_CHECK_INTERVAL_MS;
}

async function scheduledUpdateCheck() {
  // Модалка открыта — не дёргаем проверку под ней (и не сбиваем установку).
  if (updateCheckBusy || updateModalShowing) return;
  updateCheckBusy = true;
  try {
    if (await runUpdateCheck({ silent: true })) {
      updateCheckSucceeded();
    } else {
      const step = UPDATE_RETRY_STEPS_MS[Math.min(updateRetryIdx, UPDATE_RETRY_STEPS_MS.length - 1)];
      updateRetryIdx++;
      updateNextCheckAt = Date.now() + step;
    }
  } finally {
    updateCheckBusy = false;
  }
}

// Внеплановая проверка (фокус/online/connect) — только если давно не было
// успешной, чтобы каждый Alt-Tab/реконнект не дёргал эндпоинты.
function updateCheckIfStale(staleMs = UPDATE_STALE_MS) {
  if (Date.now() - updateLastSuccessAt >= staleMs) scheduledUpdateCheck();
}

setTimeout(scheduledUpdateCheck, 3000);
setInterval(() => { if (Date.now() >= updateNextCheckAt) scheduledUpdateCheck(); }, 60_000);

// Сеть появилась (Wi-Fi догнал после логина, вышли из самолётного режима).
window.addEventListener("online", () => updateCheckIfStale(60_000));

// Вернулись к окну (фокус из трея/таскбара) → показать отложенный апдейт;
// заодно дочекать, если с последней удачной проверки прошло полчаса.
(async () => {
  try {
    await tauriWin?.onFocusChanged?.(({ payload: focused }) => {
      if (!focused) return;
      flushPendingUpdate();
      updateCheckIfStale();
    });
  } catch (e) { console.warn("focus listener failed", e); }
})();

// Глобальная функция для кнопки «Проверить обновления» в settings
window.__ninetyUpdateCheck = async () => {
  if (await runUpdateCheck({ silent: false })) updateCheckSucceeded();
};

// ── Subscriptions auto-refresh ─────────────────────────────
// Тик каждые 30 минут (первый — через 60 сек, чтобы не тормозить старт), но
// каждая подписка обновляется по СВОЕМУ интервалу: profile-update-interval из
// заголовка панели, без заголовка — раз в 6 часов. Раньше заголовок сохранялся,
// но игнорировался — всё дёргалось каждые 30 минут. Ручное «Обновить все»
// по-прежнему обновляет немедленно. Ошибки не показываем — фоновая задача.
const SUBS_REFRESH_DEFAULT_HOURS = 6;
async function silentRefreshSubs() {
  const now = Date.now();
  let refreshed = 0;
  for (const s of loadSubscriptions()) {
    const hours = Number(s.updateIntervalHours) > 0
      ? Number(s.updateIntervalHours)
      : SUBS_REFRESH_DEFAULT_HOURS;
    if (s.lastUpdate && now - s.lastUpdate < hours * 3600_000) continue;
    try {
      await refreshSubscription(s.id);
      refreshed++;
    } catch (e) {
      console.warn("sub auto-refresh failed", s.id, e);
    }
  }
  if (refreshed) {
    refreshSubCardFromActive();
    refreshProfilesSummary();
  }
}
setTimeout(silentRefreshSubs, 60_000);
setInterval(silentRefreshSubs, 30 * 60_000);

// «Только что» / «N мин назад» обновляем каждые 30 сек
setInterval(refreshSubCardFromActive, 30_000);

// ── Deep links ──────────────────────────────────────────────
// Разбор форматов — в /lib/deeplink.js (чистая функция, покрыта тестами).
// Windows запускает Ninety с argv, single-instance plugin перехватывает и
// emit'ит onOpenUrl в первый процесс. Авто-импорта нет — юзер видит prefilled
// URL в add-modal и подтверждает (защита от malicious links).
function handleDeepLinkUrl(rawUrl) {
  try {
    const intent = parseDeepLink(rawUrl);
    if (intent) openAddModal({ prefillUrl: intent.url, prefillName: intent.name });
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
