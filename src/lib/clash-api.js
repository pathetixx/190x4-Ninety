// Thin JS wrapper over the clash API Tauri commands.

import { perfObserver } from "/lib/performance-observer.js";
import { createTelemetryCache } from "/lib/telemetry-cache.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const DEFAULT_PORT = 9090;
const DEFAULT_URL = "https://www.gstatic.com/generate_204";
const PROXIES_TTL_MS = 1200;
const CONNECTIONS_TTL_MS = 800;
const TRAFFIC_TTL_MS = 800;

let runtimeProvider = null;
// The measurement target. The balancer in the core measures nodes with the URL from settings; manual and
// background probes must hit the same place, otherwise the UI compares latencies to one
// host with the core's decision made based on latencies to another.
let probeUrlProvider = null;
let selectionRevision = 0;
let selectionQueue = Promise.resolve();
const telemetryCache = createTelemetryCache();
let telemetryRuntimeKey = null;

export class ClashApiError extends Error {
  constructor(operation, message, { port, processGeneration } = {}) {
    super(`${operation} (port=${port}, generation=${processGeneration ?? "none"}): ${message}`);
    this.name = "ClashApiError";
    this.code = "CLASH_API_ERROR";
    this.operation = operation;
    this.port = port;
    this.processGeneration = processGeneration ?? null;
  }
}

export function configureProbeUrl(getter) {
  probeUrlProvider = typeof getter === "function" ? getter : null;
}

function probeUrl(explicit) {
  if (explicit) return explicit;
  try {
    const url = probeUrlProvider?.();
    if (typeof url === "string" && url) return url;
  } catch { /* settings unavailable — fall back to the built-in address */ }
  return DEFAULT_URL;
}

export function configureClashRuntime(provider) {
  runtimeProvider = provider || null;
  telemetryCache.clear();
  telemetryRuntimeKey = null;
}

function captureRuntime(explicitToken) {
  return explicitToken || runtimeProvider?.capture?.() || null;
}

function runtimePort(explicitPort, token) {
  return Number(explicitPort ?? token?.clashPort ?? runtimeProvider?.clashPort?.()) || DEFAULT_PORT;
}

function assertRuntime(token, operation) {
  if (token && runtimeProvider?.assertCurrent) runtimeProvider.assertCurrent(token, operation);
}

function telemetryKey(operation, port, token) {
  return `${operation}:${port}:${token?.processGeneration ?? "none"}`;
}

export function invalidateClashTelemetry(scope = null) {
  if (!scope) telemetryCache.invalidate();
  else telemetryCache.invalidate(`${scope}:`);
}

function ensureTelemetryRuntime(captured, port) {
  const key = `${port}:${captured?.processGeneration ?? "none"}`;
  if (key === telemetryRuntimeKey) return;
  telemetryCache.clear();
  telemetryRuntimeKey = key;
}

async function call(operation, command, args, { token } = {}) {
  const captured = captureRuntime(token);
  const port = runtimePort(args.port, captured);
  const finish = perfObserver.time("clash.ipc.ms", { operation, port });
  perfObserver.increment("clash.ipc.calls");
  try {
    assertRuntime(captured, operation);
    const value = await invoke(command, { ...args, port });
    assertRuntime(captured, operation);
    return value;
  } catch (e) {
    if (e?.code === "STALE_RUNTIME") throw e;
    throw new ClashApiError(operation, e?.message || String(e), {
      port,
      processGeneration: captured?.processGeneration,
    });
  } finally {
    finish();
  }
}

async function cachedCall(operation, command, args, options, ttlMs) {
  const captured = captureRuntime(options?.token);
  const port = runtimePort(args.port, captured);
  ensureTelemetryRuntime(captured, port);
  const key = telemetryKey(operation, port, captured);
  const cached = telemetryCache.peek(key);
  if (!options?.fresh && cached !== undefined) perfObserver.increment(`clash.cache.peek.${operation}`);
  return telemetryCache.get(
    key,
    () => call(operation, command, { ...args, port }, { token: captured }),
    { ttlMs, force: options?.fresh === true },
  );
}

export async function getProxies(port, options = {}) {
  const value = await cachedCall("proxies", "clash_get_proxies", { port }, options, PROXIES_TTL_MS);
  if (!value || typeof value !== "object" || !value.proxies || typeof value.proxies !== "object") {
    const token = captureRuntime(options.token);
    invalidateClashTelemetry("proxies");
    throw new ClashApiError("getProxies", "невалидная структура ответа", {
      port: runtimePort(port, token), processGeneration: token?.processGeneration,
    });
  }
  return value;
}

