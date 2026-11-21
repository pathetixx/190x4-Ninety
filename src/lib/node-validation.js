// Ninety · preflight check of nodes before building the config.
//
// sing-box initializes the config AS A WHOLE: one node with parameters the core
// doesn't accept brings down the whole start — "create service: initialize outbound[72]:
// invalid public_key", and a subscription of three hundred servers doesn't work at all because of
// one broken panel server. We check exactly what the core rejects at
// initialization, and don't let such nodes into either the config or the lists.
//
// The checks are deliberately narrow. A node that simply doesn't respond is valid here:
// the health checker weeds it out, not the config builder.

import { awgHeaderRange, parseAwgHeader, profileProto, vlessEncryptionOf, vlessEncryptionValid } from "/lib/protocol-parsers.js";
import { openvpnEndpointIssue } from "/lib/openvpn.js";

// The core decodes public_key strictly as base64url without padding and requires exactly
// 32 bytes (X25519). Panels sometimes return the key in the regular alphabet or with "=" —
// this is fixed by normalization, not by rejection.
function decodedLength(base64Url) {
  const s = String(base64Url || "");
  if (!s || /[^A-Za-z0-9\-_]/.test(s)) return -1;
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (std.length % 4)) % 4;
  if (pad === 3) return -1; // length % 4 === 1 — such base64 doesn't exist
  try {
    return atob(std + "=".repeat(pad)).length;
  } catch {
    return -1;
  }
}

/**
 * Brings the reality public_key into the form the core accepts.
 * @returns {string} the normalized key, or "" if it isn't a 32-byte key.
 */
export function normalizeRealityPublicKey(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const urlSafe = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return decodedLength(urlSafe) === 32 ? urlSafe : "";
}

// The core decodes short_id from hex into 8 bytes: an odd length, a non-hex character or
// more than 16 characters is a fatal initialization error.
function shortIdValid(raw) {
  const s = String(raw || "").trim();
  if (!s) return true; // an empty short_id is allowed
  return /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length <= 16;
}

// The core accepts exactly two flow values for vless: empty and "xtls-rprx-vision"
// (sing-vmess, NewClient). The Xray variant "…-udp443" differs only in that
// UDP:443 goes past the tunnel locally — the same "xtls-rprx-vision" goes on the wire,
// so we simply strip the suffix rather than throw the node away.
// The core rejects everything else at initialization and brings down the whole config.
const SINGBOX_FLOWS = new Set(["", "xtls-rprx-vision"]);

/**
 * @returns {string|null} flow for sing-box, or null if the core won't accept it.
 */
export function normalizeFlow(raw) {
  const flow = String(raw || "").trim();
  const base = flow === "xtls-rprx-vision-udp443" ? "xtls-rprx-vision" : flow;
  return SINGBOX_FLOWS.has(base) ? base : null;
}

// The list of uTLS fingerprints the core knows (common/tls/utls_client.go).
// An unfamiliar name is a fatal config error, but a fingerprint is just a disguise
// for the ClientHello: replacing it with chrome is safer than losing the server.
const UTLS_FINGERPRINTS = new Set([
  "chrome", "chrome_psk", "chrome_psk_shuffle", "chrome_padding_psk_shuffle",
  "chrome_pq", "chrome_pq_psk", "firefox", "edge", "safari", "360", "qq",
  "ios", "android", "random", "randomized",
]);

export function normalizeFingerprint(raw) {
  const fp = String(raw || "").trim();
  return UTLS_FINGERPRINTS.has(fp) ? fp : "chrome";
}

