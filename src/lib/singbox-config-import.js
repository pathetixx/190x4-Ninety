// Ninety · importing a ready sing-box config (JSON) → profiles.
//
// Panels hand out a subscription in two ways: as a list of share links and as an assembled
// core config. Ninety builds the config itself (routing, DNS, kill switch are
// its own), so from a foreign config we take exactly the server part: outbounds and
// endpoints. Each server is first turned into its share link and only
// then parsed by the same parseLink as a regular subscription — see
// /lib/share-link.js on why exactly through a link.
//
// What deliberately does NOT carry over from a foreign config: routing, DNS,
// inbounds, rules, and from the outbounds themselves — mux, tcp_fast_open, ech,
// record_fragment. The former is app policy, the latter are client options
// without which the node works, just without that optimization.

import { parseAwgHeader, parseLink } from "/lib/protocol-parsers.js";
import { safeJsonParse } from "/lib/config-format.js";
import {
  bareHost,
  buildShareLink,
  buildVmessLink,
  credentialsUserinfo,
  hostForUri,
  isPlainObject,
  joinList,
  numberOrNull,
  shadowsocksUserinfo,
} from "/lib/share-link.js";

// Group and system outbounds: these aren't servers, and they must not get into the "skipped"
// counter — otherwise the user sees "4 skipped" on a config
// where there was nothing to skip.
const NON_SERVER_TYPES = new Set([
  "selector", "urltest", "balancer", "direct", "block", "dns", "dns-out",
  "blackhole", "freedom", "loopback",
]);

// Protocols the core supports but Ninety doesn't create as a separate profile.
// We count them as skipped and name the reason — staying silent isn't allowed: they were in the config.
const UNSUPPORTED_TYPES = new Set([
  "http", "shadowtls", "ssh", "tor", "tailscale", "shadowsocksr", "vmess-legacy",
]);

