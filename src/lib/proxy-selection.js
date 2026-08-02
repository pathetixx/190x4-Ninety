import { getProxySelectionFromStore, saveProxySelectionToStore } from "/lib/profile-store.js";

export function selectionSourceKey(source) {
  if (source?.kind === "sub" && source.subscription?.id) return `sub:${source.subscription.id}`;
  if (source?.kind === "single" && source.profile?.id) return `single:${source.profile.id}`;
  return null;
}

function loadSelections() {
  return getProxySelectionFromStore();
}

export function getRememberedProxySelection(source) {
  const key = selectionSourceKey(source);
  if (!key) return null;
  const tag = loadSelections()[key];
  return typeof tag === "string" && tag ? tag : null;
}

export function rememberProxySelection(source, tag) {
  const key = selectionSourceKey(source);
  if (!key || typeof tag !== "string" || !tag) return false;
  const selections = loadSelections();
  selections[key] = tag;
  saveProxySelectionToStore(selections);
  // Критическое пользовательское состояние: main.js по событию сразу
  // зеркалирует localStorage в дисковый backup.
  try { window.dispatchEvent(new CustomEvent("ninety:proxy-selection-saved")); } catch {}
  return true;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Краткий сбой Clash API не должен молча оставлять новый runtime на "auto".
// После исчерпания попыток ошибка уходит в connectNetwork, который безопасно
// погасит неподтверждённый runtime.
export async function restoreRememberedProxySelection({
  source,
  topology,
  apply,
  isCurrent = () => true,
  attempts = 3,
  retryDelayMs = 140,
  wait = sleep,
}) {
  const tag = getRememberedProxySelection(source);
  if (!tag) return { status: "none", tag: null };

  const selector = topology?.proxies?.proxy;
  const selectableTags = Array.isArray(selector?.all) ? selector.all : [];
  if (!selectableTags.includes(tag)) return { status: "unavailable", tag };
  if (selector?.now === tag) return { status: "current", tag };

  let lastError = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!isCurrent()) return { status: "stale", tag };
    try {
      const result = await apply(tag);
      if (result?.stale || !isCurrent()) return { status: "stale", tag };
      return { status: "restored", tag };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) await wait(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError || new Error(`Не удалось восстановить выбранный сервер ${tag}`);
}