// Other values the core checks strictly. The lists are taken from the sources of the
// core itself (ninety-core v1.13.19-ninety.4 and its dependencies), not from the documentation:
//   vmess security      — sing-vmess/client.go
//   shadowsocks method  — sing-shadowsocks2 (shadowaead / _2022 / shadowstream / none)
//   hysteria2 obfs      — protocol/hysteria2/outbound.go (salamander only, password required)
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
const MIERU_MULTIPLEXING = new Set([
  "MULTIPLEXING_DEFAULT", "MULTIPLEXING_OFF", "MULTIPLEXING_LOW", "MULTIPLEXING_MIDDLE", "MULTIPLEXING_HIGH",
]);
const MIERU_HANDSHAKE = new Set(["HANDSHAKE_DEFAULT", "HANDSHAKE_STANDARD", "HANDSHAKE_NO_WAIT"]);
// transport/sip003: an unknown plugin → "plugin not found" at initialization.
const SHADOWSOCKS_PLUGINS = new Set(["obfs-local", "v2ray-plugin"]);
// Key length of the 2022 methods in bytes (sing-shadowsocks2/shadowaead_2022).
const SHADOWSOCKS_2022_KEY_BYTES = {
  "2022-blake3-aes-128-gcm": 16,
  "2022-blake3-aes-256-gcm": 32,
  "2022-blake3-chacha20-poly1305": 32,
};

// Transports the app can actually handle: some are carried by the core itself
// (ws/grpc/http/httpupgrade/quic), xhttp and mKCP by the local xray bridge. Everything
// else (e.g. the old v2ray "tcp+http obfuscation" or unknown
// names) was silently built as regular TCP: the config is valid, the core starts,
// the node is dead without a single line in the log. It's more honest not to take such a node.
const TRANSPORT_TYPES = new Set([
  "", "tcp", "raw", "ws", "grpc", "http", "h2", "httpupgrade", "quic", "xhttp", "kcp",
]);
// Only v2ray-family protocols have a transport; for the others the field means
// something else or doesn't exist at all.
const TRANSPORT_PROTOS = new Set(["vless", "vmess", "trojan"]);
// Protocols of a ready Xray outbound (proto "xray") that the xray bridge carries.
const XRAY_RAW_PROTOCOLS = new Set(["vless", "vmess", "trojan", "shadowsocks", "hysteria"]);

function realityRequested(node) {
  const mode = node?.tlsMode || node?.security;
  return String(mode || "").toLowerCase() === "reality";
}

// The check is called on every read of the active source, and the source returns the same
// set of node objects until the storage is rewritten. A cache by reference removes
// the repeated parsing of three hundred nodes; node objects are immutable — they're replaced entirely.
const issueCache = new WeakMap();

/**
 * The reason the core won't accept the node. null — the node is usable.
 * @returns {{code: string} | null}
 */
export function nodeConfigIssue(node) {
  if (!node || typeof node !== "object") return { code: "malformed" };
  if (issueCache.has(node)) return issueCache.get(node);
  const issue = computeNodeConfigIssue(node);
  issueCache.set(node, issue);
  return issue;
}

// WireGuard lives in endpoints, not in outbounds, but the rule is the same: the core
// initializes the config as a whole, and one broken key brings down the whole launch.
// We check exactly what the core and our wireguard-go fork reject at startup.
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
  let anyReserved = false;
  for (const peer of peers) {
    if (!wireguardKeyValid(peer.publicKey)) return { code: "wgPublicKey" };
    if (peer.presharedKey && !wireguardKeyValid(peer.presharedKey)) return { code: "wgPresharedKey" };
    const peerPort = Number(peer.port);
    if (!peer.host || !Number.isInteger(peerPort) || peerPort < 1 || peerPort > 65535) {
      return { code: "endpoint" };
    }
    if (peer.reserved !== undefined) {
      // Three bytes, each a regular octet. They come only from an imported
      // core config: there's no such field in .conf.
      const reserved = peer.reserved;
      if (!Array.isArray(reserved) || reserved.length !== 3
        || reserved.some(v => !Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 255)) {
        return { code: "wgReserved" };
      }
      anyReserved = true;
    }
  }
  const awgIssue = amneziaIssue(node.awg);
  if (awgIssue) return awgIssue;
  // reserved and AmneziaWG shaping on the same peer are incompatible — the core rejects
  // such an endpoint entirely, and the whole config with it.
  if (anyReserved && amneziaActive(node.awg)) return { code: "wgReservedNoise" };
  return null;
}

// OpenVPN, like WireGuard, lives in endpoints. We check both saved .ovpn files
// and settings imported directly from sing-box JSON.
export function openvpnIssue(node) {
  if (String(node?.dev || "").toLowerCase().startsWith("tap")) return { code: "ovpnTun" };
  if (node?.network !== undefined && !["udp", "tcp"].includes(node.network)) return { code: "ovpnNetwork" };
  return openvpnEndpointIssue(node?.endpoint, node?.authUserPass === true);
}

