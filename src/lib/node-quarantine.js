// Ninety · quarantine for nodes the core rejected at startup.
//
// Static checks (`node-validation.js`) know everything the core has rejected so
// far, but a panel may send a parameter we haven't seen yet — and
// one such node will again bring down the initialization of the whole config. Then the cause
// is named by the core itself: "initialize outbound[N]: …". We find the node by index
// precisely, remember it here and don't let it into the config anymore: the next connection
// attempt goes without it instead of running into the same refusal.
//
// The key is the node's semantic fingerprint: it survives renaming, a subscription
// update and the order in the list. If the panel fixes the server, the fingerprint
// changes and the quarantine doesn't apply to it.

import { nodeSemanticFingerprint } from "/lib/runtime-identity.js";
import { STORAGE_KEYS } from "/lib/storage-policy.js";

const KEY = STORAGE_KEYS.nodeQuarantine;
const CAP = 300;

// The parse is kept with the source string: the node list is checked one by one, i.e.
// on a subscription of hundreds of servers readAll is called hundreds of times in one pass, and
// the same JSON was parsed just as many times. Comparing with the string keeps
// an external write (restoring from a backup, clearing data) noticed.
let rawCache = null;
let valCache = null;

function readAll() {
  let raw;
  try { raw = localStorage.getItem(KEY); } catch { raw = null; }
  if (raw === rawCache && valCache) return valCache;
  let parsed;
  try {
    const o = JSON.parse(raw || "{}");
    parsed = o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    parsed = {};
  }
  rawCache = raw;
  valCache = parsed;
  return parsed;
}

function writeAll(map) {
  try {
    const keys = Object.keys(map);
    if (keys.length > CAP) {
      // Keep the fresh ones: old refusals are no longer interesting, and the storage
      // must not grow without bounds.
      const trimmed = keys
        .sort((a, b) => (map[b]?.at || 0) - (map[a]?.at || 0))
        .slice(0, CAP);
      map = Object.fromEntries(trimmed.map(k => [k, map[k]]));
    }
    const raw = JSON.stringify(map);
    localStorage.setItem(KEY, raw);
    rawCache = raw;
    valCache = map;
  } catch { /* private mode/overflow — the quarantine isn't critical */ }
}

export function quarantineNode(node, reason = "") {
  if (!node) return null;
  const key = nodeSemanticFingerprint(node);
  const map = readAll();
  map[key] = { reason: String(reason || "").slice(0, 200), at: Date.now() };
  writeAll(map);
  return key;
}

export function isNodeQuarantined(node) {
  if (!node) return false;
  return Object.hasOwn(readAll(), nodeSemanticFingerprint(node));
}

export function quarantineReason(node) {
  if (!node) return "";
  return readAll()[nodeSemanticFingerprint(node)]?.reason || "";
}

export function clearNodeQuarantine() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clean up */ }
}

/**
 * Parses the core's "initialize outbound[N]: reason" refusal and finds the node by
 * the outbound index. The index is computed by the core itself, so the index map is provided by
 * the config builder — repeating the arithmetic over selector/balancer positions
 * isn't allowed, it would diverge on the very first change in the outbound set.
 *
 * The core initializes WireGuard nodes as a separate list and calls them
 * "initialize endpoint[N]" (box.go), so they have their own index map.
 * @returns {{node: object, reason: string, index: number, kind: string} | null}
 */
export function matchCoreOutboundRejection(errorText, outboundNodes, endpointNodes = null) {
  const text = String(errorText || "");
  for (const [kind, nodes] of [["outbound", outboundNodes], ["endpoint", endpointNodes]]) {
    if (!Array.isArray(nodes)) continue;
    const match = text.match(new RegExp(`initialize ${kind}\\[(\\d+)\\]:\\s*([^\\n\\r]*)`));
    if (!match) continue;
    const index = Number(match[1]);
    const node = nodes[index];
    if (!node) continue;
    return { node, reason: match[2].trim(), index, kind };
  }
  return null;
}
