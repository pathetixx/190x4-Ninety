// Ninety · sing-box 1.13.x config builder
// Protocol parsers live in protocol-parsers.js; here — the builder + the storage facade.

import { DEFAULT_OPTIONS } from "/lib/options.js";
import { t } from "/lib/i18n/index.js";
import { uid } from "/lib/uid.js";
import { hashRuntimeValue, stableNodeId } from "/lib/runtime-identity.js";
import {
  resolveRuntimePrivacyPolicy,
  selectStrictPrivacyCandidate,
  StrictPrivacyPolicyError,
} from "/lib/strict-privacy-policy.js";
import {
  parsePort,
  safeAtob,
  splitHostPort,
} from "/lib/url-helpers.js";
import { parseAwgHeader, parseLink, parseTrustTunnelToml, profileProto, stripXrayFileFields, vlessEncryptionOf } from "/lib/protocol-parsers.js";
import { GEOSITE_BASE, REGION_GEOSITE, isKnownSet, parseSetRef, setUrl } from "/lib/rule-sets.js";
import { isNodeQuarantined } from "/lib/node-quarantine.js";
import {
  nodeConfigIssue,
  normalizeFingerprint,
  normalizeFlow,
  normalizeRealityPublicKey,
  usableNodes,
  withoutPlaceholders,
} from "/lib/node-validation.js";
import { parseWireguardConf } from "/lib/protocol-parsers.js";
import { parseOpenvpnConf } from "/lib/openvpn.js";
import {
  getActiveKindFromStore,
  getActiveProfileIdFromStore,
  getActiveSubscriptionIdFromStore,
  loadProfilesFromStore,
  loadSubscriptionsFromStore,
  saveProfilesToStore,
  setActiveKindInStore,
  setActiveProfileIdInStore,
} from "/lib/profile-store.js";

export {
  parseHysteria2,
  parseLink,
  parseMieru,
  parseNaive,
  parseShadowsocks,
  parseTrojan,
  parseTrustTunnelDeepLink,
  parseTrustTunnelToml,
  parseTuic,
  parseVless,
  parseVmess,
  parseWireguardConf,
  profileProto,
  wireguardConfText,
} from "/lib/protocol-parsers.js";
export { parseOpenvpnConf, openvpnConfText } from "/lib/openvpn.js";

const MODE_KEY = "ninety.mode";
export const ENGINE_PROCESS_NAMES = [
  "sing-box.exe",
  "sing-box-x86_64-pc-windows-msvc.exe",
  "xray.exe",
  "xray-x86_64-pc-windows-msvc.exe",
  "naive.exe",
  "naive-x86_64-pc-windows-msvc.exe",
  "trusttunnel_client.exe",
  "trusttunnel_client-x86_64-pc-windows-msvc.exe",
];

// Rule lists come from the original sources, not from third-party mirrors (rule-sets.js).
// The malware/phishing/miner lists are maintained by a separate project: neither sing-geosite
// nor sing-geoip has such categories. Their tags are their own, with a prefix: names from
// the SagerNet catalog get tags like geosite-<name>, and a name match must not
// substitute one file for another.
const SECURITY_BASE = "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set";

const BLOCK_AD_SETS = [
  ["geosite-category-ads-all", `${GEOSITE_BASE}/geosite-category-ads-all.srs`],
  ["security-geosite-malware", `${SECURITY_BASE}/geosite-malware.srs`],
  ["security-geosite-phishing", `${SECURITY_BASE}/geosite-phishing.srs`],
  ["security-geosite-cryptominers", `${SECURITY_BASE}/geosite-cryptominers.srs`],
  ["security-geoip-malware", `${SECURITY_BASE}/geoip-malware.srs`],
  ["security-geoip-phishing", `${SECURITY_BASE}/geoip-phishing.srs`],
];

// Tag of a list from the SagerNet catalog: the same file under the same tag, whoever
// wires it — the region, split Discord or a user rule.
// Otherwise one file would be downloaded and stored in the cache twice.
export function setTag(ref) {
  return `${ref.kind}-${ref.name}`;
}

// The region whose base is in effect. "Make them mine" moves its rules into
// the user rules (regionDetached): the region stays selected — by it,
// for example, the sites for diagnostics are picked — but it doesn't emit its own rules.
function activeRegion(options) {
  const region = options.region;
  if (!region || region === "other" || options.route?.regionDetached) return null;
  return region;
}

// Region base lists: a country geosite doesn't exist for every region (see
// REGION_GEOSITE), geoip does for any.
function regionSetRefs(region) {
  const refs = [];
  if (REGION_GEOSITE[region]) refs.push({ kind: "geosite", name: REGION_GEOSITE[region] });
  refs.push({ kind: "geoip", name: region });
  return refs;
}

// "Ready list" references in a rule. Unrecognized ones and those not from the catalog
// are dropped: sanitizeRule already doesn't let such entries into saved rules, but
// the config is also built from old or imported settings.
function customRuleSetRefs(r) {
  const refs = [];
  for (const value of customRuleValues(r)) {
    const ref = parseSetRef(value);
    if (ref && isKnownSet(ref)) refs.push(ref);
  }
  return refs;
}
// Discord domain suffixes — they duplicate geosite-discord in case the rule
// didn't load, and match by sniffed SNI. Only Discord domains go direct
// (no IP list: a broken CIDR would send someone else's traffic past the VPN = a leak).
const DISCORD_SUFFIXES = [
  "discord.com", "discordapp.com", "discordapp.net", "discord.gg",
  "discord.media", "discord.dev", "discordstatus.com", "dis.gd",
];
// Discord desktop clients. The voice media stream goes over UDP to a bare IP:
// there's no domain in the packet, sniff can't get it (it's not TLS or QUIC but RTP +
// IP discovery), domain rules don't fire on it. Matching by process is
// the only way to send voice direct without making up a Discord CIDR list.
const DISCORD_PROCESS_NAMES = [
  "Discord.exe", "DiscordCanary.exe", "DiscordPTB.exe", "DiscordDevelopment.exe",
];

const IPV6_STRATEGY_MAP = {
  disable: "ipv4_only",
  enable: "prefer_ipv4",
  prefer: "prefer_ipv6",
  only: "ipv6_only",
};

// "Direct" domains with "Enabled (prefer IPv4)" are resolved to IPv4 only.
// In TUN the interface has an IPv6 address, and the app goes for the AAAA answer; the tunnel
// will carry such an address, while direct only will if the ISP has IPv6. Without it
// the TUN stack has already accepted the connection, and direct immediately fails with "unreachable
// network" — the browser sees a reset and doesn't fall back to IPv4. In the "Prefer
// IPv6" and "IPv6 only" modes the user chose IPv6 themselves, we leave them alone.
function directDnsAction(options) {
  const mode = options.route?.ipv6Mode;
  const strategy = mode === "enable" ? { strategy: "ipv4_only" } : {};
  return { server: "dns-direct", ...strategy };
}

// ── shared parts (TLS, transport) ───────────────────────────
function buildTls(p) {
  // For vless reality/tls; vmess/trojan/tuic — regular TLS
  const tlsMode = p.tlsMode || p.security; // vmess uses tlsMode, the rest use security
  if (tlsMode !== "tls" && tlsMode !== "reality") return null;
  const tls = {
    enabled: true,
    server_name: p.sni,
    utls: { enabled: true, fingerprint: normalizeFingerprint(p.fp) },
  };
  if (p.alpn) tls.alpn = String(p.alpn).split(",").map(s => s.trim()).filter(Boolean);
  // We write it only when the link explicitly asked for it: reality has its own
  // certificate check anyway, and a silently removed check is already a different security
  // protocol than the one the user saw.
  if (p.insecure) tls.insecure = true;
  if (tlsMode === "reality") {
    // Panels return the key both in regular base64 and with padding, while the core accepts
    // only base64url without "=". We normalize; an obviously broken key is weeded out by
    // nodeConfigIssue before the build.
    tls.reality = {
      enabled: true,
      public_key: normalizeRealityPublicKey(p.pbk) || p.pbk,
      short_id: p.sid,
    };
  }
  return tls;
}

// xhttp base keys whose json names match in Xray and the sing-box fork.
const XHTTP_PASS_KEYS = [
  "host", "path", "headers", "xPaddingBytes", "noGRPCHeader", "noSSEHeader",
  "scMaxEachPostBytes", "scMinPostsIntervalMs", "scMaxBufferedPosts",
  "scStreamUpServerSecs", "xmux",
];

// Xray tlsSettings/realitySettings → the sing-box fork's OutboundTLSOptions.
function xrayTlsToSingbox(ds) {
  const sec = ds.security;
  if (sec !== "tls" && sec !== "reality") return null;
  const ts = ds.tlsSettings || ds.realitySettings || {};
  const tls = { enabled: true };
  const sni = ts.serverName || ts.server_name;
  if (sni) tls.server_name = sni;
  tls.utls = { enabled: true, fingerprint: normalizeFingerprint(ts.fingerprint) };
  const alpn = ts.alpn;
  if (Array.isArray(alpn) && alpn.length) tls.alpn = alpn;
  else if (typeof alpn === "string" && alpn) tls.alpn = alpn.split(",").map(s => s.trim()).filter(Boolean);
  if (ts.allowInsecure || ts.insecure) tls.insecure = true;
  if (sec === "reality") {
    const realityKey = ts.publicKey || ts.public_key || "";
    tls.reality = {
      enabled: true,
      public_key: normalizeRealityPublicKey(realityKey) || realityKey,
      short_id: ts.shortId || ts.short_id || "",
    };
  }
  return tls;
}

// Xray downloadSettings (StreamSettings) → the fork's V2RayXHTTPDownloadOptions.
// address→server, port→server_port, xhttpSettings.* → flat base fields, tls.
function xrayDownloadToSingbox(ds) {
  if (!ds || typeof ds !== "object") return null;
  const d = {};
  if (ds.address) d.server = String(ds.address);
  if (ds.port != null) d.server_port = Number(ds.port);
  const xs = (ds.xhttpSettings && typeof ds.xhttpSettings === "object") ? ds.xhttpSettings : {};
  for (const k of XHTTP_PASS_KEYS) if (xs[k] !== undefined) d[k] = xs[k];
  const tls = xrayTlsToSingbox(ds);
  if (tls) d.tls = tls;
  return Object.keys(d).length ? d : null;
}

// Safe merge of the Xray extra into the fork's xhttp transport. We emit only
// fields known to the fork (otherwise an unknown field brings down the WHOLE config).
function mergeXhttpExtra(transport, ex) {
  for (const k of XHTTP_PASS_KEYS) if (ex[k] !== undefined) transport[k] = ex[k];
  if (ex.mode) transport.mode = ex.mode;
  if (ex.downloadSettings) {
    const d = xrayDownloadToSingbox(ex.downloadSettings);
    if (d) transport.downloadSettings = d;
  }
}

