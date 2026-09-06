// Ninety · импорт готового конфига sing-box (JSON) → профили.
//
// Панели раздают подписку двумя способами: списком share-ссылок и собранным
// конфигом ядра. Ninety собирает конфиг сам (маршрутизация, DNS, kill-switch —
// свои), поэтому из чужого конфига берём ровно серверную часть: outbounds и
// endpoints. Каждый сервер сначала превращается в свою share-ссылку и только
// потом разбирается тем же parseLink, что и обычная подписка — см.
// /lib/share-link.js о том, почему именно через ссылку.
//
// Что из чужого конфига сознательно НЕ переносится: маршрутизация, DNS,
// inbounds, правила, а из самих outbound'ов — mux, tcp_fast_open, ech,
// record_fragment. Первое — политика приложения, второе — клиентские опции,
// без которых нода работает, просто без этой оптимизации.

import { parseLink } from "/lib/protocol-parsers.js";
import { safeJsonParse } from "/lib/config-format.js";
import {
  bareHost,
  buildShareLink,
  buildVmessLink,
  credentialsUserinfo,
  isPlainObject,
  joinList,
  numberOrNull,
  shadowsocksUserinfo,
} from "/lib/share-link.js";

// Групповые и системные outbound'ы: это не серверы, и в счётчик «пропущено»
// они попадать не должны — иначе пользователь видит «пропущено 4» на конфиге,
// где пропускать было нечего.
const NON_SERVER_TYPES = new Set([
  "selector", "urltest", "balancer", "direct", "block", "dns", "dns-out",
  "blackhole", "freedom", "loopback",
]);

// Протоколы, которые ядро умеет, а Ninety как отдельный профиль не заводит.
// Считаем пропущенными и называем причину — молчать нельзя: в конфиге они были.
const UNSUPPORTED_TYPES = new Set([
  "http", "shadowtls", "ssh", "tor", "tailscale", "shadowsocksr", "vmess-legacy",
]);

