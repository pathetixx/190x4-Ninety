function requireInvoke(invoke) {
  if (typeof invoke !== "function") throw new TypeError("Tauri invoke is required");
}

export function enableSystemProxy(invoke, {
  hostPort,
  bypassLan = true,
  expectedGeneration,
  // Token of the current connect operation. It's needed not for setting the proxy itself, but
  // for the emergency stop when that fails: without ownership Rust would kill a runtime
  // that a newer connect could have taken over during IPC.
  operationToken = null,
} = {}) {
  requireInvoke(invoke);
  const endpoint = typeof hostPort === "string" ? hostPort.trim() : "";
  const generation = Number(expectedGeneration);
  if (!endpoint) throw new TypeError("system proxy requires a runtime endpoint");
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new TypeError("system proxy requires a positive runtime generation");
  }
  return invoke("enable_system_proxy", {
    hostPort: endpoint,
    bypassLan: bypassLan !== false,
    expectedGeneration: generation,
    operationToken: operationToken || null,
  });
}

export function disableSystemProxy(invoke) {
  requireInvoke(invoke);
  return invoke("disable_system_proxy");
}
