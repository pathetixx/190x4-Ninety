import { startMesh } from "/lib/mesh-background.js";

const win = window.__TAURI__?.window?.getCurrentWindow?.();

// ── Mesh-фон ────────────────────────────────────────────────
const canvas = document.getElementById("mesh-bg");
if (canvas) startMesh(canvas);

// ── Titlebar ────────────────────────────────────────────────
document.querySelectorAll("[data-window-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!win) return;
    const action = btn.dataset.windowAction;
    if (action === "minimize") await win.minimize();
    else if (action === "maximize") await win.toggleMaximize();
    else if (action === "close") await win.close();
  });
});

// ── Навигация ───────────────────────────────────────────────
const navItems = document.querySelectorAll(".menu__item[data-view]");
const views = document.querySelectorAll("section.view[data-view]");

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const target = item.dataset.view;
    navItems.forEach((n) => n.classList.toggle("menu__item--active", n === item));
    views.forEach((v) => { v.hidden = v.dataset.view !== target; });
  });
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
