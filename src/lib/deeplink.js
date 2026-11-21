// Ninety · parsing a deep-link URL into an import intent. A pure function without DOM —
// moved out of main.js to cover the formats with tests (node --test).
//
// Supported formats:
//   ninety://import/<encoded-url>             — subscription (legacy, kept)
//   ninety://import?url=...&name=...          — subscription (query-style)
//   ninety://config/<encoded-link>            — single config (vless/vmess/...)
//   ninety://add/<base64-url>                 — subscription (Happ-style, base64 URL)
//   <proto>://...                             — top-level link (vless/vmess/ss/
//                                               trojan/hysteria2/tuic/sub/tt/naive),
//                                               if the user enabled opt-in registration
//                                               of schemes in Settings → General
//
// Returns: { url, name } for add-modal (prefillUrl/prefillName), or null
// if the link wasn't recognized. There's no auto-import — the user sees the prefilled URL and
// confirms (protection against malicious links).

// The tail after the action may start with either "/" (path-style) or "?" (query-style:
// ninety://import?url=...). The old pattern (?:\/(.*))? required "/" — query-style
// didn't match at all and was silently ignored (caught by a test).
const NINETY_RE = /^ninety:\/\/([a-z]+)([/?].*)?$/i;
export const ALLOWED_ACTIONS = new Set(["import", "config", "add"]);
const MAX_DEEPLINK_LENGTH = 64 * 1024;
const MAX_DEEPLINK_PAYLOAD_LENGTH = 48 * 1024;
const MAX_DEEPLINK_NAME_LENGTH = 256;
const hasControlChars = (value) => [...String(value)].some((char) => {
  const code = char.codePointAt(0);
  return code < 0x20 || code === 0x7f;
});
const TOP_LEVEL_PROTOS = [
  "vless", "vmess", "ss", "trojan", "hysteria2", "hy2", "hysteria", "tuic", "sub",
  "anytls", "tt", "naive+https", "naive+quic",
];

export function safeAtobUrl(s) {
  try {
    if (String(s).length > MAX_DEEPLINK_PAYLOAD_LENGTH) return "";
    const cleaned = String(s).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = cleaned + "=".repeat((4 - cleaned.length % 4) % 4);
    return atob(padded);
  } catch { return ""; }
}

function validDeepLinkName(n) {
  return !!n && n.length <= MAX_DEEPLINK_NAME_LENGTH && !hasControlChars(n);
}

export function parseDeepLink(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw || raw.length > MAX_DEEPLINK_LENGTH || raw.includes("\0")) return null;

  // top-level proto:// (vless/vmess/...) — opt-in
  const protoIdx = raw.indexOf("://");
  if (protoIdx > 0) {
    const proto = raw.slice(0, protoIdx).toLowerCase();
    if (TOP_LEVEL_PROTOS.includes(proto)) {
      if (proto === "sub") {
        // sub://<base64-url> → expand and send as a subscription
        // The #Name tail and ?query aren't part of the base64: atob failed entirely on them.
        const [, body, hash = ""] = raw.slice(protoIdx + 3).match(/^([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/s);
        const decoded = safeAtobUrl(body);
        if (decoded) {
          let subName = hash;
          try { subName = decodeURIComponent(hash); } catch {}
          return { url: decoded, name: validDeepLinkName(subName) ? subName : "" };
        }
      }
      return { url: raw, name: "" };
    }
  }

  // ninety://<action>/<rest>
  const m = raw.match(NINETY_RE);
  if (!m) return null;
  const action = m[1].toLowerCase();
  // We check the action before parsing the query and decoding the payload. Otherwise any
  // unknown action turned into a "regular import" and could get a new
  // meaning if the handler ever added action-specific behavior.
  if (!ALLOWED_ACTIONS.has(action)) return null;
  let rest = m[2] || "";
  if (rest.length > MAX_DEEPLINK_PAYLOAD_LENGTH) return null;
  if (rest.startsWith("/")) rest = rest.slice(1); // path-style; query-style keeps the "?"

  // The ?name=... tail is shared by import/config
  let name = "";
  let queryUrl = "";
  const qIdx = rest.indexOf("?");
  // An unencoded payload with its own scheme: its query is part of the link itself
  // (the subscription token, security and pbk for vless). It must not be cut off: the node would silently
  // be imported without TLS. We take only our name and leave the rest untouched.
  const ownScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rest);
  if (ownScheme && qIdx >= 0) {
    const hashIdx = rest.indexOf("#", qIdx);
    const query = rest.slice(qIdx + 1, hashIdx >= 0 ? hashIdx : undefined);
    const fragment = hashIdx >= 0 ? rest.slice(hashIdx) : "";
    const kept = [];
    for (const part of query.split("&")) {
      if (!part.startsWith("name=")) { kept.push(part); continue; }
      const n = new URLSearchParams(part).get("name");
      if (validDeepLinkName(n)) name = n;
    }
    rest = rest.slice(0, qIdx) + (kept.length ? `?${kept.join("&")}` : "") + fragment;
  } else if (qIdx >= 0) {
    const tail = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
    try {
      const params = new URLSearchParams(tail);
      const n = params.get("name");
      if (validDeepLinkName(n)) name = n;
      const u = params.get("url");
      if (u) queryUrl = u;
    } catch {}
  }
  // ninety://import?url=... — the path is empty, the URL came in the query
  if (!rest && queryUrl) rest = queryUrl;

  // We keep the legacy behavior for add/import with a regular raw payload, but
  // check the result below: control chars and an oversized payload are still
  // rejected.
  if (!ownScheme) {
    try { rest = decodeURIComponent(rest); } catch {}
  }

  if (!rest || rest.length > MAX_DEEPLINK_PAYLOAD_LENGTH || hasControlChars(rest)) {
    return null;
  }

  if (action === "add") {
    // ninety://add/<base64-url> — expand the base64
    const decoded = safeAtobUrl(rest);
    if (decoded) return { url: decoded, name };
  }

  // import / config / add (if the base64 wasn't recognized) — pass the raw URL
  return { url: rest, name };
}