// Live connections for the routing rules monitor:
// [{ process, processPath, host, destinationIP, outbound:"direct"|"proxy"|"block" }].
// All concurrent consumers share one IPC/HTTP snapshot within the TTL.
export async function getConnections(port, options = {}) {
  const value = await cachedCall(
    "connections",
    "clash_get_connections",
    { port },
    options,
    CONNECTIONS_TTL_MS,
  );
  if (!Array.isArray(value)) {
    invalidateClashTelemetry("connections");
    throw new ClashApiError("getConnections", "ожидался массив", {
      port: runtimePort(port, captureRuntime(options.token)),
    });
  }
  return value;
}

// The core's cumulative totals. traffic-meter uses the same single-flight layer,
// so a parallel tick doesn't create a second /connections request.
export async function getTrafficTotal(port, options = {}) {
  const value = await cachedCall(
    "traffic",
    "clash_traffic_total",
    { port },
    options,
    TRAFFIC_TTL_MS,
  );
  const up = Number(value?.up);
  const down = Number(value?.down);
  if (!Number.isFinite(up) || !Number.isFinite(down)) {
    invalidateClashTelemetry("traffic");
    throw new ClashApiError("getTrafficTotal", "ожидались числовые up/down", {
      port: runtimePort(port, captureRuntime(options.token)),
    });
  }
  return { up, down };
}

// Processes with outbound network activity (for picking when creating a rule):
// [{ name, pid, path }]. A native OS snapshot, independent of sing-box.
export async function listNetworkProcesses() {
  return invoke("list_network_processes");
}

// Native Windows TCP rows are deliberately kept outside Clash telemetry: an
// OS-only row can be SYN-SENT to a dead local proxy and therefore never exist
// in /connections.
export async function snapshotNetworkTcp() {
  return invoke("snapshot_network_tcp");
}

export async function testNode(name, { port, url, timeoutMs = 5000, token } = {}) {
  const value = await call("testNode", "clash_test_node", { port, name, url: probeUrl(url), timeoutMs }, { token });
  invalidateClashTelemetry("proxies");
  return value;
}

export async function testGroup(group, { port, url, timeoutMs = 5000, token } = {}) {
  const value = await call("testGroup", "clash_test_group", { port, group, url: probeUrl(url), timeoutMs }, { token });
  invalidateClashTelemetry("proxies");
  return value;
}

// Latency measurement of the effective node for the hero/location card.
//
// The root of the "30 ms in the list, 100+ on the home screen" bug: the upstream fork, in the handler
// of a single GET /proxies/{name}/delay, measures via context.Background(), which
// does NOT carry box-ctx → IsUnifiedDelayFromContext=false → one HEAD with a full dial+TLS
// (~3x inflation). In CI the single handler is patched to use a unified context.
export async function refreshEffectiveDelay({ port, url, timeoutMs = 5000, token } = {}) {
  let data;
  try { data = await getProxies(port, { token }); } catch (e) {
    if (e?.code === "STALE_RUNTIME") throw e;
    return { delay: 0, tag: null };
  }
  const tag = pickEffectiveNode(data);
  if (!tag) return { delay: 0, tag: null };
  try {
    const r = await testNode(tag, { port, url, timeoutMs, token });
    return { delay: Number(r?.delay) || 0, tag };
  } catch { return { delay: 0, tag }; }
}

