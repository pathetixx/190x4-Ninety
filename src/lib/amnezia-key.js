// Ninety · ключ Amnezia (vpn://…) → профили.
//
// Формат — внутренний у AmneziaVPN: base64url от qCompress(JSON). qCompress —
// это 4 байта длины (big endian) и следом обычный zlib-поток. Внутри JSON с
// описанием сервера и контейнерами: у WireGuard/AmneziaWG в `last_config`
// лежит готовый .conf, у Xray — готовый конфиг Xray. Их и разбираем теми же
// парсерами, что и вставленный файл; остальное (OpenVPN, Cloak, IKEv2…)
// называем по имени.

import { parseWireguardConf } from "/lib/protocol-parsers.js";
import { parseXrayConfig } from "/lib/xray-config-import.js";
import { t } from "/lib/i18n/index.js";

const KEY_RE = /^vpn:\/\/[A-Za-z0-9_\-+/=]+$/;

/** Похоже ли на ключ Amnezia. Проверка дешёвая и синхронная — для окна добавления. */
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
 * Ключ → JSON AmneziaVPN. Старые ключи бывают и без сжатия — тогда внутри
 * сразу JSON.
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
    } catch { /* следующий вариант */ }
  }
  throw new Error(t("add.errAmneziaKey"));
}

// Контейнеры AmneziaVPN, которые Ninety проводит, и где у них лежат настройки.
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
 * Ключ Amnezia → профили Ninety.
 * @returns {Promise<{profiles: object[], ignored: string[], unsupported: string[], name: string}>}
 */
export async function parseAmneziaKey(text, displayName = "") {
  const key = await decodeAmneziaKey(text);
  const name = String(displayName || key.description || key.hostName || "Amnezia").trim();
  const containers = (Array.isArray(key.containers) ? key.containers : [])
    .filter((c) => c && typeof c === "object");
  // Контейнер по умолчанию — первым: его пользователь и выбрал в Amnezia.
  containers.sort((a, b) => (b.container === key.defaultContainer) - (a.container === key.defaultContainer));

  const supported = containers.filter((c) => WIREGUARD_CONTAINERS[c.container] || c.container === "amnezia-xray");
  const label = (c) => (supported.length > 1 ? `${name} · ${containerLabel(c.container)}` : name);
  const profiles = [];
  const ignored = [];
  const unsupported = [];
  let withoutConfig = 0;

  for (const container of containers) {
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
    // Ключи сервиса Amnezia (Premium/Free) хранят не сервер, а доступ к API:
    // конфигурацию приложение получает уже после входа.
    if (withoutConfig || key.api_config || key.auth_data || !containers.length) {
      throw new Error(t("add.errAmneziaNoConfig"));
    }
    throw new Error(t("add.errAmneziaKey"));
  }
  return { profiles, ignored, unsupported, name };
}
