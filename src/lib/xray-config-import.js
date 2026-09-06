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
      // Подопции xhttp едут в `extra` целиком, в Xray-схеме: их разбирает
      // сборщик конфига (mergeXhttpExtra) и эмитит только то, что знает форк.
      // Без них download-канал уходит в дефолт и сервер рвёт handshake.
      const extra = Object.keys(xh).length ? JSON.stringify(xh) : "";
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
      return { type: network, params: [["headerType", headerType(tcp)]] };
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
function vnextEntries(settings) {
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
    // В формате v2rayN `type` — это заголовок маскировки, а не транспорт.
    type: flat.headerType || "none",
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
  return (settings?.servers || []).filter(isPlainObject);
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
};

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
      for (const link of result.links) {
        try {
          const profile = parseLink(link);
          profiles.push(name ? { ...profile, name } : profile);
        } catch (e) {
          skipped++;
          console.warn("xray-config: skip outbound", outbound.tag, e?.message);
        }
      }
    }
  }

  return { profiles, skipped, unsupported };
}
