// Shared frontend contract for the native runtime endpoint. The backend is
// still authoritative; these pure checks prevent a stale snapshot from being
// reused during mode transitions and startup reconciliation.

export function runtimeEndpointMatchesGeneration(
  snapshot,
  expectedGeneration = null,
  expectedEndpoint = null,
) {
  const generation = Number(snapshot?.processGeneration);
  const endpoint = snapshot?.probeProxyEndpoint?.address;
  if (!snapshot || !Number.isInteger(generation) || generation <= 0
    || typeof endpoint !== "string" || !endpoint
    || snapshot.listenerReady !== true) return false;
  if (expectedGeneration != null && Number(expectedGeneration) !== generation) return false;
  if (expectedEndpoint != null && expectedEndpoint !== endpoint) return false;
  return true;
}
export function runtimeSnapshotReadyForMode(snapshot, mode) {
  if (!snapshot?.running || snapshot.clashReady !== true) return false;
  if (!runtimeEndpointMatchesGeneration(snapshot)) return false;
  if (mode !== "systemProxy") return true;
  return snapshot.systemProxyOwnership === "owned"
    && snapshot.proxyEnable === true
    && snapshot.proxyServer === snapshot.probeProxyEndpoint.address;
}

// Порт локального инбаунда ЖИВОГО runtime. Настройка `inbound.mixedPort` для
// этого не годится: её меняют без реконнекта, и запрос уходит в порт, которого
// ядро не слушает. Возвращает 0, если снимок не описывает готовый runtime, —
// вызывающий тогда идёт прямым запросом.
export function runtimeProbeProxyPort(snapshot) {
  if (!runtimeEndpointMatchesGeneration(snapshot) || snapshot.running !== true) return 0;
  const address = String(snapshot.probeProxyEndpoint?.address || "");
  // IPv6-литерал приходит как [::1]:7890 — порт всегда после последнего ":".
  const port = Number(address.slice(address.lastIndexOf(":") + 1));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}
