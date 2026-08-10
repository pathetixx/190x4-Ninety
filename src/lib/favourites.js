// Ninety · избранные серверы
// Выбор пользователя, а не движка: хранится по источнику (подписке), чтобы
// теги из чужой подписки не всплывали в списке текущей.

import { selectionSourceKey } from "/lib/proxy-selection.js";

const KEY = "ninety.favourites";

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function writeAll(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {}
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
