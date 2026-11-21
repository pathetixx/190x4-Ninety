// Ninety · masking addresses in text that not only the user sees.
//
// Two consumers with different tasks: the main screen hides your own
// public address until clicked (maskIp), while the diagnostics report goes to a support
// chat and must carry neither the server address nor the exit address
// (maskAddresses). Previously each had its own implementation, and only the first one
// knew IPv6 — because of which the report promised anonymization but performed it only for IPv4.

// IPv6-like: several groups separated by colons, possibly with an IPv4 tail
// (::ffff:1.2.3.4). The candidate is checked by parsing, not by a regex: a time like
// "12:34:56" looks the same but isn't an address and must not be mangled.
const IPV6_CANDIDATE_RE = /(?:[0-9A-Fa-f]{0,4}:){2,}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f]{0,4})/g;
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/** Valid IPv6 → normalized form; everything else → null. */
function parseIpv6(candidate) {
  try {
    // Parsing also normalizes the address: ::ffff:1.2.3.4 comes back already in
    // hex form, so the embedded IPv4 doesn't stay exposed.
    return new URL(`http://[${candidate}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/** 1.2.3.4 → 1.2.*.* (we mask the last two octets). */
export function maskIp(ip) {
  if (!ip || typeof ip !== "string") return "—";
  if (ip.includes(":")) {
    // IPv6: keep the first two groups, the rest becomes *
    const parts = ip.split(":");
    return `${parts.slice(0, 2).join(":")}:·:·`;
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.*.*`;
}

/**
 * Masks all addresses inside an arbitrary string — report lines where an address
 * sits next to the hop number, latency and reason.
 * IPv6 is handled first: otherwise the IPv4 rule would cut only the tail of
 * a ::ffff address, while the address itself would stay in the text.
 */
export function maskAddresses(value) {
  const text = String(value || "");
  if (!text) return "—";
  return text
    .replace(IPV6_CANDIDATE_RE, (candidate) => {
      const host = parseIpv6(candidate);
      if (!host) return candidate;
      const groups = host.split(":");
      return `${groups[0]}:${groups[1] ?? ""}:·:·`;
    })
    .replace(IPV4_RE, "$1.***.***.$4");
}
