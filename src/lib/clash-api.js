// Тонкий JS-wrapper над Tauri-командами clash-API.

import { perfObserver } from "/lib/performance-observer.js";
import { createTelemetryCache } from "/lib/telemetry-cache.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const DEFAULT_PORT = 9090;
const DEFAULT_URL = "https://www.gstatic.com/generate_204";
const PROXIES_TTL_MS = 1200;
const CONNECTIONS_TTL_MS = 800;
const TRAFFIC_TTL_MS = 800;

let runtimeProvider = null;
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

// Живые соединения для монитора правил маршрутизации:
// [{ process, processPath, host, destinationIP, outbound:"direct"|"proxy"|"block" }].
// Все одновременные consumers делят один IPC/HTTP snapshot в пределах TTL.
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

// Кумулятивные totals ядра. traffic-meter использует тот же single-flight слой,
// поэтому параллельный тик не создаёт второй /connections request.
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

// Процессы с исходящей сетевой активностью (для выбора при создании правила):
// [{ name, pid, path }]. Нативный снимок ОС, от sing-box не зависит.
export async function listNetworkProcesses() {
  return invoke("list_network_processes");
}

// Native Windows TCP rows are deliberately kept outside Clash telemetry: an
// OS-only row can be SYN-SENT to a dead local proxy and therefore never exist
// in /connections.
export async function snapshotNetworkTcp() {
  return invoke("snapshot_network_tcp");
}

export async function testNode(name, { port, url = DEFAULT_URL, timeoutMs = 5000, token } = {}) {
  const value = await call("testNode", "clash_test_node", { port, name, url, timeoutMs }, { token });
  invalidateClashTelemetry("proxies");
  return value;
}

export async function testGroup(group, { port, url = DEFAULT_URL, timeoutMs = 5000, token } = {}) {
  const value = await call("testGroup", "clash_test_group", { port, group, url, timeoutMs }, { token });
  invalidateClashTelemetry("proxies");
  return value;
}

// Замер задержки эффективной ноды для hero/location-card.
//
// Корень бага «в списке 30мс, на главной 100+»: апстрим-форк в обработчике
// одиночного GET /proxies/{name}/delay меряет через context.Background(), который
// НЕ несёт box-ctx → IsUnifiedDelayFromContext=false → один HEAD с полным dial+TLS
// (завышение ~3x). В CI одиночный handler патчится на unified context.
export async function refreshEffectiveDelay({ port, url = DEFAULT_URL, timeoutMs = 5000, token } = {}) {
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

// Ждёт, пока Balancer выберет ноду с ПОДТВЕРЖДЁННЫМ замером.
//
// Ставится там, где раньше стоял форс-прогон группы с коротким дедлайном.
// Тот прогон делал ровно обратное задуманному: ядро отменяло незавершённые
// пробы вместе с запросом и стирало их историю, то есть проверка «жива ли
// подписка» сама же и вычищала замеры, на которые опирается Авто.
//
// Возвращает тег лидера либо null, если за отведённое время подтверждения нет.
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

// Разрыв живых прокси-соединений. Нужен после смены ноды: сам селектор старые
// потоки не рвёт (почему — в clash.rs::clash_close_proxy_connections), поэтому
// keep-alive браузера продолжал бы идти через прежний сервер. direct-соединения
// не трогает.
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

// Ручной выбор активной ноды в Selector-группе.
// PUT /proxies/{group} {"name": tag}. Работает только для type=Selector.
//
// closeConnections=false — только для восстановления выбора на свежем runtime:
// рвать там нечего, ядро секунду как поднялось.
export function selectProxy(group, name, { port, token, closeConnections = true } = {}) {
  const revision = ++selectionRevision;
  const task = async () => {
    if (revision !== selectionRevision) return { stale: true };
    const captured = captureRuntime(token);
    await call("selectProxy", "clash_select_proxy", { port, group, name }, { token: captured });
    invalidateClashTelemetry("proxies");
    if (revision !== selectionRevision) return { stale: true };
    const confirmed = await getProxies(port, { token: captured, fresh: true });
    if (revision !== selectionRevision) return { stale: true };
    const actual = confirmed?.proxies?.[group]?.now;
    if (actual !== name) {
      throw new ClashApiError("selectProxy", `Selector подтвердил ${actual || "пустое значение"}, ожидалось ${name}`, {
        port: runtimePort(port, captured), processGeneration: captured?.processGeneration,
      });
    }
    // Выбор подтверждён ядром — теперь уводим с прежней ноды уже открытые потоки.
    // Неудача здесь не отменяет выбор: новые соединения идут через новую ноду в
    // любом случае, поэтому ошибку логируем, а не поднимаем в UI.
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

// "now" внешнего Selector — что юзер выбрал ("auto" или node-tag).
export function pickSelectorNow(proxiesResp) {
  const proxies = proxiesResp?.proxies || {};
  const sel = proxies.proxy;
  if (!sel) return null;
  return sel.now || null;
}

// Эффективная нода через которую реально пойдёт трафик.
// Если selector.now=="auto" — лезем в URLTest "auto" и берём его .now (min-delay).
// Для одиночного профиля (нет Selector) — возвращаем "proxy" (это сам outbound).
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
