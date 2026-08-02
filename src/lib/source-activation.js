// Единая транзакция смены активного источника. Зависимости передаются явно,
// чтобы один и тот же порядок использовался UI и проверялся regression-тестами.
export function applyActiveSourceTransaction(source, deps, options = {}) {
  const kind = source?.kind === "sub" ? "sub" : "single";
  const id = String(source?.id || "").trim();
  if (!id) throw new Error("Active source id is required");

  if (kind === "sub") {
    deps.setActiveSubscriptionId(id);
    deps.setActiveKind("sub");
  } else {
    deps.setActiveProfileId(id);
    deps.setActiveKind("single");
  }

  deps.resetEffectiveNode();
  deps.resetProxiesView();
  deps.resetTraffic?.();
  deps.resetQuality?.();
  deps.invalidateRuntime?.();
  deps.refreshProfiles();
  deps.syncTray();

  const state = deps.getState();
  const shouldReconnect = options.reconnect !== false
    && (state === "connected" || state === "connecting");
  const reconnected = shouldReconnect
    ? deps.reconnectForSourceChange(options.reason)
    : false;

  if (!options.silent && !reconnected) deps.notifyActivated?.(kind);
  return { kind, id, state, reconnected: Boolean(reconnected) };
}

export function normalizeSourceRef(source) {
  const kind = source?.kind === "sub" ? "sub" : "single";
  const id = String(source?.id || "").trim();
  return id ? { kind, id } : null;
}

export function sameSourceRef(left, right) {
  const a = normalizeSourceRef(left);
  const b = normalizeSourceRef(right);
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

// Переключение активного источника — двухфазная операция. localStorage нужен
// builder'у до старта нового runtime, но подтверждённым выбор становится только
// после connect + dataplane readiness. При отказе восстанавливаем последний
// рабочий источник. sequence guard не позволяет позднему завершению B откатить C.
export function createSourceSwitchController({
  getActiveSource,
  applySource,
  reconnect,
  confirm = async () => true,
  canContinue = () => true,
  persist = async () => {},
  onActivated = () => {},
  onRollback = () => {},
  onRollbackFailed = () => {},
  onFailure = () => {},
} = {}) {
  if (typeof getActiveSource !== "function" || typeof applySource !== "function"
    || typeof reconnect !== "function") {
    throw new TypeError("source switch controller requires source and reconnect dependencies");
  }

  let sequence = 0;
  let pending = null;

  const current = (token, target) => pending?.token === token
    && sameSourceRef(pending.target, target);

  async function activate(source, options = {}) {
    const target = normalizeSourceRef(source);
    if (!target) throw new Error("Active source id is required");
    const selected = normalizeSourceRef(getActiveSource());
    if (sameSourceRef(selected, target)) {
      return { changed: false, ready: true, target };
    }

    // Если B ещё не подтверждён и пользователь выбрал C, fallback остаётся A —
    // последним доказанно рабочим источником, а не промежуточным B.
    const fallback = pending?.fallback || selected;
    const token = ++sequence;
    applySource(target);

    if (options.reconnect === false) {
      pending = null;
      await persist(target);
      onActivated(target, options);
      return { changed: true, ready: true, target, reconnected: false };
    }

    pending = { token, target, fallback };
    let ready = false;
    try {
      const connected = await reconnect(options.reason, { phase: "target", target, fallback });
      if (!current(token, target)) return { changed: true, stale: true, target };
      if (connected === true && canContinue()) {
        ready = await confirm(target, { token, isCurrent: () => current(token, target) });
      }
    } catch {
      ready = false;
    }

    if (!current(token, target)) return { changed: true, stale: true, target };
    if (!canContinue()) {
      pending = null;
      await persist(target);
      return { changed: true, cancelled: true, target };
    }
    if (ready === true) {
      pending = null;
      await persist(target);
      onActivated(target, options);
      return { changed: true, ready: true, target, reconnected: true };
    }

    if (!fallback || sameSourceRef(fallback, target)) {
      pending = null;
      await persist(target);
      onFailure(target, options);
      return { changed: true, ready: false, target, restored: false };
    }

    applySource(fallback);
    await persist(fallback);
    let restored;
    try {
      restored = await reconnect(options.rollbackReason, {
        phase: "rollback",
        target: fallback,
        failedTarget: target,
      }) === true;
    } catch {
      restored = false;
    }
    if (!current(token, target)) return { changed: true, stale: true, target };
    pending = null;
    if (restored) onRollback(fallback, target, options);
    else onRollbackFailed(fallback, target, options);
    return { changed: true, ready: false, target, restored, fallback };
  }

  function cancel() {
    sequence++;
    pending = null;
  }

  return {
    activate,
    cancel,
    isPending: () => pending !== null,
  };
}
