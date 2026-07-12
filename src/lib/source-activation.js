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