function buildTransport(p) {
  switch (p.type) {
    case "ws": {
      const tr = { type: "ws" };
      if (p.path) tr.path = p.path;
      if (p.host_header) tr.headers = { Host: p.host_header };
      // Early data arrives as separate link parameters (ed/eh)
      // or from an imported config. The Xray form ("/path?ed=2560") isn't
      // converted here: the core sends such a path together with the query, it works, and
      // there's no reason to change the behavior of already added nodes.
      if (p.earlyData > 0) {
        tr.max_early_data = p.earlyData;
        tr.early_data_header_name = p.earlyDataHeader || "Sec-WebSocket-Protocol";
      }
      return tr;
    }
    case "grpc": {
      const tr = { type: "grpc" };
      if (p.serviceName) tr.service_name = p.serviceName;
      return tr;
    }
    case "http":
    case "h2": {
      const tr = { type: "http" };
      if (p.path) tr.path = p.path;
      if (p.host_header) tr.host = p.host_header.split(",").map(s => s.trim());
      return tr;
    }
    case "httpupgrade": {
      const tr = { type: "httpupgrade" };
      if (p.host_header || p.sni) tr.host = p.host_header || p.sni;
      if (p.path) tr.path = p.path;
      return tr;
    }
    case "quic":
      // v2ray QUIC has no options in the core: it doesn't implement Xray's additional transport
      // encryption (nodeConfigIssue weeds out such nodes).
      return { type: "quic" };
    case "xhttp": {
      const tr = { type: "xhttp" };
      if (p.path) tr.path = p.path;
      if (p.host_header) tr.host = p.host_header;
      if (p.mode) tr.mode = p.mode;
      // extra={...} from the link carries xhttp sub-options (xPaddingBytes,
      // scMaxEachPostBytes, downloadSettings, noGRPCHeader, headers, xmux…).
      // Without them the download channel falls back to the default and the server breaks the handshake.
      // IMPORTANT: extra is in the Xray schema. Scalars and xmux match the
      // sing-box fork by name, but downloadSettings is Xray StreamSettings
      // (address/port/security/xhttpSettings) and the fork doesn't understand it.
      // So we merge only whitelisted keys and translate downloadSettings,
      // emitting strictly the fields known to the fork — otherwise one node brings down the whole config
      // (json: unknown field "address").
      if (p.extra) {
        try {
          const ex = JSON.parse(p.extra);
          if (ex && typeof ex === "object") mergeXhttpExtra(tr, ex);
        } catch { /* a broken extra — ignore it, the base fields are enough */ }
      }
      // The core requires a non-empty mode, otherwise the whole config fails
      // ("mode is not set" at load time). auto is a safe default.
      if (!tr.mode) tr.mode = "auto";
      return tr;
    }
    default:
      return null;
  }
}

function applyMux(out, options) {
  if (!options?.mux?.enable) return;
  out.multiplex = {
    enabled: true,
    protocol: options.mux.protocol || "h2mux",
    max_streams: options.mux.maxStreams || 8,
    padding: !!options.mux.padding,
  };
}

// TLS fragmentation + tls_tricks.
// IMPORTANT: upstream 1.12 removed experimental.tls_tricks and moved these tricks to
// per-outbound tls{}: fragment / record_fragment / fragment_fallback_delay +
// tls.tls_tricks{ mixedcase_sni, padding_size }. The 1.12+ parser is strict — any
// unknown field brings down the WHOLE config (json: unknown field) and the core doesn't start
// (that was the "VPN stops working when enabled" bug). We write exactly these fields.
// Applied only to proxy outbounds with a TCP-TLS handshake; QUIC (hysteria2/tuic)
// doesn't get here — those return earlier, TLS record fragmentation doesn't apply
// to them.
function applyTlsTricks(out, options) {
  const tricksCfg = options?.tlsTricks;
  if (!tricksCfg || !out.tls?.enabled) return;
  if (tricksCfg.enableFragment) {
    if (tricksCfg.fragmentMode === "tcp") {
      // fragment and record_fragment are mutually exclusive — we set only one.
      out.tls.fragment = true;
      if (tricksCfg.fragmentFallbackDelay) out.tls.fragment_fallback_delay = tricksCfg.fragmentFallbackDelay;
    } else {
      out.tls.record_fragment = true;
    }
  }
  // From here on — only tls_tricks. The fragmentation above also applies to Reality, but
  // the tricks themselves rewrite the ClientHello, which Reality builds itself and over
  // which it seals the authentication. Besides, Reality already sends a byte-exact
  // browser fingerprint with the real SNI — that's what it exists for. The core responds
  // to such a config with an error, so we don't send it.
  if (out.tls.reality?.enabled) return;
  const tricks = {};
  if (tricksCfg.enablePadding) {
    const ps = tricksCfg.paddingSize || { from: 100, to: 900 };
    tricks.padding_size = `${ps.from}-${ps.to}`;
  }
  if (tricksCfg.mixedSniCase) tricks.mixedcase_sni = true;
  if (Object.keys(tricks).length) out.tls.tls_tricks = tricks;
}

// ── outbound dispatcher by protocol ───────────────────────
function buildOutbound(p, options) {
  const proto = profileProto(p);
  const base = { tag: "proxy", server: p.host, server_port: p.port };
  let out;
  switch (proto) {
    case "vmess": {
      out = {
        ...base,
        type: "vmess",
        uuid: p.uuid,
        // Core registries are case-sensitive: the cipher/method name from the link is
        // lowercased, otherwise "AES-128-GCM" brings down the config as unknown.
        security: String(p.security || "auto").toLowerCase(),
        alter_id: p.alterId || 0,
        packet_encoding: "xudp",
      };
      break;
    }
    case "trojan": {
      out = { ...base, type: "trojan", password: p.password };
      break;
    }
    case "shadowsocks": {
      out = {
        ...base,
        type: "shadowsocks",
        method: String(p.method || "").toLowerCase(),
        password: p.password,
      };
      if (p.plugin) {
        out.plugin = p.plugin;
        if (p.plugin_opts) out.plugin_opts = p.plugin_opts;
      }
      break;
    }
    case "hysteria2": {
      out = {
        ...base,
        type: "hysteria2",
        password: p.password,
      };
      // Port hopping: the core accepts a list of ranges instead of a single port, and
      // they aren't allowed together.
      if (Array.isArray(p.ports) && p.ports.length) {
        delete out.server_port;
        out.server_ports = [...p.ports];
      }
      if (p.upMbps) out.up_mbps = p.upMbps;
      if (p.downMbps) out.down_mbps = p.downMbps;
      if (p.obfs) {
        out.obfs = { type: String(p.obfs).toLowerCase() };
        if (p.obfsPassword) out.obfs.password = p.obfsPassword;
      }
      // hysteria2 always runs over QUIC/TLS — TLS is mandatory
      out.tls = {
        enabled: true,
        server_name: p.sni || p.host,
        insecure: !!p.insecure,
        alpn: (p.alpn || "h3").split(",").map(s => s.trim()).filter(Boolean),
      };
      if (p.pinSHA256) out.tls.certificate_public_key_sha256 = p.pinSHA256;
      return out;
    }
    case "anytls": {
      out = { ...base, type: "anytls", password: p.password };
      out.tls = {
        enabled: true,
        server_name: p.sni || p.host,
        insecure: !!p.insecure,
        utls: { enabled: true, fingerprint: normalizeFingerprint(p.fp) },
      };
      const anytlsAlpn = String(p.alpn || "").split(",").map(x => x.trim()).filter(Boolean);
      if (anytlsAlpn.length) out.tls.alpn = anytlsAlpn;
      return out;
    }
    case "mieru": {
      out = {
        ...base,
        type: "mieru",
        transport: p.transport,
        username: p.username,
        password: p.password,
      };
      // Without a single port only ranges go to the core (see parseMieru).
      if (p.rangesOnly) delete out.server_port;
      if (p.ports?.length) out.server_ports = [...p.ports];
      if (p.multiplexing !== undefined) out.multiplexing = p.multiplexing;
      if (p.handshakeMode !== undefined) out.handshake_mode = p.handshakeMode;
      if (p.mtu !== undefined) out.mtu = p.mtu;
      if (p.trafficPattern !== undefined) out.traffic_pattern = p.trafficPattern;
      return out;
    }
    case "hysteria": {
      // v1: authentication by string, obfuscation is a shared secret (also a string),
      // speeds go into the Brutal congestion controller and are therefore mandatory.
      out = { ...base, type: "hysteria" };
      if (p.authString) out.auth_str = p.authString;
      if (p.obfs) out.obfs = p.obfs;
      out.up_mbps = p.upMbps || 50;
      out.down_mbps = p.downMbps || 100;
      out.tls = {
        enabled: true,
        server_name: p.sni || p.host,
        insecure: !!p.insecure,
      };
      const hyAlpn = String(p.alpn || "").split(",").map(x => x.trim()).filter(Boolean);
      if (hyAlpn.length) out.tls.alpn = hyAlpn;
      return out;
    }
    case "socks": {
      out = { ...base, type: "socks", version: p.version === "4" || p.version === "4a" ? "4" : "5" };
      if (p.username) out.username = p.username;
      if (p.password) out.password = p.password;
      return out;
    }
    case "tuic": {
      out = {
        ...base,
        type: "tuic",
        uuid: p.uuid,
        password: p.password,
        congestion_control: String(p.congestionControl || "bbr").toLowerCase(),
        udp_relay_mode: p.udpRelayMode || "native",
        zero_rtt_handshake: !!p.zeroRttHandshake,
      };
      out.tls = {
        enabled: true,
        server_name: p.sni || p.host,
        insecure: !!p.insecure,
        disable_sni: !!p.disableSni,
        alpn: (p.alpn || "h3").split(",").map(s => s.trim()).filter(Boolean),
      };
      return out;
    }
    case "naive":
    case "trusttunnel":
    case "xray":
      // These protocols always go through a local sidecar client (a SOCKS5 bridge):
      // sing-box has no native outbound for them. A socks placeholder; the real port
      // will be substituted by the bridge loop in buildConfig (server_port=0 will be overwritten).
      return { ...base, type: "socks", server: "127.0.0.1", server_port: 0, version: "5" };
    case "vless":
    default: {
      out = {
        ...base,
        type: "vless",
        uuid: p.uuid,
        packet_encoding: "xudp",
      };
      // The core doesn't know the Xray "-udp443" suffix; normalizeFlow brings the flow to
      // what it accepts (the protocol on the wire is the same).
      const flow = normalizeFlow(p.flow);
      if (flow) out.flow = flow;
      break;
    }
  }

  const tls = buildTls(p);
  if (tls) out.tls = tls;
  const transport = buildTransport(p);
  if (transport) out.transport = transport;
  applyMux(out, options);
  applyTlsTricks(out, options);
  return out;
}

function isIpLiteral(value) {
  const host = String(value || "").trim().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host.includes(":")) {
    try {
      return new URL(`http://[${host}]/`).hostname.length > 0;
    } catch {
      return false;
    }
  }
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) =>
    /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255
  );
}

function endpointContainsIp(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    return close > 0 && isIpLiteral(raw.slice(1, close));
  }
  const colons = (raw.match(/:/g) || []).length;
  if (colons === 1) return isIpLiteral(raw.slice(0, raw.lastIndexOf(":")));
  return isIpLiteral(raw);
}

// All addresses the xhttp client actually connects to. Besides the server itself
// it's the separate download channel from `extra` (Xray StreamSettings): its address
// goes into the xray config as is, and in strict mode xray goes past the tunnel
// (a direct process rule) — so a domain name from there is resolved by the system
// DNS bypassing the whole policy. Checking only node.host didn't catch this.
function xhttpEndpointHosts(node) {
  const hosts = [node?.host];
  if (!node?.extra) return hosts;
  try {
    const extra = JSON.parse(node.extra);
    const download = extra?.downloadSettings;
    if (download && typeof download === "object" && download.address) {
      hosts.push(String(download.address));
    }
  } catch { /* a broken extra — it won't make it into the config anyway */ }
  return hosts;
}

