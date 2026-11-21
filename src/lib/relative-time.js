// "When it was" in human language. Lived inside subscriptions.js, but the same
// wording is used by "About" too (the time of the last update check),
// and pulling in the whole subscriptions module for one line means profiles, storage and
// HWID on top.

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
