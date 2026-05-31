// Тонкий JS-wrapper над Tauri-командами clash-API.

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const DEFAULT_PORT = 9090;
const DEFAULT_URL = "https://www.gstatic.com/generate_204";

export async function getProxies(port = DEFAULT_PORT) {
  return invoke("clash_get_proxies", { port });
}

export async function testNode(name, { port = DEFAULT_PORT, url = DEFAULT_URL, timeoutMs = 5000 } = {}) {
  return invoke("clash_test_node", { port, name, url, timeoutMs });
}

export async function testGroup(group, { port = DEFAULT_PORT, url = DEFAULT_URL, timeoutMs = 5000 } = {}) {
  return invoke("clash_test_group", { port, group, url, timeoutMs });
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
export async function refreshEffectiveDelay({ port = DEFAULT_PORT, url = DEFAULT_URL, timeoutMs = 5000 } = {}) {
  let data;
  try { data = await getProxies(port); } catch { return { delay: 0, tag: null }; }
  const tag = pickEffectiveNode(data);
  if (!tag) return { delay: 0, tag: null };
  try {
    const r = await testNode(tag, { port, url, timeoutMs });
    return { delay: Number(r?.delay) || 0, tag };
  } catch { return { delay: 0, tag }; }
}

// Ручной выбор активной ноды в Selector-группе.
// PUT /proxies/{group} {"name": tag}. Работает только для type=Selector.
export async function selectProxy(group, name, { port = DEFAULT_PORT } = {}) {
  return invoke("clash_select_proxy", { port, group, name });
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