function assertStrictBootstrapSafe(node) {
  const proto = profileProto(node);
  if (node?.type === "xhttp" && xhttpEndpointHosts(node).some((host) => !isIpLiteral(host))) {
    throw new StrictPrivacyPolicyError(
      "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
      "XHTTP-клиенту нужен прямой DNS для адресов сервера и download-канала. В строгом режиме выберите XHTTP-ноду, у которой оба адреса заданы IP.",
    );
  }
  if (proto === "wireguard") {
    const peers = Array.isArray(node.peers) && node.peers.length ? node.peers : [node];
    if (peers.some((peer) => !isIpLiteral(peer.host))) {
      throw new StrictPrivacyPolicyError(
        "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
        "Адрес пира WireGuard резолвится до того, как тоннель поднят. В строгом режиме выберите профиль, у которого Endpoint задан IP-адресом.",
      );
    }
  }
  if (proto === "openvpn") {
    const endpoint = node.endpoint || {};
    const servers = endpoint.servers?.length ? endpoint.servers : [endpoint];
    if (servers.some((server) => !isIpLiteral(server.server))) {
      throw new StrictPrivacyPolicyError("STRICT_PRIVACY_BOOTSTRAP_UNSAFE", t("sb.err.ovpnBootstrap"));
    }
  }
  // mKCP and VLESS with encryption are also brought up by a separate xray, which resolves
  // the server address itself, bypassing the strict mode DNS policy.
  if (proto !== "xray" && node?.type !== "xhttp" && needsXrayBridge(node) && !isIpLiteral(node.host)) {
    throw new StrictPrivacyPolicyError(
      "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
      "Этот сервер поднимает отдельный клиент Xray, которому нужен прямой DNS для адреса сервера. В строгом режиме выберите ноду с IP-адресом.",
    );
  }
  if (proto === "xray" && !isIpLiteral(node.host)) {
    throw new StrictPrivacyPolicyError(
      "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
      "Этот сервер поднимает отдельный клиент Xray, которому нужен прямой DNS для адреса сервера. В строгом режиме выберите ноду с IP-адресом.",
    );
  }
  if (proto === "naive" && !isIpLiteral(node.host)) {
    throw new StrictPrivacyPolicyError(
      "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
      "Naive-клиенту нужен прямой DNS для адреса сервера. В строгом режиме выберите ноду с IP-адресом.",
    );
  }
  if (proto === "trusttunnel") {
    const addresses = Array.isArray(node.addresses) ? node.addresses : [];
    if (!addresses.length || addresses.some((address) => !endpointContainsIp(address))) {
      throw new StrictPrivacyPolicyError(
        "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
        "TrustTunnel-клиенту нужны IP-адреса endpoint в строгом режиме.",
      );
    }
  }
}

// ── rule_sets: region, ads, split Discord, user rules ──
// The download channel is http_client.detour: download_detour is deprecated
// in sing-box 1.14 and will be removed in 1.16.
//
// optional is a ninety-core delta: a list that didn't download at startup or didn't
// make it within the shared 3 seconds is attached empty and downloaded in the background instead of
// bringing down the whole connection. "Auto" picks blindly before the first measurement, and
// a hanging server at the start of the subscription would otherwise hold the start longer than
// Ninety.
// Without it an unreachable GitHub or a category removed at the source from
// a user rule would leave the person without a VPN at all. While the list is empty,
// its rules simply don't fire and traffic follows the other rules.
function buildRuleSets(options, mode, downloadDetour = "proxy") {
  const sets = new Map();
  const add = (tag, url) => {
    if (sets.has(tag)) return;
    sets.set(tag, {
      type: "remote", tag, format: "binary", url,
      update_interval: "120h", http_client: { detour: downloadDetour }, optional: true,
    });
  };
  const addRef = (ref) => add(setTag(ref), setUrl(ref));

  // TUN + split Discord: a rule for routing Discord domains past the tunnel.
  if (mode === "tun" && options.route?.tunSplitDiscord) addRef({ kind: "geosite", name: "discord" });
  const region = activeRegion(options);
  if (region) regionSetRefs(region).forEach(addRef);
  if (options.blockAds) BLOCK_AD_SETS.forEach(([tag, url]) => add(tag, url));
  for (const r of Array.isArray(options.route?.customRules) ? options.route.customRules : []) {
    if (r && r.enabled !== false && r.type === "set") customRuleSetRefs(r).forEach(addRef);
  }
  return [...sets.values()];
}

// ── DNS server: string parser into the new sing-box 1.12+ format ─
// Supported inputs:
//   https://host/path   → {type: "https", server, path?}
//   tls://host[:port]   → {type: "tls",   server, server_port?}
//   tcp://host[:port]   → {type: "tcp",   server, server_port?}
//   udp://host[:port]   → {type: "udp",   server, server_port?}
//   quic://host[:port]  → {type: "quic",  server, server_port?}
//   1.2.3.4 / host      → {type: "udp",   server} (default)
//   local | system      → {type: "local"}
export function parseDnsAddress(raw) {
  const s = String(raw || "").trim();
  if (!s || s === "local" || s === "system") return { type: "local" };
  const m = s.match(/^([a-z]+):\/\/(.+)$/i);
  if (!m) {
    if (/\s|\//.test(s)) throw new Error(`invalid DNS server address: ${s}`);
    const hp = parseOptionalHostPort(s);
    const out = { type: "udp", server: hp.host };
    if (hp.port != null) out.server_port = hp.port;
    return out;
  }
  const scheme = m[1].toLowerCase();
  const rest = m[2];
  if (scheme === "https") {
    const u = (() => { try { return new URL(s); } catch { return null; } })();
    if (!u || !u.hostname || u.username || u.password) throw new Error(`invalid DoH URL: ${s}`);
    const o = { type: "https", server: u.hostname };
    if (u.port) o.server_port = parsePort(u.port, "sb.err.badPort");
    if (u.pathname && u.pathname !== "/") o.path = u.pathname;
    return o;
  }
  if (["tls", "tcp", "udp", "quic"].includes(scheme)) {
    const hp = parseOptionalHostPort(rest);
    const o = { type: scheme, server: hp.host };
    if (hp.port != null) o.server_port = hp.port;
    return o;
  }
  throw new Error(`unsupported DNS scheme: ${scheme}`);
}

function parseOptionalHostPort(rest) {
  const s = String(rest || "").trim();
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) throw new Error(`invalid bracketed DNS address: ${s}`);
    const host = s.slice(1, close);
    if (!host) throw new Error("empty DNS host");
    const tail = s.slice(close + 1);
    if (tail.startsWith(":")) return { host, port: parsePort(tail.slice(1), "sb.err.badPort") };
    if (tail) throw new Error(`invalid DNS address suffix: ${tail}`);
    return { host };
  }
  if (!s || /\s|\//.test(s)) throw new Error(`invalid DNS host: ${s}`);
  const colonCount = (s.match(/:/g) || []).length;
  if (colonCount === 1) {
    const idx = s.lastIndexOf(":");
    const host = s.slice(0, idx);
    if (!host) throw new Error("empty DNS host");
    return { host, port: parsePort(s.slice(idx + 1), "sb.err.badPort") };
  }
  return { host: s };
}

// mode is the actual runtime mode. FakeIP makes sense ONLY in TUN: only
// the TUN inbound can intercept an issued 198.18.x.x address. In proxy/systemProxy the same
// answer goes into direct routes (bypass, process_name, user
// direct rules) and the connection doesn't come up — while the symptom looks like
// "some apps don't work" rather than a DNS problem. An unknown mode
// is treated conservatively: no FakeIP.
function buildDns(options, protectedOutbound = "proxy", mode = "") {
  const ipv6Strategy = IPV6_STRATEGY_MAP[options.route.ipv6Mode] || "prefer_ipv4";

  const remoteSrv = {
    tag: "dns-remote",
    ...parseDnsAddress(options.dns.remoteAddress),
    domain_resolver: "dns-direct",
    detour: protectedOutbound,
  };

  // We don't set detour "direct" in sing-box 1.13 — our direct outbound is empty
  // (no bind_interface), and 1.13 on an empty direct outbound reports
  // "detour to an empty direct outbound makes no sense" and fails at startup.
  const directSrv = {
    tag: "dns-direct",
    ...parseDnsAddress(options.dns.directAddress),
  };

  const dns = {
    servers: [remoteSrv, directSrv],
    rules: [],
    // We don't set independent_cache: since 1.14 the DNS cache is always split by server.
    strategy: ipv6Strategy,
    final: "dns-remote",
  };

  const fakeIp = !!options.dns.enableFakeDns && mode === "tun";
  // User rules go above the region, just as in routing.
  const direct = directDnsAction(options);
  dns.rules.push(...customRulesToDns(options.route?.customRules, fakeIp, direct));

  const region = activeRegion(options);
  if (region) {
    dns.rules.push({
      domain_suffix: [`.${region}`],
      ...direct,
      rewrite_ttl: 86400,
    });
    const geosite = regionSetRefs(region).filter((ref) => ref.kind === "geosite");
    if (geosite.length) {
      dns.rules.push({
        rule_set: geosite.map(setTag),
        ...direct,
        rewrite_ttl: 86400,
      });
    }
  }

  if (fakeIp) {
    dns.servers.push({
      tag: "dns-fake",
      type: "fakeip",
      inet4_range: "198.18.0.0/15",
      inet6_range: "fc00::/18",
    });
    dns.rules.push({ query_type: ["A", "AAAA"], server: "dns-fake" });
  }

  return dns;
}

// ── route ──────────────────────────────────────────────────
// User routing rules (options.route.customRules) → sing-box
// rules. One user rule = one route rule. Action: proxy/direct → outbound,
// block → action:"reject" (like blockAds). We skip disabled ones and those without values.
// Type:
//   domain  + match → domain_suffix (default) / domain (exact) / domain_keyword
//   ip            → ip_cidr (a single IP is normalized to /32, IPv6 to /128)
//   process       → process_name (works in ALL modes — sing-box resolves
//                   the process by the mixed inbound's local socket, there's no tie to TUN)
//
// The node/warp actions send the rule to a SPECIFIC outbound: the tag is provided by
// resolveTarget (a buildConfig closure — only it knows which nodes made it into
// the config and whether WARP is up). If it returned null, the rule falls back to
// protectedOutbound: the server may have disappeared from the subscription or gone into quarantine, and
// a reference to a nonexistent tag would bring down the core start entirely.
function customRuleValues(r) {
  return (Array.isArray(r?.values) ? r.values : [])
    .map((v) => String(v).trim())
    .filter(Boolean);
}

function customDomainField(r) {
  return r.match === "exact" ? "domain" : r.match === "keyword" ? "domain_keyword" : "domain_suffix";
}

function customRulesToSingbox(customRules, protectedOutbound = "proxy", resolveTarget = null) {
  if (!Array.isArray(customRules)) return [];
  const out = [];
  for (const r of customRules) {
    if (!r || r.enabled === false) continue;
    const values = customRuleValues(r);
    if (!values.length) continue;

    const rule = {};
    if (r.type === "domain") {
      rule[customDomainField(r)] = values;
    } else if (r.type === "ip") {
      rule.ip_cidr = values.map((v) => (v.includes("/") ? v : `${v}/${v.includes(":") ? 128 : 32}`));
    } else if (r.type === "process") {
      rule.process_name = values;
    } else if (r.type === "set") {
      const refs = customRuleSetRefs(r);
      if (!refs.length) continue;
      rule.rule_set = refs.map(setTag);
    } else {
      continue; // unknown type — skip
    }

    if (r.action === "block") rule.action = "reject";
    else if (r.action === "direct") rule.outbound = "direct";
    else if (r.action === "node" || r.action === "warp") {
      rule.outbound = (resolveTarget && resolveTarget(r)) || protectedOutbound;
    } else rule.outbound = protectedOutbound;

    out.push(rule);
  }
  return out;
}

// DNS mirror of user domain rules. Without it a domain with a "Direct"
// rule was resolved via dns-remote, i.e. through the VPN: the CDN returned an address
// for the server's country, while the connection went direct. A domain from the region with
// a "Through VPN" rule, conversely, lost to the region's DNS rule and was resolved by
// the ISP. "Block" answers with a refusal already at DNS. IP and process rules
// don't correspond to a DNS query — we skip them.
function customRulesToDns(customRules, fakeIp = false, direct = { server: "dns-direct" }) {
  if (!Array.isArray(customRules)) return [];
  const out = [];
  for (const r of customRules) {
    if (!r || r.enabled === false) continue;
    let match;
    if (r.type === "domain") {
      const values = customRuleValues(r);
      if (!values.length) continue;
      match = { [customDomainField(r)]: values };
    } else if (r.type === "set") {
      // Only site lists answer a DNS query: geoip is addresses,
      // and the query doesn't have them yet.
      const sites = customRuleSetRefs(r).filter((ref) => ref.kind === "geosite");
      if (!sites.length) continue;
      match = { rule_set: sites.map(setTag) };
    } else {
      continue;
    }
    if (r.action === "block") {
      out.push({ ...match, action: "reject" });
    } else if (r.action === "direct") {
      out.push({ ...match, ...direct });
    } else {
      // With FakeDNS the addresses for the tunnel are still fake: otherwise the rule
      // would silently turn off FakeDNS for its domains.
      if (fakeIp) out.push({ ...match, query_type: ["A", "AAAA"], server: "dns-fake" });
      out.push({ ...match, server: "dns-remote" });
    }
  }
  return out;
}

