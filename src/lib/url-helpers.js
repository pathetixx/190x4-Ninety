// Ninety · маленькие URL/base64 helpers для парсеров конфигов.
// Ошибки parsePort остаются локализованными через i18n, как раньше в singbox.js.

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

export function parsePort(value, errKey = "sb.err.badPort") {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) throw new Error(t(errKey));
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t(errKey));
  return port;
}

export function splitHostPort(hostPort, errKey = "sb.err.badPort") {
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

// base64url -> Uint8Array (для бинарного TLV-пейлоада tt:// deep-link).
export function bytesFromB64url(s) {
  const bin = safeAtob(s); // safeAtob уже умеет url-алфавит (- _) и паддинг
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
