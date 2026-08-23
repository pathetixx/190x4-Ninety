// Ninety · карантин нод, которые ядро отвергло на старте.
//
// Статические проверки (`node-validation.js`) знают всё, что ядро отвергало до
// сих пор, но панель может прислать параметр, которого мы ещё не видели, — и
// одна такая нода снова уронит инициализацию всего конфига. Тогда причину
// называет само ядро: «initialize outbound[N]: …». Ноду по индексу находим
// точно, запоминаем её здесь и больше в конфиг не пускаем: следующая попытка
// подключения проходит без неё, а не упирается в тот же отказ.
//
// Ключ — semantic fingerprint ноды: он переживает переименование, обновление
// подписки и порядок в списке. Если панель починит сервер, fingerprint
// изменится и карантин на него не распространится.

import { nodeSemanticFingerprint } from "/lib/runtime-identity.js";

const KEY = "ninety.nodeQuarantine.v1";
const CAP = 300;

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  try {
    const keys = Object.keys(map);
    if (keys.length > CAP) {
      // Оставляем свежие: старые отказы уже неинтересны, а расти без предела
      // хранилищу нельзя.
      const trimmed = keys
        .sort((a, b) => (map[b]?.at || 0) - (map[a]?.at || 0))
        .slice(0, CAP);
      map = Object.fromEntries(trimmed.map(k => [k, map[k]]));
    }
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch { /* приватный режим/переполнение — карантин не критичен */ }
}

export function quarantineNode(node, reason = "") {
  if (!node) return null;
  const key = nodeSemanticFingerprint(node);
  const map = readAll();
  map[key] = { reason: String(reason || "").slice(0, 200), at: Date.now() };
  writeAll(map);
  return key;
}

export function isNodeQuarantined(node) {
  if (!node) return false;
  return Object.hasOwn(readAll(), nodeSemanticFingerprint(node));
}

export function quarantineReason(node) {
  if (!node) return "";
  return readAll()[nodeSemanticFingerprint(node)]?.reason || "";
}

export function clearNodeQuarantine() {
  try { localStorage.removeItem(KEY); } catch { /* нечего чистить */ }
}

/**
 * Разбирает отказ ядра «initialize outbound[N]: причина» и находит ноду по
 * индексу outbound'а. Индекс считает само ядро, поэтому карту индексов даёт
 * сборщик конфига — арифметику по позициям селектора/балансировщика повторять
 * нельзя, она разъедется на первой же смене состава outbound'ов.
 *
 * WireGuard-ноды ядро инициализирует отдельным списком и называет их
 * «initialize endpoint[N]» (box.go), поэтому у них своя карта индексов.
 * @returns {{node: object, reason: string, index: number, kind: string} | null}
 */
export function matchCoreOutboundRejection(errorText, outboundNodes, endpointNodes = null) {
  const text = String(errorText || "");
  for (const [kind, nodes] of [["outbound", outboundNodes], ["endpoint", endpointNodes]]) {
    if (!Array.isArray(nodes)) continue;
    const match = text.match(new RegExp(`initialize ${kind}\\[(\\d+)\\]:\\s*([^\\n\\r]*)`));
    if (!match) continue;
    const index = Number(match[1]);
    const node = nodes[index];
    if (!node) continue;
    return { node, reason: match[2].trim(), index, kind };
  }
  return null;
}
