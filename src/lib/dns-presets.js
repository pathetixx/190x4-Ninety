// Ninety · DNS presets for settings.
//
// The DNS field used to be free input: a typo like udp://8.8.8.8/dns-query
// was silently saved and brought down the connection later, when building the config. Here —
// a ready list plus validation of manual input with the same parser that builds
// the config (parseDnsAddress), so that the UI and the core don't disagree on what counts
// as a valid address.
//
// The remote and direct sets are DIFFERENT on purpose. remote works inside the tunnel,
// where nobody cuts :443 — encrypted DoH/DoT is appropriate there. direct must
// come up BEFORE the tunnel (it resolves the node's domain), and DoH is cut as a class in Russia,
// so regular UDP comes first there. All addresses from the dns-guard fallback chain
// are present in the direct list: otherwise auto-switching would move the select to
// "Custom address" instead of a clear name.

import { t } from "/lib/i18n/index.js";
import { parseDnsAddress } from "/lib/singbox.js";

export const DNS_CUSTOM = "__custom__";
export const DNS_SEPARATOR = "__sep__";

// type: system | doh | dot | plain — affects only the item label.
export const DNS_PRESETS = {
  // The system resolver is deliberately absent here: remote with "local" resolves past
  // the tunnel — the ISP sees the queries. It can still be entered manually, in which case
  // the UI shows a warning.
  remote: [
    { value: "https://1.1.1.1/dns-query", brand: "Cloudflare", type: "doh" },
    { value: "tls://1.1.1.1", brand: "Cloudflare", type: "dot" },
    { value: "https://8.8.8.8/dns-query", brand: "Google", type: "doh" },
    { value: "tls://8.8.8.8", brand: "Google", type: "dot" },
    { value: "https://9.9.9.9/dns-query", brand: "Quad9", type: "doh" },
    { value: "tls://9.9.9.9", brand: "Quad9", type: "dot" },
    { value: "https://94.140.14.14/dns-query", brand: "AdGuard", type: "doh" },
    { value: "tls://94.140.14.14", brand: "AdGuard", type: "dot" },
  ],
  // The plain group is ordered by resistance to spoofing, not by latency.
  // A filter doesn't have to block open UDP:53: it can FORGE the answer.
  // For a domain from the registry some public resolvers return an instant NXDOMAIN
  // instead of addresses, and it looks like an honest "no such domain" — the client doesn't
  // retry and doesn't move to a fallback, while the direct resolver is exactly what brings up the node's
  // domain before the tunnel. Measured from Russia: Yandex, Quad9 and AdGuard answer correctly,
  // Cloudflare and Google with a forged NXDOMAIN, so they rank lower. The default
  // (options.js) is Yandex, i.e. nobody gets the forgery by default.
  // Over DoH nobody spoofs: the answer is encrypted, an NXDOMAIN can't be injected,
  // so in the lower group the same operators are appropriate without caveats.
  direct: [
    { value: "local", type: "system" },
    { value: DNS_SEPARATOR },
    { value: "udp://77.88.8.8", brand: "Yandex", type: "plain" },
    { value: "udp://149.112.112.112", brand: "Quad9", type: "plain" },
    { value: "udp://94.140.14.14", brand: "AdGuard", type: "plain" },
    { value: "udp://1.1.1.1", brand: "Cloudflare", type: "plain" },
    { value: "udp://8.8.8.8", brand: "Google", type: "plain" },
    { value: DNS_SEPARATOR },
    { value: "https://149.112.112.112/dns-query", brand: "Quad9", type: "doh" },
    { value: "https://77.88.8.8/dns-query", brand: "Yandex", type: "doh" },
    { value: "https://94.140.14.14/dns-query", brand: "AdGuard", type: "doh" },
    { value: "https://8.8.8.8/dns-query", brand: "Google", type: "doh" },
  ],
};

// Address host for the item label and for dns-guard toasts. There's no point showing
// the scheme and the /dns-query path: within one type they're the same for everyone, and
// it's exactly the address that distinguishes the items. The port is kept — it's the only thing
// that sets a non-standard resolver apart from a regular one.
export function dnsHostLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    if (raw.startsWith("https://")) return new URL(raw).host;
    return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  } catch { return raw; }
}

// "Brand · address · type". The type is mandatory and can't be removed: for Cloudflare
// https://1.1.1.1/dns-query and tls://1.1.1.1 give the same host, for Yandex in
// direct — the same pair on 77.88.8.8. Without the type these items would be indistinguishable.
// UDP/DoT/DoH aren't translated: they're protocol names, not interface terms.
export function dnsPresetLabel(preset) {
  if (preset.type === "system") return t("settings.dns.presetSystem");
  const kind = preset.type === "plain" ? "UDP" : preset.type === "dot" ? "DoT" : "DoH";
  return `${preset.brand} · ${dnsHostLabel(preset.value)} · ${kind}`;
}

// Whether such an address is among the set's presets (exact string match).
export function findDnsPreset(kind, value) {
  const list = DNS_PRESETS[kind] || [];
  return list.find(p => p.value !== DNS_SEPARATOR && p.value === value) || null;
}

// "local"/"system" — resolving through the system servers. For remote this means
// queries will go past the tunnel, so the UI shows a warning.
export function isSystemDns(value) {
  const s = String(value || "").trim();
  return s === "local" || s === "system";
}

// Validation of manual input. Returns { ok } or { ok:false, messageKey }.
// An empty string is valid: normalizeOptions will return the default.
export function validateDnsAddress(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: true };
  const m = s.match(/^([a-z]+):\/\/(.+)$/i);
  if (m) {
    const scheme = m[1].toLowerCase();
    // A common mistake: the /dns-query path copied from a DoH link into a plain address.
    // The message is specific, otherwise the parser answers with a vague "invalid DNS host".
    if (["udp", "tcp", "tls", "quic"].includes(scheme) && m[2].includes("/")) {
      return { ok: false, messageKey: "settings.dns.errPath" };
    }
    if (!["udp", "tcp", "tls", "quic", "https"].includes(scheme)) {
      return { ok: false, messageKey: "settings.dns.errScheme" };
    }
  }
  try {
    parseDnsAddress(s);
    return { ok: true };
  } catch {
    return { ok: false, messageKey: "settings.dns.errGeneric" };
  }
}
