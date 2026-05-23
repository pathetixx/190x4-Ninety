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
}

navItems.forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

document.getElementById("location-card")?.addEventListener("click", (e) => {
  if (e.target.closest(".hero__disc")) return;
  switchView("profiles");
});

// ── Settings view ──────────────────────────────────────────
const settingsRoot = document.getElementById("settings-root");
let settingsCtl = null;
if (settingsRoot) {
  settingsCtl = mountSettings(settingsRoot, {
    onChange: () => {
      if (state === "connected" || state === "connecting") {
        toast("Изменения применятся при следующем подключении", "info", 2400);
      }
      if (state === "idle") updateHeroHint();
    },
  });
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

function renderProfilesView() {
  if (!profilesView) return;
  const profilesList = loadProfiles();
  const subsList = loadSubscriptions();
  const activeProfileId = getActiveProfileId();
  const activeKind = getActiveKind();
  const activeSubId = getActiveSubscriptionId();

  if (profilesList.length === 0 && subsList.length === 0) {
    profilesView.innerHTML = `
      <div class="placeholder">
        <h2>Профили</h2>
        <p>Добавьте конфиг или подписку через кнопку «+» наверху главного экрана.</p>
      </div>
    `;
    return;
  }

  const subItems = subsList.map(s => {
    const isActive = activeKind === "sub" && s.id === activeSubId;
    const days = subscriptionDaysLeft(s);
    const meta = [
      `${s.profiles?.length || 0} нод`,
      days != null ? `${days} дн` : null,
      s.total != null ? `${formatGiB(subscriptionUsedBytes(s))}/${formatGiB(s.total)} ГБ` : null,
      `обн. ${relativeTime(s.lastUpdate)}`,
    ].filter(Boolean).join(" · ");
    return `
      <div class="profile-card${isActive ? " profile-card--active" : ""}" data-sub-id="${s.id}">
        <div class="profile-card__main">
          <div class="profile-card__name">${escapeHtml(s.name)} <span class="profile-card__tag">SUB</span></div>
          <div class="profile-card__meta">${escapeHtml(meta)}</div>
        </div>
        <div class="profile-card__actions">
          ${isActive
            ? `<span class="profile-card__badge">Активна</span>`
            : `<button class="profile-card__btn" data-sub-act="activate" type="button">Выбрать</button>`}
          <button class="profile-card__btn" data-sub-act="refresh" type="button">Обновить</button>
          <button class="profile-card__btn profile-card__btn--danger" data-sub-act="remove" type="button">Удалить</button>
        </div>
      </div>
    `;
  }).join("");

  const profileItems = profilesList.map(p => {
    const isActive = activeKind === "single" && p.id === activeProfileId;
    return `
      <div class="profile-card${isActive ? " profile-card--active" : ""}" data-id="${p.id}">
        <div class="profile-card__main">
          <div class="profile-card__name">${escapeHtml(p.name)}</div>
          <div class="profile-card__meta">${escapeHtml(p.host)}:${p.port} · ${escapeHtml(p.security)} · ${escapeHtml(p.type)}</div>
        </div>
        <div class="profile-card__actions">
          ${isActive
            ? `<span class="profile-card__badge">Активен</span>`
            : `<button class="profile-card__btn" data-act="activate" type="button">Выбрать</button>`}
          <button class="profile-card__btn profile-card__btn--danger" data-act="remove" type="button">Удалить</button>
        </div>
      </div>
    `;
  }).join("");

  profilesView.innerHTML = `
    <div class="profiles-list">
      ${subsList.length ? `<h2 class="profiles-list__title">Подписки</h2>${subItems}` : ""}
      ${profilesList.length ? `<h2 class="profiles-list__title">Конфиги</h2>${profileItems}` : ""}
    </div>
  `;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

profilesView?.addEventListener("click", async (e) => {
  const subCard = e.target.closest(".profile-card[data-sub-id]");
  if (subCard) {
    const id = subCard.dataset.subId;
    const act = e.target.closest("[data-sub-act]")?.dataset.subAct;
    if (!act) return;
    if (act === "activate") {
      setActiveKind("sub");
      setActiveSubscriptionId(id);
      refreshProfilesSummary();
      toast("Подписка активирована", "success", 1800);
    } else if (act === "refresh") {
      const btn = e.target.closest("button");
      if (btn) { btn.disabled = true; btn.textContent = "…"; }
      try {
        const r = await refreshSubscription(id);
        toast(`Обновлено: ${r.profiles.length} нод`, "success", 1800);
        refreshProfilesSummary();
      } catch (err) {
        toast(`Ошибка: ${err?.message || err}`, "error", 2800);
      } finally {
        renderProfilesView();
      }
    } else if (act === "remove") {
      removeSubscription(id);
      if (getActiveKind() === "sub" && !getActiveSubscriptionId()) {
        setActiveKind("single");
      }
      refreshProfilesSummary();
      toast("Подписка удалена", "info", 1800);
    }
    return;
  }

  const card = e.target.closest(".profile-card");
  if (!card) return;
  const id = card.dataset.id;
  const act = e.target.closest("[data-act]")?.dataset.act;
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
const locPing = document.getElementById("loc-ping");
const locName = document.querySelector(".location-card__name");
const locProto = document.querySelector(".location-card__proto");

if (heroMask) heroMask.playbackRate = 0.6;

let state = "idle";
let trafficTimer = null;
let pingTimer = null;

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

  if (next === "idle") {
    setHeroClass(null);
    heroLabel.textContent = "Не подключено";
    showMeta(false);
    showTraffic(false);
    heroDisc.setAttribute("aria-label", "Подключиться");
    tfDown.textContent = "0";
    tfUp.textContent = "0";
    if (heroRx) heroRx.textContent = "0";
    if (heroTx) heroTx.textContent = "0";
    if (heroMask) heroMask.playbackRate = 0.6;
    clearInterval(trafficTimer);
    clearInterval(pingTimer);
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
    startTrafficSim();
    startPingSim();
  }
}

heroDisc?.addEventListener("click", async () => {
  if (heroDisc.disabled) return;
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
      setState("connected", { ping: `${28 + Math.floor(Math.random() * 28)} мс` });
      toast("Подключено", "success", 1600);
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
  }
});

function startTrafficSim() {
  clearInterval(trafficTimer);
  trafficTimer = setInterval(() => {
    if (state !== "connected") return;
    const down = (Math.random() * 900 + 100).toFixed(0);
    const up = (Math.random() * 200 + 20).toFixed(0);
    tfDown.textContent = down;
    tfUp.textContent = up;
    if (heroRx) heroRx.textContent = down;
    if (heroTx) heroTx.textContent = up;
  }, 850);
}

function startPingSim() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    const next = 26 + Math.floor(Math.random() * 28);
    heroMetaValue.textContent = `${next} мс`;
  }, 3500);
}

// ── Bootstrap ──────────────────────────────────────────────
if (locPing) locPing.textContent = `${24 + Math.floor(Math.random() * 12)} мс`;
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