// The core accepts hysteria speeds both as a number (up_mbps) and as a string ("50 Mbps").
function mbps(node, numericKey, stringKey) {
  const direct = numberOrNull(node[numericKey]);
  if (direct) return direct;
  const parsed = parseInt(String(node[stringKey] ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// ── TLS ────────────────────────────────────────────────────
// Returns link parameters in v2rayN terms — the same vocabulary that
// Ninety's parsers read.
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

// ── transport ──────────────────────────────────────────────
// Early data (max_early_data) goes into the link as an ed/eh pair — that's how
// sing-box clients write it, and that's how our parser reads it back. We don't put it into the path
// ("/path?ed=2560", the Xray form): the path stays a path for the core.
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
      // The core has no early data for httpupgrade: writing ed/eh into the link means
      // changing the node fingerprint with a field that goes nowhere.
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
      // An unfamiliar transport isn't passed off as tcp: such a node would be built as regular
      // TCP and silently not work. Let the transport validator reject it.
      return { type, params: [] };
  }
}

// ── outbound → share link ────────────────────────────────
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

// A vmess share link is base64 of v2rayN JSON, not a query string.
function vmessUri(node, tag) {
  const tls = isPlainObject(node.tls) && node.tls.enabled !== false ? node.tls : null;
  const reality = tls && isPlainObject(tls.reality) && tls.reality.enabled !== false;
  const transport = isPlainObject(node.transport) ? node.transport : {};
  const net = String(transport.type || "tcp").toLowerCase();
  // In v2rayN one `path` field serves three different transports: the path for ws/http,
  // the service name for grpc. The parser reads it exactly the same way.
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
    // The v2rayN format has no early data and insecure fields — we add our own.
    // Other clients ignore unknown keys, while for us the config comes back
    // from the link the same as it went in.
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

// server_ports ("20000:30000") → the Hysteria link form ("20000-30000",
// comma-separated). null — no ranges or they're broken.
function hysteria2PortSpec(serverPorts) {
  const list = Array.isArray(serverPorts) ? serverPorts : serverPorts ? [serverPorts] : [];
  if (!list.length) return null;
  const items = [];
  for (const range of list) {
    const m = /^(\d{1,5}):(\d{1,5})$/.exec(String(range).trim());
    if (!m) return null;
    items.push(m[1] === m[2] ? m[1] : `${m[1]}-${m[2]}`);
  }
  return items.join(",");
}

function hysteria2Uri(node, tag) {
  const tls = isPlainObject(node.tls) ? node.tls : {};
  const obfs = isPlainObject(node.obfs) ? node.obfs : {};
  const hopPorts = hysteria2PortSpec(node.server_ports);
  const endpoint = hopPorts ? { ...node, server_port: hopPorts } : node;
  return link(endpoint, "hysteria2", encodeURIComponent(node.password || ""), tag, [
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
  // The core accepts the password as a string (auth_str) and as base64 (auth); a v1 link carries
  // only the string, so we decode the base64 here.
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

// Mieru keeps ports in the query: repeating port/protocol are linked by position.
// The shared link builder uses set(), so append() is needed here.
function mieruUri(node, tag) {
  const query = new URLSearchParams([["profile", "default"]]);
  for (const [key, value] of [
    ["multiplexing", node.multiplexing],
    ["handshake-mode", node.handshake_mode],
    ["mtu", node.mtu],
    ["traffic-pattern", node.traffic_pattern],
  ]) {
    if (value !== undefined && value !== null) query.append(key, String(value));
  }
  const ports = [
    ...(node.server_port !== undefined && node.server_port !== null ? [node.server_port] : []),
    ...(Array.isArray(node.server_ports) ? node.server_ports : []),
  ];
  for (const port of ports) {
    query.append("port", String(port));
    query.append("protocol", String(node.transport ?? ""));
  }
  const userinfo = credentialsUserinfo(node.username, node.password);
  const name = tag ? `#${encodeURIComponent(tag)}` : "";
  return `mierus://${userinfo}@${hostForUri(node.server)}?${query}${name}`;
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
  mieru: mieruUri,
  socks: socksUri,
};

/**
 * One sing-box outbound → a share link. null — it isn't a server (group, direct)
 * or a protocol Ninety doesn't have.
 * @returns {{link: string} | {unsupported: string} | null}
 */
export function singboxOutboundToLink(outbound) {
  if (!isPlainObject(outbound)) return null;
  const type = String(outbound.type || "").toLowerCase();
  if (!type || NON_SERVER_TYPES.has(type)) return null;
  // WireGuard is parsed by a separate parseSingboxConfig branch — the protocol has no
  // share link of its own. It isn't "unsupported" here: configs older than 1.13 keep
  // it among the outbounds, and without this line the same node was both imported
  // and added to the skipped counter.
  if (type === "wireguard") return null;
  if (UNSUPPORTED_TYPES.has(type)) return { unsupported: type };

  const builder = URI_BUILDERS[type];
  if (!builder) return { unsupported: type };
  // A node behind someone else's detour isn't a standalone server: without the chain it would go
  // direct, i.e. behave differently than in the config it came from.
  if (outbound.detour) return { unsupported: `${type}+detour` };
  if (type === "mieru") {
    const hasPort = outbound.server_port !== undefined && outbound.server_port !== null;
    const hasRanges = Array.isArray(outbound.server_ports) && outbound.server_ports.length > 0;
    if (!outbound.server || (!hasPort && !hasRanges)
      || (outbound.server_ports !== undefined && !Array.isArray(outbound.server_ports))) {
      return { unsupported: type };
    }
    return { link: builder(outbound, outbound.tag || "") };
  }
  // The link expresses a hysteria2 port range (server_ports) as a comma-separated
  // list; for other schemes without a whole port the node would connect to the wrong place.
  const hopPorts = type === "hysteria2" ? hysteria2PortSpec(outbound.server_ports) : null;
  if (!outbound.server || (!hopPorts && !Number.isInteger(Number(outbound.server_port)))) {
    return { unsupported: type };
  }
  return { link: builder(outbound, outbound.tag || "") };
}

// ── WireGuard: endpoints, not outbounds ───────────────────
// WireGuard has no share link of its own, so we put the endpoint straight into the profile
// model — the same one a .conf import produces. This path can't go through .conf:
// reserved bytes (WARP) can't be expressed in the wg-quick ini format.
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
      ...(num("s3") ? { s3: num("s3") } : {}),
      ...(num("s4") ? { s4: num("s4") } : {}),
      // AmneziaWG 2.0 H1..H4 is a "from-to" range, it can't be read as a number.
      h1: parseAwgHeader(amnezia.h1) ?? 0, h2: parseAwgHeader(amnezia.h2) ?? 0,
      h3: parseAwgHeader(amnezia.h3) ?? 0, h4: parseAwgHeader(amnezia.h4) ?? 0,
      ...(amnezia.header_protection_key ? { headerProtectionKey: String(amnezia.header_protection_key) } : {}),
      ...(parseAwgHeader(amnezia.content_padding_addition) ? { contentPaddingAddition: parseAwgHeader(amnezia.content_padding_addition) } : {}),
      ...(amnezia.random_trailers === true ? { randomTrailers: true } : {}),
      i1: amnezia.i1 || "", i2: amnezia.i2 || "", i3: amnezia.i3 || "",
      i4: amnezia.i4 || "", i5: amnezia.i5 || "",
    },
    ignored: [],
  };
}

// OpenVPN is already represented by endpoint options; we carry them over without losing fields.
// Paths to local files are kept for validation but aren't read by the browser.
function openvpnProfile(source) {
  const endpoint = structuredClone(source);
  delete endpoint.type;
  delete endpoint.tag;
  // The foreign config's DNS isn't imported: its tag doesn't exist in ours.
  delete endpoint.domain_resolver;
  const primary = Array.isArray(endpoint.servers) && endpoint.servers.length
    ? endpoint.servers[0] : endpoint;
  if (!isPlainObject(primary)) return null;
  const host = String(primary.server || "").replace(/^\[|\]$/g, "");
  const port = Number(primary.server_port) || 0;
  if (!host || !port) return null;
  return {
    raw: `ovpn://${host}:${port}`,
    proto: "openvpn",
    name: source.tag || host,
    host,
    port,
    network: primary.network || endpoint.network || "udp",
    endpoint,
    ovpn: "",
    ignored: [],
  };
}

/**
 * A ready sing-box config → Ninety profiles.
 * @param {string|object} input the config text or an already parsed object
 * @returns {{profiles: object[], skipped: number, unsupported: string[]}}
 */
export function parseSingboxConfig(input) {
  const root = typeof input === "string" ? safeJsonParse(input) : input;
  if (!root) return { profiles: [], skipped: 0, unsupported: [] };

  // We accept a whole config, a bare array of outbounds and an array of configs:
  // different panels serve all three kinds, and the difference is visible only from the contents.
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

  // In sing-box 1.13 WireGuard lives in endpoints; older configs keep it
  // among the outbounds — we accept both placements.
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

  const openvpns = endpoints.filter((endpoint) => String(endpoint.type || "").toLowerCase() === "openvpn-client");
  for (const endpoint of openvpns) {
    if (endpoint.detour) {
      skipped++;
      if (!unsupported.includes("openvpn-client+detour")) unsupported.push("openvpn-client+detour");
      continue;
    }
    const profile = openvpnProfile(endpoint);
    if (profile) profiles.push(profile);
    else skipped++;
  }

  return { profiles, skipped, unsupported };
}
