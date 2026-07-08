// Ninety · явное in-app подтверждение для опасных действий.

import { escapeAttr, escapeHtml } from "/lib/esc.js";
import { t } from "/lib/i18n/index.js";

let cleanup = null;
let settle = null;

function close(result) {
  document.querySelectorAll(".confirm-modal").forEach((el) => el.remove());
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  if (settle) {
    const resolve = settle;
    settle = null;
    resolve(result);
  }
}

function onKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    close(false);
  }
}

export function openConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
} = {}) {
  close(false);
  return new Promise((resolve) => {
    settle = resolve;

    const root = document.createElement("div");
    root.className = "confirm-modal";
    root.innerHTML = `
      <div class="confirm-modal__backdrop" data-confirm-cancel></div>
      <section class="confirm-modal__card" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title" aria-describedby="confirm-modal-message">
        <header class="confirm-modal__head">
          <div class="confirm-modal__kicker">${escapeHtml(t("confirm.kicker"))}</div>
          <h3 class="confirm-modal__title" id="confirm-modal-title">${escapeHtml(title || t("confirm.title"))}</h3>
        </header>
        <p class="confirm-modal__message" id="confirm-modal-message">${escapeHtml(message || t("confirm.message"))}</p>
        <footer class="confirm-modal__actions">
          <button class="confirm-modal__btn confirm-modal__btn--ghost" data-confirm-cancel type="button">${escapeHtml(cancelLabel || t("confirm.cancel"))}</button>
          <button class="confirm-modal__btn ${danger ? "confirm-modal__btn--danger" : "confirm-modal__btn--primary"}" data-confirm-ok type="button" aria-label="${escapeAttr(confirmLabel || t("confirm.ok"))}">${escapeHtml(confirmLabel || t("confirm.ok"))}</button>
        </footer>
      </section>
    `;
    document.body.appendChild(root);

    root.querySelectorAll("[data-confirm-cancel]").forEach((el) => {
      el.addEventListener("click", () => close(false));
    });
    root.querySelector("[data-confirm-ok]")?.addEventListener("click", () => close(true));
    document.addEventListener("keydown", onKey);
    cleanup = () => document.removeEventListener("keydown", onKey);

    setTimeout(() => root.querySelector("[data-confirm-cancel]")?.focus(), 30);
  });
}
