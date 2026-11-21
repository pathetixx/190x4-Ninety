// Ninety · small URL/base64 helpers for config parsers.
// parsePort errors stay localized via i18n, as they used to be in singbox.js.

import { t } from "/lib/i18n/index.js";

export function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function safeAtob(s) {
  try {
    const cleaned = String(s).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!cleaned) return "";
    const padded = cleaned + "=".repeat((4 - cleaned.length % 4) % 4);
    return atob(padded);
  } catch { return ""; }
}

// We try to decode as base64/base64url; if that fails — empty.
export function safeDecodeBase64(s) {
  try {
    const bin = safeAtob(s);
    if (!bin) return "";
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

export function parsePort(value, errKey = "sb.err.badPort") {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) throw new Error(t(errKey));
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t(errKey));
  return port;
}

// The address ends at the first "/" (RFC 3986): the path follows. Links like
// vless://id@host:443/?type=ws — the official Hysteria 2 form and a common panel
// output — used to fail to parse in every scheme: the "/" ended up in the port.
export function withoutUrlPath(hostPort) {
  const value = String(hostPort ?? "");
  const slash = value.indexOf("/");
  return slash >= 0 ? value.slice(0, slash) : value;
}

export function splitHostPort(rawHostPort, errKey = "sb.err.badPort") {
  const hostPort = withoutUrlPath(rawHostPort);
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) throw new Error(t("sb.err.badIpv6"));
    if (hostPort.slice(close + 1, close + 2) !== ":") throw new Error(t("sb.err.noPort"));
    return {
      host: hostPort.slice(1, close),
      port: parsePort(hostPort.slice(close + 2), errKey),
    };
  }
  const colonIdx = hostPort.lastIndexOf(":");
  if (colonIdx < 0) throw new Error(t("sb.err.noPort"));
  return {
    host: hostPort.slice(0, colonIdx),
    port: parsePort(hostPort.slice(colonIdx + 1), errKey),
  };
}

// base64url -> Uint8Array (for the binary TLV payload of the tt:// deep link).
export function bytesFromB64url(s) {
  const bin = safeAtob(s); // safeAtob already handles the url alphabet (- _) and padding
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function splitTrailingHashName(url, fallback) {
  const hashIdx = url.indexOf("#");
  const name = hashIdx >= 0 ? safeDecode(url.slice(hashIdx + 1)) : fallback;
  const main = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  return { name, main };
}

export function splitQuery(main) {
  const qIdx = main.indexOf("?");
  const head = qIdx >= 0 ? main.slice(0, qIdx) : main;
  const query = qIdx >= 0 ? main.slice(qIdx + 1) : "";
  return { head, query: new URLSearchParams(query) };
}
