// Ninety · importing a ready Xray config (JSON) → profiles.
//
// Built like the sing-box importer (see /lib/singbox-config-import.js): an outbound
// is laid out into share link parameters and parsed by the same parseLink.
//
// The format difference: a panel's Xray subscription is usually **an array of whole
// configs** (the v2rayN format), not a single config. The server name in such an array
// lies in the config's own `remarks`, while outbound tags are service ones ("proxy",
// "proxy-1"), so we take the name from remarks.
//
// What doesn't carry over: routing, DNS, inbounds, balancers/observatory and
// mux — that's app policy, Ninety has its own.
//
// The exception is a server that doesn't fit into a link: `finalmask` disguise
// (e.g. XMC — traffic disguised as a Minecraft login), post-quantum VLESS
// encryption (`encryption` ≠ none), etc. Such an outbound goes into the profile in full
// (proto "xray") and is brought up by the local xray bridge as is: converting it into
// a link would silently throw away exactly what the server doesn't respond without.

import { parseLink, stripXrayFileFields } from "/lib/protocol-parsers.js";
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

// Outbounds that don't lead to any server.
const NON_SERVER_PROTOCOLS = new Set([
  "freedom", "blackhole", "dns", "loopback",
]);

// The Xray core supports them, but Ninety doesn't create them as a profile.
const UNSUPPORTED_PROTOCOLS = new Set([
  "http", "shadowsocksr", "vlite", "mtproto",
]);

function configList(root) {
  if (Array.isArray(root)) return root.filter(isPlainObject);
  return isPlainObject(root) ? [root] : [];
}

