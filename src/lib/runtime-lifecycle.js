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
