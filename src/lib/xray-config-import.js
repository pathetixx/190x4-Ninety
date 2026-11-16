// Ninety · импорт готового конфига Xray (JSON) → профили.
//
// Устроен как импортёр sing-box (см. /lib/singbox-config-import.js): outbound
// раскладывается по параметрам share-ссылки и разбирается тем же parseLink.
//
// Отличие формата: подписка Xray у панелей — это, как правило, **массив целых
// конфигов** (формат v2rayN), а не один конфиг. Имя сервера в таком массиве
// лежит в `remarks` самого конфига, а теги outbound'ов служебные («proxy»,
// «proxy-1»), поэтому имя берём из remarks.
//
// Что не переносится: маршрутизация, DNS, inbounds, balancers/observatory и
// mux — это политика приложения, у Ninety она своя.
//
// Исключение — сервер, который в ссылку не помещается: маскировка `finalmask`
// (например, XMC — трафик под вход в Minecraft), постквантовое шифрование
// VLESS (`encryption` ≠ none) и т.п. Такой outbound едет в профиль целиком
// (proto "xray") и поднимается локальным xray-мостом как есть: перевод в
// ссылку молча выкинул бы ровно то, без чего сервер не отвечает.

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

// Исходящие, которые не ведут ни на какой сервер.
const NON_SERVER_PROTOCOLS = new Set([
  "freedom", "blackhole", "dns", "loopback",
]);

// Ядро Xray их умеет, а Ninety как профиль не заводит.
const UNSUPPORTED_PROTOCOLS = new Set([
  "http", "shadowsocksr", "vlite", "mtproto",
]);

function configList(root) {
  if (Array.isArray(root)) return root.filter(isPlainObject);
  return isPlainObject(root) ? [root] : [];
}

// ── streamSettings → параметры ссылки ──────────────────────
function tlsParams(stream) {
  const security = String(stream.security || "none").toLowerCase();
  if (security === "none" || !security) return { security: "none", params: [] };
  // xtls жил только в старых Xray и на провод давал обычный TLS.
  const reality = security === "reality";
  const ts = (reality ? stream.realitySettings : stream.tlsSettings) || {};
  const params = [
    ["sni", ts.serverName || ts.server_name || ""],
    ["alpn", joinList(ts.alpn)],
    ["fp", ts.fingerprint || ""],
  ];
  if (ts.allowInsecure || ts.insecure) params.push(["allowInsecure", "1"]);
  if (reality) {
    params.push(
      ["pbk", ts.publicKey || ts.public_key || ""],
      ["sid", ts.shortId || ts.short_id || ""],
    );
  }
  return { security: reality ? "reality" : "tls", params };
}

function headerType(settings) {
  return settings?.header?.type || "";
}

// Поля xhttp, которые ссылка несёт отдельными параметрами (и сам вложенный extra).
const XHTTP_LINK_FIELDS = new Set(["host", "path", "mode", "extra"]);

