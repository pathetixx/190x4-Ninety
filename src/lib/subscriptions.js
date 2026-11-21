// Ninety · subscriptions
// URL import of a vless:// list, parsing subscription-userinfo, storage.

import { nodeTag, parseLink } from "/lib/singbox.js";
import { t } from "/lib/i18n/index.js";
import { uid } from "/lib/uid.js";
import { loadOptions } from "/lib/options.js";
import { safeDecodeBase64 } from "/lib/url-helpers.js";
import { nodeSemanticFingerprint } from "/lib/runtime-identity.js";
import { isPlaceholderNode, partitionNodes, withoutPlaceholders } from "/lib/node-validation.js";
import { looksLikeWireguardConf, parseTrustTunnelToml, parseWireguardConf, profileProto } from "/lib/protocol-parsers.js";
import { looksLikeOpenvpnConf, parseOpenvpnConf } from "/lib/openvpn.js";
import { detectConfigFormat, parseClientConfig, unsupportedFormatMessage } from "/lib/config-import.js";
import { getRememberedProxySelection, rememberProxySelection } from "/lib/proxy-selection.js";
import { looksLikeAmneziaKey } from "/lib/amnezia-key.js";
import { HWID_SCOPE_PROVIDER, hwidHeaders, hwidSignal, subscriptionUsesScopedHwid } from "/lib/hwid.js";
// Re-export: the wording moved to its own module, but callers (main.js,
// the profiles screen) keep taking it from here together with the other helpers.
export { relativeTime } from "/lib/relative-time.js";
import {
  getActiveSubscriptionIdFromStore,
  loadSubscriptionsFromStore,
  saveSubscriptionsToStore,
  setActiveSubscriptionIdInStore,
} from "/lib/profile-store.js";
import { localizedInvoke } from "/lib/backend-errors.js";

export { safeDecodeBase64 };

const PROTO_PREFIX_RE = /^(?:(?:vless|vmess|trojan|ss|hysteria2?|hy2|tuic|tt|anytls|mierus|socks(?:5h?|4a?)?):\/\/|naive\+[a-z]+:\/\/)/i;

const REFRESH_ALL_CONCURRENCY = 3;

// The response format we ask the panel for instead of the link list (Rust changes
// the User-Agent based on it). Whole Xray configs carry what a link doesn't — and
// panels put servers there that aren't in the link list at all (e.g.
// XMC: disguise as Minecraft via finalmask).
export const XRAY_JSON_FORMAT = "xray-json";
// How often to recheck whether the panel serves such JSON and whether to
// switch to it: panels add such servers over time, and an extra request on
// every update is unnecessary.
export const XRAY_JSON_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// ── base64 detection (try-and-see) ─────────────────────────
// No regex checks for "looks like base64". We simply try to decode —
// if it succeeds and there are meaningful links, we take the decoded version; otherwise the original.
const KNOWN_PROTO_RE = /vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\/|hysteria2?:\/\/|hy2:\/\/|tuic:\/\/|tt:\/\/|anytls:\/\/|mierus:\/\/|socks(?:5h?|4a?)?:\/\/|naive\+[a-z]+:\/\//i;
const KNOWN_PROTO_URL_RE = /(?:(?:vless|vmess|trojan|ss|hysteria2?|hy2|tuic|tt|anytls|mierus|socks(?:5h?|4a?)?):\/\/|naive\+[a-z]+:\/\/)\S+/ig;

// TrustTunnel endpoint .toml (export from endpoint): a flat toml with hostname/addresses.
const TT_TOML_RE = /^\s*hostname\s*=.*[\r\n]/m;
function looksLikeTrustTunnelToml(s) {
  return TT_TOML_RE.test(s) && /^\s*addresses\s*=/m.test(s) && /^\s*username\s*=/m.test(s);
}

// The panel may return not a link list but an assembled core config or a profile
// file — both plain and base64. Nothing gets decoded here by accident:
// atob rejects everything outside the base64 alphabet.
function looksLikeJsonText(text) {
  const s = String(text || "").trimStart();
  return s.startsWith("{") || s.startsWith("[");
}