// Destinations on this PC itself. "Access from the local network" opens an inbound on
// 0.0.0.0, and without a separate rule network neighbors got not only internet access
// but also services that listen here only on 127.0.0.1 (panels,
// dev servers): such a destination went direct. We allow it only for the PC
// itself — a source with a loopback address. ::ffff:127.x is the same loopback in the form
// of an IPv6 socket; some stacks also route the "unspecified" address to the host itself.
const LOOPBACK_CIDRS = ["127.0.0.0/8", "::1/128", "::ffff:127.0.0.0/104"];
const SELF_DEST_CIDRS = [...LOOPBACK_CIDRS, "0.0.0.0/32", "::/128"];

// Inbounds neighbors can come to: mixed-in without a password or a separate
// mixed-lan with a password (then mixed-in listens only on loopback).
const LAN_INBOUNDS = ["mixed-in", "mixed-lan"];

// "off" — nothing is open to the network; "open" — mixed-in on 0.0.0.0 without a password;
// "password" — a separate mixed-lan with a login and password. The pair is substituted by
// the backend before launching the core (lan_auth.rs), and without it this inbound is removed
// entirely: an enabled password never turns into an open inbound.
export function lanInboundPolicy(inbound) {
  if (!inbound?.allowConnectionFromLan) return "off";
  return inbound.lanAuth ? "password" : "open";
}

function fromLanNeighbour() {
  return [{ inbound: LAN_INBOUNDS }, { source_ip_cidr: LOOPBACK_CIDRS, invert: true }];
}

function lanLoopbackGuard() {
  return {
    type: "logical",
    mode: "and",
    rules: [
      { inbound: LAN_INBOUNDS, domain_suffix: ["localhost"], ip_cidr: SELF_DEST_CIDRS },
      { source_ip_cidr: LOOPBACK_CIDRS, invert: true },
    ],
    action: "reject",
  };
}

// The rule above sees only what came in the request. The direct outbound resolves a neighbor's
// domain itself, after routing, so "x.example.ru → 127.0.0.1"
// (region, a user "Direct") led the neighbor to services listening
// only on loopback. Before every direct rule we resolve the name with the same resolver
// direct would resolve it with, and check the address again. The resolve sits right next
// to its rule and only for neighbors: a connection that will go into the tunnel
// and the PC's own traffic don't change (after resolve the core dials by IP).
function guardLanDirect(rules, resolver) {
  const out = [];
  for (const rule of rules) {
    if (rule.outbound === "direct" && !rule.process_name) {
      const match = { ...rule };
      delete match.outbound;
      delete match.action;
      out.push(
        { type: "logical", mode: "and", rules: [match, ...fromLanNeighbour()], action: "resolve", server: resolver },
        { type: "logical", mode: "and", rules: [{ ip_cidr: SELF_DEST_CIDRS }, ...fromLanNeighbour()], action: "reject" },
      );
    }
    out.push(rule);
  }
  return out;
}

function buildRoute(options, mode, protectedOutbound = "proxy", strictPrivacy = false, resolveTarget = null) {
  const rules = [
    { action: "sniff" },
    { protocol: "dns", action: "hijack-dns" },
    // Forced process lookup for ALL connections (in all modes). In
    // stock sing-box there's no global find_process — the process is resolved only
    // when a rule requires it. This rule with a nonexistent name forces the resolve
    // socket→PID→exe (sing-box puts the name into metadata.process for the clash API), but itself
    // does NOT match → it doesn't change routing. Thanks to it the connection monitor
    // shows the app name for every connection (like Throne), not only under
    // a process rule. It sits above bypass/custom/region so the lookup fires before
    // the first terminal rule. Overhead: one lookup per connection (sing-box
    // caches the TCP table). The sentinel is guaranteed not to match any real exe.
    // Opt-out (route.processLookup === false): the monitor stops showing process
    // names, but the per-connection resolve disappears — cheaper on a busy channel.
    ...(options.route?.processLookup !== false
      ? [{ process_name: ["\u0000ninety-force-process-lookup"], outbound: "direct" }]
      : []),
  ];

  const lanOpen = mode !== "tun" && lanInboundPolicy(options.inbound) !== "off";
  if (lanOpen) rules.push(lanLoopbackGuard());

  // ProcessName bypass — critical for TUN mode. Without it Ninety's own traffic
  // (Tauri webview HTTP requests to ipwho.is, etc.), sing-box itself and
  // all the bridges (xray, naive, trusttunnel_client — each dials the
  // real server itself) would loop back into the TUN interface: a connect to the endpoint
  // is caught by TUN → final:proxy → socks bridge → the same client again, recursion.
  // In proxy/systemProxy this bypass rule isn't needed: Ninety's own traffic doesn't
  // loop there (no_proxy reqwest + no auto_route intercepting everything), so
  // we add it only in TUN. IMPORTANT: process matching itself works in ALL modes
  // (sing-box resolves the process by the mixed inbound's local socket) — there is NO
  // "process_name only in TUN" restriction; this is solely about the bypass loop.
  if (mode === "tun") {
    // The quality probe (probe-in) goes into the tunnel, BEFORE the bypass rule below: otherwise
    // the Ninety.exe process match would send it direct and the bare channel would be measured
    // instead of the tunnel. With WARP active buildConfig will switch the outbound → warp.
    rules.push({ inbound: ["probe-in"], outbound: protectedOutbound });
    // The list must cover ALL engines that dial out (= ENGINES in
    // killswitch.rs + Ninety.exe) — a missed sidecar loops into itself.
    // In regular TUN Ninety's own HTTP requests go direct. A strict
    // session excludes only the engines: the controller must also go through TUN,
    // otherwise the updater/a service fetch could reveal the real address.
    rules.push({
      process_name: strictPrivacy ? ENGINE_PROCESS_NAMES : ["Ninety.exe", ...ENGINE_PROCESS_NAMES],
      outbound: "direct",
    });
  }

  // TUN + split Discord: Discord goes direct (past the tunnel) so that winws
  // desyncs it on the real interface. winws is NOT paused in TUN in this case (see
  // dpi-view.setDpiVpnMode). The VPN node is already in winws exclude — its traffic is left alone.
  //
  // Process + domains, not just one: domain rules cover Discord in
  // the browser but not voice UDP (see DISCORD_PROCESS_NAMES), while the process
  // covers the desktop client entirely, including voice. Without the process rule
  // voice went into the tunnel — exactly what the feature was supposed to remove.
  // User rules go ABOVE region/ads/LAN (they take priority over the base), but
  // below the service safety rules. Order in the array = priority (the first match
  // wins): custom overrides the region (e.g. "Telegram → through VPN" beats
  // .ru-direct for Telegram traffic), and all other traffic follows the base below.
  //
  // Split Discord sits BELOW custom (not above, as it used to): otherwise a rule
  // "discord.com → through VPN" created by the user manually silently didn't
  // work — the match was found earlier, in the split block. The split setting
  // stays the base, but the user's explicit rule overrides it.
  rules.push(...customRulesToSingbox(options.route?.customRules, protectedOutbound, resolveTarget));

  if (mode === "tun" && options.route?.tunSplitDiscord) {
    rules.push({ process_name: DISCORD_PROCESS_NAMES, outbound: "direct" });
    rules.push({ rule_set: [setTag({ kind: "geosite", name: "discord" })], outbound: "direct" });
    rules.push({ domain_suffix: DISCORD_SUFFIXES, outbound: "direct" });
  }

  if (options.route.bypassLan) {
    rules.push({ ip_is_private: true, outbound: "direct" });
  }

  const region = activeRegion(options);
  if (region) {
    rules.push({ domain_suffix: [`.${region}`], outbound: "direct" });
    rules.push({ rule_set: regionSetRefs(region).map(setTag), outbound: "direct" });
  }

  if (options.blockAds) {
    rules.push({ rule_set: BLOCK_AD_SETS.map(([tag]) => tag), action: "reject" });
  }

  const directResolver = options.route.resolveDestination ? "dns-remote" : "dns-direct";
  const route = {
    rules: lanOpen ? guardLanDirect(rules, directResolver) : rules,
    rule_set: buildRuleSets(options, mode, protectedOutbound),
    final: "proxy",
    auto_detect_interface: true,
    default_domain_resolver: {
      server: directResolver,
    },
  };

  return route;
}

// ── inbounds (sing-box 1.13: sniff/tun.address — via route rules / inet4_address) ─
// Returns an ARRAY of inbounds. In TUN, besides tun-in, we bring up probe-in — mixed
// on loopback for the quality engine probe: Ninety.exe's own traffic in TUN
// goes direct via the bypass rule (loop protection), so a "direct" probe
// would measure the bare channel, not the tunnel. The inbound=probe-in → proxy/warp rule
// in buildRoute sits ABOVE bypass and drives the probe through the outbound.
// ULA prefix for TUN: it doesn't get into public routing.
const TUN_IPV4 = "172.19.0.1/30";
const TUN_IPV6 = "fdfe:dcba:9876::1/126";

/**
 * TUN interface addresses.
 *
 * Both IPv4 + IPv6 are needed: auto_route builds routes only for the families
 * whose address is on the interface. With only an IPv4 address all native IPv6 traffic
 * goes past the tunnel via the physical interface — apps with their own resolver
 * (Chromium/Electron with DoH get AAAA bypassing hijack-dns) leak with the real
 * address even in TUN.
 *
 * There's exactly one exception: a system where IPv6 is disabled entirely. There assigning
 * the address fails ("set ipv6 address: Element not found"), and the core dies together
 * with the whole TUN mode. Nothing is lost — since the stack is off, there's no IPv6 traffic
 * and nothing to protect.
 *
 * `systemIpv6` is ternary and comes from the Rust probe: we drop the address ONLY on
 * an explicit false. Unknown (the probe didn't run, non-Windows, the machine is offline)
 * keeps today's behavior: erring on the side of protection is cheaper than
 * silently removing it on a healthy machine.
 */
function tunAddresses(systemIpv6) {
  return systemIpv6 === false ? [TUN_IPV4] : [TUN_IPV4, TUN_IPV6];
}

function buildInbounds(mode, options, systemIpv6) {
  if (mode === "tun") {
    return [
      {
        type: "tun",
        tag: "tun-in",
        interface_name: "ninety-tun",
        address: tunAddresses(systemIpv6),
        mtu: options.inbound.mtu || 9000,
        auto_route: true,
        strict_route: !!options.inbound.strictRoute,
        stack: options.inbound.tunStack || "mixed",
      },
      {
        type: "mixed",
        tag: "probe-in",
        listen: "127.0.0.1",
        listen_port: options.inbound.mixedPort || 7890,
      },
    ];
  }
  const lan = lanInboundPolicy(options.inbound);
  const inbounds = [{
    type: "mixed",
    tag: "mixed-in",
    listen: lan === "open" ? "0.0.0.0" : "127.0.0.1",
    listen_port: options.inbound.mixedPort || 7890,
  }];
  if (lan === "password") {
    // users are deliberately absent here: the backend writes them from the encrypted
    // storage, and without them removes this inbound.
    inbounds.push({
      type: "mixed",
      tag: "mixed-lan",
      listen: "0.0.0.0",
      listen_port: options.inbound.lanPort || 7891,
    });
  }
  return inbounds;
}

