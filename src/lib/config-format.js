// Ninety · detecting the format of a foreign config.
//
// A leaf without dependencies: both importers and callers ask for the format here,
// so it must not know about them.
//
// Both sing-box and Xray have an `outbounds` key — what tells them apart is how
// a server is written: in sing-box it's `type` and flat fields, in Xray `protocol` plus
// `settings`/`streamSettings`. Getting it wrong is costlier than not recognizing it: parsing
// with the wrong importer would give "config without servers" on a healthy file.

export function safeJsonParse(text) {
  const s = String(text ?? "").trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// A v2rayN Xray subscription is an array of whole configs, not a single config.
function configList(root) {
  if (Array.isArray(root)) return root.filter(isPlainObject);
  return isPlainObject(root) ? [root] : [];
}

function outboundsOf(root) {
  const out = [];
  for (const config of configList(root)) {
    if (Array.isArray(config.outbounds)) out.push(...config.outbounds.filter(isPlainObject));
    // A bare array of outbounds: each element is itself an outbound.
    else if (config.type || config.protocol) out.push(config);
  }
  return out;
}

function looksLikeXray(root) {
  if (outboundsOf(root).some(item => typeof item.protocol === "string")) return true;
  return configList(root).some(config => isPlainObject(config.routing) || isPlainObject(config.policy));
}

function looksLikeSingbox(root) {
  if (configList(root).some(config => Array.isArray(config.endpoints))) return true;
  return outboundsOf(root).some(item => typeof item.type === "string" && !item.protocol);
}

// Clash is usually YAML, but JSON is its subset, and panels make use of that:
// BPB-Worker-Panel serves the clash subscription exactly as JSON. Checking only
// YAML means not recognizing the format exactly where it occurs most often.
// We have nothing to parse it with here anyway — we recognize it to name it.
const CLASH_YAML_RE = /^\s*proxies\s*:/m;

function looksLikeClash(root) {
  return configList(root).some(config => Array.isArray(config.proxies)
    && config.proxies.some(proxy => isPlainObject(proxy) && proxy.name && proxy.type && proxy.server));
}

// ZIP: the local header signature. The subscription body arrives as a string, but these
// four bytes are ASCII and control characters, lossy decoding doesn't touch them.
const ZIP_SIGNATURE = "PK\u0003\u0004";

/**
 * @returns {"sing-box"|"xray"|"clash"|"archive"|null} null — this isn't a client config.
 */
export function detectConfigFormat(text) {
  const s = String(text ?? "");
  if (s.startsWith(ZIP_SIGNATURE)) return "archive";
  const root = safeJsonParse(s);
  if (root) {
    if (looksLikeXray(root)) return "xray";
    if (looksLikeSingbox(root)) return "sing-box";
    if (looksLikeClash(root)) return "clash";
    return null;
  }
  if (CLASH_YAML_RE.test(s) && /^\s*-\s+(?:name|\{)/m.test(s)) return "clash";
  return null;
}

// The format name is written the way the project itself writes it.
export const CONFIG_FORMAT_NAMES = {
  "sing-box": "sing-box",
  xray: "Xray",
  clash: "Clash",
};
