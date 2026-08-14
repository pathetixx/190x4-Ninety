// Синхронность i18n: все 15 каталогов обязаны иметь ровно те же ключи, что ru
// (источник истины), и те же {плейсхолдеры} в значениях. Ловит забытые переводы
// при добавлении фич и опечатки в {var}.
//
// Исключение — группы склонений, которые читает tn() через Intl.PluralRules:
// набор форм там диктует CLDR, а не русский каталог. У японского нет "few",
// у арабского есть "zero" и "two", которых нет в ru, — требовать от них копию
// русских форм значило бы засорять каталоги мёртвыми ключами. Поэтому для таких
// групп сверяем набор форм с Intl для этого языка.
import { test } from "node:test";
import assert from "node:assert/strict";

const CODES = ["ru", "en", "fa", "zh", "ar", "es", "de", "uk", "ja", "fr", "it", "pt", "ko", "pl", "tr"];

const PLURAL_FORMS = new Set(["zero", "one", "two", "few", "many", "other"]);

// Группы склонений в ru: объект, все ключи которого — формы CLDR. Наличие
// "other" отличает группы под tn()/Intl от старых rr.plural* — те живут на
// самодельном плюрализаторе с жёстким one/few/many и паритет с ru сохраняют.
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

// Покрывает ли форма ровно одно число. Диапазон 0..200 берёт все правила CLDR:
// они цикличны по последним двум разрядам, так что более широкий поиск ничего
// нового не даст.
function singularOnly(code, form) {
  const rules = new Intl.PluralRules(code);
  let count = 0;
  for (let n = 0; n <= 200; n++) if (rules.select(n) === form && ++count > 1) return false;
  return count === 1;
}

const ruKeys = Object.keys(catalogs.ru).sort();
// Ключи под строгий паритет: всё, кроме отдельных форм склонения.
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
      // Для форм склонения эталон один — ru "other": сами формы у языков разные.
      const ruKey = isPluralForm(k) ? `${k.slice(0, k.lastIndexOf("."))}.other` : k;
      const ruPh = new Set(String(catalogs.ru[ruKey]).match(/\{[a-zA-Z0-9_]+\}/g) || []);
      const value = catalogs[code][k];
      if (value === undefined && isPluralForm(k)) continue;   // формы нет в этом языке — законно
      const ph = new Set(String(value ?? "").match(/\{[a-zA-Z0-9_]+\}/g) || []);
      // Форма, покрывающая ровно одно число (ar one=1, two=2, zero=0), вправе
      // назвать его словом вместо {n} — «قياسان» вместо «2 قياس». Там, где форма
      // покрывает много чисел (ru one — это 1, 21, 31…), {n} обязателен.
      const expected = isPluralForm(k) && singularOnly(code, k.slice(k.lastIndexOf(".") + 1))
        ? new Set([...ruPh].filter((p) => p !== "{n}"))
        : ruPh;
      const same = [...expected].every((p) => ph.has(p)) && [...ph].every((p) => ruPh.has(p));
      if (!same) bad.push(`${k}: ru=[${[...ruPh]}] ${code}=[${[...ph]}]`);
    }
    assert.deepEqual(bad, [], bad.slice(0, 5).join("; "));
  });
}

// Windows кладёт подсказку трея в NOTIFYICONDATAW.szTip — 128 UTF-16 единиц
// вместе с завершающим нулём — и всё лишнее молча срезает. Резалась именно
// вторая строка, с номером версии: до tray-icon 0.24.2 предел был 64, и на нём
// ru/uk/es/it/pt/pl в режиме «Системный прокси» теряли часть номера.
// Считаем в .length (UTF-16), а не в кодовых точках: в szTip уходят эти единицы.
for (const code of CODES) {
  test(`${code}: подсказка трея влезает в szTip`, () => {
    const t = catalogs[code];
    const version = "99.99.999";                     // с запасом на рост номера
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

// Ключ может присутствовать во всех каталогах и всё равно быть непереведённым:
// проверки выше видят набор ключей, формы и плейсхолдеры, но не то, что значение
// дословно скопировано из en. Так целые разделы («Кэш Discord», «Подмена UDP»,
// приватность подписок, очистка данных, диалог подтверждения) месяцами
// оставались английскими у всех 13 языков — включая деструктивные подтверждения.
//
// ALLOWED — то, что совпадать обязано: названия продуктов и протоколов, единицы,
// адреса, строки из одних плейсхолдеров.
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
  // Совпадают законно в отдельных языках: заимствованные слова и единицы.
  // it: «Driver … (standard)», «LOG · SING-BOX»; fr: «strict»; de: «Traffic · live».
  "dpi.monkey.toastOff",
  "logs.kickerInit",
  "proxies.pinAuto",
  "settings.enums.qualityGood.3000000",
  "settings.warp.scanRowHint",
  "traffic.label",
]);

const wordCount = (value) => String(value).trim().split(/\s+/).filter(Boolean).length;

for (const code of CODES.filter((c) => c !== "en" && c !== "ru")) {
  test(`${code}: значения не скопированы из en`, () => {
    const untranslated = Object.keys(catalogs.en).filter((key) => {
      if (ALLOWED_SAME_AS_EN.has(key) || isPluralForm(key)) return false;
      const english = catalogs.en[key];
      if (typeof english !== "string" || catalogs[code][key] !== english) return false;
      // Одно-двухсловные подписи совпадают законно чаще (термины, «OK», «PTB»).
      return english.length > 12 && wordCount(english) >= 3;
    });
    assert.deepEqual(untranslated, [], `${code}: ${untranslated.slice(0, 5).join(", ")}`);
  });
}
