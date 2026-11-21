// Ninety · i18n — a minimalist runtime without dependencies and without a build step.
// Catalogs are regular ES modules (ru.js/en.js/…). The base (ru) and the fallback (en) are loaded
// statically so that t() is SYNCHRONOUS (it's called inside render() template literals).
// Additional languages (phase 3) are wired via DYNAMIC — a dynamic import without blocking.
//
// API:
//   t(key, vars?)        — translation by a dotted key ("onb.welcome.title"); {var} in the string.
//   setLang(code)        — change the language (async: waits for the catalog), writes dir/lang, calls listeners.
//   getLang()            — the current code.
//   onLangChange(cb)     — subscription to changes (for live view re-rendering).
//   applyDom(root)       — fill in static strings by data-i18n* attributes.
//   availableLangs()     — list of languages whose catalogs are already loaded (for the picker).

import { ru } from "/lib/i18n/ru.js";
import { en } from "/lib/i18n/en.js";

// Metadata of all 15 target languages (name — native, flag — ISO for /assets/flags).
// rtl=true → document.dir="rtl" (phase 2: mirrored layout for Fa/Ar).
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

// Static catalogs — always in memory (base + fallback). Phase 3: the other 13.
const STATIC = { ru, en };
// Dynamic loaders (phase 3): code -> () => import(...).then(m => m.<code>)
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

const _flat = {};   // code -> flat key->string dictionary
let _lang = "en";
const _listeners = new Set();

// nested {a:{b:"x"}} → {"a.b":"x"} (readable catalogs, O(1) lookup in t).
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

// Plural forms by number: "1 подписка", "2 подписки", "5 подписок".
// The forms live under `${key}.${form}` (one/few/many/other) — each language has its own
// set of forms, so we take it from Intl rather than hardcoding the Slavic rule.
const _pluralRules = new Map();
export function tn(key, n, vars) {
  let form;
  try {
    let rules = _pluralRules.get(_lang);
    if (!rules) { rules = new Intl.PluralRules(_lang); _pluralRules.set(_lang, rules); }
    form = rules.select(n);
  } catch { form = "other"; }
  const flat = _flat[_lang] || _flat.en || {};
  const picked = flat[`${key}.${form}`] ?? flat[`${key}.other`] ?? _flat.en?.[`${key}.other`] ?? key;
  let out = picked;
  const all = { n, ...(vars || {}) };
  for (const k in all) out = out.replaceAll(`{${k}}`, all[k]);
  return out;
}

// System locale → an available code (zh-CN→zh, pt-BR→pt). A saved choice takes priority.
function detectLang() {
  const ready = availableLangs().map(l => l.code);
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && ready.includes(saved)) return saved;
  // An existing user (onboarding done → updated via OTA, they will NOT see Welcome and didn't
  // choose a language): we keep the historical RU so the update doesn't change the language suddenly
  // (e.g. a RU user on an English Windows). They'll change the language in Settings.
  if (localStorage.getItem("ninety.onboarding.done") === "1") {
    return ready.includes("ru") ? "ru" : "en";
  }
  // A new user — the system locale (and they'll confirm it on Welcome).
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

// Synchronous initialization at startup: the language is already in memory (STATIC), no await.
export function initI18n() {
  _lang = detectLang();
  if (!localStorage.getItem(LANG_KEY)) localStorage.setItem(LANG_KEY, _lang);
  applyDir(_lang);
  applyDom(document);
  // The saved language may be a dynamic one (not in STATIC) — at the synchronous start
  // its catalog isn't in memory yet, t() returns the en fallback. We load it and re-render
  // through the same onLangChange as on a manual language change (the listeners are
  // already subscribed by the time the promise resolves — bootstrap runs synchronously earlier).
  if (!_flat[_lang]) ensure(_lang).then(ok => {
    if (!ok) return;
    applyDom(document);
    for (const cb of _listeners) { try { cb(_lang); } catch (e) { console.warn(e); } }
  });
  return _lang;
}

// Fills in the static strings of index.html. Supported:
//   data-i18n="key"            → textContent
//   data-i18n-html="key"       → innerHTML (strings with markup)
//   data-i18n-title / -placeholder / -aria-label → the corresponding attribute
export function applyDom(root = document) {
  root.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll("[data-i18n-title]").forEach(el => el.setAttribute("title", t(el.dataset.i18nTitle)));
  root.querySelectorAll("[data-i18n-placeholder]").forEach(el => el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder)));
  root.querySelectorAll("[data-i18n-aria-label]").forEach(el => el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel)));
}
