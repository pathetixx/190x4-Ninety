// Ninety · ready lists for routing rules and the region base.
//
// The value of a "Ready list" rule is a reference like "geosite:youtube" (sites
// of a service or category) or "geoip:ru" (a country's addresses). The files are taken from
// the original SagerNet sources; a name that isn't in the catalog can't be downloaded
// by the core, so only names from rule-set-catalog.js get into a rule.

import { GEOIP_CODES, GEOSITE_NAMES } from "/lib/rule-set-catalog.js";

export const GEOSITE_BASE = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set";
export const GEOIP_BASE = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set";

export const SET_KINDS = ["geosite", "geoip"];

// A country geosite doesn't exist for every region — only these three.
// For the rest the region base relies on geoip. Previously a mirror was substituted here
// where for tr there was a file with Russian government site domains, and for by there was
// nothing — the rule silently didn't work.
export const REGION_GEOSITE = {
  ru: "category-ru",
  cn: "cn",
  ir: "category-ir",
};

const GEOSITE = new Set(GEOSITE_NAMES);
const GEOIP = new Set(GEOIP_CODES);

// The first thing visible in the list picker while the search is empty. The rest — via search.
export const POPULAR_GEOSITE = [
  "youtube", "google", "telegram", "discord", "openai", "anthropic", "category-ai-!cn",
  "netflix", "spotify", "twitch", "instagram", "facebook", "x", "tiktok", "whatsapp",
  "github", "microsoft", "apple", "steam", "yandex", "vk",
  "category-ru", "category-gov-ru", "cn", "category-ads-all",
];
export const POPULAR_GEOIP = ["ru", "by", "kz", "ua", "cn", "ir", "tr", "us", "de", "nl", "fi"];

// "geosite:YouTube" / " geoip:RU " → { kind, name } in canonical form, or null.
export function parseSetRef(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const sep = raw.indexOf(":");
  if (sep < 0) return null;
  const kind = raw.slice(0, sep).trim();
  const name = raw.slice(sep + 1).trim();
  if (!SET_KINDS.includes(kind) || !name) return null;
  return { kind, name };
}

export function isKnownSet(ref) {
  if (!ref) return false;
  return ref.kind === "geosite" ? GEOSITE.has(ref.name) : GEOIP.has(ref.name);
}

export function formatSetRef(ref) {
  return `${ref.kind}:${ref.name}`;
}

export function normalizeSetRef(value) {
  const ref = parseSetRef(value);
  return ref && isKnownSet(ref) ? formatSetRef(ref) : "";
}

export function setUrl(ref) {
  return ref.kind === "geosite"
    ? `${GEOSITE_BASE}/geosite-${ref.name}.srs`
    : `${GEOIP_BASE}/geoip-${ref.name}.srs`;
}

// Catalog search for the list picker: matches at the start of the name first,
// then the rest. An empty query — the popular ones.
export function searchSets(kind, query, limit = 60) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return kind === "geosite" ? POPULAR_GEOSITE.slice() : POPULAR_GEOIP.slice();
  const names = kind === "geosite" ? GEOSITE_NAMES : GEOIP_CODES;
  const head = [];
  const rest = [];
  for (const name of names) {
    if (name.startsWith(q)) head.push(name);
    else if (name.includes(q)) rest.push(name);
    if (head.length >= limit) break;
  }
  return [...head, ...rest].slice(0, limit);
}