function transportParams(stream) {
  const network = String(stream.network || "tcp").toLowerCase();
  switch (network) {
    case "ws": {
      const ws = stream.wsSettings || {};
      return {
        type: "ws",
        params: [
          ["path", ws.path || ""],
          ["host", ws.host || joinList(ws.headers?.Host) || ""],
          // Ранняя передача жила отдельными полями только в старых Xray;
          // нынешний пишет её в путь как «?ed=», и путь мы не трогаем.
          ["ed", numberOrNull(ws.maxEarlyData) || ""],
          ["eh", ws.earlyDataHeaderName || ""],
        ],
      };
    }
    case "grpc": {
      const grpc = stream.grpcSettings || {};
      return {
        type: "grpc",
        params: [
          ["serviceName", grpc.serviceName || ""],
          ["mode", grpc.multiMode ? "multi" : ""],
        ],
      };
    }
    case "http":
    case "h2": {
      const http = stream.httpSettings || {};
      return {
        type: "http",
        params: [["path", http.path || ""], ["host", joinList(http.host)]],
      };
    }
    case "httpupgrade": {
      const hu = stream.httpupgradeSettings || {};
      return {
        type: "httpupgrade",
        params: [["path", hu.path || ""], ["host", hu.host || ""]],
      };
    }
    case "quic": {
      const quic = stream.quicSettings || {};
      return {
        type: "quic",
        params: [
          ["quicSecurity", quic.security || ""],
          ["headerType", headerType(quic)],
        ],
      };
    }
    case "kcp": {
      const kcp = stream.kcpSettings || {};
      return {
        type: "kcp",
        params: [["headerType", headerType(kcp)], ["seed", kcp.seed || ""]],
      };
    }
    case "xhttp":
    case "splithttp": {
      const xh = stream.xhttpSettings || stream.splithttpSettings || {};
      // Подопции xhttp едут в `extra` в Xray-схеме: их разбирает сборщик
      // конфига (mergeXhttpExtra) и эмитит только то, что знает форк. Без них
      // download-канал уходит в дефолт и сервер рвёт handshake.
      // Форма — как у параметра `extra` в ссылке: подопции плоско, без
      // host/path/mode (они отдельными параметрами). Панели пишут их и прямо в
      // xhttpSettings, и во вложенный xhttpSettings.extra — сводим к одному,
      // иначе сборщик не нашёл бы вложенные, а тот же сервер из JSON и из
      // ссылки различался бы отпечатком.
      const options = Object.fromEntries(Object.entries(xh)
        .filter(([key]) => !XHTTP_LINK_FIELDS.has(key)));
      if (isPlainObject(xh.extra)) Object.assign(options, xh.extra);
      const extra = Object.keys(options).length ? JSON.stringify(options) : "";
      return {
        type: "xhttp",
        params: [
          ["path", xh.path || ""],
          ["host", xh.host || ""],
          ["mode", xh.mode || ""],
          ["extra", extra],
        ],
      };
    }
    case "tcp":
    case "raw":
    default: {
      const tcp = stream.tcpSettings || stream.rawSettings || {};
      // «none» у TCP — то же, что отсутствие маскировки; ссылка его не пишет.
      // Иначе тот же сервер из JSON и из списка ссылок различался бы одним
      // этим полем: смена формата подписки сбрасывала бы выбор сервера.
      const header = headerType(tcp);
      return { type: network, params: [["headerType", header === "none" ? "" : header]] };
    }
  }
}

function streamParams(outbound) {
  const stream = isPlainObject(outbound.streamSettings) ? outbound.streamSettings : {};
  const tls = tlsParams(stream);
  const transport = transportParams(stream);
  return [
    ["security", tls.security],
    ["type", transport.type],
    ...tls.params,
    ...transport.params,
  ];
}

// ── outbound → набор серверов ──────────────────────────────
// vnext/servers — массивы, у vless/vmess внутри ещё и users: один outbound
// Xray описывает несколько серверов. Разворачиваем всё, что там лежит.
// Xray 26 пишет outbound и «плоско»: address/port/id прямо в settings, без
// vnext/servers. Такой сервер ровно один, а пользователь — сами settings.
function flatServer(settings) {
  return isPlainObject(settings) && settings.address !== undefined && !settings.vnext && !settings.servers;
}

function vnextEntries(settings) {
  if (flatServer(settings)) return [{ vnext: settings, user: settings }];
  const out = [];
  for (const vnext of settings?.vnext || []) {
    for (const user of vnext?.users || []) out.push({ vnext, user });
  }
  return out;
}

function vlessLinks(outbound) {
  const params = streamParams(outbound);
  return vnextEntries(outbound.settings).map(({ vnext, user }) => buildShareLink({
    scheme: "vless",
    userinfo: encodeURIComponent(user.id || ""),
    server: vnext.address,
    port: vnext.port,
    params: [["encryption", user.encryption || "none"], ["flow", user.flow || ""], ...params],
  }));
}

