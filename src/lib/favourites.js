// Ninety · favorite servers
// The user's choice, not the engine's: stored per source (subscription) so that
// tags from another subscription don't pop up in the current one's list.

import { selectionSourceKey } from "/lib/proxy-selection.js";
import { STORAGE_KEYS } from "/lib/storage-policy.js";

const KEY = STORAGE_KEYS.favourites;

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

export function getFavourites(source) {
  const key = selectionSourceKey(source);
  if (!key) return new Set();
  const list = readAll()[key];
  return new Set(Array.isArray(list) ? list : []);
}

export function isFavourite(source, tag) {
  return getFavourites(source).has(tag);
}

export function toggleFavourite(source, tag) {
  // A source without its own key has nothing to remember with: the former "none" bucket was immediately
  // erased by dropLegacyBuckets in this same write — the star "lit up" and disappeared
  // on the next render.
  const key = selectionSourceKey(source);
  if (!key) return false;
  const map = readAll();
  const set = new Set(Array.isArray(map[key]) ? map[key] : []);
  if (set.has(tag)) set.delete(tag); else set.add(tag);
  map[key] = [...set];
  writeAll(map);
  return set.has(tag);
}
