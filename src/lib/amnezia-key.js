// Ninety · Amnezia key (vpn://…) → profiles.
//
// The format is internal to AmneziaVPN: base64url of qCompress(JSON). qCompress
// is 4 length bytes (big endian) followed by a regular zlib stream. Inside is JSON with
// the server description and containers: for WireGuard/AmneziaWG `last_config`
// holds a ready .conf, for Xray a ready Xray config. We parse them with the same
// parsers as a pasted file; the rest (Cloak, IKEv2…)
// we name.

import { parseWireguardConf } from "/lib/protocol-parsers.js";
import { parseOpenvpnConf } from "/lib/openvpn.js";
import { parseXrayConfig } from "/lib/xray-config-import.js";
import { t } from "/lib/i18n/index.js";

const KEY_RE = /^vpn:\/\/[A-Za-z0-9_\-+/=]+$/;

/** Whether it looks like an Amnezia key. The check is cheap and synchronous — for the add window. */
export function looksLikeAmneziaKey(text) {
  return KEY_RE.test(String(text || "").trim());
}

function base64UrlBytes(text) {
  const std = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function inflateZlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Key → AmneziaVPN JSON. Old keys may also come without compression — then there's
 * JSON right inside.
 * @returns {Promise<object>}
 */
export async function decodeAmneziaKey(text) {
  const value = String(text || "").trim();
  if (!looksLikeAmneziaKey(value)) throw new Error(t("add.errAmneziaKey"));
  let bytes;
  try {
    bytes = base64UrlBytes(value.slice("vpn://".length));
  } catch {
    throw new Error(t("add.errAmneziaKey"));
  }
  const decoder = new TextDecoder();
  const attempts = [
    async () => decoder.decode(await inflateZlib(bytes.subarray(4))),
    async () => decoder.decode(bytes),
  ];
  for (const attempt of attempts) {
    try {
      const json = JSON.parse(await attempt());
      if (json && typeof json === "object" && !Array.isArray(json)) return json;
    } catch { /* next variant */ }
  }
  throw new Error(t("add.errAmneziaKey"));
}

// AmneziaVPN containers that Ninety handles, and where their settings live.
const WIREGUARD_CONTAINERS = {
  "amnezia-awg": "awg",
  "amnezia-awg2": "awg",
  "amnezia-wireguard": "wireguard",
};
const CONTAINER_NAMES = {
  "amnezia-openvpn": "OpenVPN",
  "amnezia-shadowsocks": "Shadowsocks",
  "amnezia-openvpn-cloak": "Cloak",
  "amnezia-ikev2": "IKEv2",
  "amnezia-sftp": "SFTP",
  "amnezia-dns": "DNS",
  "amnezia-tor": "Tor",
  "amnezia-socks5proxy": "SOCKS5",
};

function lastConfig(section) {
  const raw = section?.last_config;
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function containerLabel(name) {
  if (WIREGUARD_CONTAINERS[name]) return name === "amnezia-wireguard" ? "WireGuard" : "AmneziaWG";
  if (name === "amnezia-xray") return "Xray";
  return CONTAINER_NAMES[name] || String(name || "").replace(/^amnezia-/, "");
}

/**
 * Amnezia key → Ninety profiles.
 * @returns {Promise<{profiles: object[], ignored: string[], unsupported: string[], name: string}>}
 */
export async function parseAmneziaKey(text, displayName = "", credentials = {}) {
  const key = await decodeAmneziaKey(text);
  const name = String(displayName || key.description || key.hostName || "Amnezia").trim();
  const containers = (Array.isArray(key.containers) ? key.containers : [])
    .filter((c) => c && typeof c === "object");
  // The default container goes first: that's the one the user picked in Amnezia.
  containers.sort((a, b) => (b.container === key.defaultContainer) - (a.container === key.defaultContainer));

  const supported = containers.filter((c) => WIREGUARD_CONTAINERS[c.container]
    || c.container === "amnezia-xray" || c.container === "amnezia-openvpn");
  const label = (c) => (supported.length > 1 ? `${name} · ${containerLabel(c.container)}` : name);
  const profiles = [];
  const ignored = [];
  const unsupported = [];
  let withoutConfig = 0;

  for (const container of containers) {
    if (container.container === "amnezia-openvpn") {
      const config = lastConfig(container.openvpn);
      if (!config?.config) { withoutConfig++; continue; }
      const profile = parseOpenvpnConf(String(config.config), label(container), credentials);
      profiles.push(profile);
      for (const directive of profile.ignored || []) if (!ignored.includes(directive)) ignored.push(directive);
      continue;
    }
    const section = WIREGUARD_CONTAINERS[container.container];
    if (section) {
      const config = lastConfig(container[section]);
      if (!config?.config) { withoutConfig++; continue; }
      const profile = parseWireguardConf(String(config.config), label(container));
      profiles.push(profile);
      for (const line of profile.ignored || []) if (!ignored.includes(line)) ignored.push(line);
      continue;
    }
    if (container.container === "amnezia-xray") {
      const config = lastConfig(container.xray);
      if (!config) { withoutConfig++; continue; }
      const { profiles: servers } = parseXrayConfig(config);
      for (const server of servers) profiles.push({ ...server, name: label(container) });
      continue;
    }
    unsupported.push(containerLabel(container.container));
  }

  if (!profiles.length) {
    if (unsupported.length) {
      throw new Error(t("add.errAmneziaUnsupported", { list: unsupported.join(", ") }));
    }
    // Amnezia service keys (Premium/Free) store not a server but API access:
    // the app gets the configuration only after signing in.
    if (withoutConfig || key.api_config || key.auth_data || !containers.length) {
      throw new Error(t("add.errAmneziaNoConfig"));
    }
    throw new Error(t("add.errAmneziaKey"));
  }
  return { profiles, ignored, unsupported, name };
}
