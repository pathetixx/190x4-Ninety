// Ninety · reaction to the panel's response about the device limit.
//
// A panel with the limit enabled returns, instead of servers, a placeholder or a 404
// to a request without a HWID. Without an explanation this looks like a broken subscription,
// so we offer to enable sending the identifier for it — and only
// once: a refusal is remembered so we don't ask on every update.

import { openConfirmModal } from "/lib/confirm-modal.js";
import { loadSubscriptions, updateSubscription } from "/lib/subscriptions.js";
import { t } from "/lib/i18n/index.js";

/** A single question about sending the HWID — asked both when adding and when updating. */
export function askEnableHwid() {
  return openConfirmModal({
    title: t("hwid.promptTitle"),
    message: t("hwid.promptMessage"),
    confirmLabel: t("hwid.promptOk"),
    cancelLabel: t("hwid.promptCancel"),
  });
}

/**
 * @param {object} params
 * @param {string} params.subId — the subscription the panel responded for
 * @param {{required?: boolean, limitReached?: boolean}|undefined} params.signal
 * @param {(msg: string, kind?: string, ms?: number) => void} [params.toast]
 * @param {() => Promise<any>} [params.onEnabled] — reload after enabling
 * @returns {Promise<boolean>} whether the HWID was enabled by this response
 */
export async function handleHwidSignal({ subId, signal, toast, onEnabled } = {}) {
  if (!signal) return false;
  if (signal.limitReached) {
    toast?.(t("hwid.limitReached"), "warn", 7000);
    return false;
  }
  if (!signal.required) return false;

  const sub = loadSubscriptions().find(s => s.id === subId);
  if (!sub || sub.hwid || sub.hwidPromptDismissed) return false;

  const confirmed = await askEnableHwid();
  if (!confirmed) {
    updateSubscription(subId, { hwidPromptDismissed: true });
    return false;
  }
  updateSubscription(subId, { hwid: true, hwidPromptDismissed: true });
  await onEnabled?.();
  return true;
}
