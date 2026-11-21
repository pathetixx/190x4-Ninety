// Ninety · building a share link from server fields.
//
// A shared base for importers of foreign configs: both sing-box and Xray describe the same
// server, just with different field names. Each importer lays out
// its outbound into v2rayN parameters — the vocabulary Ninety's parsers
// read — and this module assembles the string from them.
//
// Why go through a link at all: storage, node export and backward compatibility of old
// records rely on the profile's `raw` field. A "foreign config →
// straight to a profile object" branch would mean a second node model with its own validation.

/** The server in the link: IPv6 must be in brackets, otherwise parsing cuts at
 *  the last colon and cuts off half the address instead of the port. */
export function hostForUri(server) {
  const host = String(server ?? "").trim().replace(/^\[|\]$/g, "");
  if (!host) return "";
  return host.includes(":") ? `[${host}]` : host;
}

/** Address for fields the core accepts without brackets (server, peer address). */
export function bareHost(server) {
  return String(server ?? "").trim().replace(/^\[|\]$/g, "");
}

function b64(text, urlSafe) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  const encoded = btoa(bin);
  return urlSafe ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
}

export const b64urlUtf8 = (text) => b64(text, true);
export const b64Utf8 = (text) => b64(text, false);

/** The ALPN list arrives both as an array and as a comma-separated string. */
export function joinList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean).join(",");
  return String(value ?? "").trim();
}

export function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Builds the link. Empty parameters aren't written at all: the parsers have their own
 * defaults, and `sni=` as an empty string differs from a missing one.
 * @param {object} spec {scheme, userinfo, server, port, params: [key, value][], tag}
 */
export function buildShareLink({ scheme, userinfo = "", server, port, params = [], tag = "" }) {
  const query = new URLSearchParams();
  for (const [key, value] of params) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const auth = userinfo ? `${userinfo}@` : "";
  const search = query.toString();
  const name = tag ? `#${encodeURIComponent(tag)}` : "";
  // Only the hysteria2 port hopping range arrives as a string ("443,20000-30000").
  const portPart = typeof port === "string" && /^\d[\d,-]*$/.test(port) ? port : Number(port);
  return `${scheme}://${auth}${hostForUri(server)}:${portPart}${search ? `?${search}` : ""}${name}`;
}

/** vmess is the only scheme where the "link" is base64 of v2rayN JSON. */
export function buildVmessLink(payload, tag) {
  return `vmess://${b64Utf8(JSON.stringify(payload))}${tag ? `#${encodeURIComponent(tag)}` : ""}`;
}

/** SIP002: userinfo — base64url(method:password). */
export function shadowsocksUserinfo(method, password) {
  return b64urlUtf8(`${method ?? ""}:${password ?? ""}`);
}

/** socks/http: "user:pass", both halves escaped. */
export function credentialsUserinfo(username, password) {
  const user = username ? encodeURIComponent(username) : "";
  const pass = password ? encodeURIComponent(password) : "";
  return user || pass ? `${user}:${pass}` : "";
}