function vmessLinks(outbound) {
  const stream = isPlainObject(outbound.streamSettings) ? outbound.streamSettings : {};
  const network = String(stream.network || "tcp").toLowerCase();
  const security = String(stream.security || "none").toLowerCase();
  const ts = (security === "reality" ? stream.realitySettings : stream.tlsSettings) || {};
  const flat = Object.fromEntries(transportParams(stream).params);
  return vnextEntries(outbound.settings).map(({ vnext, user }) => buildVmessLink({
    v: "2",
    ps: "",
    add: bareHost(vnext.address),
    port: String(vnext.port ?? ""),
    id: user.id || "",
    aid: String(user.alterId ?? 0),
    scy: user.security || "auto",
    net: network === "h2" ? "http" : network,
    // В формате v2rayN `type` — это заголовок маскировки, а не транспорт. У xhttp
    // это поле несёт mode: «none» здесь Xray отверг бы как неизвестный режим.
    type: network === "xhttp" ? (flat.mode || "") : (flat.headerType || "none"),
    ...(network === "xhttp" && flat.extra ? { extra: flat.extra } : {}),
    host: flat.host || "",
    // Одно поле `path` обслуживает путь у ws/http, имя сервиса у grpc и seed
    // у mKCP — парсер читает его ровно так же.
    path: network === "grpc" ? (flat.serviceName || "") : (flat.path || flat.seed || ""),
    tls: security === "none" ? "" : (security === "reality" ? "reality" : "tls"),
    sni: ts.serverName || "",
    alpn: joinList(ts.alpn),
    fp: ts.fingerprint || "",
    ...(ts.allowInsecure ? { allowInsecure: true } : {}),
  }, ""));
}

function serverEntries(settings) {
  if (flatServer(settings)) return [settings];
  return (settings?.servers || []).filter(isPlainObject);
}

// ── finalmask ──────────────────────────────────────────────
// Маски слоя под транспортом: { tcp: [...], udp: [...] }, каждая — {type, settings}.
function finalmaskEntries(stream) {
  const fm = isPlainObject(stream?.finalmask) ? stream.finalmask : null;
  if (!fm) return [];
  return Object.values(fm).flatMap(list => (Array.isArray(list) ? list.filter(isPlainObject) : []));
}

// Hysteria в Xray — это протокол + транспорт, а obfs у него — маска salamander.
// Её ссылка hysteria2:// передаёт; всё прочее (udphop, TCP-маски) — нет.
function hysteriaSalamander(stream) {
  const masks = finalmaskEntries(stream);
  if (!masks.length) return { ok: true, password: "" };
  const fm = stream.finalmask;
  const onlySalamander = masks.length === 1
    && Array.isArray(fm.udp) && fm.udp.length === 1
    && String(masks[0].type || "").toLowerCase() === "salamander";
  return onlySalamander
    ? { ok: true, password: String(masks[0].settings?.password || "") }
    : { ok: false, password: "" };
}

function hysteriaLinks(outbound) {
  const stream = isPlainObject(outbound.streamSettings) ? outbound.streamSettings : {};
  const hy = stream.hysteriaSettings || {};
  if (Number(hy.version ?? outbound.settings?.version ?? 2) !== 2) return [];
  const ts = stream.tlsSettings || {};
  const { password } = hysteriaSalamander(stream);
  return serverEntries(outbound.settings).map(server => buildShareLink({
    scheme: "hysteria2",
    userinfo: encodeURIComponent(hy.auth || server.password || ""),
    server: server.address,
    port: server.port,
    params: [
      ["sni", ts.serverName || ""],
      ["alpn", joinList(ts.alpn)],
      ["insecure", ts.allowInsecure ? "1" : ""],
      ["obfs", password ? "salamander" : ""],
      ["obfs-password", password],
    ],
  }));
}

function trojanLinks(outbound) {
  const params = streamParams(outbound);
  return serverEntries(outbound.settings).map(server => buildShareLink({
    scheme: "trojan",
    userinfo: encodeURIComponent(server.password || ""),
    server: server.address,
    port: server.port,
    params,
  }));
}

