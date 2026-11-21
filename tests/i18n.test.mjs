// i18n sync: all 15 catalogs must have exactly the same keys as ru
// (the source of truth), and the same {placeholders} in values. Catches forgotten translations
// when adding features and typos in {var}.
//
// The exception is plural groups read by tn() via Intl.PluralRules:
// the set of forms there is dictated by CLDR, not by the Russian catalog. Japanese has no "few",
// Arabic has "zero" and "two", which ru doesn't have — requiring them to copy
// the Russian forms would clutter the catalogs with dead keys. So for such
// groups we check the set of forms against Intl for that language.
import { test } from "node:test";
import assert from "node:assert/strict";

const CODES = ["ru", "en", "fa", "zh", "ar", "es", "de", "uk", "ja", "fr", "it", "pt", "ko", "pl", "tr"];

const PLURAL_FORMS = new Set(["zero", "one", "two", "few", "many", "other"]);

// Plural groups in ru: an object all of whose keys are CLDR forms. The presence of
// "other" distinguishes groups under tn()/Intl from the old rr.plural* — those live on
// a homemade pluralizer with a hard one/few/many and keep parity with ru.
function cldrGroups(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== "object") continue;
    const forms = Object.keys(v);
    if (forms.length && forms.every((f) => PLURAL_FORMS.has(f))) {
      if ("other" in v) out.add(prefix ? `${prefix}.${k}` : k);
    } else {
      cldrGroups(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

// the same flattener as in /lib/i18n/index.js
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
const raw = {};
for (const code of CODES) {
  const mod = await import(`/lib/i18n/${code}.js`);
  raw[code] = mod[code];
  catalogs[code] = flatten(mod[code]);
}

const groups = cldrGroups(raw.ru);
const isPluralForm = (key) => {
  const i = key.lastIndexOf(".");
  return i > 0 && PLURAL_FORMS.has(key.slice(i + 1)) && groups.has(key.slice(0, i));
};

// Whether a form covers exactly one number. The 0..200 range covers all CLDR rules:
// they cycle over the last two digits, so a wider search would give nothing
// new.
function singularOnly(code, form) {
  const rules = new Intl.PluralRules(code);
  let count = 0;
  for (let n = 0; n <= 200; n++) if (rules.select(n) === form && ++count > 1) return false;
  return count === 1;
}

const ruKeys = Object.keys(catalogs.ru).sort();
// Keys under strict parity: everything except individual plural forms.
const ruPlainKeys = ruKeys.filter((k) => !isPluralForm(k));

test("ru не пустой", () => {
  assert.ok(ruKeys.length > 500, `подозрительно мало ключей: ${ruKeys.length}`);
});

for (const code of CODES.filter((c) => c !== "ru")) {
  test(`${code}: тот же набор ключей, что ru`, () => {
    const keys = Object.keys(catalogs[code]).filter((k) => !isPluralForm(k)).sort();
    const missing = ruPlainKeys.filter((k) => !catalogs[code][k] && catalogs[code][k] !== "");
    const extra = keys.filter((k) => !(k in catalogs.ru));
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `${code}: missing=${missing.slice(0, 5)} extra=${extra.slice(0, 5)}`
    );
  });

  test(`${code}: формы склонения по CLDR для языка`, () => {
    const want = new Set(new Intl.PluralRules(code).resolvedOptions().pluralCategories);
    const bad = [];
    for (const g of groups) {
      const node = g.split(".").reduce((a, k) => a?.[k], raw[code]);
      if (!node) { bad.push(`${g}: группы нет`); continue; }
      const have = new Set(Object.keys(node));
      const missing = [...want].filter((f) => !have.has(f));
      const extra = [...have].filter((f) => !want.has(f));
      if (missing.length || extra.length) bad.push(`${g}: нет=[${missing}] лишние=[${extra}]`);
    }
    assert.deepEqual(bad, [], bad.slice(0, 5).join("; "));
  });

  test(`${code}: плейсхолдеры {var} совпадают с ru`, () => {
    const bad = [];
    for (const k of ruKeys) {
      // For plural forms there's one reference — ru "other": the forms themselves differ between languages.
      const ruKey = isPluralForm(k) ? `${k.slice(0, k.lastIndexOf("."))}.other` : k;
      const ruPh = new Set(String(catalogs.ru[ruKey]).match(/\{[a-zA-Z0-9_]+\}/g) || []);
      const value = catalogs[code][k];
      if (value === undefined && isPluralForm(k)) continue;   // the form doesn't exist in this language — legitimate
      const ph = new Set(String(value ?? "").match(/\{[a-zA-Z0-9_]+\}/g) || []);
      // A form covering exactly one number (ar one=1, two=2, zero=0) may
      // name it with a word instead of {n} — "قياسان" instead of "2 قياس". Where a form
      // covers many numbers (ru one is 1, 21, 31…), {n} is mandatory.
      const expected = isPluralForm(k) && singularOnly(code, k.slice(k.lastIndexOf(".") + 1))
        ? new Set([...ruPh].filter((p) => p !== "{n}"))
        : ruPh;
      const same = [...expected].every((p) => ph.has(p)) && [...ph].every((p) => ruPh.has(p));
      if (!same) bad.push(`${k}: ru=[${[...ruPh]}] ${code}=[${[...ph]}]`);
    }
    assert.deepEqual(bad, [], bad.slice(0, 5).join("; "));
  });
}

// Windows puts the tray tooltip into NOTIFYICONDATAW.szTip — 128 UTF-16 units
// including the terminating null — and silently cuts everything beyond. It was
// the second line, with the version number, that got cut: before tray-icon 0.24.2 the limit was 64, and at it
// ru/uk/es/it/pt/pl in "System proxy" mode lost part of the number.
// We count in .length (UTF-16), not in code points: these units go into szTip.
for (const code of CODES) {
  test(`${code}: подсказка трея влезает в szTip`, () => {
    const t = catalogs[code];
    const version = "99.99.999";                     // with headroom for the number to grow
    const states = [
      t["tray.tipOff"],
      ...["mode.proxy", "mode.systemProxy", "mode.tun"]
        .map((m) => t["tray.tipConnected"].replace("{mode}", t[m])),
    ];
    const tooLong = states
      .map((state) => `${state}\n${t["tray.tipUpdate"].replace("{ver}", version)}`)
      .filter((tip) => tip.length > 127)
      .map((tip) => `${tip.length}: ${tip.replaceAll("\n", " / ")}`);
    assert.deepEqual(tooLong, [], tooLong.join("; "));
  });
}

// A key may be present in all catalogs and still be untranslated:
// the checks above see the set of keys, forms and placeholders, but not that the value
// was copied verbatim from en. This way whole sections ("Discord cache", "UDP spoofing",
// subscription privacy, data clearing, the confirmation dialog) stayed
// English for months in all 13 languages — including destructive confirmations.
//
// ALLOWED — what must match: product and protocol names, units,
// addresses, strings made only of placeholders.
const ALLOWED_SAME_AS_EN = new Set([
  "mode.tun",
  "dpi.modeTxt.tun",
  "dpi.game.tcpudp",
  "dpi.fakes.discord",
  "add.detTomlK",
  "proxies.metaLine",
  "settings.dns.remoteTitle",
  "settings.dns.directTitle",
  "settings.dns.customPlaceholder",
  // Legitimately matching in individual languages: loanwords and units.
  // it: «Driver … (standard)», «LOG · SING-BOX»; fr: «strict»; de: «Traffic · live».
  "dpi.monkey.toastOff",
  "logs.kickerInit",
  "proxies.pinAuto",
  "settings.enums.qualityGood.3000000",
  "settings.warp.scanRowHint",
  "traffic.label",
  // de/pl: "Region · {name}" — the word "Region" is the same in both languages.
  "rr.base.region",
]);

const wordCount = (value) => String(value).trim().split(/\s+/).filter(Boolean).length;

for (const code of CODES.filter((c) => c !== "en" && c !== "ru")) {
  test(`${code}: значения не скопированы из en`, () => {
    const untranslated = Object.keys(catalogs.en).filter((key) => {
      if (ALLOWED_SAME_AS_EN.has(key) || isPluralForm(key)) return false;
      const english = catalogs.en[key];
      if (typeof english !== "string" || catalogs[code][key] !== english) return false;
      // One- or two-word labels legitimately match more often (terms, "OK", "PTB").
      return english.length > 12 && wordCount(english) >= 3;
    });
    assert.deepEqual(untranslated, [], `${code}: ${untranslated.slice(0, 5).join(", ")}`);
  });
}
