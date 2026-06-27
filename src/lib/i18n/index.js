// Ninety · i18n — минималистичный рантайм без зависимостей и build-step.
// Каталоги — обычные ES-модули (ru.js/en.js/…). База (ru) и фолбэк (en) грузятся
// статически, чтобы t() был СИНХРОННЫМ (его зовут внутри template-литералов render()).
// Доп. языки (фаза 3) подключаются через DYNAMIC — динамическим import без блокировки.
//
// API:
//   t(key, vars?)        — перевод по точечному ключу ("onb.welcome.title"); {var} в строке.
//   setLang(code)        — сменить язык (async: ждёт каталог), пишет dir/lang, дёргает листенеры.
//   getLang()            — текущий код.
//   onLangChange(cb)     — подписка на смену (для живого ре-рендера вью).
//   applyDom(root)       — проставить static-строки по data-i18n* атрибутам.
//   availableLangs()     — список языков, чьи каталоги уже подключены (для пикера).

import { ru } from "/lib/i18n/ru.js";
import { en } from "/lib/i18n/en.js";

// Метаданные всех 15 целевых языков (имя — нативное, flag — ISO для /assets/flags).
// rtl=true → document.dir="rtl" (фаза 2: зеркальная вёрстка под Fa/Ar).
export const LANGS = [
  { code: "ru", name: "Русский",    flag: "ru", rtl: false },
  { code: "en", name: "English",    flag: "gb", rtl: false },
  { code: "fa", name: "فارسی",      flag: "ir", rtl: true  },
  { code: "zh", name: "中文",        flag: "cn", rtl: false },
  { code: "ar", name: "العربية",    flag: "sa", rtl: true  },
  { code: "es", name: "Español",    flag: "es", rtl: false },
  { code: "de", name: "Deutsch",    flag: "de", rtl: false },
  { code: "uk", name: "Українська", flag: "ua", rtl: false },
  { code: "ja", name: "日本語",      flag: "jp", rtl: false },
  { code: "fr", name: "Français",   flag: "fr", rtl: false },
  { code: "it", name: "Italiano",   flag: "it", rtl: false },
  { code: "pt", name: "Português",  flag: "pt", rtl: false },
  { code: "ko", name: "한국어",      flag: "kr", rtl: false },
  { code: "pl", name: "Polski",     flag: "pl", rtl: false },
  { code: "tr", name: "Türkçe",     flag: "tr", rtl: false },
];

const LANG_KEY = "ninety.lang";

// Статические каталоги — всегда в памяти (база + фолбэк). Фаза 3: остальные 13.
const STATIC = { ru, en };
// Динамические загрузчики (фаза 3): code -> () => import(...).then(m => m.<code>)
const DYNAMIC = {
  fa: () => import("/lib/i18n/fa.js").then(m => m.fa),
  ar: () => import("/lib/i18n/ar.js").then(m => m.ar),
  uk: () => import("/lib/i18n/uk.js").then(m => m.uk),
  zh: () => import("/lib/i18n/zh.js").then(m => m.zh),
  es: () => import("/lib/i18n/es.js").then(m => m.es),
  de: () => import("/lib/i18n/de.js").then(m => m.de),
  ja: () => import("/lib/i18n/ja.js").then(m => m.ja),
  fr: () => import("/lib/i18n/fr.js").then(m => m.fr),
  it: () => import("/lib/i18n/it.js").then(m => m.it),
  pt: () => import("/lib/i18n/pt.js").then(m => m.pt),
  ko: () => import("/lib/i18n/ko.js").then(m => m.ko),
  pl: () => import("/lib/i18n/pl.js").then(m => m.pl),
  tr: () => import("/lib/i18n/tr.js").then(m => m.tr),
};

const _flat = {};   // code -> плоский словарь key->string
let _lang = "en";
const _listeners = new Set();

// nested {a:{b:"x"}} → {"a.b":"x"} (читаемые каталоги, O(1) lookup в t).
function flatten(obj, prefix = "", out = {}) {
  for (const k in obj) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

for (const code in STATIC) _flat[code] = flatten(STATIC[code]);

async function ensure(code) {
  if (_flat[code]) return true;
  const loader = DYNAMIC[code];
  if (!loader) return false;
  try {
    _flat[code] = flatten(await loader());
    return true;
  } catch (e) {
    console.warn(`i18n: каталог ${code} не загрузился`, e);
    return false;
  }
}

export function availableLangs() {
  const ready = new Set([...Object.keys(STATIC), ...Object.keys(DYNAMIC)]);
  return LANGS.filter(l => ready.has(l.code));
}

export function langMeta(code) {
  return LANGS.find(l => l.code === code) || null;
}

export function isRtl(code = _lang) {
  return !!langMeta(code)?.rtl;
}

export function t(key, vars) {
  let s = _flat[_lang]?.[key] ?? _flat.en?.[key] ?? key;
  if (vars) for (const k in vars) s = s.replaceAll(`{${k}}`, vars[k]);
  return s;
}

export function getLang() {
  return _lang;
}

// Системная локаль → доступный код (zh-CN→zh, pt-BR→pt). Сохранённый выбор приоритетнее.
function detectLang() {
  const ready = availableLangs().map(l => l.code);
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && ready.includes(saved)) return saved;
  // Существующий юзер (онбординг пройден → апдейт по OTA, Welcome он НЕ увидит и язык
  // не выбирал): оставляем исторический RU, чтобы апдейт не сменил язык внезапно
  // (напр. RU-юзер на англоязычной Windows). Язык он сменит в Настройках.
  if (localStorage.getItem("ninety.onboarding.done") === "1") {
    return ready.includes("ru") ? "ru" : "en";
  }
  // Новый юзер — системная локаль (и сам подтвердит на Welcome).
  const sys = (navigator.language || "en").slice(0, 2).toLowerCase();
  if (ready.includes(sys)) return sys;
  return ready.includes("en") ? "en" : (ready[0] || "en");
}

function applyDir(code) {
  document.documentElement.lang = code;
  document.documentElement.dir = isRtl(code) ? "rtl" : "ltr";
}

export async function setLang(code) {
  if (!(await ensure(code))) return;
  _lang = code;
  localStorage.setItem(LANG_KEY, code);
  applyDir(code);
  for (const cb of _listeners) { try { cb(code); } catch (e) { console.warn(e); } }
}

export function onLangChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

// Синхронная инициализация на старте: язык уже в памяти (STATIC), без await.
export function initI18n() {
  _lang = detectLang();
  if (!localStorage.getItem(LANG_KEY)) localStorage.setItem(LANG_KEY, _lang);
  applyDir(_lang);
  applyDom(document);
  return _lang;
}

// Проставляет static-строки index.html. Поддержка:
//   data-i18n="key"            → textContent
//   data-i18n-html="key"       → innerHTML (строки с разметкой)
//   data-i18n-title / -placeholder / -aria-label → соответствующий атрибут
export function applyDom(root = document) {
  root.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll("[data-i18n-title]").forEach(el => el.setAttribute("title", t(el.dataset.i18nTitle)));
  root.querySelectorAll("[data-i18n-placeholder]").forEach(el => el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder)));
  root.querySelectorAll("[data-i18n-aria-label]").forEach(el => el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel)));
}