// ── WARP endpoint (Cloudflare WireGuard) ───────────────────
// Takes WarpInfo from the warp_status Tauri command (see src-tauri/src/warp.rs)
// and builds a sing-box endpoint type=wireguard. Returns [endpoint, finalTag]
// or null if WARP isn't configured.
//
//   mode "direct": WARP is the only outbound, route.final = "warp",
//                  the proxy selector stays in the outbounds for the UI/clash API.
//   mode "chain":  WARP on top of proxy (endpoint.detour = "proxy"), route.final = "warp".
function buildWarpEndpoint(warpOpts, warpInfo) {
  if (!warpOpts?.enabled || !warpInfo?.private_key || !warpInfo?.peer_public_key) {
    return null;
  }
  const endpointStr = warpOpts.endpoint || "engage.cloudflareclient.com:2408";
  // hostPort: either host:port, or auto4/auto6/auto → host = the string, port = 2408
  let host = endpointStr, port = 2408;
  if (/^auto[46]?$/.test(endpointStr)) {
    host = endpointStr;
  } else {
    try {
      const { host: h, port: p } = splitHostPort(endpointStr);
      host = h;
      if (p) port = p;
    } catch {
      // fallback: keep endpointStr as the host
    }
  }

  // client_id base64 → 3 reserved bytes (CF checks the first 3)
  const clientIdRaw = safeAtob(warpInfo.client_id || "");
  const reserved = [];
  for (let i = 0; i < 3; i++) reserved.push(clientIdRaw.charCodeAt(i) || 0);

  const address = [];
  if (warpInfo.local_ipv4) address.push(`${warpInfo.local_ipv4}/32`);
  if (warpInfo.local_ipv6) address.push(`${warpInfo.local_ipv6}/128`);
  if (!address.length) return null;

  const endpoint = {
    type: "wireguard",
    tag: "warp",
    address,
    private_key: warpInfo.private_key,
    mtu: warpOpts.mtu || 1280,
    peers: [
      {
        address: host,
        port,
        public_key: warpInfo.peer_public_key,
        allowed_ips: ["0.0.0.0/0", "::/0"],
        reserved,
      },
    ],
  };

  // AmneziaWG obfuscation. The noise.fake_packet field
  // is written straight into the sing-box fork's WG endpoint (see hsb/option/wireguard.go).
  // Range is serialized as a "from-to" string (Range.MarshalJSON in the core).
  const noisePreset = warpOpts.noisePreset || "off";
  let noise = WARP_NOISE_PRESETS[noisePreset];
  if (noisePreset === "custom") {
    noise = buildCustomNoise(warpOpts.customNoise);
  }
  if (noise) {
    endpoint.noise = { fake_packet: noise };
  }

  if (warpOpts.mode === "chain") {
    // detour: WARP WG packets are sent through the active "proxy" selector
    endpoint.detour = "proxy";
  }
  return endpoint;
}

// A user WireGuard node (.conf import). In sing-box 1.13 the wireguard outbound
// was removed, only the endpoint remains — so the node lives in endpoints, not outbounds.
// The tag is regular, node-*: groups (selector, urltest, balancer) reference
// it the same way as any outbound, because on a miss the core's manager
// looks the tag up among the endpoints by outbound tags (adapter/outbound/manager.go).
function buildWireguardEndpoint(p, tag, pinServerResolver = false) {
  const peers = (p.peers?.length ? p.peers : [{
    host: p.host, port: p.port, publicKey: p.publicKey,
    allowedIps: ["0.0.0.0/0", "::/0"], keepalive: 0,
  }]);
  const endpoint = {
    type: "wireguard",
    tag,
    address: (p.addresses || []).slice(),
    private_key: p.privateKey,
    peers: peers.map((peer) => {
      const out = {
        address: peer.host,
        port: peer.port,
        public_key: peer.publicKey,
        allowed_ips: peer.allowedIps?.length ? peer.allowedIps : ["0.0.0.0/0", "::/0"],
      };
      if (peer.presharedKey) out.pre_shared_key = peer.presharedKey;
      if (peer.keepalive) out.persistent_keepalive_interval = peer.keepalive;
      // Three reserved bytes are carried by WARP and peers compatible with it. A .conf has no such
      // field — it comes only from an imported core config.
      if (Array.isArray(peer.reserved) && peer.reserved.length === 3) {
        out.reserved = peer.reserved.map(Number);
      }
      return out;
    }),
  };
  if (p.mtu) endpoint.mtu = p.mtu;
  if (p.listenPort) endpoint.listen_port = p.listenPort;
  const amnezia = buildAmneziaNoise(p.awg);
  if (amnezia) endpoint.noise = { amnezia };
  // The peer address is resolved before the tunnel is up — the same case as
  // the address of a regular server (see pinServerResolver in buildConfig).
  if (pinServerResolver && peers.some((peer) => !isIpLiteral(peer.host))) {
    endpoint.domain_resolver = "dns-direct";
  }
  return endpoint;
}

// OpenVPN, like WireGuard, lives in endpoints. The copy keeps the original
// profile model when changing the tag and applying the DNS policy.
function buildOpenvpnEndpoint(profile, tag, pinServerResolver = false) {
  const endpoint = structuredClone(profile.endpoint);
  endpoint.type = "openvpn-client";
  endpoint.tag = tag;
  const servers = endpoint.servers?.length ? endpoint.servers : [endpoint];
  if (pinServerResolver && servers.some((server) => !isIpLiteral(server.server))) {
    endpoint.domain_resolver = "dns-direct";
  }
  return endpoint;
}

// AmneziaWG shaping goes to the core with the names from .conf (see noise/amnezia.go in
// ninety-wireguard-go). An empty block isn't written at all: regular WireGuard doesn't
// need it, and the core rejects a partially filled H1..H4 set.
function buildAmneziaNoise(awg) {
  if (!awg) return null;
  const noise = {};
  if (awg.jc > 0 && awg.jmax > 0) {
    noise.jc = awg.jc;
    noise.jmin = awg.jmin || 0;
    noise.jmax = awg.jmax;
  }
  if (awg.s1 > 0) noise.s1 = awg.s1;
  if (awg.s2 > 0) noise.s2 = awg.s2;
  // S3/S4 — AmneziaWG 2.0: padding for the cookie reply and for every transport packet.
  if (awg.s3 > 0) noise.s3 = awg.s3;
  if (awg.s4 > 0) noise.s4 = awg.s4;
  // H1..H4 = 1,2,3,4 are exactly the WireGuard message types: the file repeats
  // the default, nobody asks to change the protocol. The value goes as is: a number (1.x)
  // or a "from-to" string (a 2.0 range) — the core reads both forms.
  const headers = [awg.h1, awg.h2, awg.h3, awg.h4].map((value) => parseAwgHeader(value) || 0);
  if (headers.some((value, index) => value && value !== index + 1)) {
    headers.forEach((value, index) => {
      noise[`h${index + 1}`] = value || index + 1;
    });
  }
  for (const key of ["i1", "i2", "i3", "i4", "i5"]) {
    if (awg[key]) noise[key] = awg[key];
  }
  // AmneziaWG 3: header protection, content padding, random trailers.
  if (awg.headerProtectionKey) noise.header_protection_key = awg.headerProtectionKey;
  if (awg.contentPaddingAddition) noise.content_padding_addition = awg.contentPaddingAddition;
  if (awg.randomTrailers) noise.random_trailers = true;
  return Object.keys(noise).length ? noise : null;
}

const WARP_NOISE_PRESETS = {
  off: null,
  default: {
    enabled: true,
    count: "1-3",
    size: "10-30",
    delay: "10-30",
    mode: "random",
  },
  aggressive: {
    enabled: true,
    count: "3-8",
    size: "30-90",
    delay: "5-15",
    mode: "random",
  },
  custom: null, // built from warp.customNoise via buildCustomNoise
};

function buildCustomNoise(cn) {
  if (!cn) return null;
  const range = (r, defFrom, defTo) => {
    const f = Number.isFinite(r?.from) ? r.from : defFrom;
    const to = Number.isFinite(r?.to)   ? r.to   : defTo;
    const lo = Math.min(f, to), hi = Math.max(f, to);
    return `${lo}-${hi}`;
  };
  return {
    enabled: true,
    count: range(cn.count, 2, 5),
    size:  range(cn.size, 20, 60),
    delay: range(cn.delay, 8, 20),
    mode: "random",
  };
}

// ── two-core bridge: xhttp via xray-core ─────────────────
// The xhttp port in the sing-box fork (packet-up) reliably carries only ping, a real
// stream falls apart. The reference is xray-core. So xhttp nodes are moved to a local
// xray (a per-node socks inbound), and sing-box keeps a socks bridge on 127.0.0.1.
// sing-box urltest/balancer keep pinging the node through socks → xray.
// Important: xhttpSettings for xray are EXACTLY what's in the link (host/path/mode +
// extra with downloadSettings in the Xray schema), without any translation.
const XRAY_BRIDGE_BASE_PORT = 31100;
// Local SOCKS5 ports of the naive / trusttunnel_client sidecar clients. Separate
// ranges so they don't overlap with each other or with xray (31100+).
const NAIVE_BRIDGE_BASE_PORT = 31200;
const TT_BRIDGE_BASE_PORT = 31300;

// How many loopback bridges the source needs — one port per xhttp/naive/TT
// node. Using these counters main.js asks Rust (plan_bridge_ports) to pick
// free bases with a bind probe: the default 31100+ may be taken by a foreign process, and
// the bridge would die at startup. The result goes into buildConfig({ bridgePorts }).
export function bridgeNeeds(nodes) {
  const needs = { xray: 0, naive: 0, trusttunnel: 0 };
  for (const n of nodes || []) {
    if (needsXrayBridge(n)) needs.xray++;
    const proto = profileProto(n);
    if (proto === "naive") needs.naive++;
    else if (proto === "trusttunnel") needs.trusttunnel++;
  }
  return needs;
}

