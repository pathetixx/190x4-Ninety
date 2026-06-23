// Ninety · Edit Modal — переименование, авто-обновление, интервал
// Используется и для подписок (полная форма), и для одиночных профилей (только rename).

import { updateSubscription } from "/lib/subscriptions.js";
import { updateProfile } from "/lib/singbox.js";
import { escapeHtml } from "/lib/esc.js";

function intervalLabel(h) {
  const n = Number(h) || 0;
  if (n === 0) return "Не обновлять";
  if (n < 24) return `Каждые ${n} ч`;
  const d = Math.floor(n / 24);
  const r = n % 24;
  return r === 0 ? `Каждые ${d} д` : `Каждые ${d} д ${r} ч`;
}

let cleanup = null;

function close() {
  document.querySelectorAll(".edit-modal").forEach(el => el.remove());
  if (cleanup) { cleanup(); cleanup = null; }
}

function onKey(e) {
  if (e.key === "Escape") close();
}

function build({ title, fields, onSave }) {
  close();
  const root = document.createElement("div");
  root.className = "edit-modal";
  root.innerHTML = `
    <div class="edit-modal__backdrop"></div>
    <div class="edit-modal__panel" role="dialog" aria-modal="true">
      <header class="edit-modal__head">
        <h3 class="edit-modal__title">${escapeHtml(title)}</h3>
        <button class="edit-modal__close" type="button" aria-label="Закрыть">✕</button>
      </header>
      <div class="edit-modal__body">${fields}</div>
      <footer class="edit-modal__foot">
        <button class="edit-modal__cancel" type="button">Отмена</button>
        <button class="edit-modal__save" type="button">Сохранить</button>
      </footer>
    </div>
  `;
  document.body.appendChild(root);

  root.querySelector(".edit-modal__backdrop").addEventListener("click", close);
  root.querySelector(".edit-modal__close").addEventListener("click", close);
  root.querySelector(".edit-modal__cancel").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  cleanup = () => document.removeEventListener("keydown", onKey);

  const saveBtn = root.querySelector(".edit-modal__save");
  saveBtn.addEventListener("click", async () => {
    try { await onSave(root); close(); } catch (e) {
      console.error("edit save failed", e);
    }
  });

  // Enter в input → save
  root.querySelectorAll("input[type=text]").forEach(inp => {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
    });
  });

  // Auto-focus первое поле
  const first = root.querySelector("input[type=text], input[type=range]");
  if (first) setTimeout(() => first.focus(), 30);
  return root;
}

export function openEditProfile(profile, { onSaved, onToast } = {}) {
  const fields = `
    <label class="edit-modal__field">
      <span class="edit-modal__label">Имя</span>
      <input type="text" id="edit-name" value="${escapeHtml(profile.name || "")}" maxlength="80" autocomplete="off">
    </label>
    <div class="edit-modal__hint">${escapeHtml(`${profile.host}:${profile.port} · ${(profile.proto || "vless").toUpperCase()}`)}</div>
  `;
  build({
    title: "Редактировать конфиг",
    fields,
    onSave: (root) => {
      const name = root.querySelector("#edit-name").value.trim() || profile.name;
      updateProfile(profile.id, { name });
      onToast?.("Сохранено", "success", 1400);
      onSaved?.();
    },
  });
}

export function openEditSubscription(sub, { onSaved, onToast } = {}) {
  const interval = sub.updateIntervalHours ?? 24;
  const autoUpdate = sub.autoUpdate !== false; // default true
  const fields = `
    <label class="edit-modal__field">
      <span class="edit-modal__label">Имя</span>
      <input type="text" id="edit-name" value="${escapeHtml(sub.name || "")}" maxlength="80" autocomplete="off">
    </label>
    <div class="edit-modal__row">
      <span class="edit-modal__label">Авто-обновление</span>
      <span class="switch" id="edit-auto" role="switch" tabindex="0"
            data-on="${autoUpdate ? "true" : "false"}"
            aria-checked="${autoUpdate ? "true" : "false"}"></span>
    </div>
    <label class="edit-modal__field">
      <span class="edit-modal__label">Интервал обновления — <span id="edit-interval-val">${escapeHtml(intervalLabel(interval))}</span></span>
      <input type="range" id="edit-interval" min="0" max="96" step="1" value="${interval}">
    </label>
    <div class="edit-modal__hint">${escapeHtml(sub.url || "")}</div>
  `;
  const root = build({
    title: "Редактировать подписку",
    fields,
    onSave: (root) => {
      const name = root.querySelector("#edit-name").value.trim() || sub.name;
      const autoUpdate = root.querySelector("#edit-auto").dataset.on === "true";
      const interval = parseInt(root.querySelector("#edit-interval").value, 10) || 0;
      updateSubscription(sub.id, { name, autoUpdate, updateIntervalHours: interval });
      onToast?.("Сохранено", "success", 1400);
      onSaved?.();
    },
  });
  const slider = root.querySelector("#edit-interval");
  const valEl = root.querySelector("#edit-interval-val");
  slider.addEventListener("input", () => { valEl.textContent = intervalLabel(slider.value); });
  const sw = root.querySelector("#edit-auto");
  const toggleSw = () => {
    const next = sw.dataset.on !== "true";
    sw.dataset.on = String(next);
    sw.setAttribute("aria-checked", String(next));
  };
  sw.addEventListener("click", toggleSw);
  sw.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleSw(); }
  });
}
