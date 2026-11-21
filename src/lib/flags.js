// Ninety · flags — a single source: node name → ISO-3166-1 alpha-2 (lowercase).
// Previously the logic was duplicated in proxies-view.js and main.js; the main copy fell behind
// (no COUNTRY_NAME) → hysteria/naive flags didn't appear on the home screen and in the tray.
// Now both sides import from here.
//
// Name parsing order:
// 1) A regional-indicator pair in the name (🇫🇮, 🇩🇪) → converted to "fi", "de".
// 2) A full country name as a word ("Poland", "Финляндия") → ISO.
// 3) Otherwise we look for an explicit 2-letter token at a word boundary ("FI", "DE-Mobile").
// 4) Mapping of common non-ISO abbreviations in subscriptions (UK→gb, EN→gb, etc.).

export const FLAGS_BASE = "/assets/flags";

export const NON_ISO_ALIAS = { uk: "gb", en: "gb", uae: "ae", usa: "us", rus: "ru" };

// Full country names (English + Russian) → ISO. For nodes without an emoji/code in the name
// (hysteria/naive from EOFVPN: "Poland", "Germany", "Netherlands"…).
export const COUNTRY_NAME = {
  poland: "pl", польша: "pl",
  germany: "de", deutschland: "de", германия: "de",
  finland: "fi", финляндия: "fi",
  czechia: "cz", "czech republic": "cz", czech: "cz", чехия: "cz",
  netherlands: "nl", holland: "nl", нидерланды: "nl", голландия: "nl",
  "united states": "us", "united states of america": "us", america: "us", сша: "us", америка: "us",
  "united kingdom": "gb", britain: "gb", england: "gb", британия: "gb", англия: "gb",
  france: "fr", франция: "fr",
  italy: "it", италия: "it",
  spain: "es", испания: "es",
  sweden: "se", швеция: "se",
  norway: "no", норвегия: "no",
  denmark: "dk", дания: "dk",
  switzerland: "ch", швейцария: "ch",
  austria: "at", австрия: "at",
  belgium: "be", бельгия: "be",
  ireland: "ie", ирландия: "ie",
  portugal: "pt", португалия: "pt",
  ukraine: "ua", украина: "ua",
  russia: "ru", россия: "ru",
  turkey: "tr", türkiye: "tr", турция: "tr",
  japan: "jp", япония: "jp",
  singapore: "sg", сингапур: "sg",
  "hong kong": "hk", hongkong: "hk", гонконг: "hk",
  taiwan: "tw", тайвань: "tw",
  korea: "kr", "south korea": "kr", корея: "kr",
  china: "cn", китай: "cn",
  india: "in", индия: "in",
  canada: "ca", канада: "ca",
  australia: "au", австралия: "au",
  brazil: "br", бразилия: "br",
  estonia: "ee", эстония: "ee",
  latvia: "lv", латвия: "lv",
  lithuania: "lt", литва: "lt",
  hungary: "hu", венгрия: "hu",
  romania: "ro", румыния: "ro",
  bulgaria: "bg", болгария: "bg",
  greece: "gr", греция: "gr",
  serbia: "rs", сербия: "rs",
  moldova: "md", молдова: "md",
  kazakhstan: "kz", казахстан: "kz",
  "united arab emirates": "ae", emirates: "ae", dubai: "ae", оаэ: "ae",
  israel: "il", израиль: "il",
  iceland: "is", исландия: "is",
  luxembourg: "lu", люксембург: "lu",
  argentina: "ar", аргентина: "ar",
  mexico: "mx", мексика: "mx",
  "south africa": "za",
  indonesia: "id", индонезия: "id",
  vietnam: "vn", вьетнам: "vn",
  thailand: "th", таиланд: "th",
  malaysia: "my", малайзия: "my",
  philippines: "ph", филиппины: "ph",
};
// Keys sorted by length (descending) — multi-word ones ("united states")
// match before their parts.
const COUNTRY_NAME_KEYS = Object.keys(COUNTRY_NAME).sort((a, b) => b.length - a.length);
// Escape for regex; search at a word boundary so that "romania" doesn't yield "oman".
const COUNTRY_NAME_RE = new RegExp(
  "(?:^|[^\\p{L}])(" + COUNTRY_NAME_KEYS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![\\p{L}])",
  "iu"
);

export function flagIsoFromName(name) {
  if (!name) return null;
  const codepoints = Array.from(name);
  for (let i = 0; i < codepoints.length - 1; i++) {
    const a = codepoints[i].codePointAt(0);
    const b = codepoints[i + 1].codePointAt(0);
    if (a >= 0x1F1E6 && a <= 0x1F1FF && b >= 0x1F1E6 && b <= 0x1F1FF) {
      return String.fromCharCode(97 + (a - 0x1F1E6)) + String.fromCharCode(97 + (b - 0x1F1E6));
    }
  }
  // Full country name as a word (English/Russian) → ISO
  const cm = name.match(COUNTRY_NAME_RE);
  if (cm) return COUNTRY_NAME[cm[1].toLowerCase()];
  // Fallback: a 2-3 letter token at the start or after a non-digit boundary.
  // ONLY uppercase ("DE-1", "US East", "UK"): country codes in node names
  // are written in caps, while ordinary words ("My", "Do", "Is") aren't. Without this gate
  // "My Server" caught Malaysia's flag, "Do X" Dominica's (a false flag is worse than
  // a text fallback). Full names/emoji are handled by the branches above.
  const m = String(name).match(/(?:^|[\s|·,])([A-Za-z]{2,3})\b/);
  if (m && m[1] === m[1].toUpperCase()) {
    const tok = m[1].toLowerCase();
    if (NON_ISO_ALIAS[tok]) return NON_ISO_ALIAS[tok];
    if (tok.length === 2) return tok;
  }
  return null;
}

export function stripFlag(name) {
  return String(name || "").replace(/(?:\p{Regional_Indicator}){2}\s*/u, "").trim();
}
