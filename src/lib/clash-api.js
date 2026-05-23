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

// Текущая выбранная нода urltest-группы.
// В sing-box clash-API структура: proxies["proxy"] = { type:"URLTest", now: "node-tag", all: ["node-0", ...], history: [{time, delay}] }
export function pickActiveNode(proxiesResp) {
  const proxies = proxiesResp?.proxies || {};
  const group = proxies.proxy;
  if (!group) return null;
  return group.now || null;
}

// Достаём последний delay по истории истории
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
  if (ms < 800) return "good";
  if (ms < 1500) return "mid";
  return "bad";
}