// Waits until the Balancer picks a node with a CONFIRMED measurement.
//
// Placed where a forced group run with a short deadline used to be.
// That run did exactly the opposite of what was intended: the core cancelled unfinished
// probes together with the request and erased their history, i.e. the "is the
// subscription alive" check itself wiped the measurements Auto relies on.
//
// Returns the leader's tag, or null if there's no confirmation within the allotted time.
export async function awaitMeasuredLeader({ port, timeoutMs = 6000, token } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let data;
    try {
      data = await getProxies(port, { token, fresh: true });
    } catch (e) {
      if (e?.code === "STALE_RUNTIME") throw e;
      return null;
    }
    const tag = pickEffectiveNode(data);
    if (tag && lastDelay(data?.proxies?.[tag]) > 0) return tag;
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

// Tears down live proxy connections. Needed after a node switch: the selector itself doesn't tear down
// old streams (why — see clash.rs::clash_close_proxy_connections), so
// the browser's keep-alive would keep going through the previous server. direct connections
// are not touched.
export async function closeProxyConnections({ port, token } = {}) {
  const closed = await call(
    "closeProxyConnections",
    "clash_close_proxy_connections",
    { port },
    { token },
  );
  invalidateClashTelemetry("connections");
  return Number(closed) || 0;
}

// Manual selection of the active node in a Selector group.
// PUT /proxies/{group} {"name": tag}. Works only for type=Selector.
//
// closeConnections=false — for restoring the selection on a fresh runtime (there is nothing
// to tear down, the core came up a second ago) and for quietly returning to "Auto" after
// temporarily pinning a node: the live connections on it are fine.
//
// background=true — a background switch (returning to "Auto" on a timer): it doesn't
// displace a user selection already queued, and decides itself at
// execution time whether it's still needed. shouldApply is called inside the queue
// when all previously queued selections have been applied; false → { stale: true }.
export function selectProxy(group, name, {
  port, token, closeConnections = true, background = false, shouldApply,
} = {}) {
  // A regular selection displaces all previously queued ones (latest wins). A background one
  // doesn't change the revision at all: any user selection made after it was
  // queued makes the background one stale, and the background one itself never
  // displaces the user's selection.
  const revision = background ? selectionRevision : ++selectionRevision;
  const isStale = () => revision !== selectionRevision;
  const task = async () => {
    if (isStale()) return { stale: true };
    if (background && typeof shouldApply === "function" && !(await shouldApply())) return { stale: true };
    const captured = captureRuntime(token);
    await call("selectProxy", "clash_select_proxy", { port, group, name }, { token: captured });
    invalidateClashTelemetry("proxies");
    if (isStale()) return { stale: true };
    const confirmed = await getProxies(port, { token: captured, fresh: true });
    if (isStale()) return { stale: true };
    const actual = confirmed?.proxies?.[group]?.now;
    if (actual !== name) {
      throw new ClashApiError("selectProxy", `Selector подтвердил ${actual || "пустое значение"}, ожидалось ${name}`, {
        port: runtimePort(port, captured), processGeneration: captured?.processGeneration,
      });
    }
    // The selection is confirmed by the core — now move the already open streams off the previous node.
    // A failure here doesn't cancel the selection: new connections go through the new node
    // either way, so we log the error rather than surface it in the UI.
    if (closeConnections) {
      try {
        await closeProxyConnections({ port, token: captured });
      } catch (e) {
        if (e?.code === "STALE_RUNTIME") return { stale: true };
        console.warn("close proxy connections failed", e);
      }
    }
    return { stale: false, confirmed };
  };
  selectionQueue = selectionQueue.then(task, task);
  return selectionQueue;
}

export function cancelPendingSelections() {
  selectionRevision++;
}

// "now" of the outer Selector — what the user picked ("auto" or a node tag).
export function pickSelectorNow(proxiesResp) {
  const proxies = proxiesResp?.proxies || {};
  const sel = proxies.proxy;
  if (!sel) return null;
  return sel.now || null;
}

// The effective node the traffic will actually go through.
// If selector.now=="auto" — we look into the URLTest "auto" and take its .now (min delay).
// For a single profile (no Selector) we return "proxy" (that's the outbound itself).
export function pickEffectiveNode(proxiesResp) {
  const proxies = proxiesResp?.proxies || {};
  const sel = proxies.proxy;
  if (!sel) return null;
  if (!sel.now) {
    return sel.type && sel.type.toLowerCase() === "selector" ? null : "proxy";
  }
  if (sel.now === "auto") {
    return proxies.auto?.now || null;
  }
  return sel.now;
}

export function pickActiveNode(proxiesResp) {
  return pickSelectorNow(proxiesResp);
}

export function lastDelay(proxyObj) {
  if (!proxyObj) return 0;
  const hist = proxyObj.history;
  if (Array.isArray(hist) && hist.length) {
    const d = hist[hist.length - 1]?.delay;
    if (typeof d === "number") return d;
  }
  return 0;
}

export function gradeDelay(ms) {
  if (!ms || ms <= 0) return "dead";
  if (ms >= 65000) return "dead";
  if (ms < 800) return "good";
  if (ms < 1500) return "mid";
  return "bad";
}
