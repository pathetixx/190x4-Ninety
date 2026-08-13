// Ninety · предполётная проверка нод перед сборкой конфига.
//
// sing-box инициализирует конфиг ЦЕЛИКОМ: одна нода с параметрами, которые ядро
// не принимает, роняет весь старт — «create service: initialize outbound[72]:
// invalid public_key», и подписка из трёхсот серверов не работает вообще из-за
// одного битого сервера панели. Проверяем ровно то, что ядро отвергает на
// инициализации, и такие ноды не пускаем ни в конфиг, ни в списки.
//
// Проверки намеренно узкие. Нода, которая просто не отвечает, здесь валидна:
// её отбраковывает health-checker, а не сборщик конфига.

import { profileProto } from "/lib/protocol-parsers.js";

// Ядро декодирует public_key строго как base64url без паддинга и требует ровно
// 32 байта (X25519). Панели иногда отдают ключ в обычном алфавите или с «=» —
// это лечится нормализацией, а не отбраковкой.
function decodedLength(base64Url) {
  const s = String(base64Url || "");
  if (!s || /[^A-Za-z0-9\-_]/.test(s)) return -1;
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (std.length % 4)) % 4;
  if (pad === 3) return -1; // длина % 4 === 1 — такого base64 не бывает
  try {
    return atob(std + "=".repeat(pad)).length;
  } catch {
    return -1;
  }
}

/**
 * Приводит reality public_key к тому виду, который принимает ядро.
 * @returns {string} нормализованный ключ или "" если это не 32-байтный ключ.
 */
export function normalizeRealityPublicKey(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const urlSafe = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return decodedLength(urlSafe) === 32 ? urlSafe : "";
}

// short_id ядро декодирует из hex в 8 байт: нечётная длина, не-hex символ или
// больше 16 символов — фатальная ошибка инициализации.
function shortIdValid(raw) {
  const s = String(raw || "").trim();
  if (!s) return true; // пустой short_id допустим
  return /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length <= 16;
}

function realityRequested(node) {
  const mode = node?.tlsMode || node?.security;
  return String(mode || "").toLowerCase() === "reality";
}

// Проверку зовут на каждое чтение активного источника, а тот отдаёт один и тот
// же набор объектов нод, пока хранилище не переписали. Кэш по ссылке снимает
// повторный разбор трёхсот нод; объекты нод неизменяемы — их заменяют целиком.
const issueCache = new WeakMap();

/**
 * Причина, по которой ядро не примет ноду. null — нода пригодна.
 * @returns {{code: string} | null}
 */
export function nodeConfigIssue(node) {
  if (!node || typeof node !== "object") return { code: "malformed" };
  if (issueCache.has(node)) return issueCache.get(node);
  const issue = computeNodeConfigIssue(node);
  issueCache.set(node, issue);
  return issue;
}

function computeNodeConfigIssue(node) {
  const proto = profileProto(node);
  // Sidecar-протоколы (naive/trusttunnel) в sing-box уходят socks-мостом:
  // их параметры ядро не разбирает, проверять по его правилам нечего.
  if (proto === "naive" || proto === "trusttunnel") return null;

  const port = Number(node.port);
  if (!node.host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { code: "endpoint" };
  }

  if (realityRequested(node)) {
    if (!normalizeRealityPublicKey(node.pbk)) return { code: "realityKey" };
    if (!shortIdValid(node.sid)) return { code: "realityShortId" };
  }

  return null;
}

/**
 * Делит список на пригодные ноды и отбракованные с причиной.
 * @returns {{usable: object[], skipped: {node: object, issue: {code: string}}[]}}
 */
export function partitionNodes(nodes) {
  const usable = [];
  const skipped = [];
  for (const node of nodes || []) {
    const issue = nodeConfigIssue(node);
    if (issue) skipped.push({ node, issue });
    else usable.push(node);
  }
  return { usable, skipped };
}

export function usableNodes(nodes) {
  return partitionNodes(nodes).usable;
}
