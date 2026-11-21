// Ninety · the "Feedback" window.
//
// The text goes through the send_feedback Rust command to the project relay, which
// forwards it to Telegram. The checks here are only for convenience: the real
// limits are enforced by the server, because localStorage is removed by clearing data, and
// the endpoint address is visible in the sources.

import { t, getLang } from "/lib/i18n/index.js";
import { escapeHtml, escapeAttr } from "/lib/esc.js";
import { ensureDeviceIdentity } from "/lib/hwid.js";
import { toast } from "/lib/toast.js";
import { STORAGE_KEYS } from "/lib/storage-policy.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const STATE_KEY = STORAGE_KEYS.feedbackState;
const TEXT_MIN = 10;
const TEXT_MAX = 2000;
const CONTACT_MAX = 120;
// Pause after a successful submission: the server allows two messages per six hours,
// so the pause here is deliberately shorter — otherwise the window would block a second
// legitimate message that the server would accept.
const SEND_PAUSE_MS = 15 * 60 * 1000;

function readState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}
function writeState(next) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(next)); } catch {}
}

/** How long to wait until the next submission, ms (0 — can submit). */
function cooldownLeft() {
  const until = Number(readState().blockedUntil) || 0;
  return Math.max(0, until - Date.now());
}

function blockFor(ms) {
  writeState({ ...readState(), blockedUntil: Date.now() + ms, lastSentAt: Date.now() });
}

function cooldownText(ms) {
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return t("feedback.retryMin", { n: mins });
  return t("feedback.retryHour", { n: Math.ceil(mins / 60) });
}

let openRoot = null;
let escHandler = null;

function close() {
  openRoot?.remove();
  openRoot = null;
  if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
}

export function openFeedbackModal() {
  close();
  const openedAt = Date.now();
  const root = document.createElement("div");
  openRoot = root;
  root.className = "confirm-modal fb-modal";
  root.innerHTML = `
    <div class="confirm-modal__backdrop" data-fb-cancel></div>
    <section class="confirm-modal__card fb-modal__card" role="dialog" aria-modal="true" aria-labelledby="fb-title">
      <header class="confirm-modal__head">
        <div class="confirm-modal__kicker">${escapeHtml(t("feedback.kicker"))}</div>
        <h3 class="confirm-modal__title" id="fb-title">${escapeHtml(t("feedback.title"))}</h3>
      </header>
      <p class="fb-modal__lead">${escapeHtml(t("feedback.lead"))}</p>
      <textarea class="fb-modal__text" id="fb-text" rows="7" maxlength="${TEXT_MAX}"
        spellcheck="false" placeholder="${escapeAttr(t("feedback.placeholder"))}"></textarea>
      <div class="fb-modal__row">
        <input class="fb-modal__contact" id="fb-contact" type="text" maxlength="${CONTACT_MAX}"
          spellcheck="false" placeholder="${escapeAttr(t("feedback.contactPh"))}">
        <span class="fb-modal__counter" id="fb-counter">0 / ${TEXT_MAX}</span>
      </div>
      <p class="fb-modal__meta">${escapeHtml(t("feedback.meta"))}</p>
      <p class="fb-modal__error" id="fb-error" hidden></p>
      <footer class="confirm-modal__actions">
        <button class="confirm-modal__btn confirm-modal__btn--ghost" data-fb-cancel type="button">${escapeHtml(t("feedback.cancel"))}</button>
        <button class="confirm-modal__btn confirm-modal__btn--primary" id="fb-send" type="button" disabled>${escapeHtml(t("feedback.send"))}</button>
      </footer>
    </section>
  `;
  document.body.appendChild(root);

  const text = root.querySelector("#fb-text");
  const contact = root.querySelector("#fb-contact");
  const counter = root.querySelector("#fb-counter");
  const send = root.querySelector("#fb-send");
  const error = root.querySelector("#fb-error");

  const showError = (message) => {
    error.textContent = message;
    error.hidden = !message;
  };

  const sync = () => {
    const length = text.value.trim().length;
    counter.textContent = `${length} / ${TEXT_MAX}`;
    send.disabled = length < TEXT_MIN;
  };
  text.addEventListener("input", sync);
  sync();

  const left = cooldownLeft();
  if (left > 0) {
    showError(t("feedback.cooldown", { time: cooldownText(left) }));
    send.disabled = true;
    text.disabled = true;
    contact.disabled = true;
  }

  root.querySelectorAll("[data-fb-cancel]").forEach((el) => el.addEventListener("click", close));
  escHandler = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", escHandler);

  send.addEventListener("click", async () => {
    if (send.disabled) return;
    send.disabled = true;
    const label = send.textContent;
    send.textContent = t("feedback.sending");
    showError("");
    try {
      const identity = await ensureDeviceIdentity();
      await invoke("send_feedback", {
        input: {
          text: text.value,
          contact: contact.value,
          deviceSeed: identity?.hwid || "",
          formAgeMs: Date.now() - openedAt,
          lang: getLang(),
        },
      });
      blockFor(SEND_PAUSE_MS);
      close();
      toast(t("feedback.sent"), "success", 3200);
      return;
    } catch (e) {
      const code = String(e?.message || e || "");
      send.textContent = label;
      send.disabled = false;
      if (code.startsWith("rate_limited")) {
        const seconds = Number(code.split(":")[1]) || 21600;
        blockFor(seconds * 1000);
        showError(t("feedback.cooldown", { time: cooldownText(seconds * 1000) }));
        send.disabled = true;
      } else if (code === "too_short") {
        showError(t("feedback.errShort"));
      } else if (code === "network") {
        showError(t("feedback.errNetwork"));
      } else {
        showError(t("feedback.errGeneric", { err: code || "?" }));
      }
    }
  });

  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send.click();
    }
  });

  setTimeout(() => text.focus(), 30);
}