// config.json of the naive client (klzgrad): one proxy → one local SOCKS5.
// An IPv6 literal in the URL authority must be in brackets: the parser strips them when
// parsing the link, and without putting them back the result was `https://u:p@2001:db8::1:443`,
// which the klzgrad client can't parse — the node silently didn't come up.
function urlAuthorityHost(host) {
  const value = String(host || "");
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function naiveSidecarConfig(p, port) {
  const u = encodeURIComponent(p.username);
  const pw = encodeURIComponent(p.password);
  const scheme = p.scheme === "quic" ? "quic" : "https";
  return JSON.stringify({
    listen: `socks://127.0.0.1:${port}`,
    proxy: `${scheme}://${u}:${pw}@${urlAuthorityHost(p.host)}:${p.port}`,
  }, null, 2);
}

// Escaping a value for a TOML basic string. Besides \ and ", we must
// escape control characters: TOML forbids a raw line break/tab
// inside a basic string, so a subscription field with \n (username/password/customSni/
// certificate) would otherwise produce an invalid config → trusttunnel_client fails on
// parsing and the node silently doesn't come up.
function tomlStr(v) {
  const s = String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    // other control characters (U+0000–U+001F, plus DEL U+007F); \n \r \t are already
    // replaced above and won't fall into the range.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (c) =>
      `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
  return `"${s}"`;
}
function tomlArr(list) {
  return `[${(list || []).map(tomlStr).join(", ")}]`;
}

// Log level from settings (opts.log.level) → a specific engine's format.
// There's one setting, but the engines name levels differently. The base scale is
// sing-box: trace/debug/info/warn/error.
const SB_LEVELS = ["trace", "debug", "info", "warn", "error"];
function sbLevel(opts) {
  const l = opts?.log?.level;
  return SB_LEVELS.includes(l) ? l : "info";
}
// xray: debug/info/warning/error/none (warn → warning).
function xrayLevel(opts) {
  return ({ trace: "debug", debug: "debug", info: "info", warn: "warning", error: "error" })[sbLevel(opts)] || "warning";
}
// trusttunnel: trace/debug/info/warn/error — the names match sing-box.
function ttLevel(opts) { return sbLevel(opts); }

// trusttunnel_client.toml in SOCKS5 listener mode (no TUN → no admin rights).
// killswitch is off: it isn't needed in a socks bridge and could cut local traffic.
function trustTunnelSidecarConfig(p, port, opts) {
  const lines = [
    `loglevel = ${tomlStr(ttLevel(opts))}`,
    // vpn_mode is mandatory (top-level): the client fails with "Unexpected VPN mode: " when
    // it's missing (build_config parses it before the listener). general = all socks
    // listener traffic into the endpoint; selective sends only exclusions into the tunnel —
    // we need general, because sing-box does the routing, and TT is a pure bridge.
    `vpn_mode = "general"`,
    `killswitch_enabled = false`,
    // The official setup_wizard default is true; we align 1:1 (a post-quantum
    // group in the TLS handshake). It doesn't affect auth, but removes the only
    // difference between our settings config and the wizard's canonical output.
    `post_quantum_group_enabled = true`,
    ``,
    `[endpoint]`,
    `hostname = ${tomlStr(p.hostname)}`,
    `addresses = ${tomlArr(p.addresses)}`,
    `has_ipv6 = ${p.hasIpv6 ? "true" : "false"}`,
    `username = ${tomlStr(p.username)}`,
    `password = ${tomlStr(p.password)}`,
    `skip_verification = ${p.skipVerification ? "true" : "false"}`,
    `upstream_protocol = ${tomlStr(p.upstreamProtocol || "http2")}`,
    `anti_dpi = ${p.antiDpi ? "true" : "false"}`,
  ];
  // custom_sni: overrides the SNI/authority for the endpoint. If the subscription
  // sets it, without it the request goes to the wrong vhost → the server may return
  // "Authorization Required". The field used to get lost.
  if (p.customSni) lines.push(`custom_sni = ${tomlStr(p.customSni)}`);
  if (p.clientRandom) lines.push(`client_random = ${tomlStr(p.clientRandom)}`);
  if (p.certificate) lines.push(`certificate = ${tomlStr(p.certificate)}`);
  if (p.dnsUpstreams && p.dnsUpstreams.length) lines.push(`dns_upstreams = ${tomlArr(p.dnsUpstreams)}`);
  lines.push(``, `[listener.socks]`, `address = "127.0.0.1:${port}"`);
  return lines.join("\n") + "\n";
}

// Xray exits on an unfamiliar fingerprint, and its list is narrower than sing-box's.
// A fingerprint is just a ClientHello disguise: as for the core, we replace it with chrome.
const XRAY_FINGERPRINTS = new Set([
  "chrome", "firefox", "safari", "ios", "android", "edge", "360", "qq",
  "random", "randomized", "randomizednoalpn",
]);

function xrayFingerprint(raw) {
  const fp = String(raw || "").trim().toLowerCase();
  return XRAY_FINGERPRINTS.has(fp) ? fp : "chrome";
}

function nodeToXrayStream(p) {
  // The bridge is brought up not only for xhttp: the core doesn't support mKCP at all, while xray does.
  // Regular TCP (raw) goes here only for VLESS encryption, which the core doesn't have.
  const network = p.type === "kcp" ? "kcp" : XRAY_RAW_TYPES.has(String(p.type || "")) ? "raw" : "xhttp";
  const ss = { network };
  const sec = p.tlsMode || p.security;
  if (sec === "reality") {
    ss.security = "reality";
    ss.realitySettings = {
      serverName: p.sni || "",
      fingerprint: xrayFingerprint(p.fp),
      publicKey: normalizeRealityPublicKey(p.pbk) || p.pbk || "",
      shortId: p.sid || "",
    };
  } else if (sec === "tls") {
    ss.security = "tls";
    ss.tlsSettings = { serverName: p.sni || "", fingerprint: xrayFingerprint(p.fp) };
    if (p.alpn) ss.tlsSettings.alpn = String(p.alpn).split(",").map(s => s.trim()).filter(Boolean);
  } else {
    ss.security = "none";
  }
  if (network === "raw") return ss;
  if (network === "kcp") {
    // Other mKCP parameters (mtu/tti/windows/congestion) aren't passed in links —
    // we keep the xray defaults, they match the server side's defaults.
    ss.kcpSettings = { header: { type: p.headerType || "none" } };
    if (p.seed) ss.kcpSettings.seed = p.seed;
    return ss;
  }
  const xs = { host: p.host_header || p.sni || "", path: p.path || "/", mode: p.mode || "auto" };
  if (p.extra) {
    try { const ex = JSON.parse(p.extra); if (ex && typeof ex === "object") Object.assign(xs, ex); }
    catch { /* a broken extra — the base fields are enough */ }
  }
  ss.xhttpSettings = xs;
  return ss;
}

// Protocols the local xray bridge can bring up for xhttp. Previously EVERYTHING
// that wasn't trojan fell through here: vmess+xhttp was built as a vless outbound with
// its own uuid — the config is valid, the core starts, the node is dead without a single line in
// the log. There's one predicate for bridgeNeeds and for building the config: a divergence between these two
// places would mean that the number of planned ports differs from the number used.
const XRAY_BRIDGE_PROTOS = new Set(["vless", "vmess", "trojan"]);
// Transports the core doesn't have: they're carried by the local xray, and sing-box
// keeps a socks bridge.
const XRAY_BRIDGE_TYPES = new Set(["xhttp", "kcp"]);
// Regular TCP. Only VLESS with encryption goes through xray (see below).
const XRAY_RAW_TYPES = new Set(["", "tcp", "raw"]);
export function needsXrayBridge(node) {
  // A ready Xray outbound (a server that can't be expressed by a link: finalmask,
  // VLESS encryption) can't be brought up by the core at all — only by xray.
  if (profileProto(node) === "xray") return true;
  // VLESS encryption (ML-KEM, etc.) exists only in xray: the native sing-box
  // outbound silently lost the field, and the node was dead without a single line in the log.
  // Other transports with encryption are weeded out by link validation.
  if (vlessEncryptionOf(node) && XRAY_RAW_TYPES.has(String(node?.type || ""))) return true;
  return XRAY_BRIDGE_TYPES.has(node?.type) && XRAY_BRIDGE_PROTOS.has(profileProto(node));
}

// DNS for the xray bridge. Without it xray resolves the server address with the Windows system
// resolver (Go → GetAddrInfoW → the DNS Client service), and with the Kill Switch
// WFP lets through only the engine processes: the service's request was blocked, and
// domain-based XHTTP/mKCP nodes stopped connecting as soon as the cache expired.
// We take the same direct DNS that sing-box already uses to resolve its servers' addresses,
// and only if it's given as an IP address (otherwise it itself would need resolving).
// "+local" — the query goes straight from xray.exe, not through its outbounds. For
// regular UDP there's no such form: xray would send it through the dispatcher, i.e.
// into a proxy outbound, which first needs its own address for that.
function xrayDnsServer(directAddress) {
  let parsed;
  try { parsed = parseDnsAddress(directAddress); } catch { return null; }
  // URL.hostname returns IPv6 already in brackets — we strip them to avoid doubling.
  const ip = String(parsed?.server || "").replace(/^\[(.*)\]$/, "$1");
  if (!ip || !isIpLiteral(ip)) return null;
  const host = ip.includes(":") ? `[${ip}]` : ip;
  const port = parsed.server_port ? `:${parsed.server_port}` : "";
  switch (parsed.type) {
    case "https": return `https+local://${host}${port}${parsed.path || "/dns-query"}`;
    case "tcp": return `tcp+local://${host}${port}`;
    case "quic": return `quic+local://${host}${port}`;
    default: return null; // UDP and DoT — the system resolver stays, as before
  }
}

// Resolve the server address with xray's built-in DNS. UseIP, not ForceIP: if DoH
// is unavailable, xray falls back to the system resolver, as before.
function preferXrayDns(outbound) {
  const ss = outbound?.streamSettings;
  if (!ss || typeof ss !== "object") return;
  for (const holder of [ss, ss.xhttpSettings?.downloadSettings]) {
    if (!holder || typeof holder !== "object") continue;
    if (!holder.sockopt || typeof holder.sockopt !== "object") holder.sockopt = {};
    if (!holder.sockopt.domainStrategy) holder.sockopt.domainStrategy = "UseIP";
  }
}

function nodeToXrayOutbound(p, tag) {
  const proto = profileProto(p);
  if (proto === "xray") {
    // A deep copy: the node object lives in storage and is shared by all builds,
    // while each build has its own tag. File fields are stripped here too: profiles
    // saved before this check may still contain them.
    return { ...stripXrayFileFields(JSON.parse(JSON.stringify(p.outbound || {}))), tag };
  }
  if (proto === "trojan") {
    return {
      tag, protocol: "trojan",
      settings: { servers: [{ address: p.host, port: p.port, password: p.password }] },
      streamSettings: nodeToXrayStream(p),
    };
  }
  if (proto === "vmess") {
    // alterId>0 is legacy MD5 authentication, which current xray-core no longer
    // has; we send 0, as all current panels do.
    const user = { id: p.uuid, alterId: 0, security: p.security || "auto" };
    return {
      tag, protocol: "vmess",
      settings: { vnext: [{ address: p.host, port: p.port, users: [user] }] },
      streamSettings: nodeToXrayStream(p),
    };
  }
  const user = { id: p.uuid, encryption: p.encryption || "none" };
  if (p.flow) user.flow = p.flow;
  return {
    tag, protocol: "vless",
    settings: { vnext: [{ address: p.host, port: p.port, users: [user] }] },
    streamSettings: nodeToXrayStream(p),
  };
}

