// «Когда это было» человеческим языком. Жило внутри subscriptions.js, но той же
// формулировкой пользуется и «О программе» (время последней проверки обновлений),
// а тянуть ради одной строки весь модуль подписок — это профили, хранилище и
// HWID в придачу.

import { t } from "/lib/i18n/index.js";

export function relativeTime(ts) {
  if (!ts) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return t("subs.relNow");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t("subs.relMin", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("subs.relHour", { n: hours });
  const days = Math.floor(hours / 24);
  return t("subs.relDay", { n: days });
}
