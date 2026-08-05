function requireInvoke(invoke) {
  if (typeof invoke !== "function") throw new TypeError("Tauri invoke is required");
}

export function enableSystemProxy(invoke, {
  hostPort,
  bypassLan = true,
  expectedGeneration,
  // Токен текущей операции подключения. Нужен не для самой установки прокси, а
  // для аварийной остановки при её провале: без владения Rust гасил бы runtime,
  // которым за время IPC мог завладеть более новый connect.
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