// ── main builder ────────────────────────────────────────
// Supports both calls:
//   buildConfig({ profile, mode, options }) — a single vless (legacy)
//   buildConfig({ source, mode, options })  — { kind, profile|nodes }
// If nodes.length >= 2 → builds a urltest group: an "auto" outbound with
// child vless outbounds; route.final → auto.
//
// warpInfo: an optional WarpInfo object from the warp_status command.
//   If options.warp.enabled === true and warpInfo is passed with valid keys,
//   a WireGuard endpoint is added and route.final switches to "warp".
//
// runtimePolicy: the pure runtime policy from strict-privacy-policy.js. The strict
// policy always switches the builder to TUN, applies a safe copy of options and
// for a multi-node subscription requires one specific selectedNodeTag.
export function buildConfig({
  profile,
  source,
  mode,
  options,
  runtimePolicy,
  warpInfo,
  xray = false,
  bridgePorts,
  systemIpv6,
}) {
  const runtime = resolveRuntimePrivacyPolicy({
    mode,
    options: options || DEFAULT_OPTIONS,
    runtimePolicy,
  });
  const opts = runtime.options || DEFAULT_OPTIONS;
  const effectiveMode = runtime.mode;
  const src = source ?? (profile ? { kind: "single", profile } : null);

  const warpEndpoint = buildWarpEndpoint(opts.warp, warpInfo);
  // A WARP peer by domain: with dns-remote (detour through WARP) it would be resolved through
  // WARP itself. Like the server addresses, it gets direct dns-direct.
  if (warpEndpoint && opts.route?.resolveDestination
      && (warpEndpoint.peers || []).some((peer) => peer?.address && !isIpLiteral(peer.address))) {
    warpEndpoint.domain_resolver = "dns-direct";
  }
  const warpOnly = !src && !!warpEndpoint && opts.warp?.mode === "direct";
  if (!src && !warpOnly) throw new Error(t("sb.err.buildNoSource"));

  // Loopback bridge port bases: the plan from plan_bridge_ports (free ranges)
  // or static defaults (config export, tests — bind isn't needed there).
  const basePorts = {
    xray: bridgePorts?.xray || XRAY_BRIDGE_BASE_PORT,
    naive: bridgePorts?.naive || NAIVE_BRIDGE_BASE_PORT,
    trusttunnel: bridgePorts?.trusttunnel || TT_BRIDGE_BASE_PORT,
  };

  // Connection test URL/interval from settings (keys connectionTestUrl/intervalSec,
  // Previously buildConfig read nonexistent url/interval and
  // the user's config was ignored.
  const testUrl = opts.urlTest?.connectionTestUrl || "https://www.gstatic.com/generate_204";
  const intervalSec = Number(opts.urlTest?.intervalSec) > 0 ? Number(opts.urlTest.intervalSec) : 600;
  const testInterval = `${intervalSec}s`;

  let nodes = warpOnly ? [] : (src.kind === "sub" ? src.nodes : [src.profile]);
  if (!warpOnly && !nodes?.length) throw new Error(t("sb.err.buildNoNodes"));
  // The core initializes the config as a whole: one node with parameters it doesn't
  // accept brings down the whole start. We clean the subscription and work on the remaining ones,
  // a single profile has nothing to clean — we return a clear error instead of a core FATAL.
  if (!warpOnly && src.kind === "sub") {
    nodes = withoutPlaceholders(usableNodes(nodes).filter(node => !isNodeQuarantined(node)));
    if (!nodes.length) throw new Error(t("sb.err.buildAllNodesInvalid"));
  } else if (!warpOnly && nodeConfigIssue(nodes[0])) {
    throw new Error(t("sb.err.nodeInvalid", { name: nodes[0]?.name || nodes[0]?.host || "" }));
  }
  let pinnedNodeTag = null;
  if (runtime.strictPrivacy && nodes.length) {
    const selected = selectStrictPrivacyCandidate(
      nodes.map((node, index) => ({ tag: nodeTag(index, node), value: node })),
      runtime.selectedNodeTag,
    );
    nodes = [selected.value];
    pinnedNodeTag = selected.tag;
    assertStrictBootstrapSafe(selected.value);
  }

  const protectedOutbound = warpEndpoint ? "warp" : "proxy";
  const useUrltest = nodes.length >= 2;

  // A "through a specific server" rule (action:"node") stores a reference to the node, not
  // a ready tag: on a single-node subscription the tag is different altogether ("proxy", there's no
  // group), and the quarantine and usableNodes may have dropped the node from this build. We build the map
  // from the nodes that actually made it into the config, and search first by
  // the hash tag, then by name. Not found — resolveRuleTarget returns null, and
  // the rule goes to protectedOutbound instead of referencing a nonexistent tag.
  const outboundByNodeTag = new Map();
  const outboundByNodeName = new Map();
  nodes.forEach((node, i) => {
    const actual = useUrltest ? nodeTag(i, node) : "proxy";
    outboundByNodeTag.set(nodeTag(i, node), actual);
    const name = String(node?.name || "").trim();
    if (name && !outboundByNodeName.has(name)) outboundByNodeName.set(name, actual);
  });
  const resolveRuleTarget = (rule) => {
    // WARP as a target exists only when the endpoint is built: otherwise there's no "warp" tag
    // in the config at all.
    if (rule?.action === "warp") return warpEndpoint ? "warp" : null;
    if (rule?.action !== "node") return null;
    const tag = String(rule?.target?.tag || "").trim();
    if (tag && outboundByNodeTag.has(tag)) return outboundByNodeTag.get(tag);
    const name = String(rule?.target?.name || "").trim();
    return (name && outboundByNodeName.get(name)) || null;
  };

  const route = buildRoute(opts, effectiveMode, protectedOutbound, runtime.strictPrivacy, resolveRuleTarget);
  // WireGuard and OpenVPN are built into endpoints, the rest into outbounds. The array
  // is shared and matches nodes by index: tags, groups and the "object → node" map
  // must see the same order, otherwise diagnostics would start naming
  // someone else's node. Which of them are endpoints is remembered by nodeEndpoints.
  const nodeEndpoints = new Set();
  // The VPN server's own address is inevitably resolved before the tunnel is ready. When
  // the default resolver is dns-remote (strict mode or "Resolve site addresses
  // inside the tunnel"), and it goes through the same proxy, the server address
  // would be resolved through the server itself, and not a single domain node would come up.
  // So the server address gets direct dns-direct (in strict mode this is IP-hosted DoH without
  // a detour); DNS for user destinations still goes through dns-remote.
  const pinServerResolver = runtime.strictPrivacy || !!opts.route?.resolveDestination;
  const vlessOutbounds = nodes.map((n, i) => {
    const tag = useUrltest ? nodeTag(i, n) : "proxy";
    if (profileProto(n) === "wireguard") {
      const endpoint = buildWireguardEndpoint(n, tag, pinServerResolver);
      nodeEndpoints.add(endpoint);
      return endpoint;
    }
    if (profileProto(n) === "openvpn") {
      const endpoint = buildOpenvpnEndpoint(n, tag, pinServerResolver);
      nodeEndpoints.add(endpoint);
      return endpoint;
    }
    const ob = buildOutbound(n, opts);
    ob.tag = tag;
    if (pinServerResolver && !isIpLiteral(ob.server)) {
      ob.domain_resolver = "dns-direct";
    }
    return ob;
  });

  // Two-core bridge: xhttp nodes → local xray, sing-box keeps a socks bridge.
  let xrayConfig = null;
  if (xray) {
    const xIn = [], xOut = [], xRules = [];
    nodes.forEach((n, i) => {
      if (!needsXrayBridge(n)) return;
      const idx = xOut.length;
      const port = basePorts.xray + idx;
      const inTag = `in-${idx}`, outTag = `out-${idx}`;
      xIn.push({ tag: inTag, listen: "127.0.0.1", port, protocol: "socks", settings: { auth: "noauth", udp: true } });
      xOut.push(nodeToXrayOutbound(n, outTag));
      xRules.push({ type: "field", inboundTag: [inTag], outboundTag: outTag });
      // A bridge instead of vless+xhttp; the outbound tag is kept — the selector/urltest
      // reference it.
      vlessOutbounds[i] = {
        tag: vlessOutbounds[i].tag,
        type: "socks", server: "127.0.0.1", server_port: port, version: "5",
      };
    });
    if (xOut.length) {
      xrayConfig = {
        log: { loglevel: xrayLevel(opts) },
        inbounds: xIn,
        outbounds: xOut,
        routing: { domainStrategy: "AsIs", rules: xRules },
      };
      const xrayDns = xrayDnsServer(opts.dns?.directAddress);
      if (xrayDns) {
        xrayConfig.dns = { servers: [xrayDns] };
        xOut.forEach(preferXrayDns);
      }
    }
  }

  // Sidecar bridge for naive / trusttunnel (always, independent of the xray flag):
  // these protocols have no native outbound — each node brings up its own
  // client process on 127.0.0.1:PORT (SOCKS5), and sing-box keeps a socks bridge.
  // urltest/balancer ping the node through socks → the client, as with xray.
  const sidecars = [];
  let naiveN = 0, ttN = 0;
  nodes.forEach((n, i) => {
    const proto = profileProto(n);
    let port, config, kind;
    if (proto === "naive") {
      port = basePorts.naive + naiveN++; kind = "naive"; config = naiveSidecarConfig(n, port);
    } else if (proto === "trusttunnel") {
      port = basePorts.trusttunnel + ttN++; kind = "trusttunnel"; config = trustTunnelSidecarConfig(n, port, opts);
    } else return;
    sidecars.push({ kind, port, config });
    vlessOutbounds[i] = {
      tag: vlessOutbounds[i].tag,
      type: "socks", server: "127.0.0.1", server_port: port, version: "5",
    };
  });

  let outbounds;
  if (warpOnly) {
    outbounds = [
      { type: "direct", tag: "direct" },
    ];
  } else if (useUrltest) {
    // "Auto" is NOT a URLTest but a Balancer with strategy=lowest-delay: it picks
    // the outbound with the minimum latency, and interrupt_exist_connections tears down
    // old connections when the leader changes → a real "live" switch.
    //
    // It does the measurements ITSELF (url/interval below). Previously there was a separate
    // "lowest" health checker of urltest type next to it, and it didn't work: a urltest group
    // starts its periodic check from Touch(), and Touch is called only
    // when traffic is dialed through the group itself. Nothing went through "lowest",
    // the ticker never started once, and latencies froze at the single
    // pass at core startup — after that the balancer chose from dead numbers.
    const nodeTags = vlessOutbounds.map(o => o.tag);

    const auto = {
      type: "balancer",
      tag: "auto",
      outbounds: nodeTags,
      strategy: "lowest-delay",
      url: testUrl,
      interval: testInterval,
      // The threshold below which a difference isn't worth tearing down connections. It must
      // be smaller than the real spread between servers: with 50 ms and a subscription
      // where live nodes fit into 59-76 ms, the whole range was inside
      // the threshold — the balancer couldn't switch in principle, and the selected server
      // stayed worse than its neighbors in the list.
      tolerance: 15,
      // A node that couldn't be dialed drops out of the elections for this
      // time (then exponentially). Otherwise "the fastest by measurement but
      // dead" one is re-elected right after every failure.
      failure_cooldown: "30s",
      interrupt_exist_connections: true,
    };
    const selector = {
      type: "selector",
      tag: "proxy",
      outbounds: ["auto", ...nodeTags],
      default: "auto",
      // Tears down old connections when the choice changes — but only those the core
      // dialed itself through the selector as a dialer (dns detour, the WARP chain).
      // Inbound traffic goes past it: Selector.NewConnectionEx hands the connection
      // straight to the selected outbound, and the selector's interrupt group stays
      // empty. It's torn down by clash_close_proxy_connections after a node switch.
      interrupt_exist_connections: true,
    };
    outbounds = [
      selector,
      auto,
      ...vlessOutbounds.filter((node) => !nodeEndpoints.has(node)),
      { type: "direct", tag: "direct" },
    ];
  } else if (nodeEndpoints.has(vlessOutbounds[0])) {
    // The only node is an endpoint: it isn't in the outbounds at all, the "proxy" tag
    // belongs to the endpoint referenced by route.final and DNS.
    outbounds = [
      { type: "direct", tag: "direct" },
    ];
  } else {
    outbounds = [
      vlessOutbounds[0],
      { type: "direct", tag: "direct" },
    ];
  }

  // WARP endpoint (optional): mix in the wireguard endpoint and
  // switch route.final to "warp".
  if (warpEndpoint) {
    route.final = "warp";
    // The quality probe follows final: we must measure the leg through which traffic actually
    // goes (the probe-in rule in buildRoute is built with outbound=proxy).
    for (const r of route.rules) {
      if (Array.isArray(r.inbound) && r.inbound.includes("probe-in")) r.outbound = "warp";
    }
  }

  const config = {
    log: {
      level: sbLevel(opts),
      timestamp: true, // needed for the Logs screen parser/filter
      ...(opts.log?.disabled ? { disabled: true } : {}),
    },
    dns: buildDns(opts, warpEndpoint ? "warp" : "proxy", effectiveMode),
    inbounds: buildInbounds(effectiveMode, opts, systemIpv6),
    outbounds,
    route,
    experimental: {
      // store_rdrc is deprecated in 1.14 and only cached refusals of DNS rules with
      // a filter on the answer address, and there are no such rules here.
      cache_file: { enabled: true },
    },
  };
  const endpoints = vlessOutbounds.filter((node) => nodeEndpoints.has(node));
  if (warpEndpoint) endpoints.push(warpEndpoint);
  if (endpoints.length) config.endpoints = endpoints;

  // clash_api isn't an option but the runtime control panel: node selection,
  // pings, traffic and all diagnostics go through it, and Rust refuses to start at all
  // without external_controller. Previously this was behind a flag, and a cleared flag (by hand
  // or from an old backup) produced a config with which the connection didn't come up
  // in any mode. The port stays configurable; Rust enforces loopback.
  config.experimental.clash_api = {
    external_controller: `127.0.0.1:${opts.experimental?.clashApiPort || 9090}`,
  };

  // Unified delay: the core makes a second measurement over the already established connection and returns
  // a clean RTT without the TCP/TLS handshake. Without it the ping for VLESS+Reality is inflated
  // 2-3 times. A global flag — it affects both the UI ping (urltest history + manual
  // /delay) and the "auto" balancer.
  config.experimental.unified_delay = { enabled: true };

  // TLS tricks (fragmentation/padding/mixedcase) are NO LONGER written globally:
  // the core has no experimental.tls_tricks. Now they're
  // applied per outbound in applyTlsTricks() when building a proxy outbound.

  validateConfigReferences(config);
  // The "outbound index → node" map: it's exactly this index the core uses to name
  // the culprit in "initialize outbound[N]". Computing it by arithmetic over the selector
  // position isn't possible — the outbound set changes from mode to mode.
  const nodeByOutbound = new Map(vlessOutbounds.map((outbound, i) => [outbound, nodes[i]]));
  const outboundNodes = outbounds.map(outbound => nodeByOutbound.get(outbound) || null);
  // The core numbers endpoints as a separate list ("initialize endpoint[N]"), so
  // the culprit endpoint node can't be found via outboundNodes.
  const endpointNodes = endpoints.map(endpoint => nodeByOutbound.get(endpoint) || null);
  return {
    config,
    xray: xrayConfig,
    outboundNodes,
    endpointNodes,
    sidecars,
    runtime: {
      mode: effectiveMode,
      strictPrivacy: runtime.strictPrivacy,
      pinnedNodeTag,
      options: opts,
    },
  };
}

