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
  beginOperation = null,
  completeOperation = async () => {},
  cancelOperation = async () => {},
} = {}) {
  if (typeof getActiveSource !== "function" || typeof applySource !== "function"
    || typeof reconnect !== "function") {
    throw new TypeError("source switch controller requires source and reconnect dependencies");
  }

  let sequence = 0;
  let pending = null;

  const current = (token, target) => pending?.token === token
    && sameSourceRef(pending.target, target);

  const verdictKind = (verdict) => {
    if (verdict === true) return "ready";
    if (verdict === false || verdict == null) return "hardFailed";
    const status = String(verdict.status || verdict.kind || "").toLowerCase();
    if (status === "ready") return "ready";
    if (status === "hardfailed" || status === "hard_failed") return "hardFailed";
    if (status === "unverified") return "unverified";
    if (status === "cancelled") return "cancelled";
    if (status === "stale") return "stale";
    return "unverified";
  };

  async function finish(operationToken) {
    if (operationToken) await completeOperation(operationToken);
  }

  async function activate(source, options = {}) {
    const target = normalizeSourceRef(source);
    if (!target) throw new Error("Active source id is required");
    const selected = normalizeSourceRef(getActiveSource());
    if (sameSourceRef(selected, target)) {
      return { changed: false, ready: true, target };
    }

    // Если B ещё не подтверждён и пользователь выбрал C, fallback остаётся A —
    // последним доказанно рабочим источником, а не промежуточным B.
    const superseded = pending;
    if (superseded?.operationToken) void cancelOperation(superseded.operationToken);
    const fallback = superseded?.fallback || selected;
    const token = ++sequence;
    // Reserve ownership before awaiting IPC for the native token.  Without
    // this placeholder, two rapid clicks could both pass `pending === null`
    // and the older async begin would later overwrite the newer intent.
    pending = { token, target, fallback, operationToken: null };
    const operationToken = typeof beginOperation === "function"
      ? await beginOperation(target, { fallback, token })
      : null;
    if (!current(token, target)) {
      if (operationToken) await cancelOperation(operationToken);
      return { changed: true, stale: true, target };
    }
    if (typeof beginOperation === "function" && !operationToken) {
      pending = null;
      return { changed: false, busy: true, target, fallback };
    }
    pending.operationToken = operationToken;
    applySource(target);

    if (options.reconnect === false) {
      pending = null;
      await persist(target);
      await finish(operationToken);
      onActivated(target, options);
      return { changed: true, ready: true, target, reconnected: false };
    }

    let verdict = "hardFailed";
    try {
      const connected = await reconnect(options.reason, {
        phase: "target", target, fallback, operationToken,
      });
      if (!current(token, target)) return { changed: true, stale: true, target };
      if (connected === true && canContinue()) {
        verdict = verdictKind(await confirm(target, {
          token: operationToken,
          isCurrent: () => current(token, target),
        }));
      }
    } catch {
      verdict = "hardFailed";
    }

    if (!current(token, target)) return { changed: true, stale: true, target };
    if (!canContinue()) {
      pending = null;
      await persist(target);
      await cancelOperation(operationToken);
      return { changed: true, cancelled: true, target };
    }
    if (verdict === "ready") {
      pending = null;
      await persist(target);
      await finish(operationToken);
      onActivated(target, options);
      return { changed: true, ready: true, target, reconnected: true };
    }

    // Pressure, a busy permit and monitor/internal errors say nothing about
    // whether the newly started subscription is bad.  Keep it selected and
    // let the regular native watchdog observe it once verification is useful.
    if (verdict === "unverified") {
      pending = null;
      await persist(target);
      await finish(operationToken);
      return { changed: true, ready: false, unverified: true, target, restored: false };
    }
    if (verdict === "cancelled" || verdict === "stale") {
      pending = null;
      await cancelOperation(operationToken);
      return { changed: true, [verdict]: true, target };
    }

    if (!fallback || sameSourceRef(fallback, target)) {
      pending = null;
      await persist(target);
      await finish(operationToken);
      onFailure(target, options);
      return { changed: true, ready: false, target, restored: false };
    }

    applySource(fallback);
    let rollbackOperationToken = operationToken;
    if (typeof beginOperation === "function") {
      try {
        rollbackOperationToken = await beginOperation(fallback, {
          fallback: target,
          token,
          phase: "rollback",
        });
      } catch {
        rollbackOperationToken = null;
      }
      if (!current(token, target)) {
        if (rollbackOperationToken) await cancelOperation(rollbackOperationToken);
        return { changed: true, stale: true, target };
      }
      if (!rollbackOperationToken) {
        pending = null;
        await cancelOperation(operationToken);
        onRollbackFailed(fallback, target, options);
        return { changed: true, ready: false, target, restored: false, fallback };
      }
      pending.operationToken = rollbackOperationToken;
    }
    let restored = false;
    try {
      const rollbackConnected = await reconnect(options.rollbackReason, {
        phase: "rollback",
        target: fallback,
        failedTarget: target,
        operationToken: rollbackOperationToken,
      });
      if (rollbackConnected === true && canContinue()) {
        // Rollback is part of the same user-visible SourceSwitch transaction,
        // but it has its own identity-bound native operation token. A
        // successful reconnect alone is not proof that the fallback runtime
        // owns the expected generation/source or that its dataplane is live.
        restored = verdictKind(await confirm(fallback, {
          token: rollbackOperationToken,
          isCurrent: () => current(token, target),
        })) === "ready";
      }
    } catch {
      restored = false;
    }
    if (!current(token, target)) return { changed: true, stale: true, target };
    pending = null;
    if (restored) await persist(fallback);
    await finish(rollbackOperationToken);
    if (restored) onRollback(fallback, target, options);
    else onRollbackFailed(fallback, target, options);
    return { changed: true, ready: false, target, restored, fallback };
  }

  function cancel() {
    sequence++;
    if (pending?.operationToken) void cancelOperation(pending.operationToken);
    pending = null;
  }

  return {
    activate,
    cancel,
    isPending: () => pending !== null,
  };
}
