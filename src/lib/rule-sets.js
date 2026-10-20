// Ninety · готовые списки для правил маршрутизации и базы региона.
//
// Значение правила «Готовый список» — ссылка вида "geosite:youtube" (сайты
// сервиса или категории) или "geoip:ru" (адреса страны). Файлы берутся из
// первоисточников SagerNet; имя, которого нет в каталоге, ядро скачать не
// сможет, поэтому в правило попадают только имена из rule-set-catalog.js.

import { GEOIP_CODES, GEOSITE_NAMES } from "/lib/rule-set-catalog.js";

export const GEOSITE_BASE = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set";
export const GEOIP_BASE = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set";

export const SET_KINDS = ["geosite", "geoip"];

// Страновой geosite существует не для каждого региона — только эти три.
// Для остальных база региона опирается на geoip. Раньше сюда подставлялось
// зеркало, где для tr лежал файл с доменами госсайтов РФ, а для by не лежало
// ничего — правило молча не работало.
export const REGION_GEOSITE = {
  ru: "category-ru",
  cn: "cn",
  ir: "category-ir",
};

const GEOSITE = new Set(GEOSITE_NAMES);
const GEOIP = new Set(GEOIP_CODES);

// Первое, что видно в выборе списка, пока поиск пуст. Остальное — поиском.
export const POPULAR_GEOSITE = [
  "youtube", "google", "telegram", "discord", "openai", "anthropic", "category-ai-!cn",
  "netflix", "spotify", "twitch", "instagram", "facebook", "x", "tiktok", "whatsapp",
  "github", "microsoft", "apple", "steam", "yandex", "vk",
  "category-ru", "category-gov-ru", "cn", "category-ads-all",
];
export const POPULAR_GEOIP = ["ru", "by", "kz", "ua", "cn", "ir", "tr", "us", "de", "nl", "fi"];

// "geosite:YouTube" / " geoip:RU " → { kind, name } в каноническом виде, либо null.
export function parseSetRef(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const sep = raw.indexOf(":");
  if (sep < 0) return null;
  const kind = raw.slice(0, sep).trim();
  const name = raw.slice(sep + 1).trim();
  if (!SET_KINDS.includes(kind) || !name) return null;
  return { kind, name };
}

export function isKnownSet(ref) {
  if (!ref) return false;
  return ref.kind === "geosite" ? GEOSITE.has(ref.name) : GEOIP.has(ref.name);
}

export function formatSetRef(ref) {
  return `${ref.kind}:${ref.name}`;
}

export function normalizeSetRef(value) {
  const ref = parseSetRef(value);
  return ref && isKnownSet(ref) ? formatSetRef(ref) : "";
}

export function setUrl(ref) {
  return ref.kind === "geosite"
    ? `${GEOSITE_BASE}/geosite-${ref.name}.srs`
    : `${GEOIP_BASE}/geoip-${ref.name}.srs`;
}

// Поиск по каталогу для выбора списка: сначала совпадения с начала имени,
// потом остальные. Пустой запрос — популярные.
export function searchSets(kind, query, limit = 60) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return kind === "geosite" ? POPULAR_GEOSITE.slice() : POPULAR_GEOIP.slice();
  const names = kind === "geosite" ? GEOSITE_NAMES : GEOIP_CODES;
  const head = [];
  const rest = [];
  for (const name of names) {
    if (name.startsWith(q)) head.push(name);
    else if (name.includes(q)) rest.push(name);
    if (head.length >= limit) break;
  }
  return [...head, ...rest].slice(0, limit);
}