function bodyIsRecognizable(text) {
  return KNOWN_PROTO_RE.test(text)
    || looksLikeJsonText(text)
    || looksLikeWireguardConf(text)
    || looksLikeOpenvpnConf(text)
    || looksLikeTrustTunnelToml(text);
}

// The subscription body is a single profile file, not a list. The parsing is the same as when
// pasting as text; the node name is taken by the parser itself (the peer endpoint / hostname).
function parseSingleFileBody(text) {
  try {
    if (looksLikeWireguardConf(text)) return parseWireguardConf(text);
    if (looksLikeOpenvpnConf(text)) return parseOpenvpnConf(text);
    if (looksLikeTrustTunnelToml(text)) return parseTrustTunnelToml(text);
  } catch (e) {
    console.warn("subscription: file body did not parse", e?.message);
  }
  return null;
}

/**
 * Parses the subscription body. Parses the lines and immediately rejects nodes the
 * core won't accept: one such node brings down the initialization of the whole config, i.e.
 * the whole subscription. We count the rejected ones to tell the user honestly.
 * Supports: a plain newline list, a base64-encoded list, a ready sing-box config
 * (JSON) — only the server part is taken from it.
 * `format` is filled in when the body turned out to be a client config: the caller uses it to
 * explain an empty result instead of a faceless "no supported configs".
 * @returns {{profiles: object[], skipped: number, format: string|null}}
 */
export function parseSubscriptionEntries(body) {
  let originalText = String(body || "");
  let text = originalText.trim();
  if (!text) return { profiles: [], skipped: 0, format: null };

  // First we try to decode as base64 — if the result is a recognizable subscription body
  // in any of the supported forms, we work with the decoded version from there on.
  const decoded = safeDecodeBase64(text);
  if (decoded && bodyIsRecognizable(decoded)) {
    text = decoded;
    originalText = decoded;
  }

  const { format, profiles: fromConfig, skipped: configSkipped } = parseClientConfig(text);
  if (format) {
    // A format we have nothing to read with (Clash) yields zero servers: the caller
    // will name it instead of a faceless "no supported configs".
    const { usable, skipped: rejected } = partitionNodes(fromConfig);
    for (const { node, issue } of rejected) {
      console.warn("subscription: skip unusable node", issue.code, node?.host);
    }
    return { profiles: usable, skipped: configSkipped + rejected.length, format };
  }

  // A panel may also hand out a file by link: WARP in BPB-Worker-Panel is
  // a WireGuard .conf, not a link list. We understood pasting such a file as text
  // before, but not as a subscription body, and the subscription looked empty.
  const single = parseSingleFileBody(looksLikeOpenvpnConf(text) ? originalText : text);
  if (single) {
    const { usable, skipped: rejected } = partitionNodes([single]);
    return { profiles: usable, skipped: rejected.length, format: null };
  }

  const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  const parsed = [];
  let skipped = 0;
  for (const line of lines) {
    if (!PROTO_PREFIX_RE.test(line)) continue;
    try {
      parsed.push(parseLink(line));
    } catch (e) {
      skipped++;
      console.warn("subscription: skip invalid link", e?.message);
    }
  }
  const { usable, skipped: rejected } = partitionNodes(parsed);
  for (const { node, issue } of rejected) {
    console.warn("subscription: skip unusable node", issue.code, node?.host);
  }
  return { profiles: usable, skipped: skipped + rejected.length, format: null };
}

/**
 * A subscription body received by link: the same as parseSubscriptionEntries,
 * but without the provider's placeholder nodes (see withoutPlaceholders). A list pasted by hand
 * isn't touched: 127.0.0.1 may be deliberate there.
 * `received` — all nodes before weeding out: the HWID placeholder is recognized by them.
 * @returns {{profiles: object[], received: object[], skipped: number, format: string|null}}
 */
export function parseRemoteSubscription(body) {
  const parsed = parseSubscriptionEntries(body);
  return { ...parsed, profiles: withoutPlaceholders(parsed.profiles), received: parsed.profiles };
}

