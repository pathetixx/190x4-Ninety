// Ninety · реакция на ответ панели про лимит устройств.
//
// Панель с включённым лимитом на запрос без HWID отдаёт вместо серверов
// заглушку или 404. Без объяснения это выглядит как сломанная подписка,
// поэтому предлагаем включить отправку идентификатора для неё — и только
// один раз: отказ запоминается, чтобы не спрашивать при каждом обновлении.

import { openConfirmModal } from "/lib/confirm-modal.js";
import { loadSubscriptions, updateSubscription } from "/lib/subscriptions.js";
import { t } from "/lib/i18n/index.js";

/** Единый вопрос про отправку HWID — задаётся и при добавлении, и при обновлении. */
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
 * @param {string} params.subId — подписка, которой ответила панель
 * @param {{required?: boolean, limitReached?: boolean}|undefined} params.signal
 * @param {(msg: string, kind?: string, ms?: number) => void} [params.toast]
 * @param {() => Promise<any>} [params.onEnabled] — повторная загрузка после включения
 * @returns {Promise<boolean>} включён ли HWID этим ответом
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
