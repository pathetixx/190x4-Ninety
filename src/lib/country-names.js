// Ninety · название страны словом. Intl.DisplayNames локализован под язык
// интерфейса, поэтому таблицу из двух сотен стран заводить не нужно; кэш
// сбрасывается сам, когда меняется язык.

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