function shadowsocksLinks(outbound) {
  return serverEntries(outbound.settings).map(server => buildShareLink({
    scheme: "ss",
    userinfo: shadowsocksUserinfo(server.method, server.password),
    server: server.address,
    port: server.port,
    params: [],
  }));
}

function socksLinks(outbound) {
  return serverEntries(outbound.settings).map((server) => {
    const user = (server.users || [])[0] || {};
    return buildShareLink({
      scheme: "socks5",
      userinfo: credentialsUserinfo(user.user, user.pass),
      server: server.address,
      port: server.port,
      params: [],
    });
  });
}

const LINK_BUILDERS = {
  vless: vlessLinks,
  vmess: vmessLinks,
  trojan: trojanLinks,
  shadowsocks: shadowsocksLinks,
  socks: socksLinks,
  hysteria: hysteriaLinks,
};

// ── сервер, который в ссылку не помещается ─────────────────
// Протоколы, которые локальный xray-мост поднимет из outbound как есть.
const RAW_PROTOCOLS = new Set(["vless", "vmess", "trojan", "shadowsocks", "hysteria"]);
// Что ссылка передаёт без потерь. Всё прочее — повод везти outbound целиком.
const LINK_NETWORKS = new Set([
  "", "tcp", "raw", "ws", "grpc", "http", "h2", "httpupgrade", "quic", "kcp", "xhttp", "splithttp",
]);
const LINK_SECURITY = new Set(["", "none", "tls", "reality"]);

function vlessEncryption(settings) {
  if (flatServer(settings)) return String(settings.encryption || "");
  return String(settings?.vnext?.[0]?.users?.[0]?.encryption || "");
}

/**
 * Почему outbound нельзя передать ссылкой (null — можно).
 * @returns {string|null}
 */
export function rawOutboundReason(outbound) {
  const protocol = String(outbound?.protocol || "").toLowerCase();
  if (!RAW_PROTOCOLS.has(protocol)) return null;
  const stream = isPlainObject(outbound.streamSettings) ? outbound.streamSettings : {};
  if (protocol === "hysteria") return hysteriaSalamander(stream).ok ? null : "finalmask";
  if (finalmaskEntries(stream).length) return "finalmask";
  const encryption = vlessEncryption(outbound.settings).toLowerCase();
  if (protocol === "vless" && encryption && encryption !== "none") return "encryption";
  if (!LINK_NETWORKS.has(String(stream.network || "").toLowerCase())) return "network";
  if (!LINK_SECURITY.has(String(stream.security || "").toLowerCase())) return "security";
  return null;
}

function rawEndpoint(settings) {
  if (flatServer(settings)) return { host: settings.address, port: settings.port, count: 1 };
  const vnext = (settings?.vnext || []).filter(isPlainObject);
  if (vnext.length) {
    const users = vnext.reduce((n, v) => n + (Array.isArray(v.users) ? v.users.length : 0), 0);
    return { host: vnext[0].address, port: vnext[0].port, count: Math.max(vnext.length, users) };
  }
  const servers = serverEntries(settings);
  return { host: servers[0]?.address, port: servers[0]?.port, count: servers.length };
}

// Короткая метка для списка серверов: по ней пользователь видит, чем этот
// сервер отличается от обычного (XMC, а не безликое VLESS).
function rawLabel(outbound, reason) {
  const stream = outbound.streamSettings || {};
  const masks = finalmaskEntries(stream)
    .map(mask => String(mask.type || "").toUpperCase())
    .filter(type => type && type !== "SALAMANDER");
  if (masks.length) return [...new Set(masks)].join("+");
  if (reason === "encryption") return "VLESS ML-KEM";
  return String(outbound.protocol || "xray").toUpperCase();
}

