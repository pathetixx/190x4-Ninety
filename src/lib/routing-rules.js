// Ninety · Flexible routing rules — contract + validation/normalization.
// Pure helpers (no DOM/Tauri): the UI of the "Routing rules" subsection (from
// Claude Design) calls them when adding/saving a rule, and the config engine
// (singbox.js::customRulesToSingbox) turns ready rules into sing-box
// route rules. The source of truth for the rule shape and allowed values.
//
// Rule:
//   { id, enabled, type:"domain"|"ip"|"process"|"set",
//     match:"suffix"|"exact"|"keyword" (domain only),
//     values:[…] (for "set" — "geosite:<name>" / "geoip:<country code>"), action:"proxy"|"direct"|"block"|"node"|"warp",
//     target:{ tag, name } — only for action:"node",
//     name — an optional label for the list; doesn't get into the core config }

import { uid } from "/lib/uid.js";
import { REGION_GEOSITE, normalizeSetRef } from "/lib/rule-sets.js";

export const RULE_TYPES = ["domain", "ip", "process", "set"];
export const DOMAIN_MATCHES = ["suffix", "exact", "keyword"];
export const RULE_ACTIONS = ["proxy", "direct", "block", "node", "warp"];

// Actions that send traffic to a specific outbound rather than the general "through VPN".
// "node" requires a target, "warp" requires WARP to be enabled: either may
// be missing at config build time, so both degrade to "proxy"
// (see resolveRuleTarget in singbox.js) instead of the core failing on an empty tag.
export const TARGETED_ACTIONS = ["node", "warp"];

// UI labels are in the i18n catalog (rr.type/rr.match/rr.action), taken by routing-view.js.

// A rule's reference to a specific server. A node tag is a hash of its contents
// (singbox.js::nodeTag), so the rule survives the subscription being reordered.
// The name is kept as a second key: if the provider changed the node's parameters, the hash moves,
// but the human-readable name usually stays the same — the rule won't silently become orphaned.
export function normalizeTarget(target) {
  const tag = String(target?.tag || "").trim().slice(0, 128);
  const name = String(target?.name || "").trim().slice(0, 200);
  if (!tag && !name) return null;
  return { ...(tag ? { tag } : {}), ...(name ? { name } : {}) };
}

// Rule label: a purely cosmetic field by which the user recognizes
// the rule in the list. The limit is in characters (code points), not UTF-16: truncating
// with .slice() could cut an emoji in half. Line breaks and tabs become spaces,
// other control and bidi-override characters are stripped: they break the list
// row and allow visually spoofing the text. ZWJ/ZWNJ are kept — they're
// needed for Persian text and composite emoji.
export const RULE_NAME_MAX = 64;
const NAME_SPACE_RE = /[\t\n\r\v\f\u2028\u2029]+/g;
// eslint-disable-next-line no-control-regex
const NAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export function clampRuleName(raw) {
  const chars = Array.from(String(raw));
  return chars.length > RULE_NAME_MAX ? chars.slice(0, RULE_NAME_MAX).join("") : String(raw);
}
export function normalizeRuleName(raw) {
  if (typeof raw !== "string") return "";
  const clean = raw.replace(NAME_SPACE_RE, " ").replace(NAME_STRIP_RE, "").trim();
  return clampRuleName(clean).trim();
}

// Do the rules differ only by label? Then the network result is the same and
// there's no reason to reconnect. We compare everything except the root name; target.name is
// a working field of the server choice, its comparison stays.
function stableJson(v) {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v ?? null);
}
export function sameRuleExceptName(a, b) {
  if (!a || !b) return false;
  const strip = (r) => ({ ...r, name: undefined });
  return stableJson(strip(a)) === stableJson(strip(b));
}

// A new rule with defaults (for the "Add" button).
export function newRule(partial = {}) {
  return {
    id: uid("r-"),
    enabled: true,
    type: "domain",
    match: "suffix",
    values: [],
    action: "proxy",
    ...partial,
  };
}

// ── Normalizing values by type ───────────────────────────────────
// Unicode domain → punycode (A-label). sing-box matches domains in the form
// the resolver sees them, i.e. punycode: a rule saved as "почта.рф" would
// never match. The conversion is done by WHATWG URL itself — no external dependencies.
// We touch ONLY strings with non-ASCII: for pure ASCII the URL parser would also
// normalize "0x7f.1" into an IP address, which the user didn't ask for.
function hasNonAscii(s) {
  for (const ch of s) if (ch.codePointAt(0) > 0x7f) return true;
  return false;
}

function toPunycode(host) {
  if (!hasNonAscii(host)) return host;
  try {
    const { hostname } = new URL(`http://${host}/`);
    return hostname || host;
  } catch { return host; }
}

