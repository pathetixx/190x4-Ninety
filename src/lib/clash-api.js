// Тонкий JS-wrapper над Tauri-командами clash-API.

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const DEFAULT_PORT = 9090;
const DEFAULT_URL = "https://www.gstatic.com/generate_204";

let runtimeProvider = null;
let selectionRevision = 0;
let selectionQueue = Promise.resolve();

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

async function call(operation, command, args, { token } = {}) {
  const captured = captureRuntime(token);
  const port = runtimePort(args.port, captured);
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
  }
}

export async function getProxies(port, options = {}) {
  const value = await call("getProxies", "clash_get_proxies", { port }, options);
  if (!value || typeof value !== "object" || !value.proxies || typeof value.proxies !== "object") {
    const token = captureRuntime(options.token);
    throw new ClashApiError("getProxies", "невалидная структура ответа", {
      port: runtimePort(port, token), processGeneration: token?.processGeneration,
    });
  }
  return value;
}

// Живые соединения для монитора правил маршрутизации:
// [{ process, processPath, host, destinationIP, outbound:"direct"|"proxy"|"block" }].
// Процесс резолвится у каждого соединения (в конфиге есть форсирующее
// process-правило → sing-box ищет владельца сокета на каждом коннекте). Форк шлёт
// только processPath; имя (process) Rust выводит как basename пути. process=null
// лишь для соединений, у которых ОС не отдала владельца сокета (системные и т.п.).
export async function getConnections(port, options = {}) {
  const value = await call("getConnections", "clash_get_connections", { port }, options);
  if (!Array.isArray(value)) throw new ClashApiError("getConnections", "ожидался массив", {
    port: runtimePort(port, captureRuntime(options.token)),
  });
  return value;
}

// Процессы с исходящей сетевой активностью (для выбора при создании правила):
// [{ name, pid, path }]. Нативный снимок ОС, от sing-box не зависит.
export async function listNetworkProcesses() {
  return invoke("list_network_processes");
}

export async function testNode(name, { port, url = DEFAULT_URL, timeoutMs = 5000, token } = {}) {
  return call("testNode", "clash_test_node", { port, name, url, timeoutMs }, { token });
}

export async function testGroup(group, { port, url = DEFAULT_URL, timeoutMs = 5000, token } = {}) {
  return call("testGroup", "clash_test_group", { port, group, url, timeoutMs }, { token });
}

// Замер задержки эффективной ноды для hero/location-card.
//
// Корень бага «в списке 30мс, на главной 100+»: апстрим-форк в обработчике
// одиночного GET /proxies/{name}/delay меряет через context.Background(), который
// НЕ несёт box-ctx → IsUnifiedDelayFromContext=false → один HEAD с полным dial+TLS
// (завышение ~3x). Групповой /group/{name}/delay меряет через r.Context() → unified
// (чистый второй RTT) → 30мс. min-из-N не спасал: каждый /delay — холодный.
// Перейти на групповой нельзя — он interval-gated (молчит 600с, не перемеряет) →
// заморозка. Поэтому в CI одиночный обработчик пропатчен на r.Context() (build.yml):
// теперь /proxies/{name}/delay тоже unified И перемеряет каждый вызов (без gate) →
// число совпадает со списком, автозамер и клик живые. Это и есть единый путь здесь.
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

// Ручной выбор активной ноды в Selector-группе.
// PUT /proxies/{group} {"name": tag}. Работает только для type=Selector.
export function selectProxy(group, name, { port, token } = {}) {
  const revision = ++selectionRevision;
  const task = async () => {
    if (revision !== selectionRevision) return { stale: true };
    const captured = captureRuntime(token);
    await call("selectProxy", "clash_select_proxy", { port, group, name }, { token: captured });
    if (revision !== selectionRevision) return { stale: true };
    const confirmed = await getProxies(port, { token: captured });
    if (revision !== selectionRevision) return { stale: true };
    const actual = confirmed?.proxies?.[group]?.now;
    if (actual !== name) {
      throw new ClashApiError("selectProxy", `Selector подтвердил ${actual || "пустое значение"}, ожидалось ${name}`, {
        port: runtimePort(port, captured), processGeneration: captured?.processGeneration,
      });
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
    // single-mode: "proxy" — это и есть конечный outbound, а не Selector
    return sel.type && sel.type.toLowerCase() === "selector" ? null : "proxy";
  }
  if (sel.now === "auto") {
    return proxies.auto?.now || null;
  }
  return sel.now;
}

// Совместимая точка для старого кода — теперь == pickSelectorNow.
export function pickActiveNode(proxiesResp) {
  return pickSelectorNow(proxiesResp);
}

// Последний delay по истории
export function lastDelay(proxyObj) {
  if (!proxyObj) return 0;
  const hist = proxyObj.history;
  if (Array.isArray(hist) && hist.length) {
    const d = hist[hist.length - 1]?.delay;
    if (typeof d === "number") return d;
  }
  return 0;
}

// Hiddify-UX: 0 или >65000 трактуем как "не дотянулись" — "Connecting"/dead.
// Прочее — числовая градация.
export function gradeDelay(ms) {
  if (!ms || ms <= 0) return "dead";
  if (ms >= 65000) return "dead";
  if (ms < 800) return "good";
  if (ms < 1500) return "mid";
  return "bad";
}
