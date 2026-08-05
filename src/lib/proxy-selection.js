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
  try { window.dispatchEvent(new CustomEvent("ninety:proxy-selection-saved")); } catch {}
  return true;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function restoreRememberedProxySelection({
  source,
  topology,
  apply,
  isCurrent = () => true,
  attempts = 3,
  retryDelayMs = 140,
  wait = sleep,
}) {
  let tag = getRememberedProxySelection(source);
  if (!tag) return { status: "none", tag: null };

  const selector = topology?.proxies?.proxy;
  const selectableTags = Array.isArray(selector?.all) ? selector.all : [];
  const selectorType = String(selector?.type || "").toLowerCase();
  const isSelector = selectorType === "selector" || selectableTags.length > 0;

  // A source which now has one physical route cannot restore an old selector
  // child. Normalise stale auto/manual state to the only runtime tag.
  if (!isSelector) {
    if (tag === "proxy") return { status: "current", tag };
    if (!isCurrent()) return { status: "stale", tag };
    const previousTag = tag;
    rememberProxySelection(source, "proxy");
    return {
      status: "reset",
      tag: "proxy",
      previousTag,
      reason: "single_route_normalized",
    };
  }

  let previousTag = null;
  let resetReason = null;

  // Legacy singleton runtimes stored "proxy" as the effective outbound. In a
  // multi-node runtime it is the selector group name, not a selectable child.
  if (tag === "proxy" && selectableTags.includes("auto")) {
    previousTag = tag;
    resetReason = "legacy_singleton_selection";
    tag = "auto";
  }

  // Provider rotation may remove or re-key a previously selected node. This
  // must not make the whole subscription unusable in ordinary mode. The only
  // permitted automatic recovery is the explicit app policy "auto".
  if (!selectableTags.includes(tag)) {
    if (!selectableTags.includes("auto")) {
      return { status: "unavailable", tag };
    }
    previousTag = tag;
    resetReason = "remembered_selection_unavailable";
    tag = "auto";
  }

  if (selector?.now === tag) {
    if (previousTag == null) return { status: "current", tag };
    if (!isCurrent()) return { status: "stale", tag };
    rememberProxySelection(source, tag);
    return {
      status: "reset",
      tag,
      previousTag,
      reason: resetReason,
    };
  }

  let lastError = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!isCurrent()) return { status: "stale", tag };
    try {
      const result = await apply(tag);
      if (result?.stale || !isCurrent()) return { status: "stale", tag };
      if (previousTag != null) {
        // Persist only after Clash confirms the fallback. A failed/stale apply
        // leaves the previous preference intact.
        rememberProxySelection(source, tag);
        return {
          status: "reset",
          tag,
          previousTag,
          reason: resetReason,
        };
      }
      return { status: "restored", tag };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) await wait(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError || new Error(`Не удалось восстановить выбранный сервер ${tag}`);
}