// Shaping is on if at least one field that will reach the core is set. The conditions
// repeat buildAmneziaNoise: an empty block doesn't get into the config at all.
function amneziaActive(awg) {
  if (!awg) return false;
  const num = (value) => Number(awg[value]) || 0;
  if (num("jc") > 0 && num("jmax") > 0) return true;
  if (num("s1") > 0 || num("s2") > 0 || num("s3") > 0 || num("s4") > 0) return true;
  if (awg.headerProtectionKey || awg.contentPaddingAddition || awg.randomTrailers) return true;
  if (customAwgHeaders(awg)) return true;
  return ["i1", "i2", "i3", "i4", "i5"].some(key => awg[key]);
}

// Header protection key: base64, as in .conf, or hex, as in the AmneziaWG UAPI.
function headerKeyLength(raw) {
  const text = String(raw || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return 32;
  const std = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!std || /[^A-Za-z0-9+/]/.test(std) || std.length % 4 === 1) return -1;
  try { return atob(std + "=".repeat((4 - (std.length % 4)) % 4)).length; } catch { return -1; }
}

// H1..H4 differ from the WireGuard message types (1..4). A range is always
// different: 2.0 doesn't exist without its own headers.
function customAwgHeaders(awg) {
  return ["h1", "h2", "h3", "h4"].some((key, index) => {
    const range = awgHeaderRange(awg[key]);
    return !!range && !(range.from === index + 1 && range.to === index + 1);
  });
}

// AmneziaWG shaping: the same invariants the core checks (noise/amnezia.go).
// We catch them here so that the node is weeded out with its own reason rather than dragging
// the whole config down with it.
const WG_MESSAGE_SIZES = { initiation: 148, response: 92 };

function amneziaIssue(awg) {
  if (!awg) return null;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const jc = num(awg.jc), jmin = num(awg.jmin), jmax = num(awg.jmax);
  if (jc < 0 || jc > 128) return { code: "wgJunkCount" };
  if (jc > 0 && (jmax <= 0 || jmin > jmax || jmax > 1280)) return { code: "wgJunkSize" };
  const s1 = num(awg.s1), s2 = num(awg.s2);
  if (s1 < 0 || s1 > 1280 || s2 < 0 || s2 > 1280) return { code: "wgHandshakeJunk" };
  // Padded init and response must not match in length: the receiver
  // tells them apart by size first.
  if (s1 + WG_MESSAGE_SIZES.initiation === s2 + WG_MESSAGE_SIZES.response) {
    return { code: "wgHandshakeJunk" };
  }
  // S3 — cookie reply, S4 — every transport packet (AmneziaWG 2.0).
  const s3 = num(awg.s3), s4 = num(awg.s4);
  if (s3 < 0 || s3 > 1280) return { code: "wgHandshakeJunk" };
  if (s4 < 0 || s4 > 256) return { code: "wgTransportJunk" };
  // AmneziaWG 3: the header protection key is 32 bytes; the nonce is taken from the start
  // of the padding before each message, so each S is at least 12.
  if (awg.headerProtectionKey) {
    if (headerKeyLength(awg.headerProtectionKey) !== 32) return { code: "wgHeaderKey" };
    if ([num(awg.s1), num(awg.s2), s3, s4].some((padding) => padding < 12)) return { code: "wgHeaderKey" };
  }
  if (awg.contentPaddingAddition) {
    const range = awgHeaderRange(awg.contentPaddingAddition);
    if (!range || range.to > 1500) return { code: "wgContentPadding" };
  }
  const keys = ["h1", "h2", "h3", "h4"];
  if (keys.some((key) => parseAwgHeader(awg[key]) === null)) return { code: "wgMagicHeaders" };
  if (customAwgHeaders(awg)) {
    // An unset header is filled in by the builder with the WireGuard type; the receiver
    // tells messages apart by whose range the type falls into — the ranges must not
    // overlap even by one value.
    const effective = keys.map((key, index) => awgHeaderRange(awg[key]) || { from: index + 1, to: index + 1 });
    for (let i = 0; i < effective.length; i++) {
      for (let j = i + 1; j < effective.length; j++) {
        if (effective[i].from <= effective[j].to && effective[j].from <= effective[i].to) {
          return { code: "wgMagicHeaders" };
        }
      }
    }
  }
  return null;
}