// Скорости hysteria ядро принимает и числом (up_mbps), и строкой («50 Mbps»).
function mbps(node, numericKey, stringKey) {
  const direct = numberOrNull(node[numericKey]);
  if (direct) return direct;
  const parsed = parseInt(String(node[stringKey] ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// ── TLS ────────────────────────────────────────────────────
// Возвращает параметры ссылки в терминах v2rayN — том же словаре, который
// читают парсеры Ninety.
function tlsParams(tls) {
  if (!isPlainObject(tls) || tls.enabled === false) return { security: "none", params: [] };
  const reality = isPlainObject(tls.reality) && tls.reality.enabled !== false ? tls.reality : null;
  const utls = isPlainObject(tls.utls) && tls.utls.enabled !== false ? tls.utls : null;
  const params = [
    ["sni", tls.server_name || ""],
    ["alpn", joinList(tls.alpn)],
    ["fp", utls?.fingerprint || ""],
  ];
  if (tls.insecure) params.push(["allowInsecure", "1"]);
  if (reality) {
    params.push(["pbk", reality.public_key || ""], ["sid", reality.short_id || ""]);
  }
  return { security: reality ? "reality" : "tls", params };
}

// ── транспорт ──────────────────────────────────────────────
// Ранняя передача данных (max_early_data) уезжает в ссылку парой ed/eh — так её
// пишут sing-box-клиенты, и так же её читает обратно наш парсер. В путь
// («/path?ed=2560», форма Xray) не складываем: путь для ядра остаётся путём.
function transportParams(transport) {
  if (!isPlainObject(transport)) return { type: "tcp", params: [] };
  const type = String(transport.type || "").toLowerCase();
  const early = [
    ["ed", numberOrNull(transport.max_early_data) || ""],
    ["eh", transport.early_data_header_name || ""],
  ];
  switch (type) {
    case "ws":
      return {
        type: "ws",
        params: [
          ["path", transport.path || ""],
          ["host", transport.headers?.Host ? joinList(transport.headers.Host) : ""],
          ...early,
        ],
      };
    case "http":
      return {
        type: "http",
        params: [
          ["path", transport.path || ""],
          ["host", joinList(transport.host)],
        ],
      };
    case "httpupgrade":
      // Ранней передачи у httpupgrade в ядре нет: писать ed/eh в ссылку значит
      // менять отпечаток ноды полем, которое никуда не доедет.
      return {
        type: "httpupgrade",
        params: [
          ["path", transport.path || ""],
          ["host", joinList(transport.host)],
        ],
      };
    case "grpc":
      return { type: "grpc", params: [["serviceName", transport.service_name || ""]] };
    case "quic":
      return { type: "quic", params: [] };
    default:
      // Незнакомый транспорт не выдаём за tcp: такая нода собралась бы обычным
      // TCP и молча не работала. Пусть её отбракует валидатор транспорта.
      return { type, params: [] };
  }
}

// ── outbound → share-ссылка ────────────────────────────────
const link = (node, scheme, userinfo, tag, params) => buildShareLink({
  scheme, userinfo, server: node.server, port: node.server_port, params, tag,
});

function vlessUri(node, tag) {
  const tls = tlsParams(node.tls);
  const transport = transportParams(node.transport);
  return link(node, "vless", encodeURIComponent(node.uuid || ""), tag, [
    ["encryption", "none"],
    ["security", tls.security],
    ["type", transport.type],
    ["flow", node.flow || ""],
    ...tls.params,
    ...transport.params,
  ]);
}

function trojanUri(node, tag) {
  const tls = tlsParams(node.tls);
  const transport = transportParams(node.transport);
  return link(node, "trojan", encodeURIComponent(node.password || ""), tag, [
    ["security", tls.security],
    ["type", transport.type],
    ...tls.params,
    ...transport.params,
  ]);
}

// vmess share-ссылка — это base64 от JSON v2rayN, а не query-строка.
function vmessUri(node, tag) {
  const tls = isPlainObject(node.tls) && node.tls.enabled !== false ? node.tls : null;
  const reality = tls && isPlainObject(tls.reality) && tls.reality.enabled !== false;
  const transport = isPlainObject(node.transport) ? node.transport : {};
  const net = String(transport.type || "tcp").toLowerCase();
  // У v2rayN одно поле `path` обслуживает три разных транспорта: путь у ws/http,
  // имя сервиса у grpc. Парсер читает его ровно так же.
  const path = net === "grpc" ? (transport.service_name || "") : (transport.path || "");
  const host = net === "ws"
    ? (transport.headers?.Host ? joinList(transport.headers.Host) : "")
    : joinList(transport.host);
  const payload = {
    v: "2",
    ps: tag || "",
    add: bareHost(node.server),
    port: String(node.server_port ?? ""),
    id: node.uuid || "",
    aid: String(node.alter_id ?? 0),
    scy: node.security || "auto",
    net,
    type: "none",
    host,
    path,
    tls: tls ? (reality ? "reality" : "tls") : "",
    sni: tls?.server_name || "",
    alpn: tls ? joinList(tls.alpn) : "",
    fp: (tls && isPlainObject(tls.utls) && tls.utls.enabled !== false) ? (tls.utls.fingerprint || "") : "",
    // Полей ранней передачи и insecure в формате v2rayN нет — дописываем свои.
    // Чужие клиенты неизвестные ключи игнорируют, а у нас конфиг возвращается
    // из ссылки таким же, каким в неё вошёл.
    ...(net === "ws" && numberOrNull(transport.max_early_data)
      ? { ed: String(transport.max_early_data), eh: transport.early_data_header_name || "Sec-WebSocket-Protocol" }
      : {}),
    ...(tls?.insecure ? { allowInsecure: true } : {}),
  };
  return buildVmessLink(payload, tag);
}

function shadowsocksUri(node, tag) {
  const userinfo = shadowsocksUserinfo(node.method, node.password);
  const plugin = node.plugin
    ? `${node.plugin}${node.plugin_opts ? `;${node.plugin_opts}` : ""}`
    : "";
  return link(node, "ss", userinfo, tag, [["plugin", plugin]]);
}

function hysteria2Uri(node, tag) {
  const tls = isPlainObject(node.tls) ? node.tls : {};
  const obfs = isPlainObject(node.obfs) ? node.obfs : {};
  return link(node, "hysteria2", encodeURIComponent(node.password || ""), tag, [
    ["sni", tls.server_name || ""],
    ["alpn", joinList(tls.alpn) || "h3"],
    ["insecure", tls.insecure ? "1" : ""],
    ["obfs", obfs.type || ""],
    ["obfs-password", obfs.password || ""],
    ["up", mbps(node, "up_mbps", "up") || ""],
    ["down", mbps(node, "down_mbps", "down") || ""],
    ["pinSHA256", tls.certificate_public_key_sha256 || ""],
  ]);
}

function hysteriaUri(node, tag) {
  const tls = isPlainObject(node.tls) ? node.tls : {};
  // Ядро принимает пароль строкой (auth_str) и base64 (auth); ссылка v1 несёт
  // только строку, поэтому base64 разворачиваем здесь.
  const auth = node.auth_str || (node.auth ? String(node.auth) : "");
  return link(node, "hysteria", "", tag, [
    ["auth", auth],
    ["peer", tls.server_name || ""],
    ["alpn", joinList(tls.alpn)],
    ["insecure", tls.insecure ? "1" : ""],
    ["obfs", node.obfs || ""],
    ["protocol", "udp"],
    ["upmbps", mbps(node, "up_mbps", "up") || ""],
    ["downmbps", mbps(node, "down_mbps", "down") || ""],
  ]);
}

function tuicUri(node, tag) {
  const tls = isPlainObject(node.tls) ? node.tls : {};
  const userinfo = `${encodeURIComponent(node.uuid || "")}:${encodeURIComponent(node.password || "")}`;
  return link(node, "tuic", userinfo, tag, [
    ["sni", tls.server_name || ""],
    ["alpn", joinList(tls.alpn) || "h3"],
    ["congestion_control", node.congestion_control || ""],
    ["udp_relay_mode", node.udp_relay_mode || ""],
    ["zero_rtt_handshake", node.zero_rtt_handshake ? "1" : ""],
    ["disable_sni", tls.disable_sni ? "1" : ""],
    ["insecure", tls.insecure ? "1" : ""],
  ]);
}

function anytlsUri(node, tag) {
  const tls = isPlainObject(node.tls) ? node.tls : {};
  const utls = isPlainObject(tls.utls) && tls.utls.enabled !== false ? tls.utls : null;
  return link(node, "anytls", encodeURIComponent(node.password || ""), tag, [
    ["sni", tls.server_name || ""],
    ["alpn", joinList(tls.alpn)],
    ["fp", utls?.fingerprint || ""],
    ["insecure", tls.insecure ? "1" : ""],
  ]);
}

function socksUri(node, tag) {
  const version = String(node.version ?? "5");
  const scheme = version === "4" ? "socks4" : (version === "4a" ? "socks4a" : "socks5");
  const userinfo = credentialsUserinfo(node.username, node.password);
  return link(node, scheme, userinfo, tag, []);
}

const URI_BUILDERS = {
  vless: vlessUri,
  trojan: trojanUri,
  vmess: vmessUri,
  shadowsocks: shadowsocksUri,
  hysteria2: hysteria2Uri,
  hysteria: hysteriaUri,
  tuic: tuicUri,
  anytls: anytlsUri,
  socks: socksUri,
};

/**
 * Один outbound sing-box → share-ссылка. null — это не сервер (группа, direct)
 * либо протокол, которого у Ninety нет.
 * @returns {{link: string} | {unsupported: string} | null}
 */
export function singboxOutboundToLink(outbound) {
  if (!isPlainObject(outbound)) return null;
  const type = String(outbound.type || "").toLowerCase();
  if (!type || NON_SERVER_TYPES.has(type)) return null;
  if (UNSUPPORTED_TYPES.has(type)) return { unsupported: type };

  const builder = URI_BUILDERS[type];
  if (!builder) return { unsupported: type };
  // Нода за чужим detour — не самостоятельный сервер: без цепочки она пойдёт
  // напрямую, то есть будет вести себя не так, как в конфиге, откуда пришла.
  if (outbound.detour) return { unsupported: `${type}+detour` };
  // Диапазон портов hysteria2 (server_ports) в ссылку не укладывается, и
  // ядро без него подключится не туда.
  if (!outbound.server || !Number.isInteger(Number(outbound.server_port))) {
    return { unsupported: type };
  }
  return { link: builder(outbound, outbound.tag || "") };
}

// ── WireGuard: endpoints, а не outbounds ───────────────────
// Своей share-ссылки у WireGuard нет, поэтому endpoint кладём прямо в модель
// профиля — ту же, что даёт импорт .conf. Через .conf этот путь пустить нельзя:
// reserved-байты (WARP) в ini-формате wg-quick не выражаются.
function wireguardProfile(endpoint) {
  const address = Array.isArray(endpoint.address) ? endpoint.address.map(String) : [];
  const peers = (Array.isArray(endpoint.peers) ? endpoint.peers : []).map((peer) => {
    const out = {
      host: String(peer.address ?? "").replace(/^\[|\]$/g, ""),
      port: Number(peer.port) || 0,
      publicKey: String(peer.public_key ?? "").trim(),
      presharedKey: String(peer.pre_shared_key ?? "").trim(),
      allowedIps: Array.isArray(peer.allowed_ips) && peer.allowed_ips.length
        ? peer.allowed_ips.map(String)
        : ["0.0.0.0/0", "::/0"],
      keepalive: Number(peer.persistent_keepalive_interval) || 0,
    };
    if (Array.isArray(peer.reserved) && peer.reserved.length === 3) {
      out.reserved = peer.reserved.map(Number);
    }
    return out;
  });
  if (!peers.length) return null;
  const amnezia = isPlainObject(endpoint.noise?.amnezia) ? endpoint.noise.amnezia : {};
  const num = (key) => Number(amnezia[key]) || 0;
  const primary = peers[0];
  return {
    raw: `wg-conf://${primary.host}:${primary.port}`,
    proto: "wireguard",
    name: endpoint.tag || primary.host,
    host: primary.host,
    port: primary.port,
    privateKey: String(endpoint.private_key ?? "").trim(),
    addresses: address,
    mtu: Number(endpoint.mtu) || 0,
    listenPort: Number(endpoint.listen_port) || 0,
    peers,
    awg: {
      jc: num("jc"), jmin: num("jmin"), jmax: num("jmax"),
      s1: num("s1"), s2: num("s2"),
      h1: num("h1"), h2: num("h2"), h3: num("h3"), h4: num("h4"),
      i1: amnezia.i1 || "", i2: amnezia.i2 || "", i3: amnezia.i3 || "",
      i4: amnezia.i4 || "", i5: amnezia.i5 || "",
    },
    ignored: [],
  };
}

/**
 * Готовый конфиг sing-box → профили Ninety.
 * @param {string|object} input текст конфига или уже разобранный объект
 * @returns {{profiles: object[], skipped: number, unsupported: string[]}}
 */
export function parseSingboxConfig(input) {
  const root = typeof input === "string" ? safeJsonParse(input) : input;
  if (!root) return { profiles: [], skipped: 0, unsupported: [] };

  // Принимаем и целый конфиг, и голый массив outbound'ов, и массив конфигов:
  // разные панели отдают всё три вида, а разница видна только по содержимому.
  const configs = Array.isArray(root) ? root.filter(isPlainObject) : (isPlainObject(root) ? [root] : []);
  const outbounds = [];
  const endpoints = [];
  for (const config of configs) {
    if (Array.isArray(config.outbounds)) outbounds.push(...config.outbounds.filter(isPlainObject));
    else if (config.type) outbounds.push(config);
    if (Array.isArray(config.endpoints)) endpoints.push(...config.endpoints.filter(isPlainObject));
  }

  const profiles = [];
  const unsupported = [];
  let skipped = 0;

  for (const outbound of outbounds) {
    const result = singboxOutboundToLink(outbound);
    if (!result) continue;
    if (result.unsupported) {
      skipped++;
      if (!unsupported.includes(result.unsupported)) unsupported.push(result.unsupported);
      continue;
    }
    try {
      profiles.push(parseLink(result.link));
    } catch (e) {
      skipped++;
      console.warn("sb-config: skip outbound", outbound?.tag, e?.message);
    }
  }

  // WireGuard в sing-box 1.13 живёт в endpoints; конфиги постарше держат его
  // среди outbounds — принимаем оба размещения.
  const isWireguard = (e) => String(e.type || "").toLowerCase() === "wireguard";
  const wireguards = [...endpoints.filter(isWireguard), ...outbounds.filter(isWireguard)];
  for (const endpoint of wireguards) {
    if (endpoint.detour) {
      skipped++;
      if (!unsupported.includes("wireguard+detour")) unsupported.push("wireguard+detour");
      continue;
    }
    const profile = wireguardProfile(endpoint);
    if (profile) profiles.push(profile);
    else skipped++;
  }

  return { profiles, skipped, unsupported };
}
