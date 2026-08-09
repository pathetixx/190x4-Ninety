// Ninety · избранные серверы
// Выбор пользователя, а не движка: хранится по источнику (подписке), чтобы
// теги из чужой подписки не всплывали в списке текущей.

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

function scopeKey(source) {
  if (!source) return "none";
  return `${source.kind}:${source.id ?? ""}`;
}

export function getFavourites(source) {
  const list = readAll()[scopeKey(source)];
  return new Set(Array.isArray(list) ? list : []);
}

export function isFavourite(source, tag) {
  return getFavourites(source).has(tag);
}

export function toggleFavourite(source, tag) {
  const map = readAll();
  const key = scopeKey(source);
  const set = new Set(Array.isArray(map[key]) ? map[key] : []);
  if (set.has(tag)) set.delete(tag); else set.add(tag);
  map[key] = [...set];
  writeAll(map);
  return set.has(tag);
}
