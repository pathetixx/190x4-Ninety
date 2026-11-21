// Ninety · country name as a word. Intl.DisplayNames is localized to the interface
// language, so there's no need to maintain a table of two hundred countries; the cache
// resets itself when the language changes.

import { getLang } from "/lib/i18n/index.js";

let regionNames = null;
let cachedLang = null;

export function countryName(iso) {
  if (!iso) return "";
  const code = String(iso).toUpperCase();
  try {
    const lang = getLang();
    if (!regionNames || cachedLang !== lang) {
      regionNames = new Intl.DisplayNames([lang], { type: "region" });
      cachedLang = lang;
    }
    return regionNames.of(code) || code;
  } catch { return code; }
}

export function resetCountryNames() {
  regionNames = null;
  cachedLang = null;
}