// Глубокая копия без служебных полей конфига-источника: tag назначит сборщик,
// а dialerProxy/proxySettings ссылались на соседей по исходному конфигу
// (фрагментация у Ninety своя, цепочки отсеяны раньше).
function detachedOutbound(outbound) {
  const copy = JSON.parse(JSON.stringify(outbound));
  delete copy.tag;
  delete copy.proxySettings;
  delete copy.sendThrough;
  const sockopt = copy.streamSettings?.sockopt;
  if (isPlainObject(sockopt)) {
    delete sockopt.dialerProxy;
    if (!Object.keys(sockopt).length) delete copy.streamSettings.sockopt;
  }
  return copy;
}

function rawProfile(outbound, name, reason) {
  const { host, port, count } = rawEndpoint(outbound.settings);
  const portNumber = Number(port);
  // Один outbound — один сервер: несколько адресов внутри никто, кроме
  // балансировщика панели, не пишет, а различать их в списке нечем.
  if (count !== 1 || !host || !Number.isInteger(portNumber)) return null;
  return {
    proto: "xray",
    name: name || `${host}:${portNumber}`,
    host: bareHost(host),
    port: portNumber,
    label: rawLabel(outbound, reason),
    outbound: detachedOutbound(outbound),
  };
}

// ── WireGuard ──────────────────────────────────────────────
// В Xray это обычный outbound, а не endpoint, и имена полей свои
// (secretKey/publicKey/endpoint). Своей share-ссылки у протокола нет, поэтому
// кладём прямо в модель профиля — как и у импортёра sing-box.
function wireguardProfile(outbound, name) {
  const settings = isPlainObject(outbound.settings) ? outbound.settings : {};
  const peers = (settings.peers || []).filter(isPlainObject).map((peer) => {
    const endpoint = String(peer.endpoint ?? "").trim();
    const close = endpoint.lastIndexOf(":");
    const host = close > 0 ? endpoint.slice(0, close) : endpoint;
    const port = close > 0 ? Number(endpoint.slice(close + 1)) : 0;
    return {
      host: bareHost(host),
      port: Number.isFinite(port) ? port : 0,
      publicKey: String(peer.publicKey ?? "").trim(),
      presharedKey: String(peer.preSharedKey ?? "").trim(),
      allowedIps: Array.isArray(peer.allowedIPs) && peer.allowedIPs.length
        ? peer.allowedIPs.map(String)
        : ["0.0.0.0/0", "::/0"],
      keepalive: Number(peer.keepAlive) || 0,
      ...(Array.isArray(settings.reserved) && settings.reserved.length === 3
        ? { reserved: settings.reserved.map(Number) }
        : {}),
    };
  });
  if (!peers.length) return null;
  const primary = peers[0];
  return {
    raw: `wg-conf://${primary.host}:${primary.port}`,
    proto: "wireguard",
    name: name || primary.host,
    host: primary.host,
    port: primary.port,
    privateKey: String(settings.secretKey ?? "").trim(),
    addresses: Array.isArray(settings.address) ? settings.address.map(String) : [],
    mtu: Number(settings.mtu) || 0,
    listenPort: 0,
    peers,
    // Шейпинга AmneziaWG у Xray нет.
    awg: {
      jc: 0, jmin: 0, jmax: 0, s1: 0, s2: 0, h1: 0, h2: 0, h3: 0, h4: 0,
      i1: "", i2: "", i3: "", i4: "", i5: "",
    },
    ignored: [],
  };
}

// Fragment у Xray — это отдельный freedom-outbound, на который сервер ссылается
// через sockopt.dialerProxy. Такая ссылка путь до сервера не меняет (у Ninety
// фрагментация своя, общая для приложения), поэтому ноду берём. А вот
// dialerProxy на настоящий прокси — это цепочка, и без неё нода пошла бы
// напрямую: не наш случай, называем и пропускаем.
function chainedThroughProxy(outbound, byTag) {
  const target = outbound?.streamSettings?.sockopt?.dialerProxy;
  if (!target) return false;
  const protocol = String(byTag.get(target) || "").toLowerCase();
  return !!protocol && !NON_SERVER_PROTOCOLS.has(protocol);
}

