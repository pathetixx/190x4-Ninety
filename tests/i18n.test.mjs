// Синхронность i18n: все 15 каталогов обязаны иметь ровно те же ключи, что ru
// (источник истины), и те же {плейсхолдеры} в значениях. Ловит забытые переводы
// при добавлении фич и опечатки в {var}.
import { test } from "node:test";
import assert from "node:assert/strict";

const CODES = ["ru", "en", "fa", "zh", "ar", "es", "de", "uk", "ja", "fr", "it", "pt", "ko", "pl", "tr"];

// тот же флэттенер, что в /lib/i18n/index.js
function flatten(obj, prefix = "", out = {}) {
  for (const k in obj) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const catalogs = {};
for (const code of CODES) {
  const mod = await import(`/lib/i18n/${code}.js`);
  catalogs[code] = flatten(mod[code]);
}

const ruKeys = Object.keys(catalogs.ru).sort();

test("ru не пустой", () => {
  assert.ok(ruKeys.length > 500, `подозрительно мало ключей: ${ruKeys.length}`);
});

for (const code of CODES.filter((c) => c !== "ru")) {
  test(`${code}: тот же набор ключей, что ru`, () => {
    const keys = Object.keys(catalogs[code]).sort();
    const missing = ruKeys.filter((k) => !catalogs[code][k] && catalogs[code][k] !== "");
    const extra = keys.filter((k) => !(k in catalogs.ru));
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${code}: missing=${missing.slice(0, 5)} extra=${extra.slice(0, 5)}`
    );
  });

  test(`${code}: плейсхолдеры {var} совпадают с ru`, () => {
    const bad = [];
    for (const k of ruKeys) {
      const ruPh = new Set(String(catalogs.ru[k]).match(/\{[a-zA-Z0-9_]+\}/g) || []);
      const ph = new Set(String(catalogs[code][k] ?? "").match(/\{[a-zA-Z0-9_]+\}/g) || []);
      const same = ruPh.size === ph.size && [...ruPh].every((p) => ph.has(p));
      if (!same) bad.push(`${k}: ru=[${[...ruPh]}] ${code}=[${[...ph]}]`);
    }
    assert.deepEqual(bad, [], bad.slice(0, 5).join("; "));
  });
}
