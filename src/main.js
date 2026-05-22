import { startMesh } from "/lib/mesh-background.js";

// ── Tauri 2 с withGlobalTauri:true даёт нам window.__TAURI__.window ──
const tauriWin = window.__TAURI__?.window?.getCurrentWindow?.()
  ?? window.__TAURI__?.window?.getCurrent?.();

// ── Mesh-фон ────────────────────────────────────────────────
const canvas = document.getElementById("mesh-bg");
if (canvas) startMesh(canvas);

// ── Titlebar ────────────────────────────────────────────────
document.querySelectorAll("[data-window-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!tauriWin) {
      console.warn("Tauri window API недоступен");
      return;
    }
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

// ── Popovers (mode-toggle + add-subscription) ───────────────
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
  // привязка к правому краю — popover тянется влево от кнопки
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

// ── Mode segmented ──────────────────────────────────────────
const modeSeg = document.getElementById("mode-seg");
modeSeg?.addEventListener("click", (e) => {
  const b = e.target.closest(".seg__btn");
  if (!b) return;
  modeSeg.querySelectorAll(".seg__btn").forEach((x) => {
    x.classList.toggle("seg__btn--active", x === b);
    x.setAttribute("aria-selected", x === b ? "true" : "false");
  });
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
  // клик по location-card → переход в Профили
  if (e.target.closest(".hero__disc")) return;
  switchView("profiles");
});

// ── HERO ───────────────────────────────────────────────────
const hero = document.getElementById("hero");
const heroDisc = document.getElementById("hero-disc");
const heroLabel = document.getElementById("hero-label");
const heroHint = document.getElementById("hero-hint");
const heroMeta = document.getElementById("hero-meta");
const heroMetaValue = document.getElementById("hero-meta-value");
const tfDown = document.getElementById("tf-down");
const tfUp = document.getElementById("tf-up");

let state = "idle";
let connectingTimer = null;
let pingTimer = null;
let trafficTimer = null;

function setHeroClass(cls) {
  hero.classList.remove("hero--connecting", "hero--connected");
  if (cls) hero.classList.add(cls);
}

function showMeta(show) {
  if (show) heroMeta.removeAttribute("hidden");
  else heroMeta.setAttribute("hidden", "");
}

function setState(next, opts = {}) {
  state = next;

  if (next === "idle") {
    setHeroClass(null);
    heroLabel.textContent = "Не подключено";
    heroHint.textContent = "Нажмите, чтобы запустить туннель";
    showMeta(false);
    heroDisc.setAttribute("aria-label", "Подключиться");
    tfDown.textContent = "0";
    tfUp.textContent = "0";
    clearInterval(pingTimer);
    clearInterval(trafficTimer);
  } else if (next === "connecting") {
    setHeroClass("hero--connecting");
    heroLabel.textContent = "Подключаюсь…";
    heroHint.textContent = "Поднимаю туннель через pl.190x4.pw";
    showMeta(false);
    heroDisc.setAttribute("aria-label", "Отменить подключение");
  } else if (next === "connected") {
    setHeroClass("hero--connected");
    heroLabel.textContent = "Подключено";
    heroHint.textContent = "Трафик идёт через pl.190x4.pw";
    heroMetaValue.textContent = opts.ping ?? "— мс";
    showMeta(true);
    heroDisc.setAttribute("aria-label", "Отключиться");
    startPingPolling();
    startTrafficPolling();
  }
}

heroDisc?.addEventListener("click", () => {
  if (state === "idle") {
    setState("connecting");
    connectingTimer = setTimeout(() => {
      setState("connected", { ping: `${28 + Math.floor(Math.random() * 28)} мс` });
    }, 1300);
  } else if (state === "connecting") {
    clearTimeout(connectingTimer);
    setState("idle");
  } else if (state === "connected") {
    setState("idle");
  }
});

function startPingPolling() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    const next = 26 + Math.floor(Math.random() * 28);
    heroMetaValue.textContent = `${next} мс`;
  }, 3500);
}

function startTrafficPolling() {
  clearInterval(trafficTimer);
  trafficTimer = setInterval(() => {
    if (state !== "connected") return;
    tfDown.textContent = (Math.random() * 900 + 100).toFixed(0);
    tfUp.textContent = (Math.random() * 200 + 20).toFixed(0);
  }, 850);
}

// ── Sub-card ping (placeholder) ─────────────────────────────
const subPing = document.getElementById("sub-ping");
if (subPing) subPing.textContent = `${24 + Math.floor(Math.random() * 12)} мс`;