// hysteria2 port hopping ranges in the core's form: "start:end".
function validPortRanges(ports) {
  if (!Array.isArray(ports) || !ports.length) return false;
  return ports.every((range) => {
    const m = /^(\d{1,5}):(\d{1,5})$/.exec(String(range));
    if (!m) return false;
    const from = Number(m[1]);
    const to = Number(m[2]);
    return from >= 1 && to <= 65535 && from <= to;
  });
}

// Mieru writes the range with a hyphen, unlike hysteria2.
function validMieruPortRanges(ports) {
  if (!Array.isArray(ports) || !ports.length) return false;
  return ports.every((range) => {
    const m = /^(\d{1,5})-(\d{1,5})$/.exec(String(range));
    if (!m) return false;
    const from = Number(m[1]);
    const to = Number(m[2]);
    return from >= 1 && to <= 65535 && from <= to;
  });
}

// Strict base64 with padding: that's how the core decodes the PSK and the pinned key hash.
function strictBase64Length(raw) {
  const s = String(raw || "");
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return -1;
  try {
    return atob(s).length;
  } catch {
    return -1;
  }
}

// "ipsk:upsk" — several keys separated by a colon, each of the required length.
function shadowsocks2022KeysValid(password, keyBytes) {
  return String(password || "").split(":").every((key) => strictBase64Length(key) === keyBytes);
}

// The core accepts gofrs/uuid forms: with hyphens, without them, in braces and urn:uuid:.
function uuidValid(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/^urn:uuid:/, "").replace(/^\{(.*)\}$/, "$1");
  return /^[0-9a-f]{32}$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