/**
 * Один outbound Xray → ссылки (их может быть несколько: vnext/servers/users —
 * массивы) либо профиль напрямую (WireGuard).
 * @returns {{links: string[]} | {profile: object} | {unsupported: string} | null}
 */
export function xrayOutboundToLinks(outbound, name = "", byTag = new Map()) {
  if (!isPlainObject(outbound)) return null;
  const protocol = String(outbound.protocol || "").toLowerCase();
  if (!protocol || NON_SERVER_PROTOCOLS.has(protocol)) return null;
  if (UNSUPPORTED_PROTOCOLS.has(protocol)) return { unsupported: protocol };

  if (chainedThroughProxy(outbound, byTag)) return { unsupported: `${protocol}+chain` };

  if (protocol === "wireguard") {
    const profile = wireguardProfile(outbound, name);
    return profile ? { profile } : { unsupported: "wireguard" };
  }

  const reason = rawOutboundReason(outbound);
  if (reason) {
    const profile = rawProfile(outbound, name, reason);
    return profile ? { profile } : { unsupported: `${protocol}+${reason}` };
  }

  const builder = LINK_BUILDERS[protocol];
  if (!builder) return { unsupported: protocol };
  const links = builder(outbound).filter(link => !/:(?:NaN|0)(?:[?#]|$)/.test(link));
  return links.length ? { links } : { unsupported: protocol };
}

/**
 * Готовый конфиг Xray (или массив конфигов) → профили Ninety.
 * @returns {{profiles: object[], skipped: number, unsupported: string[]}}
 */
export function parseXrayConfig(input) {
  const root = typeof input === "string" ? safeJsonParse(input) : input;
  if (!root) return { profiles: [], skipped: 0, unsupported: [] };

  const profiles = [];
  const unsupported = [];
  let skipped = 0;
  const note = (reason) => {
    skipped++;
    if (!unsupported.includes(reason)) unsupported.push(reason);
  };

  for (const config of configList(root)) {
    const outbounds = Array.isArray(config.outbounds)
      ? config.outbounds.filter(isPlainObject)
      // Голый массив outbound'ов: элемент списка и есть outbound.
      : (config.protocol ? [config] : []);
    const byTag = new Map(outbounds.map(o => [o.tag, String(o.protocol || "").toLowerCase()]));
    // Имя сервера у подписки-массива лежит в remarks конфига; служебный тег
    // outbound'а («proxy-3») пользователю не говорит ничего.
    const remarks = String(config.remarks || "").trim();
    const servers = outbounds.filter(o => {
      const protocol = String(o.protocol || "").toLowerCase();
      return protocol && !NON_SERVER_PROTOCOLS.has(protocol);
    });

    for (const outbound of servers) {
      // Конфиг с одним сервером именуется своим remarks; если серверов
      // несколько (у панелей это конфиг-балансировщик), различаем их тегом.
      const base = remarks || String(outbound.tag || "");
      const name = servers.length > 1 && remarks && outbound.tag
        ? `${remarks} · ${outbound.tag}`
        : base;
      const result = xrayOutboundToLinks(outbound, name, byTag);
      if (!result) continue;
      if (result.unsupported) { note(result.unsupported); continue; }
      if (result.profile) { profiles.push(result.profile); continue; }
      // Один outbound разворачивается в несколько ссылок, когда в `vnext`
      // перечислено больше одного пользователя (или в `servers` — больше одного
      // адреса). Это разные серверы, и общее имя конфига делало их в списке
      // неразличимыми — нумеруем.
      const numbered = result.links.length > 1;
      for (const [index, link] of result.links.entries()) {
        try {
          const profile = parseLink(link);
          const base = name || profile.name || profile.host || "";
          const label = numbered ? `${base} · ${index + 1}`.trim() : name;
          profiles.push(label ? { ...profile, name: label } : profile);
        } catch (e) {
          skipped++;
          console.warn("xray-config: skip outbound", outbound.tag, e?.message);
        }
      }
    }
  }

  return { profiles, skipped, unsupported };
}