/**
 * Parses the subscription body into an array of profiles (without the rejected counter).
 */
export function parseSubscriptionBody(body) {
  return parseSubscriptionEntries(body).profiles;
}

// ── LinkParser: recognizes what the user pasted ────────────────
//   { kind: "url", url }              — a subscription by http(s) URL
//   { kind: "config", content }       — a single vless:// link
//   { kind: "list", content }         — several vless:// (raw or base64)
//   { kind: "client-config", content, format } — a ready client config
//   { kind: "tt-toml", content }      — endpoint TrustTunnel
//   { kind: "wg-conf", content }      — WireGuard / AmneziaWG .conf
//   { kind: "ovpn-conf", content }    — OpenVPN .ovpn
//   { kind: "amnezia-key", content }  — an AmneziaVPN key (vpn://…)
//   { kind: "empty" } / { kind: "unknown" }
export function detectAddInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return { kind: "empty" };

  // A ready client config is checked first: the recognition is exact (the JSON must
  // parse), while the heuristics below could get it wrong.
  const pastedFormat = detectConfigFormat(s);
  if (pastedFormat) return { kind: "client-config", content: s, format: pastedFormat };

  // AmneziaVPN key: compressed JSON in base64url behind the vpn:// scheme. It's parsed
  // asynchronously when adding, here it's enough to recognize the shape.
  if (looksLikeAmneziaKey(s)) return { kind: "amnezia-key", content: s };

  // Files are checked before searching for links: a comment may contain a URL.
  if (looksLikeOpenvpnConf(s)) return { kind: "ovpn-conf", content: String(raw) };

  const protocolUrls = Array.from(s.matchAll(KNOWN_PROTO_URL_RE), m => m[0]);
  if (protocolUrls.length > 1) return { kind: "list", content: s };
  // Direct protocol link (vless/vmess/trojan/ss/hysteria2/tuic)
  // Panels don't always encode the name after "#": a space in it broke the match, and
  // a single link went into the list branch.
  const singleLine = !/[\r\n]/.test(s);
  if (protocolUrls.length === 1 && PROTO_PREFIX_RE.test(s) && (protocolUrls[0] === s || singleLine)) {
    return { kind: "config", content: s };
  }

  // Deep links of other clients: <scheme>://import/<url> or ?url=
  const dl = s.match(/^(?:hiddify|v2ray|v2rayn|v2rayng|clash|clashmeta|sing-box):\/\/(.+)$/i);
  if (dl) {
    const rest = dl[1];
    if (/^https?:\/\//i.test(rest)) return { kind: "url", url: rest };
    try {
      const u = new URL(s.replace(/^[a-z0-9-]+:\/\//i, "http://"));
      const url = u.searchParams.get("url");
      if (url) return { kind: "url", url };
      const importPath = rest.replace(/^import\//i, "");
      if (/^https?:\/\//i.test(importPath)) return { kind: "url", url: importPath };
    } catch {}
  }

  // Plain http(s) URL
  if (/^https?:\/\//i.test(s)) return { kind: "url", url: s };

  // A base64 list or a base64-wrapped config?
  const decoded = safeDecodeBase64(s);
  if (decoded && KNOWN_PROTO_RE.test(decoded)) return { kind: "list", content: decoded };
  if (decoded) {
    const decodedFormat = detectConfigFormat(decoded);
    if (decodedFormat) return { kind: "client-config", content: decoded, format: decodedFormat };
    if (looksLikeOpenvpnConf(decoded)) return { kind: "ovpn-conf", content: decoded };
  }

  // A plain list with any supported protocols
  if (KNOWN_PROTO_RE.test(s)) return { kind: "list", content: s };

  // TrustTunnel endpoint .toml (pasted as text or loaded as a file)
  if (looksLikeTrustTunnelToml(s)) return { kind: "tt-toml", content: s };

  // WireGuard / AmneziaWG .conf — also a file, not a link.
  if (looksLikeWireguardConf(s)) return { kind: "wg-conf", content: s };

  return { kind: "unknown", raw: s };
}

// ── storage ────────────────────────────────────────────────
export function loadSubscriptions() {
  return loadSubscriptionsFromStore();
}

export function saveSubscriptions(list, options) {
  return saveSubscriptionsToStore(list, options);
}

function tooLargeToSave(saved) {
  return saved?.error?.code === "too_large";
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Rolling back a failed refresh: we restore only the fields the refresh itself
// changed, and only if nobody has changed them since. A rename, HWID
// or interval set by the user during the write stay.
// Fields that make sense only together: an interval mode without its hours
// turns into a setting nobody chose.
const REFRESH_FIELD_GROUPS = [
  ["updateIntervalMode", "updateIntervalHours", "serverUpdateIntervalHours"],
];

function fieldGroup(key) {
  return REFRESH_FIELD_GROUPS.find(group => group.includes(key)) || [key];
}

function revertRefresh(current, fresh, merged) {
  const out = { ...current };
  for (const key of new Set([...Object.keys(fresh), ...Object.keys(merged)])) {
    if (sameValue(fresh[key], merged[key])) continue;
    // If the user touched at least one field of a group, the group isn't rolled back.
    if (fieldGroup(key).some(k => !sameValue(current[k], merged[k]))) continue;
    if (key in fresh) out[key] = fresh[key];
    else delete out[key];
  }
  return out;
}

// A stable ID survives rename/reorder and a repeated refresh. For new identical
// structures an occurrence is added; after the first save the ID matches back.
export function assignStableNodeIds(profiles, previous = [], namespace = "sub") {
  const oldByShape = new Map();
  for (const node of previous || []) {
    const shape = nodeSemanticFingerprint(node);
    const q = oldByShape.get(shape) || [];
    if (node.stableId) q.push(node.stableId);
    oldByShape.set(shape, q);
  }
  const seen = new Map();
  return (profiles || []).map(node => {
    if (node.stableId || node.id) return node;
    const shape = nodeSemanticFingerprint(node);
    const occurrence = seen.get(shape) || 0;
    seen.set(shape, occurrence + 1);
    const reused = oldByShape.get(shape)?.shift();
    return { ...node, stableId: reused || `${namespace}-${shape}-${occurrence}` };
  });
}

// Legacy subscriptions may have saved a manual choice by the old tag before
// stableId appeared. On the first migration stableId changes the tag, so we carry the choice over by
// the node's semantic identity rather than leaving the new Selector on default=auto.
function migrateRememberedSelection(id, previous = [], next = []) {
  const source = { kind: "sub", subscription: { id } };
  const oldTag = getRememberedProxySelection(source);
  if (!oldTag || oldTag === "auto") return;

  const oldIndex = previous.findIndex((node, i) => nodeTag(i, node) === oldTag);
  if (oldIndex < 0) return;
  const identity = nodeSemanticFingerprint(previous[oldIndex]);
  const nextIndex = next.findIndex(node => nodeSemanticFingerprint(node) === identity);
  if (nextIndex < 0) return;

  const nextTag = nodeTag(nextIndex, next[nextIndex]);
  if (nextTag !== oldTag) rememberProxySelection(source, nextTag);
}

export function getActiveSubscriptionId() {
  return getActiveSubscriptionIdFromStore();
}

export function setActiveSubscriptionId(id) {
  setActiveSubscriptionIdInStore(id);
}

export function getActiveSubscription() {
  const id = getActiveSubscriptionId();
  if (!id) return null;
  return loadSubscriptions().find(s => s.id === id) || null;
}

export function removeSubscription(id) {
  const wasActive = getActiveSubscriptionId() === id;
  const list = loadSubscriptions().filter(s => s.id !== id);
  saveSubscriptions(list);
  if (wasActive) {
    setActiveSubscriptionId(list[0]?.id ?? null);
  }
}

// Targeted update of subscription fields (rename, autoUpdate, interval, …).
// Keeps the unspecified fields, doesn't touch .profiles and .lastUpdate.
export function updateSubscription(id, patch) {
  const list = loadSubscriptions();
  const idx = list.findIndex(s => s.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  saveSubscriptions(list);
  return list[idx];
}

// ── duplicates ───────────────────────────────────────────────
// The same link added twice produces two copies of the same
// servers: they double the list, each pulls its own refresh, and "Auto" picks
// between clones. We compare the normalized address: the scheme and host
// are case-insensitive, the default port and the anchor don't affect the panel's response, while the path
// and parameters are kept as is — that's what distinguishes subscriptions of the same panel.
export function normalizeSubscriptionUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return value;
    url.hash = "";
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch { return value; }
}

/** An already added subscription with the same address, otherwise null. */
export function findSubscriptionByUrl(url, list = null) {
  const key = normalizeSubscriptionUrl(url);
  if (!key) return null;
  const subs = list || loadSubscriptions();
  return subs.find(s => normalizeSubscriptionUrl(s.url) === key) || null;
}

// ── fetch + merge ───────────────────────────────────────────
// Proxy for fetch_subscription: main.js substitutes the local inbound when
// the VPN is up — the request to the panel goes through the tunnel (doesn't expose the real IP
// and works where the panel is blocked directly). null → direct.
let subProxyProvider = null;
export function setSubscriptionProxy(fn) { subProxyProvider = fn; }
let subTunnelInTransit = null;
// true while the tunnel is coming up or going down: there's no proxy yet, but the VPN is already on.
export function setSubscriptionTunnelTransit(fn) { subTunnelInTransit = fn; }

// The HWID goes only to subscriptions for which the user enabled it:
// panels without a device limit have no reason to know the device identifier.
async function fetchInfo(url, { hwid = false, scopedHwid = false, format = null } = {}) {
  let proxy = null;
  try { proxy = subProxyProvider?.() || null; } catch {}
  // Without this check the ban on the direct path was bypassed: the address with the token and HWID went out
  // from the real IP if the timer fired during a reconnect.
  if (!proxy && subTunnelInTransit?.()) {
    const options = loadOptions();
    if (options.privacy?.strictTunnel || !options.general?.allowDirectSubscriptionFallback) {
      throw new Error(t("subs.proxyFallbackDisabled"));
    }
  }
  const headers = hwid ? await hwidHeaders({ scoped: scopedHwid }) : null;
  // The field is present only when the format is set: the old call stays byte-for-byte the same.
  const extra = format ? { format } : {};
  let info;
  try {
    info = await invoke("fetch_subscription", { url, proxy, hwid: headers, ...extra });
  } catch (e) {
    if (!proxy) throw e;
    const options = loadOptions();
    const allowDirectFallback = !options.privacy?.strictTunnel
      && !!options.general?.allowDirectSubscriptionFallback;
    if (!allowDirectFallback) {
      throw new Error(t("subs.proxyFallbackDisabled"), { cause: e });
    }
    // The tunnel may have just died — if the user explicitly allowed it, we retry directly.
    info = await invoke("fetch_subscription", { url, proxy: null, hwid: headers, ...extra });
  }
  if (info.status >= 400) {
    const err = new Error(`HTTP ${info.status}`);
    // 404 is what a panel with the limit enabled answers to a request without a HWID;
    // the error itself carries the hint about it, otherwise it looks like "the panel is down".
    err.hwid = hwidSignal(info, [], { sent: hwid });
    throw err;
  }
  return info;
}

// ── xray JSON instead of the link list ─────────────────────────
// Comparing the nodes of two responses of the same panel: the name, order and minor fields
// differ between formats, while a server is the protocol, address, port and transport.
function looseNodeKey(node) {
  return [
    profileProto(node),
    String(node?.host || "").toLowerCase(),
    String(node?.port ?? ""),
    String(node?.type || "").toLowerCase(),
  ].join("|");
}

/**
 * Whether to take xray JSON instead of the link list: only if it has EVERYTHING that
 * was in the list, and something extra. JSON can't do some protocols (TUIC,
 * AnyTLS, Naive…), and the panel simply doesn't serve them to JSON clients — such
 * an exchange would lose servers rather than add them.
 */
export function preferXrayJson(linkProfiles, jsonProfiles) {
  const json = Array.isArray(jsonProfiles) ? jsonProfiles : [];
  const links = Array.isArray(linkProfiles) ? linkProfiles : [];
  if (!json.length) return false;
  const jsonKeys = new Set(json.map(looseNodeKey));
  if (!links.every(node => jsonKeys.has(looseNodeKey(node)))) return false;
  const linkKeys = new Set(links.map(looseNodeKey));
  return json.some(node => !linkKeys.has(looseNodeKey(node)));
}

/**
 * Pulls the subscription in the best available format. `state` is the remembered decision
 * {use, checkedAt}: while it's fresh, we don't recheck. JSON probe errors
 * aren't fatal — the regular link list stays.
 * @returns {{info: object, parsed: object, xrayJson: {use: boolean, checkedAt: number}|null}}
 */
async function fetchRemoteSubscription(url, fetchOptions, state = null, now = Date.now()) {
  const known = state && typeof state === "object" ? state : null;
  const fresh = !!known && now - (Number(known.checkedAt) || 0) < XRAY_JSON_RECHECK_MS;

  if (fresh && known.use) {
    try {
      const info = await fetchInfo(url, { ...fetchOptions, format: XRAY_JSON_FORMAT });
      const parsed = parseRemoteSubscription(info.body);
      if (parsed.format === "xray" && parsed.profiles.length) return { info, parsed, xrayJson: known };
    } catch (e) {
      console.warn("subscription: xray-json fetch failed, falling back to links", e?.message);
    }
    // JSON is no longer served: we take the link list and decide anew.
  }

  const info = await fetchInfo(url, fetchOptions);
  const parsed = parseRemoteSubscription(info.body);
  if (fresh && !known.use) return { info, parsed, xrayJson: known };
  // An empty response is handled by the caller (HWID, format) — there's nothing to try JSON for.
  if (!parsed.profiles.length) return { info, parsed, xrayJson: known };
  const checked = { use: false, checkedAt: now };
  // The panel already returned a client config — there's no reason to ask for a second format.
  if (parsed.format) return { info, parsed, xrayJson: checked };

  try {
    const jsonInfo = await fetchInfo(url, { ...fetchOptions, format: XRAY_JSON_FORMAT });
    if (jsonInfo.status < 400) {
      const jsonParsed = parseRemoteSubscription(jsonInfo.body);
      if (jsonParsed.format === "xray" && preferXrayJson(parsed.profiles, jsonParsed.profiles)) {
        return { info: jsonInfo, parsed: jsonParsed, xrayJson: { use: true, checkedAt: now } };
      }
    }
  } catch (e) {
    console.warn("subscription: xray-json probe failed", e?.message);
  }
  return { info, parsed, xrayJson: checked };
}

/**
 * Creates a new subscription by URL: pulls, parses, saves.
 * @returns {object} subscription record
 */
export async function addSubscriptionFromUrl(url, customName = "", intervalHoursOverride = null, { hwid = false } = {}) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) throw new Error(t("subs.needHttpUrl"));

  // A safeguard for all add paths, not only the "Add" window:
  // a repeated link must not create a second copy of the subscription.
  const duplicate = findSubscriptionByUrl(u);
  if (duplicate) {
    const err = new Error(t("subs.duplicate", { name: duplicate.name || t("subs.subFallback") }));
    err.code = "duplicate";
    err.subscriptionId = duplicate.id;
    throw err;
  }

  // A new subscription immediately uses the provider HWID scheme (see hwid.js).
  const { info, parsed, xrayJson } = await fetchRemoteSubscription(u, { hwid, scopedHwid: true });
  const { profiles, received, skipped, format } = parsed;
  if (profiles.length === 0) {
    const err = new Error(unsupportedFormatMessage(format) || t("subs.noVless"));
    err.hwid = hwidSignal(info, received, { sent: hwid });
    throw err;
  }

  const id = uid("sub_");
  // An explicit slider choice (>0) takes priority over the panel header; 0 = "Auto" → we take
  // the server's profile-update-interval, and without it silentRefreshSubs uses the 6 h default.
  const hours = Number(intervalHoursOverride);
  const serverUpdateIntervalHours = info.profile_update_interval_hours ?? null;
  const updateIntervalMode = hours > 0 ? "manual" : "auto";
  const sub = {
    id,
    url: u,
    name: customName || info.profile_title || hostnameOf(u) || t("subs.subFallback"),
    lastUpdate: Date.now(),
    expire: info.expire ?? null,
    upload: info.upload ?? null,
    download: info.download ?? null,
    total: info.total ?? null,
    updateIntervalMode,
    updateIntervalHours: updateIntervalMode === "manual" ? hours : serverUpdateIntervalHours,
    serverUpdateIntervalHours,
    skipped,
    hwid: !!hwid,
    hwidScope: HWID_SCOPE_PROVIDER,
    ...(xrayJson ? { xrayJson } : {}),
    profiles: assignStableNodeIds(profiles, [], id),
  };

  const list = loadSubscriptions();
  list.push(sub);
  // We wait for the write: a subscription that doesn't fit into storage would otherwise hang
  // in the list until a restart and then vanish. We remove such a subscription right away and say why.
  const saved = await saveSubscriptions(list, { quietTooLarge: true });
  if (tooLargeToSave(saved)) {
    await saveSubscriptions(loadSubscriptions().filter(s => s.id !== id));
    const err = new Error(t("subs.tooLarge"));
    err.code = "too_large";
    throw err;
  }
  // The panel's device limit signal lives only in the response: it has no place in the subscription
  // record — it's about this request, not about the subscription itself.
  return { ...sub, hwidSignal: hwidSignal(info, received, { sent: hwid }) };
}

/**
 * Updates an existing subscription.
 */
export async function refreshSubscription(id) {
  const cur = loadSubscriptions().find(s => s.id === id);
  if (!cur) throw new Error(t("subs.notFound"));

  const { info, parsed, xrayJson } = await fetchRemoteSubscription(
    cur.url,
    { hwid: !!cur.hwid, scopedHwid: subscriptionUsesScopedHwid(cur) },
    cur.xrayJson,
  );
  const { profiles, received, skipped, format } = parsed;
  if (profiles.length === 0) {
    const err = new Error(unsupportedFormatMessage(format) || t("subs.emptyOrInvalid"));
    err.hwid = hwidSignal(info, received, { sent: !!cur.hwid });
    throw err;
  }
  // A response consisting only of placeholders (device limit, "enable HWID", end of plan) is
  // a message from the panel, not a new server list. We don't overwrite the working servers
  // with it: their credentials are often still alive, while a background update would otherwise silently
  // leave the user with a 0.0.0.0 node. A mixed response with real
  // servers is updated as usual (the placeholders have already been weeded out of it).
  if (profiles.every(isPlaceholderNode)
      && (cur.profiles || []).some((node) => !isPlaceholderNode(node))) {
    const err = new Error(t("subs.placeholderOnly"));
    err.code = "placeholder_only";
    err.hwid = hwidSignal(info, received, { sent: !!cur.hwid });
    throw err;
  }

  // The list is reread AFTER the await: during the fetch the user may have renamed
  // or deleted the subscription, and a parallel refresh may have updated a neighboring one. Saving
  // a snapshot taken before the await would silently roll back these changes.
  const list = loadSubscriptions();
  const idx = list.findIndex(s => s.id === id);
  if (idx < 0) throw new Error(t("subs.notFound"));
  const fresh = list[idx];
  const merged = mergeSubscriptionRefresh(fresh, info, profiles, skipped);
  if (xrayJson) merged.xrayJson = xrayJson;
  list[idx] = merged;
  const saved = await saveSubscriptions(list, { quietTooLarge: true });
  if (tooLargeToSave(saved)) {
    // We roll back only the result of this refresh: neighboring subscriptions and later
    // edits of this one are left alone.
    const current = loadSubscriptions();
    const at = current.findIndex(s => s.id === id);
    if (at >= 0) {
      current[at] = revertRefresh(current[at], fresh, merged);
      await saveSubscriptions(current);
    }
    const err = new Error(t("subs.tooLarge"));
    err.code = "too_large";
    throw err;
  }
  migrateRememberedSelection(id, fresh.profiles || [], merged.profiles || []);
  return { ...list[idx], hwidSignal: hwidSignal(info, received, { sent: !!cur.hwid }) };
}

export function mergeSubscriptionRefresh(fresh, info, profiles, skipped = 0) {
  const hasServerInterval = info.profile_update_interval_hours != null;
  const serverUpdateIntervalHours = hasServerInterval
    ? info.profile_update_interval_hours
    : (fresh.serverUpdateIntervalHours ?? null);
  const mode = fresh.updateIntervalMode || (Number(fresh.updateIntervalHours) > 0 ? "manual" : "auto");
  const updateIntervalHours = mode === "manual"
    ? fresh.updateIntervalHours
    : (hasServerInterval ? info.profile_update_interval_hours : fresh.updateIntervalHours);
  return {
    ...fresh,
    name: fresh.name || info.profile_title || "",
    lastUpdate: Date.now(),
    expire: info.expire ?? fresh.expire,
    upload: info.upload ?? fresh.upload,
    download: info.download ?? fresh.download,
    total: info.total ?? fresh.total,
    updateIntervalMode: mode,
    updateIntervalHours: updateIntervalHours ?? null,
    serverUpdateIntervalHours,
    skipped,
    profiles: assignStableNodeIds(profiles, fresh.profiles, fresh.id),
  };
}

async function allSettledLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      try {
        out[idx] = { status: "fulfilled", value: await fn(items[idx], idx) };
      } catch (reason) {
        out[idx] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// Limited parallelism: a sequential pass added up network timeouts,
// and Promise.all over all subscriptions created a burst with big lists. There are no races for
// localStorage — each refresh rereads the list after its own await.
export async function refreshAllSubscriptions() {
  const list = loadSubscriptions();
  const settled = await allSettledLimit(list, REFRESH_ALL_CONCURRENCY, s => refreshSubscription(s.id));
  return settled.map((r, i) => r.status === "fulfilled"
    ? { id: list[i].id, ok: true, count: r.value.profiles.length }
    : { id: list[i].id, ok: false, error: r.reason?.message || String(r.reason) });
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

// ── helpers for the UI ─────────────────────────────────────────
export function subscriptionDaysLeft(sub) {
  if (!sub?.expire) return null;
  const secsLeft = sub.expire - Math.floor(Date.now() / 1000);
  if (secsLeft <= 0) return 0;
  return Math.ceil(secsLeft / 86400);
}

export function subscriptionUsedBytes(sub) {
  const up = sub?.upload ?? 0;
  const down = sub?.download ?? 0;
  return up + down;
}

export function formatGiB(bytes) {
  if (bytes == null) return "—";
  return (bytes / 1024 / 1024 / 1024).toFixed(bytes < 1e9 ? 2 : 1);
}

// A smart traffic formatter: picks the unit itself (B/KB/MB/GB/TB), gives
// "12.3 MB" / "1.45 GB" / "857 GB" instead of the eternal "0.00 GB" on small volumes.
export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return t("subs.zero");
  const units = [t("subs.bytes.b"), t("subs.bytes.kb"), t("subs.bytes.mb"), t("subs.bytes.gb"), t("subs.bytes.tb")];
  let v = b, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const dec = i <= 1 || v >= 100 ? 0 : (v >= 10 ? 1 : 2);
  return `${v.toFixed(dec)} ${units[i]}`;
}

// total=0 (or missing) for many panels = unlimited/not metered. We return
// a number only if it's a real positive limit, otherwise null = unlimited.
export function subscriptionLimitBytes(sub) {
  const total = sub?.total;
  return typeof total === "number" && total > 0 ? total : null;
}