// Domain: strip the scheme/path/port/leading "*.", lowercase.
// match="keyword" is a substring of the name, not a domain: stripping the scheme/path/port there
// would change the searched fragment itself, so for it only trim/lowercase/punycode.
export function normalizeDomain(v, match = "suffix") {
  let s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  if (match === "keyword") return toPunycode(s);
  s = s.replace(/^[a-z]+:\/\//, ""); // https:// and the like
  s = s.split("/")[0]; // path
  s = s.split("?")[0];
  s = s.replace(/^\*\./, ""); // *.youtube.com → youtube.com (suffix covers subdomains)
  s = s.replace(/:\d+$/, ""); // :443
  return toPunycode(s);
}

// LDH label: 1..63 characters, doesn't start or end with a hyphen.
// The underscore is left on purpose (service names like _acme-challenge).
const RE_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

// A valid domain. A whole zone is written explicitly, with a dot: ".ru", ".xn--p1ai" —
// just like in the region base, and only for "Subdomains". A bare "youtube" without
// a dot stays an error: that almost always meant "Contains".
// The former regex required a TLD of letters only ([a-z]{2,63}) and
// silently threw away all punycode (xn--p1ai, i.e. any .рф/.中国) and TLDs with
// a digit (.p2p, .b2b): the rule vanished from the list, and the cause never surfaced anywhere.
function isValidDomainName(s, match = "suffix") {
  if (!s || s.length > 253) return false;
  const zone = match === "suffix" && s.startsWith(".");
  const labels = (zone ? s.slice(1) : s).split(".");
  if (labels.length < (zone ? 1 : 2)) return false;
  if (!labels.every((label) => RE_LABEL.test(label))) return false;
  const tld = labels[labels.length - 1];
  // A purely numeric TLD is forbidden — otherwise "1.2.3.4" would pass as a domain.
  return tld.length >= 2 && !/^\d+$/.test(tld);
}

// A keyword is a substring of the host name, not a domain: no dot or TLD needed.
// We check only the length and the host name alphabet.
function isValidDomainKeyword(s) {
  return !!s && s.length <= 253 && /^[a-z0-9_.-]+$/.test(s);
}

const RE_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// The canonical form of IPv4 or "" — leading zeros are stripped here, not just
// checked. Otherwise "192.168.001.100" passed validation and went into the core
// config as is: sing-box rejects such an entry, and the user's rule silently
// didn't work (or the whole config didn't come up).
function canonicalIpv4(s) {
  const m = s.match(RE_IPV4);
  if (!m) return "";
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "";
  return octets.join(".");
}

function validIpv6(s) {
  if (!s.includes(":")) return false;
  if (s.includes("%")) return false; // sing-box ip_cidr doesn't need a zone-id
  try {
    new URL(`http://[${s}]/`);
    return true;
  } catch {
    return false;
  }
}

// IP/CIDR: return a normalized entry (a single IP → /32 or /128) or "".
export function normalizeIp(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const [addr, cidrRaw, ...rest] = s.split("/");
  if (rest.length) return "";
  const isV6 = addr.includes(":");
  const canonical = isV6 ? (validIpv6(addr) ? addr : "") : canonicalIpv4(addr);
  if (!canonical) return "";
  if (cidrRaw === undefined) return `${canonical}/${isV6 ? 128 : 32}`;
  const cidr = Number(cidrRaw);
  if (!Number.isInteger(cidr) || cidr < 0 || cidr > (isV6 ? 128 : 32)) return "";
  return `${canonical}/${cidr}`;
}

// Process: the executable file name. Strip the path, add .exe if forgotten.
export function normalizeProcess(v) {
  let s = String(v || "").trim();
  if (!s) return "";
  s = s.replace(/[\\/]+$/, "");
  s = s.split(/[\\/]/).pop(); // C:\…\Telegram.exe → Telegram.exe
  if (!/\.exe$/i.test(s)) s += ".exe";
  return s;
}

// Normalize one value by type. "" = invalid.
export function normalizeValue(type, v, match = "suffix") {
  if (type === "ip") return normalizeIp(v);
  if (type === "process") return normalizeProcess(v);
  if (type === "set") return normalizeSetRef(v);
  return normalizeDomain(v, match); // domain
}

// Whether the value is valid (for highlighting the field in the UI).
export function isValidValue(type, v, match = "suffix") {
  const n = normalizeValue(type, v, match);
  if (!n) return false;
  if (type === "domain") {
    return match === "keyword" ? isValidDomainKeyword(n) : isValidDomainName(n, match);
  }
  return true; // ip/process/set are already verified by normalization
}

// Bring the rule to a clean form before saving: normalize values,
// drop empty/broken ones, dedup. Return { rule, dropped } — dropped = how many
// values were discarded (the UI may warn).
export function sanitizeRule(rule) {
  const type = RULE_TYPES.includes(rule?.type) ? rule.type : "domain";
  const match = type === "domain" && DOMAIN_MATCHES.includes(rule?.match) ? rule.match : "suffix";
  const requested = RULE_ACTIONS.includes(rule?.action) ? rule.action : "proxy";
  // "Through a server" without a target is indistinguishable from "through VPN", but it would go into the config with
  // an empty tag and bring down the core start. Such a rule is degraded right here.
  const target = requested === "node" ? normalizeTarget(rule?.target) : null;
  const action = requested === "node" && !target ? "proxy" : requested;
  const seen = new Set();
  const values = [];
  let dropped = 0;
  for (const raw of Array.isArray(rule?.values) ? rule.values : []) {
    if (!isValidValue(type, raw, match)) {
      if (String(raw || "").trim()) dropped++;
      continue;
    }
    const n = normalizeValue(type, raw, match);
    if (seen.has(n)) continue;
    seen.add(n);
    values.push(n);
  }
  const name = normalizeRuleName(rule?.name);
  return {
    rule: {
      id: rule?.id || uid("r-"),
      ...(name ? { name } : {}),
      enabled: rule?.enabled !== false,
      type,
      ...(type === "domain" ? { match } : {}),
      values,
      action,
      ...(target ? { target } : {}),
      ...(rule?.origin === "region" ? { origin: "region" } : {}),
    },
    dropped,
  };
}

// The region base as user rules ("Make them mine"): the same zone
// and the same lists that singbox.js emits for the region — after the migration
// routing doesn't change, and the rules can be edited as your own. origin tells
// them apart when the base is restored.
export function regionRules(region) {
  const sets = [
    ...(REGION_GEOSITE[region] ? [`geosite:${REGION_GEOSITE[region]}`] : []),
    `geoip:${region}`,
  ];
  return [
    newRule({ type: "domain", match: "suffix", values: [`.${region}`], action: "direct", origin: "region" }),
    newRule({ type: "set", values: sets, action: "direct", origin: "region" }),
  ].map((rule) => sanitizeRule(rule).rule);
}

// ── Rules file: export and import ───────────────────────────────────
// Moving the list between devices. A rule's id is local (the screen finds the
// row by it), so it isn't written to the file and is reissued on import.
// regionDetached travels with the rules: the migrated region base lives in
// the list itself, and without the flag the region on the second device would emit its own
// rules on top of the already imported ones.
export const RULES_FILE_TYPE = "ninety.routing-rules";
export const RULES_FILE_VERSION = 1;
export const RULES_IMPORT_MAX = 1000;

export function buildRulesExport(rules, { regionDetached = false, now = new Date() } = {}) {
  const list = (Array.isArray(rules) ? rules : []).map((raw) => {
    const rule = { ...sanitizeRule(raw).rule };
    delete rule.id;
    return rule;
  });
  return {
    type: RULES_FILE_TYPE,
    version: RULES_FILE_VERSION,
    exportedAt: now.toISOString(),
    regionDetached: !!regionDetached,
    rules: list,
  };
}

// Parsing the file. Also accepts a bare array of rules — that makes it easier to assemble a file
// by hand. An unknown type or action discards the rule entirely: silently
// turning a "Block" from a future version into "Through VPN" is worse than skipping it.
// Returns { rules, regionDetached, skipped, dropped } or { error }, where
// error — "parse" | "format" | "newer" | "tooMany" | "empty".
export function parseRulesImport(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? "").replace(/^\uFEFF/, ""));
  } catch {
    return { error: "parse" };
  }
  let list;
  let regionDetached = null;
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === "object" && data.type === RULES_FILE_TYPE) {
    if (!Number.isInteger(data.version) || data.version < 1) return { error: "format" };
    if (data.version > RULES_FILE_VERSION) return { error: "newer" };
    if (!Array.isArray(data.rules)) return { error: "format" };
    list = data.rules;
    if (typeof data.regionDetached === "boolean") regionDetached = data.regionDetached;
  } else {
    return { error: "format" };
  }
  if (list.length > RULES_IMPORT_MAX) return { error: "tooMany" };
  const rules = [];
  let skipped = 0;
  let dropped = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || !RULE_TYPES.includes(raw.type) || !RULE_ACTIONS.includes(raw.action)) {
      skipped++;
      continue;
    }
    const { rule, dropped: lost } = sanitizeRule({ ...raw, id: undefined });
    dropped += lost;
    if (!rule.values.length) {
      skipped++;
      continue;
    }
    rules.push(rule);
  }
  if (!rules.length) return { error: "empty" };
  if (regionDetached === null) regionDetached = rules.some((r) => r.origin === "region");
  return { rules, regionDetached, skipped, dropped };
}

// The same rule regardless of id, label, base mark and toggle:
// a copy disabled locally is still "already there".
function ruleFingerprint(rule) {
  return stableJson({ ...rule, id: undefined, name: undefined, origin: undefined, enabled: undefined });
}

// mode "replace" — the whole list from the file; "append" — new rules at the end,
// existing ones are skipped. When appending, the region base mark is removed:
// "Restore base" on this device must not delete what was imported.
export function mergeImportedRules(current, incoming, mode = "append") {
  const list = Array.isArray(incoming) ? incoming : [];
  if (mode === "replace") return { rules: list.map((r) => ({ ...r })), added: list.length, duplicates: 0 };
  const own = Array.isArray(current) ? current : [];
  const seen = new Set(own.map(ruleFingerprint));
  const added = [];
  let duplicates = 0;
  for (const rule of list) {
    const plain = { ...rule };
    delete plain.origin;
    const fp = ruleFingerprint(plain);
    if (seen.has(fp)) {
      duplicates++;
      continue;
    }
    seen.add(fp);
    added.push(plain);
  }
  return { rules: [...own, ...added], added: added.length, duplicates };
}
