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

// Ядро принимает у vless ровно два значения flow: пустое и «xtls-rprx-vision»
// (sing-vmess, NewClient). Xray-вариант «…-udp443» отличается только тем, что
// UDP:443 у него идёт мимо туннеля локально — на провод уходит тот же
// «xtls-rprx-vision», поэтому суффикс просто снимаем, а не выбрасываем ноду.
// Всё остальное ядро отвергает при инициализации и роняет весь конфиг.
const SINGBOX_FLOWS = new Set(["", "xtls-rprx-vision"]);

/**
 * @returns {string|null} flow для sing-box или null, если ядро его не примет.
 */
export function normalizeFlow(raw) {
  const flow = String(raw || "").trim();
  const base = flow === "xtls-rprx-vision-udp443" ? "xtls-rprx-vision" : flow;
  return SINGBOX_FLOWS.has(base) ? base : null;
}

// Список отпечатков uTLS, которые знает ядро (common/tls/utls_client.go).
// Незнакомое имя — фатальная ошибка конфига, но отпечаток это лишь маскировка
// ClientHello: подменить его на chrome безопаснее, чем потерять сервер.
const UTLS_FINGERPRINTS = new Set([
  "chrome", "chrome_psk", "chrome_psk_shuffle", "chrome_padding_psk_shuffle",
  "chrome_pq", "chrome_pq_psk", "firefox", "edge", "safari", "360", "qq",
  "ios", "android", "random", "randomized",
]);

export function normalizeFingerprint(raw) {
  const fp = String(raw || "").trim();
  return UTLS_FINGERPRINTS.has(fp) ? fp : "chrome";
}

// Остальные строго проверяемые ядром значения. Списки сняты с исходников самого
// ядра (ninety-core v1.13.16-ninety.1 и его зависимостей), а не с документации:
//   vmess security      — sing-vmess/client.go
//   shadowsocks method  — sing-shadowsocks2 (shadowaead / _2022 / shadowstream / none)
//   hysteria2 obfs      — protocol/hysteria2/outbound.go (только salamander, пароль обязателен)
//   tuic congestion     — sing-quic/tuic/client.go
const VMESS_SECURITY = new Set([
  "", "auto", "none", "zero", "aes-128-cfb", "aes-128-gcm", "chacha20-poly1305",
]);
const SHADOWSOCKS_METHODS = new Set([
  "none",
  "aes-128-gcm", "aes-192-gcm", "aes-256-gcm",
  "chacha20-ietf-poly1305", "xchacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305",
  "aes-128-cfb", "aes-192-cfb", "aes-256-cfb",
  "aes-128-ctr", "aes-192-ctr", "aes-256-ctr",
  "chacha20-ietf", "xchacha20", "rc4-md5",
]);
const TUIC_CONGESTION = new Set(["", "cubic", "new_reno", "bbr"]);

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

  if (proto === "vless" && normalizeFlow(node.flow) === null) {
    return { code: "flow" };
  }

  if (proto === "vmess" && !VMESS_SECURITY.has(String(node.security || "").toLowerCase())) {
    return { code: "vmessSecurity" };
  }

  if (proto === "shadowsocks" && !SHADOWSOCKS_METHODS.has(String(node.method || "").toLowerCase())) {
    return { code: "ssMethod" };
  }

  if (proto === "hysteria2" && node.obfs) {
    if (String(node.obfs).toLowerCase() !== "salamander" || !node.obfsPassword) {
      return { code: "obfs" };
    }
  }

  if (proto === "tuic" && !TUIC_CONGESTION.has(String(node.congestionControl || "").toLowerCase())) {
    return { code: "congestion" };
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
