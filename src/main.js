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
import { loadOptions } from "/lib/options.js";
import { mountSettings } from "/lib/settings-view.js";
import { isAvailable as updaterAvailable, checkForUpdate } from "/lib/updater.js";
import { openUpdateModal } from "/lib/update-modal.js";
import { mountAddModal, openAddModal } from "/lib/add-modal.js";
import { openEditSubscription, openEditProfile } from "/lib/edit-modal.js";
import { mountProxiesView, onProxiesViewEnter, onProxiesViewLeave } from "/lib/proxies-view.js";
import { startClashStream, stopClashStream, formatRate } from "/lib/clash-stream.js";
import { gradeDelay } from "/lib/clash-api.js";
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
async function fillAppVersion() {
  let v = "—";
  try {
    const app = window.__TAURI__?.app;
    if (app?.getVersion) v = await app.getVersion();
  } catch {}
  const sidebar = document.getElementById("sidebar-version");
  if (sidebar) sidebar.textContent = `${v} · 190X4`;
  // settings версия — после первого рендера settings
  const apply = () => {
    const el = document.getElementById("settings-version");
    if (el) el.textContent = v;
  };
  apply();
  // MutationObserver — пересоздание DOM при навигации
  const settingsRoot = document.getElementById("settings-root");
  if (settingsRoot) {
    new MutationObserver(apply).observe(settingsRoot, { childList: true, subtree: true });
  }
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
    onChange: () => {
      if (state === "connected" || state === "connecting") {
        needsReconnect = true;
        applyReconnectUI();
        toast("Изменились настройки — нажмите RECONNECT для применения", "info", 2800);
      }
      if (state === "idle") updateHeroHint();
    },
  });
}

