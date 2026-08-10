// Ninety · избранные серверы
// Выбор пользователя, а не движка: хранится по источнику (подписке), чтобы
// теги из чужой подписки не всплывали в списке текущей.

import { selectionSourceKey } from "/lib/proxy-selection.js";

const KEY = "ninety.favourites";

// getProbeHistory зовут на каждую строку каждого рендера, а рендер идёт по
// поллингу раз в 4 с. Дорогая часть — JSON.parse, поэтому кэшируем разбор, но
// сверяем исходную строку: иначе внешняя запись (очистка данных, восстановление
// из бэкапа) осталась бы незамеченной и модуль воскрешал бы стёртое.
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



// Сборки до исправления ключа писали всё в одно ведро с пустым id («sub:»).
// Эти записи никому не принадлежат и держат теги серверов на диске — чистим
// при первой же записи.
function dropLegacyBuckets(map) {
  let changed = false;
  for (const k of Object.keys(map)) {
    if (k === "none" || k.endsWith(":")) { delete map[k]; changed = true; }
  }
  return changed;
}

export function getFavourites(source) {
  const list = readAll()[selectionSourceKey(source) || "none"];
  return new Set(Array.isArray(list) ? list : []);
}

export function isFavourite(source, tag) {
  return getFavourites(source).has(tag);
}

export function toggleFavourite(source, tag) {
  const map = readAll();
  const key = selectionSourceKey(source) || "none";
  const set = new Set(Array.isArray(map[key]) ? map[key] : []);
  if (set.has(tag)) set.delete(tag); else set.add(tag);
  map[key] = [...set];
  writeAll(map);
  return set.has(tag);
}
