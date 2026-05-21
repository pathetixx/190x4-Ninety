import { startMesh } from "/lib/mesh-background.js";

const win = window.__TAURI__?.window?.getCurrentWindow?.();

// ── Mesh-фон ────────────────────────────────────────────────
const canvas = document.getElementById("mesh-bg");
if (canvas) startMesh(canvas);

// ── Кастомный titlebar ──────────────────────────────────────
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
const navItems = document.querySelectorAll(".nav-item[data-view]");
const views = document.querySelectorAll("section.view[data-view]");

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const target = item.dataset.view;
    navItems.forEach((n) => n.classList.toggle("nav-item--active", n === item));
    views.forEach((v) => {
      v.hidden = v.dataset.view !== target;
    });
  });
});

// ── Connect-кнопка (заглушка состояния — backend подключим следующей итерацией) ──
const core = document.querySelector(".connect-core");
const coreBtn = document.getElementById("core-btn");
const coreLabel = document.getElementById("core-state-label");
const coreHint = document.getElementById("core-state-hint");

let state = "idle"; // idle | connecting | connected

function setState(next) {
  state = next;
  core.dataset.state = next === "connected" ? "connected" : "";
  if (next === "idle") {
    coreLabel.textContent = "CONNECT";
    coreHint.textContent = "Tap to start";
  } else if (next === "connecting") {
    coreLabel.textContent = "CONNECTING";
    coreHint.textContent = "Поднимаю туннель…";
  } else if (next === "connected") {
    coreLabel.textContent = "CONNECTED";
    coreHint.textContent = "Трафик идёт через pl.190x4.pw";
  }
}

coreBtn?.addEventListener("click", async () => {
  if (state === "idle") {
    setState("connecting");
    // TODO: invoke('singbox_start', { profileId })
    setTimeout(() => setState("connected"), 700);
  } else if (state === "connected") {
    // TODO: invoke('singbox_stop')
    setState("idle");
  }
});

// ── Переключатель режима ───────────────────────────────────
document.querySelectorAll(".mode-switch__item").forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".mode-switch__item")
      .forEach((m) => m.classList.toggle("mode-switch__item--active", m === item));
    // TODO: persist + apply on next connect
  });
});
