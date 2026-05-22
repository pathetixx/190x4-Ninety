import { startMesh } from "/lib/mesh-background.js";
import {
  parseVless,
  buildConfig,
  loadProfiles,
  saveProfiles,
  getActiveProfile,
  getActiveProfileId,
  setActiveProfileId,
  addProfileFromVless,
  removeProfile,
  getMode,
  setMode,
} from "/lib/singbox.js";
import { loadOptions } from "/lib/options.js";
import { mountSettings } from "/lib/settings-view.js";

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
  add:  { btn: document.getElementById("add-sub"),     el: document.getElementById("add-popover") },
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

// ── Add-popover ─────────────────────────────────────────────
const addPopover = document.getElementById("add-popover");
const addManual = document.getElementById("add-manual");
const addInput = document.getElementById("add-input");
const addError = document.getElementById("add-error");
const addSubmit = document.getElementById("add-submit");
const profilesSummary = document.getElementById("profiles-summary");

function refreshProfilesSummary() {
  const list = loadProfiles();
  const active = getActiveProfile();
  if (!profilesSummary) return;
  if (list.length === 0) {
    profilesSummary.textContent = "Профилей нет — добавьте vless:// конфиг.";
  } else {
    const n = list.length;
    profilesSummary.textContent = `Активный: ${active?.name || "—"} (${n} ${plural(n, ["профиль", "профиля", "профилей"])})`;
  }
  renderProfilesView();
  updateHeroForActive();
}

function plural(n, forms) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

async function importFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) {
      addManual.hidden = false;
      addInput.focus();
      setAddError("Буфер пуст. Вставьте vless:// вручную.");
      return;
    }
    tryImport(text);
  } catch (e) {
    addManual.hidden = false;
    addInput.value = "";
    addInput.focus();
    setAddError("Нет доступа к буферу — вставьте вручную.");
  }
}

function tryImport(raw) {
  try {
    const { profile } = addProfileFromVless(raw);
    setAddError("");
    addInput.value = "";
    addManual.hidden = true;
    closeAllPopovers();
    refreshProfilesSummary();
    toast(`Профиль "${profile.name}" импортирован`, "success");
  } catch (e) {
    addManual.hidden = false;
    setAddError(e?.message || "Не удалось распарсить vless://");
    if (!addInput.value) addInput.value = raw;
    addInput.focus();
  }
}

function setAddError(msg) {
  if (addError) addError.textContent = msg || "";
}

addPopover?.addEventListener("click", (e) => {
  const tile = e.target.closest(".add-tile");
  if (!tile) return;
  const action = tile.dataset.action;
  if (action === "clipboard") {
    importFromClipboard();
  } else if (action === "manual") {
    addManual.hidden = false;
    setAddError("");
    addInput.focus();
  }
});

addSubmit?.addEventListener("click", () => {
  const raw = addInput.value.trim();
  if (!raw) {
    setAddError("Введите vless://... строку");
    return;
  }
  tryImport(raw);
});

addInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    addSubmit?.click();
  }
});

// ── Навигация ───────────────────────────────────────────────
const navItems = document.querySelectorAll(".menu__item[data-view]");
const views = document.querySelectorAll("section.view[data-view]");

function switchView(target) {
  navItems.forEach((n) => n.classList.toggle("menu__item--active", n.dataset.view === target));
  views.forEach((v) => { v.hidden = v.dataset.view !== target; });
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

// ── Profiles view ──────────────────────────────────────────
const profilesView = document.querySelector('section.view[data-view="profiles"]');
function renderProfilesView() {
  if (!profilesView) return;
  const list = loadProfiles();
  const activeId = getActiveProfileId();
  if (list.length === 0) {
    profilesView.innerHTML = `
      <div class="placeholder">
        <h2>Профили</h2>
        <p>Добавьте vless:// через кнопку «+» наверху главного экрана.</p>
      </div>
    `;
    return;
  }
  const items = list.map(p => {
    const isActive = p.id === activeId;
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
      <h2 class="profiles-list__title">Профили</h2>
      ${items}
    </div>
  `;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

profilesView?.addEventListener("click", (e) => {
  const card = e.target.closest(".profile-card");
  if (!card) return;
  const id = card.dataset.id;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "activate") {
    setActiveProfileId(id);
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
  const p = getActiveProfile();
  if (!p) {
    heroHint.textContent = "Импортируйте vless:// через кнопку «+»";
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
  const p = getActiveProfile();
  if (locName && p) locName.textContent = p.name || p.host;
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
    const p = getActiveProfile();
    heroHint.textContent = p ? `Поднимаю туннель через ${p.host}` : "Поднимаю туннель…";
    showMeta(false);
    showTraffic(false);
    heroDisc.setAttribute("aria-label", "Отменить подключение");
    if (heroMask) heroMask.playbackRate = 1.6;
  } else if (next === "connected") {
    setHeroClass("hero--connected");
    heroLabel.textContent = "Подключено";
    const p = getActiveProfile();
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
    const p = getActiveProfile();
    if (!p) { toast("Сначала импортируйте vless://", "error"); return; }
    const mode = getMode();
    const options = loadOptions();
    const config = buildConfig({ profile: p, mode, options });
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
      toast(`Не удалось запустить: ${e?.message || e}`, "error", 5000);
      try { await invoke("stop_singbox"); } catch {}
      try { await invoke("set_system_proxy", { enable: false }); } catch {}
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
