import { bumpSourceRevision, sourceFingerprint, sourceKey } from "/lib/runtime-identity.js";

// Один controller для refresh/edit/delete. Он сравнивает именно runtime shape,
// поэтому rename и служебный lastUpdate не роняют соединение, а смена нод — да.
export function createSourceMutationController(deps) {
  let queue = Promise.resolve();

  const activeKey = () => sourceKey(deps.getActiveSource());
  const reset = () => {
    deps.invalidateRuntime?.();
    deps.resetEffectiveNode();
    deps.resetProxiesView();
    deps.resetTraffic?.();
    deps.resetQuality?.();
    deps.refreshProfiles();
    deps.syncTray();
  };

  async function reconcile(before, candidates, result, reason) {
    const changed = [];
    for (const item of candidates) {
      const after = deps.getSource(item.kind, item.id);
      if (before.get(item.key) !== sourceFingerprint(after)) {
        bumpSourceRevision(item.key);
        changed.push(item.key);
      }
    }
    if (!changed.length) {
      deps.refreshProfiles();
      return { result, changed, reconnected: false };
    }
    const active = activeKey();
    if (!changed.includes(active)) {
      deps.refreshProfiles();
      deps.syncTray();
      return { result, changed, reconnected: false };
    }
    reset();
    const state = deps.getState();
    const reconnected = state === "connected" || state === "connecting"
      ? Boolean(await deps.reconnect(reason))
      : false;
    return { result, changed, reconnected };
  }

  function run(candidates, mutation, { reason, beforeFingerprints } = {}) {
    const normalized = candidates.map(({ kind, id }) => ({ kind, id, key: `${kind === "sub" ? "sub" : "profile"}:${id}` }));
    const task = async () => {
      const before = beforeFingerprints || new Map(normalized.map(item => [item.key, sourceFingerprint(deps.getSource(item.kind, item.id))]));
      const result = await mutation();
      return reconcile(before, normalized, result, reason);
    };
    queue = queue.then(task, task);
    return queue;
  }

  return { run };
}

export function planSourceDeletion({ kind, id, activeKey, subscriptions = [], profiles = [], state = "idle" }) {
  const key = `${kind === "sub" ? "sub" : "profile"}:${id}`;
  const remainingSubscriptions = subscriptions.filter(s => !(kind === "sub" && s.id === id));
  const remainingProfiles = profiles.filter(p => !(kind !== "sub" && p.id === id));
  const fallback = remainingSubscriptions[0]
    ? { kind: "sub", id: remainingSubscriptions[0].id }
    : remainingProfiles[0] ? { kind: "single", id: remainingProfiles[0].id } : null;
  const active = activeKey === key;
  return {
    key,
    active,
    fallback: active ? fallback : null,
    mustStopBeforeDelete: active && !fallback && (state === "connected" || state === "connecting"),
  };
}