// ── streamSettings → link parameters ──────────────────────
function tlsParams(stream) {
  const security = String(stream.security || "none").toLowerCase();
  if (security === "none" || !security) return { security: "none", params: [] };
  // xtls lived only in old Xray and produced regular TLS on the wire.
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

// xhttp fields the link carries as separate parameters (and the nested extra itself).
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
          // Early data lived in separate fields only in old Xray;
          // the current one writes it into the path as "?ed=", and we don't touch the path.
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
      // xhttp sub-options go into `extra` in the Xray schema: they're parsed by the config
      // builder (mergeXhttpExtra), which emits only what the fork knows. Without them
      // the download channel falls back to the default and the server breaks the handshake.
      // The shape is like the link's `extra` parameter: sub-options flat, without
      // host/path/mode (those are separate parameters). Panels write them both directly into
      // xhttpSettings and into the nested xhttpSettings.extra — we reduce them to one,
      // otherwise the builder wouldn't find the nested ones, and the same server from JSON and from
      // a link would differ by fingerprint.
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
      // "none" for TCP is the same as no masking; the link doesn't write it.
      // Otherwise the same server from JSON and from the link list would differ by this one
      // field: changing the subscription format would reset the server choice.
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

// ── outbound → set of servers ──────────────────────────────
// vnext/servers are arrays, and vless/vmess also have users inside: one Xray outbound
// describes several servers. We expand everything that's in there.
// Xray 26 also writes an outbound "flat": address/port/id directly in settings, without
// vnext/servers. There's exactly one such server, and the user is settings itself.
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
    // In the v2rayN format `type` is the masking header, not the transport. For xhttp
    // this field carries mode: Xray would reject "none" here as an unknown mode.
    type: network === "xhttp" ? (flat.mode || "") : (flat.headerType || "none"),
    ...(network === "xhttp" && flat.extra ? { extra: flat.extra } : {}),
    host: flat.host || "",
    // One `path` field serves the path for ws/http, the service name for grpc and the seed
    // for mKCP — the parser reads it exactly the same way.
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
// Masks of the layer under the transport: { tcp: [...], udp: [...] }, each — {type, settings}.
function finalmaskEntries(stream) {
  const fm = isPlainObject(stream?.finalmask) ? stream.finalmask : null;
  if (!fm) return [];
  return Object.values(fm).flatMap(list => (Array.isArray(list) ? list.filter(isPlainObject) : []));
}

// Hysteria in Xray is a protocol + a transport, and its obfs is the salamander mask.
// A hysteria2:// link carries it; everything else (udphop, TCP masks) — no.
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

// ── a server that doesn't fit into a link ─────────────────
// Protocols the local xray bridge will bring up from an outbound as is.
const RAW_PROTOCOLS = new Set(["vless", "vmess", "trojan", "shadowsocks", "hysteria"]);
// What a link carries without losses. Everything else is a reason to carry the outbound in full.
const LINK_NETWORKS = new Set([
  "", "tcp", "raw", "ws", "grpc", "http", "h2", "httpupgrade", "quic", "kcp", "xhttp", "splithttp",
]);
const LINK_SECURITY = new Set(["", "none", "tls", "reality"]);

function vlessEncryption(settings) {
  if (flatServer(settings)) return String(settings.encryption || "");
  return String(settings?.vnext?.[0]?.users?.[0]?.encryption || "");
}

/**
 * Why the outbound can't be carried by a link (null — it can).
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

// A short label for the server list: from it the user sees what sets this
// server apart from a regular one (XMC, not a faceless VLESS).
function rawLabel(outbound, reason) {
  const stream = outbound.streamSettings || {};
  const masks = finalmaskEntries(stream)
    .map(mask => String(mask.type || "").toUpperCase())
    .filter(type => type && type !== "SALAMANDER");
  if (masks.length) return [...new Set(masks)].join("+");
  if (reason === "encryption") return "VLESS ML-KEM";
  return String(outbound.protocol || "xray").toUpperCase();
}

// A deep copy without the source config's service fields: the builder will assign the tag,
// and dialerProxy/proxySettings referenced neighbors in the original config
// (Ninety has its own fragmentation, chains were weeded out earlier).
function detachedOutbound(outbound) {
  const copy = stripXrayFileFields(JSON.parse(JSON.stringify(outbound)));
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
  // One outbound — one server: nobody except the panel's balancer writes several addresses
  // inside, and there's nothing to tell them apart by in the list.
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
// In Xray this is a regular outbound, not an endpoint, and the field names are its own
// (secretKey/publicKey/endpoint). The protocol has no share link of its own, so
// we put it straight into the profile model — as the sing-box importer does.
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
    // Xray has no AmneziaWG shaping.
    awg: {
      jc: 0, jmin: 0, jmax: 0, s1: 0, s2: 0, h1: 0, h2: 0, h3: 0, h4: 0,
      i1: "", i2: "", i3: "", i4: "", i5: "",
    },
    ignored: [],
  };
}

// A fragment in Xray is a separate freedom outbound the server references
// via sockopt.dialerProxy. Such a reference doesn't change the path to the server (Ninety
// has its own app-wide fragmentation), so we take the node. But
// a dialerProxy to a real proxy is a chain, and without it the node would go
// direct: not our case, we name it and skip it.
function chainedThroughProxy(outbound, byTag) {
  const target = outbound?.streamSettings?.sockopt?.dialerProxy;
  if (!target) return false;
  const protocol = String(byTag.get(target) || "").toLowerCase();
  return !!protocol && !NON_SERVER_PROTOCOLS.has(protocol);
}

/**
 * One Xray outbound → links (there may be several: vnext/servers/users are
 * arrays) or a profile directly (WireGuard).
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
 * A ready Xray config (or an array of configs) → Ninety profiles.
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
      // A bare array of outbounds: each element of the list is an outbound.
      : (config.protocol ? [config] : []);
    const byTag = new Map(outbounds.map(o => [o.tag, String(o.protocol || "").toLowerCase()]));
    // The server name of an array subscription lies in the config's remarks; the outbound's service
    // tag ("proxy-3") tells the user nothing.
    const remarks = String(config.remarks || "").trim();
    const servers = outbounds.filter(o => {
      const protocol = String(o.protocol || "").toLowerCase();
      return protocol && !NON_SERVER_PROTOCOLS.has(protocol);
    });

    for (const outbound of servers) {
      // A config with one server is named by its remarks; if there are several
      // servers (for panels this is a balancer config), we tell them apart by the tag.
      const base = remarks || String(outbound.tag || "");
      const name = servers.length > 1 && remarks && outbound.tag
        ? `${remarks} · ${outbound.tag}`
        : base;
      const result = xrayOutboundToLinks(outbound, name, byTag);
      if (!result) continue;
      if (result.unsupported) { note(result.unsupported); continue; }
      if (result.profile) { profiles.push(result.profile); continue; }
      // One outbound expands into several links when `vnext`
      // lists more than one user (or `servers` lists more than one
      // address). These are different servers, and the shared config name made them
      // indistinguishable in the list — we number them.
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