function applyReconnectUI() {
  if (!hero) return;
  if (needsReconnect && (state === "connected" || state === "connecting")) {
    hero.classList.add("hero--reconnect");
    if (heroLabel) heroLabel.textContent = "RECONNECT";
    if (heroHint) heroHint.textContent = "Настройки изменились — переподключитесь";
  } else {
    hero.classList.remove("hero--reconnect");
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
        if (sub?.url) {
          try { await navigator.clipboard.writeText(sub.url); toast("URL скопирован", "success", 1400); }
          catch { toast("Не удалось скопировать", "error", 1800); }
        }
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
const heroMeta = document.getElementById("hero-meta");
const heroMetaValue = document.getElementById("hero-meta-value");
const heroTraffic = document.getElementById("hero-traffic");
const heroRx = document.getElementById("hero-rx");
const heroTx = document.getElementById("hero-tx");
const tfDown = document.getElementById("tf-down");
const tfUp = document.getElementById("tf-up");
const tfDownUnit = document.getElementById("tf-down-unit");
const tfUpUnit = document.getElementById("tf-up-unit");
const heroRxUnit = document.getElementById("hero-rx-unit");
const heroTxUnit = document.getElementById("hero-tx-unit");
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

function showMeta(show) {
  if (show) heroMeta.removeAttribute("hidden");
  else heroMeta.setAttribute("hidden", "");
}

function showTraffic(show) {
  if (!heroTraffic) return;
  if (show) heroTraffic.removeAttribute("hidden");
  else heroTraffic.setAttribute("hidden", "");
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

function updateHeroForActive() {
  const src = getActiveSource();
  const p = src?.kind === "sub" ? src.nodes[0] : src?.profile;
  if (locName) {
    if (src?.kind === "sub") {
      locName.textContent = `${src.subscription.name} · ${p?.name || p?.host || "—"}`;
    } else if (p) {
      locName.textContent = p.name || p.host;
    }
  }
  if (locProto && p) {
    const parts = ["VLESS"];
    if (p.security && p.security !== "none") parts.push(p.security);
    if (p.type) parts.push(p.type.toUpperCase());
    locProto.textContent = parts.join(" · ");
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
    applyReconnectUI();
    setHeroClass(null);
    heroLabel.textContent = "Не подключено";
    showMeta(false);
    showTraffic(false);
    heroDisc.setAttribute("aria-label", "Подключиться");
    tfDown.textContent = "0";
    tfUp.textContent = "0";
    if (heroRx) heroRx.textContent = "0";
    if (heroTx) heroTx.textContent = "0";
    if (tfDownUnit) tfDownUnit.textContent = "КиБ/с";
    if (tfUpUnit) tfUpUnit.textContent = "КиБ/с";
    if (heroRxUnit) heroRxUnit.textContent = "КиБ/с";
    if (heroTxUnit) heroTxUnit.textContent = "КиБ/с";
    if (heroMask) heroMask.playbackRate = 0.6;
    stopClashStream();
    if (publicIpTimer) { clearInterval(publicIpTimer); publicIpTimer = null; }
    lastPublicIp = null;
    if (locIpRow) locIpRow.hidden = true;
    updateHeroHint();
  } else if (next === "connecting") {
    setHeroClass("hero--connecting");
    heroLabel.textContent = "Подключаюсь…";
    const src = getActiveSource();
    const p = src?.kind === "sub" ? src.nodes[0] : src?.profile;
    heroHint.textContent = p ? `Поднимаю туннель через ${p.host}` : "Поднимаю туннель…";
    showMeta(false);
    showTraffic(false);
    heroDisc.setAttribute("aria-label", "Отменить подключение");
    if (heroMask) heroMask.playbackRate = 1.6;
  } else if (next === "connected") {
    setHeroClass("hero--connected");
    heroLabel.textContent = "Подключено";
    const src = getActiveSource();
    const p = src?.kind === "sub" ? src.nodes[0] : src?.profile;
    const mode = getMode() === "tun" ? "TUN-туннель" : "системный прокси";
    heroHint.textContent = p ? `Трафик идёт через ${p.host} · ${mode}` : `Трафик идёт через ${mode}`;
    heroMetaValue.textContent = opts.ping ?? "— мс";
    showMeta(true);
    showTraffic(true);
    heroDisc.setAttribute("aria-label", "Отключиться");
    if (heroMask) heroMask.playbackRate = 1.0;
    startTrafficStream();
  }
}

// ── real-time WS-стрим из clash-API ────────────────────────
function applyTrafficValues({ up, down }) {
  if (state !== "connected") return;
  const d = formatRate(down);
  const u = formatRate(up);
  if (tfDown) tfDown.textContent = d.value;
  if (tfUp) tfUp.textContent = u.value;
  if (heroRx) heroRx.textContent = d.value;
  if (heroTx) heroTx.textContent = u.value;
  if (tfDownUnit) tfDownUnit.textContent = d.unit;
  if (tfUpUnit) tfUpUnit.textContent = u.unit;
  if (heroRxUnit) heroRxUnit.textContent = d.unit;
  if (heroTxUnit) heroTxUnit.textContent = u.unit;
}

function applyPingValue({ delay }) {
  if (state !== "connected") return;
  if (delay > 0 && delay < 65000) {
    const text = `${delay} мс`;
    if (locPing) locPing.textContent = text;
    if (heroMetaValue) heroMetaValue.textContent = text;
    if (locPingDot) locPingDot.dataset.state = gradeDelay(delay) === "bad" ? "warn" : "online";
  } else {
    if (locPing) locPing.textContent = "— мс";
    if (heroMetaValue) heroMetaValue.textContent = "— мс";
    if (locPingDot) locPingDot.dataset.state = "offline";
  }
}

async function startTrafficStream() {
  try {
    await startClashStream({
      onTraffic: applyTrafficValues,
      onPing: applyPingValue,
    });
  } catch (e) {
    console.warn("startClashStream failed", e);
  }
  // Публичный IP — отложенно (sing-box секунду стартует), потом раз в 5 мин
  setTimeout(refreshPublicIp, 2500);
  if (publicIpTimer) clearInterval(publicIpTimer);
  publicIpTimer = setInterval(refreshPublicIp, 5 * 60_000);
}

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
    const config = buildConfig({ source: src, mode, options });
    setState("connecting");
    try {
      await invoke("start_singbox", { configJson: JSON.stringify(config), mode });
      if (mode === "proxy") {
        await invoke("set_system_proxy", { enable: true, hostPort: `127.0.0.1:${options.inbound.mixedPort || 7890}` });
      }
      setState("connected", { ping: "— мс" });
      toast("Подключено", "success", 1600);
      const src2 = getActiveSource();
      const p2 = src2?.kind === "sub" ? src2.nodes[0] : src2?.profile;
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
