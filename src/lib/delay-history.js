// Ninety · latency measurement history
//
// sing-box stores ONE result per tag (`map[string]*adapter.URLTestHistory`)
// and returns it in clash-compatible form as a single-element array. There's no sliding
// list there like in Clash.Meta — so spread and stability can't be computed from core data
// in principle. The app accumulates the history: on every poll we check
// the timestamp of the last measurement and append a new point.

import { selectionSourceKey } from "/lib/proxy-selection.js";
import { STORAGE_KEYS } from "/lib/storage-policy.js";

const KEY = STORAGE_KEYS.delayHistory;
const CAP = 12;                  // how many points the sparkline draws

// getProbeHistory is called for every row of every render, and rendering follows
// the 4 s polling. The expensive part is JSON.parse, so we cache the parse but
// compare the source string: otherwise an external write (clearing data, restoring
// from a backup) would go unnoticed and the module would resurrect erased data.
let _cacheRaw = null;
let _cacheVal = null;
function readAll() {
  let raw;
  try { raw = localStorage.getItem(KEY); } catch { raw = null; }
  if (raw === _cacheRaw && _cacheVal) return _cacheVal;
  let parsed;
  try {
    const o = JSON.parse(raw || "{}");
    parsed = o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch { parsed = {}; }
  _cacheRaw = raw;
  _cacheVal = parsed;
  return parsed;
}
function writeAll(map) {
  dropLegacyBuckets(map);
  let raw = "{}";
  try { raw = JSON.stringify(map); localStorage.setItem(KEY, raw); } catch {}
  _cacheRaw = raw;
  _cacheVal = map;
}


// Builds before the key fix wrote everything into one bucket with an empty id ("sub:").
// These entries belong to nobody and keep server tags on disk — we clean them up
// on the very first write.
function dropLegacyBuckets(map) {
  let changed = false;
  for (const k of Object.keys(map)) {
    if (k === "none" || k.endsWith(":")) { delete map[k]; changed = true; }
  }
  return changed;
}

// A point is written only when the core actually re-measured: the timestamp
// of the last measurement differs from the saved one. Otherwise the 4 s polling
// would multiply the same value and the spread would become falsely zero.
export function recordProbes(source, clashData, tags) {
  const proxies = clashData?.proxies;
  if (!proxies || !Array.isArray(tags) || !tags.length) return false;
  // A source without its own key remembers nothing: the "none" bucket is deleted anyway
  // by dropLegacyBuckets in this same write. The old fallback to "none"
  // produced an idle cycle — filled the bucket, erased it right away, returned changed=true.
  // On every poll (every 4 s) that was a stringify of the whole archive, a write to
  // localStorage and an extra table redraw.
  const key = selectionSourceKey(source);
  if (!key) return false;
  const map = readAll();
  const scope = map[key] && typeof map[key] === "object" ? map[key] : {};
  let changed = false;

  for (const tag of tags) {
    const entry = proxies[tag];
    if (!entry) continue;
    const last = Array.isArray(entry.history) ? entry.history[entry.history.length - 1] : null;
    if (!last) continue;
    const stamp = String(last.time ?? "");
    if (!stamp) continue;
    const cur = scope[tag] && typeof scope[tag] === "object" ? scope[tag] : { at: "", d: [] };
    if (cur.at === stamp) continue;
    const delay = Number(last.delay) || 0;
    const list = Array.isArray(cur.d) ? cur.d.slice(-(CAP - 1)) : [];
    list.push(delay);
    scope[tag] = { at: stamp, d: list };
    changed = true;
  }

  if (!changed) return false;
  map[key] = scope;
  writeAll(map);
  return true;
}

export function getProbeHistory(source, tag) {
  const key = selectionSourceKey(source);
  if (!key) return [];
  const scope = readAll()[key];
  const entry = scope && scope[tag];
  return entry && Array.isArray(entry.d) ? entry.d.slice(-CAP) : [];
}

// A change in the node set (subscription update) turns old tags into garbage.
export function pruneProbeHistory(source, validTags) {
  const key = selectionSourceKey(source);
  if (!key) return;
  const map = readAll();
  const scope = map[key];
  if (!scope) return;
  const keep = new Set(validTags || []);
  let changed = false;
  for (const tag of Object.keys(scope)) {
    if (!keep.has(tag)) { delete scope[tag]; changed = true; }
  }
  if (changed) { map[key] = scope; writeAll(map); }
}

export function clearProbeHistory(source) {
  const key = selectionSourceKey(source);
  const map = readAll();
  // No key — there was nowhere to write, but the legacy buckets of previous builds ("none" and
  // "sub:") are removed by writeAll itself via dropLegacyBuckets.
  if (key) delete map[key];
  writeAll(map);
}