// A semantic guard on top of the JSON schema: sing-box accepts tag references as strings,
// so a typo/the WARP-only branch would otherwise be discovered only when the core starts.
export function validateConfigReferences(config) {
  const outboundTags = new Set([
    ...(config.outbounds || []).map((o) => o?.tag),
    ...(config.endpoints || []).map((o) => o?.tag),
  ].filter(Boolean));
  const dnsTags = new Set((config.dns?.servers || []).map((s) => s?.tag).filter(Boolean));
  // The core resolves rule_set references as strictly as outbound tags: a rule
  // pointing at a set that wasn't emitted brings down the start entirely.
  const ruleSetTags = new Set((config.route?.rule_set || []).map((s) => s?.tag).filter(Boolean));
  const missing = [];
  const requireOutbound = (tag, path) => {
    if (tag && !outboundTags.has(tag)) missing.push(`${path} -> ${tag}`);
  };
  const requireDns = (tag, path) => {
    if (tag && !dnsTags.has(tag)) missing.push(`${path} -> ${tag}`);
  };
  const requireRuleSets = (value, path) => {
    const tags = Array.isArray(value) ? value : value ? [value] : [];
    for (const [i, tag] of tags.entries()) {
      if (tag && !ruleSetTags.has(tag)) missing.push(`${path}[${i}] -> ${tag}`);
    }
  };

  requireOutbound(config.route?.final, "route.final");
  // The core also looks for rule sets in nested rules of logical wrappers (LAN
  // protection copies direct rules there together with their rule_set).
  const requireNestedRuleSets = (rule, path) => {
    requireRuleSets(rule?.rule_set, `${path}.rule_set`);
    for (const [j, sub] of (Array.isArray(rule?.rules) ? rule.rules : []).entries()) {
      requireNestedRuleSets(sub, `${path}.rules[${j}]`);
    }
  };
  for (const [i, rule] of (config.route?.rules || []).entries()) {
    requireOutbound(rule?.outbound, `route.rules[${i}].outbound`);
    requireDns(rule?.server, `route.rules[${i}].server`);
    requireNestedRuleSets(rule, `route.rules[${i}]`);
  }
  for (const [i, set] of (config.route?.rule_set || []).entries()) {
    requireOutbound(set?.http_client?.detour, `route.rule_set[${i}].http_client.detour`);
  }
  for (const [i, outbound] of (config.outbounds || []).entries()) {
    for (const [j, tag] of (outbound?.outbounds || []).entries()) {
      requireOutbound(tag, `outbounds[${i}].outbounds[${j}]`);
    }
    requireOutbound(outbound?.default, `outbounds[${i}].default`);
    requireOutbound(outbound?.detour, `outbounds[${i}].detour`);
    requireDns(outbound?.domain_resolver, `outbounds[${i}].domain_resolver`);
  }
  // endpoints (WARP) take part in routing on par with outbounds: in chain
  // WARP goes via a detour into the selector, and a typo there also keeps the core from coming up.
  for (const [i, endpoint] of (config.endpoints || []).entries()) {
    requireOutbound(endpoint?.detour, `endpoints[${i}].detour`);
    requireDns(endpoint?.domain_resolver, `endpoints[${i}].domain_resolver`);
  }
  for (const [i, server] of (config.dns?.servers || []).entries()) {
    requireOutbound(server?.detour, `dns.servers[${i}].detour`);
    requireDns(server?.domain_resolver, `dns.servers[${i}].domain_resolver`);
  }
  requireDns(config.dns?.final, "dns.final");
  for (const [i, rule] of (config.dns?.rules || []).entries()) {
    requireDns(rule?.server, `dns.rules[${i}].server`);
    requireRuleSets(rule?.rule_set, `dns.rules[${i}].rule_set`);
  }

  if (missing.length) {
    throw new Error(`sing-box config references missing tags: ${missing.join(", ")}`);
  }
  return true;
}

// A single outbound tag logic for a multi-node subscription.
// Must match between the builder and proxies-view, otherwise the selector will miss.
// The tag depends only on the node itself and is computed as a hash of its contents.
// The servers screen, the tray and the quality engine ask for the tag for every node
// many times a second, so the result is kept with the node object: on a subscription
// of hundreds of servers recomputing it took a noticeable share of every list update.
const nodeTagCache = new WeakMap();

export function nodeTag(i, node) {
  void i; // legacy argument; identity intentionally does not depend on ordering.
  if (node && typeof node === "object") {
    const hit = nodeTagCache.get(node);
    if (hit) return hit;
  }
  const tag = `node-${hashRuntimeValue(stableNodeId(node, "node"))}`;
  if (node && typeof node === "object") nodeTagCache.set(node, tag);
  return tag;
}

// ── profiles (storage) ──────────────────────────────────────
export function loadProfiles() {
  return loadProfilesFromStore();
}

export function saveProfiles(list) {
  saveProfilesToStore(list);
}

export function getActiveProfileId() {
  return getActiveProfileIdFromStore();
}

export function setActiveProfileId(id) {
  setActiveProfileIdInStore(id);
}

export function getActiveProfile() {
  const id = getActiveProfileId();
  if (!id) return null;
  return loadProfiles().find(p => p.id === id) || null;
}

export function addProfileFromVless(raw) {
  return addProfileFromLink(raw);
}

// A universal adder — works for any supported protocol.
function storeProfile(parsed) {
  const id = uid("p_");
  const list = loadProfiles();
  list.push({ ...parsed, id });
  saveProfiles(list);
  return { id, profile: parsed };
}

export function addProfileFromLink(raw) {
  return storeProfile(parseLink(raw));
}

// A profile not parsed from a link: importing a ready sing-box config returns
// already normalized nodes (including a WireGuard endpoint, which has no
// share link of its own at all).
export function addParsedProfile(profile) {
  return storeProfile(profile);
}

// Importing TrustTunnel from an endpoint .toml (pasted as text or loaded as a file).
export function addTrustTunnelFromToml(tomlText, displayName) {
  return storeProfile(parseTrustTunnelToml(tomlText, displayName));
}

// Importing WireGuard / AmneziaWG from a .conf. Also returns ignored — lines
// of the file that didn't carry over into the profile: the user is told about them, otherwise
// the tunnel silently behaves differently than in the client the config came from.
export function addWireguardFromConf(confText, displayName) {
  const parsed = parseWireguardConf(confText, displayName);
  const stored = storeProfile(parsed);
  return { ...stored, ignored: parsed.ignored || [] };
}

// The original .ovpn stays in the profile for export; only the options go into the core.
export function addOpenvpnFromConf(confText, displayName, credentials = {}) {
  const parsed = parseOpenvpnConf(confText, displayName, credentials);
  const stored = storeProfile(parsed);
  return { ...stored, ignored: parsed.ignored || [] };
}

// ── unified active source (profile | subscription) ─────────
export function getActiveKind() {
  return getActiveKindFromStore();
}

export function setActiveKind(kind) {
  setActiveKindInStore(kind);
}

function loadSubsRaw() {
  return loadSubscriptionsFromStore();
}

/**
 * A source from a subscription record. Nodes the core won't accept are cut off right
 * here, not in the builder: the config, the server list, clash tags and the fingerprint
 * must see the same set of nodes, otherwise the topology won't add up.
 */
export function subscriptionSource(sub) {
  if (!sub) return null;
  const nodes = withoutPlaceholders(usableNodes(sub.profiles || []).filter(node => !isNodeQuarantined(node)));
  if (!nodes.length) return null;
  return { kind: "sub", subscription: sub, nodes };
}

/**
 * Returns the current active source for connecting.
 * { kind: "single", profile } — a single vless
 * { kind: "sub", subscription, nodes } — a subscription (>=1 nodes)
 * null — nothing is active
 */
export function getActiveSource() {
  const kind = getActiveKind();
  if (kind === "sub") {
    const subId = getActiveSubscriptionIdFromStore();
    if (!subId) return null;
    const sub = loadSubsRaw().find(s => s.id === subId);
    if (!sub || !sub.profiles?.length) return null;
    return subscriptionSource(sub);
  }
  const p = getActiveProfile();
  return p ? { kind: "single", profile: p } : null;
}

export function removeProfile(id) {
  const wasActive = getActiveProfileId() === id;
  const list = loadProfiles().filter(p => p.id !== id);
  saveProfiles(list);
  if (wasActive) {
    setActiveProfileId(list[0]?.id ?? null);
  }
}

// Bulk cleanup of single profiles with one store commit. A loop over
// removeProfile doesn't work here: on every step it moves the active profile
// to the next one in the list, and the caller would get a series of false source changes.
export function removeAllProfiles() {
  const removed = loadProfiles().length;
  if (!removed) return 0;
  saveProfiles([]);
  setActiveProfileId(null);
  return removed;
}

// Targeted update of a single profile's fields (rename, etc.).
export function updateProfile(id, patch) {
  const list = loadProfiles();
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  saveProfiles(list);
  return list[idx];
}

// 3 modes:
//   proxy       — sing-box locally on 127.0.0.1:mixedPort, the system proxy is NOT
//                 touched. The user points the browser/apps at SOCKS+HTTP themselves.
//   systemProxy — sing-box + we automatically set HKCU Internet Settings.
//                 This is the default on desktop.
//   tun         — TUN interception of all traffic. sing-box brings up the TUN interface
//                 as our child (Ninety runs as admin, Throne-style).
//
// The old "proxy" value from pre-alpha34 = systemProxy (we always set the
// system proxy). We migrate on read — old users don't lose the behavior.
const VALID_MODES = new Set(["proxy", "systemProxy", "tun"]);

// A mode for the current session only: declining UAC at autostart must not
// permanently replace the TUN the user chose. Reset via setMode.
let sessionModeOverride = null;

export function setSessionMode(m) {
  sessionModeOverride = VALID_MODES.has(m) ? m : null;
}

export function getMode() {
  if (sessionModeOverride) return sessionModeOverride;
  const m = localStorage.getItem(MODE_KEY);
  if (m === "tun") return "tun";
  if (m === "systemProxy") return "systemProxy";
  if (m === "proxy") {
    // Migration: if the migration flag is set — it's the new "proxy" (without the system one),
    // otherwise the old behavior → systemProxy.
    if (localStorage.getItem(MODE_KEY + ".migrated") === "1") return "proxy";
    localStorage.setItem(MODE_KEY, "systemProxy");
    localStorage.setItem(MODE_KEY + ".migrated", "1");
    return "systemProxy";
  }
  return "systemProxy"; // default desktop
}

export function setMode(m) {
  sessionModeOverride = null;
  const v = VALID_MODES.has(m) ? m : "systemProxy";
  localStorage.setItem(MODE_KEY, v);
  localStorage.setItem(MODE_KEY + ".migrated", "1");
}