function computeNodeConfigIssue(node) {
  const proto = profileProto(node);
  // Sidecar protocols (naive/trusttunnel) go into sing-box via a socks bridge:
  // the core doesn't parse their parameters, there's nothing to check by its rules.
  if (proto === "naive" || proto === "trusttunnel") return null;

  const port = Number(node.port);
  if (!node.host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { code: "endpoint" };
  }

  if (proto === "wireguard") return wireguardIssue(node);
  if (proto === "openvpn") return openvpnIssue(node);

  // The core doesn't parse a ready Xray outbound: the xray bridge brings it up as is.
  // We only check that inside there really is a server the bridge will accept.
  if (proto === "xray") {
    const outbound = node.outbound;
    const protocol = String(outbound?.protocol || "").toLowerCase();
    if (!outbound || typeof outbound !== "object" || !XRAY_RAW_PROTOCOLS.has(protocol)) {
      return { code: "malformed" };
    }
    return null;
  }

  if (proto === "vless" && normalizeFlow(node.flow) === null) {
    return { code: "flow" };
  }
  // VLESS encryption is brought up only by xray, and the bridge supports it for xhttp, mKCP and
  // regular TCP. With another transport the node would be dead without a single line in
  // the log — it's more honest to weed it out with a reason.
  if (vlessEncryptionOf(node)) {
    if (!vlessEncryptionValid(node.encryption)) return { code: "encryption" };
    const type = String(node.type || "");
    const raw = type === "" || type === "tcp" || type === "raw";
    if (!raw && type !== "xhttp" && type !== "kcp") return { code: "encryption" };
    if (raw && node.headerType && node.headerType !== "none") return { code: "encryption" };
  }

  if (proto === "vmess" && !VMESS_SECURITY.has(String(node.security || "").toLowerCase())) {
    return { code: "vmessSecurity" };
  }

  if (proto === "shadowsocks" && !SHADOWSOCKS_METHODS.has(String(node.method || "").toLowerCase())) {
    return { code: "ssMethod" };
  }

  if (proto === "shadowsocks") {
    if (node.plugin && !SHADOWSOCKS_PLUGINS.has(String(node.plugin))) return { code: "ssPlugin" };
    const keyBytes = SHADOWSOCKS_2022_KEY_BYTES[String(node.method || "").toLowerCase()];
    if (keyBytes && !shadowsocks2022KeysValid(node.password, keyBytes)) return { code: "ssKey" };
  }

  if (proto === "hysteria2" && node.ports !== undefined && !validPortRanges(node.ports)) {
    return { code: "endpoint" };
  }

  // The core expects a base64 SHA-256 of the public key (32 bytes). A hex certificate fingerprint
  // from the original client is a different quantity: with colons it brings down the config,
  // and without them it never matches, and dropping the pin just to connect is not allowed.
  if (proto === "hysteria2" && node.pinSHA256 && strictBase64Length(node.pinSHA256) !== 32) {
    return { code: "certPin" };
  }

  if (proto === "hysteria2" && node.obfs) {
    if (String(node.obfs).toLowerCase() !== "salamander" || !node.obfsPassword) {
      return { code: "obfs" };
    }
  }

  if (proto === "tuic" && !uuidValid(node.uuid)) return { code: "credentials" };

  if (proto === "tuic" && !TUIC_CONGESTION.has(String(node.congestionControl || "").toLowerCase())) {
    return { code: "congestion" };
  }

  if (TRANSPORT_PROTOS.has(proto)) {
    const type = String(node.type || "").toLowerCase();
    if (!TRANSPORT_TYPES.has(type)) return { code: "transport" };
    // The core doesn't implement TCP HTTP obfuscation: the node would be built as regular TCP,
    // the core would start, and the server would silently not respond.
    if ((type === "tcp" || type === "raw") && String(node.headerType || "").toLowerCase() === "http") {
      return { code: "transport" };
    }
    // The core brings up "raw" QUIC; it doesn't implement Xray's additional transport encryption,
    // and such a node won't come up in any case.
    if (type === "quic") {
      const quicSecurity = String(node.quicSecurity || "").toLowerCase();
      if (quicSecurity && quicSecurity !== "none") return { code: "quicSecurity" };
    }
  }

  if (proto === "anytls" && !node.password) return { code: "credentials" };

  if (proto === "mieru") {
    if (!node.username || !node.password) return { code: "credentials" };
    if (node.transport !== "TCP" && node.transport !== "UDP") return { code: "mieruTransport" };
    if (node.ports !== undefined && !validMieruPortRanges(node.ports)) return { code: "endpoint" };
    if ((node.multiplexing !== undefined && !MIERU_MULTIPLEXING.has(node.multiplexing))
      || (node.handshakeMode !== undefined && !MIERU_HANDSHAKE.has(node.handshakeMode))
      || (node.mtu !== undefined && (!Number.isInteger(node.mtu) || node.mtu < 1280 || node.mtu > 1500))) {
      return { code: "mieruOption" };
    }
  }

  if (proto === "hysteria") {
    // The core implements only regular UDP: faketcp and wechat-video from
    // the original v1 client are unknown to it.
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
 * Splits the list into usable nodes and rejected ones with a reason.
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

// Providers put lines like "traffic left", "plan until …",
// "enable HWID" into the subscription as fake servers on 127.0.0.1 or 0.0.0.0. In
// "Auto" such a node is first in the list: before the first measurement the core sends
// rule set downloads through it, gets a connection refusal and doesn't start at all.
function placeholderHost(raw) {
  const host = String(raw || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * A subscription placeholder node: the address leads nowhere beyond this PC.
 * Manual profiles aren't checked this way — there 127.0.0.1 may be deliberate
 * (e.g. a local tunnel).
 */
export function isPlaceholderNode(node) {
  if (!node || typeof node !== "object") return false;
  if (placeholderHost(node.host)) return true;
  const addresses = Array.isArray(node.addresses) ? node.addresses : [];
  return addresses.length > 0 && addresses.every((address) => placeholderHost(String(address).replace(/:\d+$/, "")));
}

/**
 * Subscription nodes without placeholders — if at least one server remains after weeding out.
 * A subscription consisting only of placeholders is the panel's response (HWID, expired plan), and it
 * is left as is: let the caller handle it by its own rules.
 */
export function withoutPlaceholders(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const real = list.filter((node) => !isPlaceholderNode(node));
  return real.length ? real : list;
}
