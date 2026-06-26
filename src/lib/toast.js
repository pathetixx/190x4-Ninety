// ─────────────────────────────────────────────────────────────
// Ninety · toast.js — premium in-app notification stack.
// Replaces the inline `toast()` in main.js and the #toast <div>.
//
//   import { toast } from "/lib/toast.js";
//   toast("Подключено", "success");                       // title only
//   toast("Ошибка", "error", 3500, { desc: "..." });      // + 2nd line
//   toast("Подключаюсь…", "info", 0, { group: "conn" });  // ms:0 = sticky
//
// Signature stays backward-compatible with the old toast(msg, kind, ms):
// every existing call site keeps working unchanged.
// ─────────────────────────────────────────────────────────────

import { t } from "/lib/i18n/index.js";

const MAX_VISIBLE = 4;          // older toasts auto-evict past this
const DEFAULT_MS  = 3000;

const ICONS = {
  success:   '<path d="m5 12 5 5L20 7"/>',
  error:     '<path d="m6 6 12 12"/><path d="m18 6-12 12"/>',
  warn:      '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  info:      '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  // shield-check — connection success; uses the theme accent (see CSS), NOT green
  connected: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
};

const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="m6 6 12 12"/><path d="m18 6-12 12"/></svg>';

let stackEl = null;
const live = new Map();   // id -> { el, timer, remaining, startedAt, group }
let seq = 0;

function ensureStack() {
  if (stackEl && document.body.contains(stackEl)) return stackEl;
  stackEl = document.querySelector(".ntf-stack");
  if (!stackEl) {
    stackEl = document.createElement("div");
    stackEl.className = "ntf-stack";
    stackEl.setAttribute("role", "region");
    stackEl.setAttribute("aria-label", t("notif.region"));
    document.body.appendChild(stackEl);
  }
  return stackEl;
}

function iconMarkup(kind, connecting) {
  if (connecting) return '<span class="ntf__pulse" aria-hidden="true"></span>';
  const path = ICONS[kind] || ICONS.info;
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>"
  );
}

function dismiss(id) {
  const item = live.get(id);
  if (!item) return;
  clearTimeout(item.timer);
  live.delete(id);
  const { el } = item;
  el.dataset.leaving = "true";
  el.addEventListener("animationend", () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 400);   // fallback if animationend doesn't fire
}

function arm(item, ms) {
  if (ms <= 0) return;            // sticky
  item.remaining = ms;
  item.startedAt = Date.now();
  item.timer = setTimeout(() => dismiss(item.id), ms);
}

/**
 * Show a notification.
 * @param {string} title  primary line
 * @param {"info"|"success"|"error"|"warn"} kind
 * @param {number} ms      auto-dismiss delay; 0 = sticky (manual close only)
 * @param {{desc?:string, group?:string, connecting?:boolean}} [opts]
 * @returns {string} id (pass to toast.dismiss to close early)
 */
export function toast(title, kind = "info", ms = DEFAULT_MS, opts = {}) {
  const stack = ensureStack();
  const { desc = "", group = null, connecting = false } = opts;

  // Dedup: a grouped toast replaces the previous one of the same group in
  // place — connection-state messages (linking → secured → idle) never pile.
  if (group) {
    for (const [oldId, it] of live) {
      if (it.group === group) dismiss(oldId);
    }
  }

  const id = "ntf-" + ++seq;
  const el = document.createElement("div");
  el.className = "ntf";
  el.dataset.kind = kind;
  el.dataset.id = id;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.style.setProperty("--ntf-life", (ms > 0 ? ms : 0) + "ms");

  el.innerHTML =
    '<span class="ntf__icon">' + iconMarkup(kind, connecting) + "</span>" +
    '<div class="ntf__body">' +
      '<div class="ntf__title"></div>' +
      (desc ? '<div class="ntf__desc"></div>' : "") +
    "</div>" +
    '<button class="ntf__close" type="button" aria-label="' + t("notif.close") + '">' + CLOSE_SVG + "</button>" +
    (ms > 0 ? '<span class="ntf__bar" aria-hidden="true"></span>' : "");

  // textContent (not innerHTML) for safety against injected server strings
  el.querySelector(".ntf__title").textContent = title;
  if (desc) el.querySelector(".ntf__desc").textContent = desc;

  el.querySelector(".ntf__close").addEventListener("click", () => dismiss(id));

  const item = { id, el, group, timer: null, remaining: ms, startedAt: Date.now() };
  live.set(id, item);

  // Hover pauses the JS timer in sync with the CSS progress bar.
  el.addEventListener("mouseenter", () => {
    if (!item.timer) return;
    clearTimeout(item.timer);
    item.timer = null;
    item.remaining -= Date.now() - item.startedAt;
  });
  el.addEventListener("mouseleave", () => {
    if (item.remaining > 0 && !item.timer) arm(item, item.remaining);
  });

  stack.appendChild(el);
  arm(item, ms);

  if (live.size > MAX_VISIBLE) {
    const oldest = live.keys().next().value;
    dismiss(oldest);
  }

  return id;
}

toast.dismiss = dismiss;
toast.clear = () => { for (const id of [...live.keys()]) dismiss(id); };

export default toast;
