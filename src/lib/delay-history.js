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
// поллингу раз в 4 с. Парсить весь JSON столько раз незачем — держим разбор
// в памяти и сбрасываем его только на запись.
let _cache = null;
function readAll() {
  if (_cache) return _cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    _cache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { _cache = {}; }
  return _cache;
}
function writeAll(map) {
  _cache = map;
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {}
}


// Точка записывается, только когда ядро реально перемерило: отметка времени
// последнего замера отличается от уже сохранённой. Иначе поллинг раз в 4 с
// размножил бы одно и то же значение и разброс стал бы ложно нулевым.
export function recordProbes(source, clashData, tags) {
  const proxies = clashData?.proxies;
  if (!proxies || !Array.isArray(tags) || !tags.length) return false;
  const map = readAll();
  const key = selectionSourceKey(source) || "none";
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
  const scope = readAll()[selectionSourceKey(source) || "none"];
  const entry = scope && scope[tag];
  return entry && Array.isArray(entry.d) ? entry.d.slice(-CAP) : [];
}

// Смена набора нод (обновление подписки) делает старые теги мусором.
export function pruneProbeHistory(source, validTags) {
  const map = readAll();
  const key = selectionSourceKey(source) || "none";
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
  const map = readAll();
  delete map[selectionSourceKey(source) || "none"];
  writeAll(map);
}
