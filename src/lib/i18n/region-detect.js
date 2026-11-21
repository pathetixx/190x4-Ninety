// Ninety · auto-detecting the routing region by time zone (offline, no network).
// A city/time zone → region table, reduced to our 6:
//   other · ru · cn · ir · tr · by  (see REGIONS in options.js).
// Region = which local traffic goes direct (geosite/geoip), NOT the interface language.
// Not detected → "other" (all traffic through the proxy).

const CITY_REGION = {
  tehran: "ir",
  istanbul: "tr",
  shanghai: "cn", chongqing: "cn", urumqi: "cn", harbin: "cn",
  minsk: "by",
  moscow: "ru", kaliningrad: "ru", samara: "ru", yekaterinburg: "ru", omsk: "ru",
  novosibirsk: "ru", barnaul: "ru", tomsk: "ru", krasnoyarsk: "ru", irkutsk: "ru",
  chita: "ru", yakutsk: "ru", vladivostok: "ru", magadan: "ru", sakhalin: "ru",
  kamchatka: "ru", anadyr: "ru", volgograd: "ru", saratov: "ru", astrakhan: "ru",
};

const LANG_REGION = { fa: "ir", tr: "tr", zh: "cn", ru: "ru", be: "by", uk: "ru" };

export function detectRegion() {
  try {
    const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").toLowerCase();
    const offset = -new Date().getTimezoneOffset(); // minutes, east is positive

    // Iran — UTC+3:30, a unique offset.
    if (offset === 210) return "ir";

    const city = tz.includes("/") ? tz.split("/").pop().replace(/\s+/g, "_") : tz;
    if (CITY_REGION[city]) return CITY_REGION[city];

    if (tz.includes("iran")) return "ir";
    if (tz.includes("turkey") || tz.includes("istanbul")) return "tr";
    if (tz.includes("china") || tz.includes("beijing") || tz.includes("urumqi")) return "cn";
    if (tz.includes("minsk") || tz.includes("belarus")) return "by";
    if (tz.includes("russia") || tz.includes("moscow")) return "ru";

    // Fallback by system language.
    const l2 = (navigator.language || "").slice(0, 2).toLowerCase();
    if (LANG_REGION[l2]) return LANG_REGION[l2];
  } catch (e) {
    console.warn("detectRegion failed", e);
  }
  return "other";
}
