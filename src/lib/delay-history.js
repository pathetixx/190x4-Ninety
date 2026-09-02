// Ninety · история замеров задержки
//
// sing-box хранит ОДИН результат на тег (`map[string]*adapter.URLTestHistory`)
// и отдаёт его в clash-совместимом виде как массив из одного элемента. Скользящего
// списка, как в Clash.Meta, там нет — значит разброс и стабильность по данным ядра
// не посчитать в принципе. Историю копит приложение: на каждом опросе сверяем
// отметку времени последнего замера и дописываем новую точку.

import { selectionSourceKey } from "/lib/proxy-selection.js";

const KEY = "ninety.delayHistory.v1";
const CAP = 12;                  // столько точек рисует спарклайн

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

// Точка записывается, только когда ядро реально перемерило: отметка времени
// последнего замера отличается от уже сохранённой. Иначе поллинг раз в 4 с
// размножил бы одно и то же значение и разброс стал бы ложно нулевым.
export function recordProbes(source, clashData, tags) {
  const proxies = clashData?.proxies;
  if (!proxies || !Array.isArray(tags) || !tags.length) return false;
  // Источник без собственного ключа ничего не помнит: ведро "none" всё равно
  // удаляет dropLegacyBuckets на этой же записи. Прежний фолбэк на "none"
  // давал холостой цикл — заполнили ведро, тут же стёрли, вернули changed=true.
  // На каждом опросе (раз в 4 с) это stringify всего архива, запись в
  // localStorage и лишняя перерисовка таблицы.
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

// Смена набора нод (обновление подписки) делает старые теги мусором.
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
  // Ключа нет — писать было некуда, но легаси-вёдра прошлых сборок ("none" и
  // "sub:") снимет сам writeAll через dropLegacyBuckets.
  if (key) delete map[key];
  writeAll(map);
}
