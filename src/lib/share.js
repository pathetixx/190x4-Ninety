// Ninety · «Поделиться» — копирование URL, экспорт sing-box JSON, QR-код.

import { buildConfig, getMode } from "/lib/singbox.js";
import { loadOptions } from "/lib/options.js";
import qrcode from "/vendor/qrcode.mjs";
import { t } from "/lib/i18n/index.js";

export async function copySubscriptionUrl(sub, toast) {
  if (!sub?.url) {
    toast?.(t("share.noUrl"), "error", 1800);
    return;
  }
  try {
    await navigator.clipboard.writeText(sub.url);
    toast?.(t("share.urlCopied"), "success", 1400);
  } catch {
    toast?.(t("share.copyFailed"), "error", 1800);
  }
}

// QR-modal для подписки. URL длинный (200+ символов) — typeNumber=0 (auto),
// errorCorrectionLevel "M" (15% избыточности — компромисс между плотностью
// и устойчивостью к свертке/бликам на экране телефона).
export function openQRModal(sub) {
  if (!sub?.url) return;

  closeQRModal();

  const card = document.createElement("div");
  card.className = "qr-modal";
  card.innerHTML = `
    <div class="qr-modal__backdrop"></div>
    <div class="qr-modal__card">
      <div class="qr-modal__head">
        <span class="qr-modal__kicker">${t("share.qrKicker")}</span>
        <button class="qr-modal__close" type="button" aria-label="${t("share.close")}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <h3 class="qr-modal__name"></h3>
      <div class="qr-modal__qr-wrap" data-qr></div>
      <p class="qr-modal__hint">${t("share.qrHint")}</p>
      <div class="qr-modal__actions">
        <button class="qr-modal__btn" type="button" data-copy>${t("share.copyUrl")}</button>
      </div>
    </div>
  `;

  card.querySelector(".qr-modal__name").textContent = sub.name || t("share.subFallback");

  try {
    const qr = qrcode(0, "M");
    qr.addData(sub.url);
    qr.make();
    card.querySelector("[data-qr]").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch (e) {
    card.querySelector("[data-qr]").textContent = t("share.qrError", { err: e?.message || e });
  }

  const close = () => closeQRModal();
  card.querySelector(".qr-modal__backdrop").addEventListener("click", close);
  card.querySelector(".qr-modal__close").addEventListener("click", close);
  card.querySelector("[data-copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(sub.url);
      card.querySelector("[data-copy]").textContent = t("share.copied");
      setTimeout(close, 700);
    } catch {}
  });
  document.addEventListener("keydown", onQRKey);

  document.body.appendChild(card);
}

function closeQRModal() {
  document.querySelectorAll(".qr-modal").forEach(el => el.remove());
  document.removeEventListener("keydown", onQRKey);
}

function onQRKey(e) {
  if (e.key === "Escape") closeQRModal();
}

export async function exportSingboxJson(source, toast) {
  if (!source) {
    toast?.(t("share.noSource"), "error", 1800);
    return;
  }
  try {
    // Шаринг — самодостаточный sing-box (xhttp транслируется в-движок,
    // без xray-моста), поэтому xray не запрашиваем.
    const { config } = buildConfig({
      source,
      mode: getMode(),
      options: loadOptions(),
    });
    const json = JSON.stringify(config, null, 2);
    await navigator.clipboard.writeText(json);
    toast?.(t("share.exported", { kb: (json.length / 1024).toFixed(1) }), "success", 2000);
  } catch (e) {
    toast?.(t("share.exportError", { err: e?.message || e }), "error", 2500);
  }
}
