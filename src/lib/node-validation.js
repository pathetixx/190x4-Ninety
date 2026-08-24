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
// ядра (ninety-core v1.13.19-ninety.4 и его зависимостей), а не с документации:
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

// Транспорты, которые приложение реально умеет провести: часть несёт само ядро
// (ws/grpc/http/httpupgrade/quic), xhttp и mKCP — локальный xray-мост. Всё
// остальное (например, старый v2ray «tcp+http-обфускация» или неизвестные
// названия) молча собиралось как обычный TCP: конфиг валиден, ядро стартует,
// нода мертва без единой строки в логе. Такую ноду честнее не брать.
const TRANSPORT_TYPES = new Set([
  "", "tcp", "raw", "ws", "grpc", "http", "h2", "httpupgrade", "quic", "xhttp", "kcp",
]);
// Транспорт есть только у протоколов v2ray-семейства; у остальных поле означает
// другое или его нет вовсе.
const TRANSPORT_PROTOS = new Set(["vless", "vmess", "trojan"]);

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

// WireGuard живёт в endpoints, а не в outbounds, но правило то же: ядро
// инициализирует конфиг целиком, и один битый ключ роняет весь запуск.
// Проверяем ровно то, что ядро и наш форк wireguard-go отвергают на старте.
function wireguardKeyValid(value) {
  return decodedLength(String(value || "").trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")) === 32;
}

function wireguardIssue(node) {
  if (!wireguardKeyValid(node.privateKey)) return { code: "wgPrivateKey" };
  const addresses = Array.isArray(node.addresses) ? node.addresses : [];
  if (!addresses.length || addresses.some((address) => !/^[0-9a-fA-F.:]+\/\d{1,3}$/.test(String(address).trim()))) {
    return { code: "wgAddress" };
  }
  const peers = Array.isArray(node.peers) && node.peers.length ? node.peers : [];
  if (!peers.length) return { code: "wgPeer" };
  for (const peer of peers) {
    if (!wireguardKeyValid(peer.publicKey)) return { code: "wgPublicKey" };
    if (peer.presharedKey && !wireguardKeyValid(peer.presharedKey)) return { code: "wgPresharedKey" };
    const peerPort = Number(peer.port);
    if (!peer.host || !Number.isInteger(peerPort) || peerPort < 1 || peerPort > 65535) {
      return { code: "endpoint" };
    }
  }
  const awgIssue = amneziaIssue(node.awg);
  if (awgIssue) return awgIssue;
  return null;
}

// Шейпинг AmneziaWG: те же инварианты, что проверяет ядро (noise/amnezia.go).
// Ловим их здесь, чтобы нода отсеялась со своей причиной, а не утащила за
// собой весь конфиг.
const WG_MESSAGE_SIZES = { initiation: 148, response: 92 };

function amneziaIssue(awg) {
  if (!awg) return null;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const jc = num(awg.jc), jmin = num(awg.jmin), jmax = num(awg.jmax);
  if (jc < 0 || jc > 128) return { code: "wgJunkCount" };
  if (jc > 0 && (jmax <= 0 || jmin > jmax || jmax > 1280)) return { code: "wgJunkSize" };
  const s1 = num(awg.s1), s2 = num(awg.s2);
  if (s1 < 0 || s1 > 1280 || s2 < 0 || s2 > 1280) return { code: "wgHandshakeJunk" };
  // Дополненные init и response не должны совпасть по длине: получатель
  // различает их сначала по размеру.
  if (s1 + WG_MESSAGE_SIZES.initiation === s2 + WG_MESSAGE_SIZES.response) {
    return { code: "wgHandshakeJunk" };
  }
  const headers = [num(awg.h1), num(awg.h2), num(awg.h3), num(awg.h4)];
  const custom = headers.some((value, index) => value && value !== index + 1);
  if (custom) {
    const effective = headers.map((value, index) => value || index + 1);
    if (new Set(effective).size !== effective.length) return { code: "wgMagicHeaders" };
  }
  return null;
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

  if (proto === "wireguard") return wireguardIssue(node);

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

  if (TRANSPORT_PROTOS.has(proto)) {
    const type = String(node.type || "").toLowerCase();
    if (!TRANSPORT_TYPES.has(type)) return { code: "transport" };
    // Ядро поднимает «сырой» QUIC; дополнительное шифрование транспорта из Xray
    // оно не реализует, и такая нода не встанет в любом случае.
    if (type === "quic") {
      const quicSecurity = String(node.quicSecurity || "").toLowerCase();
      if (quicSecurity && quicSecurity !== "none") return { code: "quicSecurity" };
    }
  }

  if (proto === "anytls" && !node.password) return { code: "credentials" };

  if (proto === "hysteria") {
    // Ядро реализует только обычный UDP: faketcp и wechat-video из
    // оригинального клиента v1 ему неизвестны.
    const wire = String(node.hysteriaProtocol || "udp").toLowerCase();
    if (wire !== "udp") return { code: "hysteriaProtocol" };
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
