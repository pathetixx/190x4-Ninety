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

// ── Навигация по разделам ──────────────────────────────────
const navItems = document.querySelectorAll(".menu__item[data-view]");
const views = document.querySelectorAll("section.view[data-view]");

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const target = item.dataset.view;
    navItems.forEach((n) => n.classList.toggle("menu__item--active", n === item));
    views.forEach((v) => { v.hidden = v.dataset.view !== target; });
  });
});

// ── HERO-диск: состояния подключения ───────────────────────
const hero = document.getElementById("hero");
const heroDisc = document.getElementById("hero-disc");
const heroLabel = document.getElementById("hero-label");
const heroHint = document.getElementById("hero-hint");
const heroMeta = document.getElementById("hero-meta");
const heroMetaValue = document.getElementById("hero-meta-value");

let state = "idle";          // idle | connecting | connected
let connectingTimer = null;
let pingTimer = null;

function setHeroClass(cls) {
  hero.classList.remove("hero--connecting", "hero--connected");
  if (cls) hero.classList.add(cls);
}

function setState(next, opts = {}) {
  state = next;

  if (next === "idle") {
    setHeroClass(null);
    heroLabel.textContent = "Не подключено";
    heroHint.textContent = "Нажмите, чтобы запустить туннель";
    heroMeta.hidden = true;
    heroDisc.setAttribute("aria-label", "Подключиться");
  } else if (next === "connecting") {
    setHeroClass("hero--connecting");
    heroLabel.textContent = "Подключаюсь…";
    heroHint.textContent = "Поднимаю туннель через pl.190x4.pw";
    heroMeta.hidden = true;
    heroDisc.setAttribute("aria-label", "Отменить подключение");
  } else if (next === "connected") {
    setHeroClass("hero--connected");
    heroLabel.textContent = "Подключено";
    heroHint.textContent = opts.hint ?? "Трафик идёт через pl.190x4.pw";
    heroMetaValue.textContent = opts.ping ?? "— мс";
    heroMeta.hidden = false;
    heroDisc.setAttribute("aria-label", "Отключиться");
  }
}

heroDisc?.addEventListener("click", () => {
  if (state === "idle") {
    setState("connecting");
    // TODO: invoke('singbox_start', { profileId }) — следующая итерация
    connectingTimer = setTimeout(() => {
      setState("connected", { ping: `${28 + Math.floor(Math.random() * 30)} мс` });
      startPingPolling();
    }, 1200);
  } else if (state === "connecting") {
    clearTimeout(connectingTimer);
    setState("idle");
  } else if (state === "connected") {
    clearInterval(pingTimer);
    setState("idle");
  }
});

function startPingPolling() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    const next = 28 + Math.floor(Math.random() * 28);
    heroMetaValue.textContent = `${next} мс`;
  }, 3500);
}

// ── Sub-card ping (placeholder, в реале: TCP probe профиля) ──
const subPing = document.getElementById("sub-ping");
if (subPing) subPing.textContent = `${24 + Math.floor(Math.random() * 18)} мс`;

// ── Traffic footer demo update ─────────────────────────────
// (заглушка — следующая итерация подключит clash-api sing-box)
setInterval(() => {
  if (state !== "connected") return;
  const d = (Math.random() * 900 + 100).toFixed(0);
  const u = (Math.random() * 200 + 20).toFixed(0);
  document.getElementById("tf-down").textContent = d;
  document.getElementById("tf-up").textContent = u;
}, 800);
