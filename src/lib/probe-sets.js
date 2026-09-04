// Ninety · наборы целей для матрицы доступности («Диагностика»).
//
// Набор собирается из трёх слоёв:
//   global — одинаков для всех: мессенджеры, видео, игры, ИИ, инфраструктура;
//   region — пакет страны, где человек живёт: банки и госсервисы, которые
//            обычно НЕ пускают зарубежный адрес, то есть ломаются как раз от
//            включённого туннеля;
//   pinned — то, что пользователь закрепил сам после ручной проверки.
//
// Региональный пакет — не «российская специфика», а обязательная часть
// диагностики в любой стране: локальный банк отказывает туннельному адресу
// одинаково и в Москве, и в Берлине. Список стран здесь ШИРЕ, чем в настройке
// «Регион» (та правит маршрутизацию и ограничена наборами geosite/geoip ядра),
// поэтому пакет выбирается своим ключом diagnose.regionPack.
//
// Требования к адресу цели: отвечает быстро, не требует авторизации, стабилен
// годами. Идеал — endpoint вида /generate_204 или /cdn-cgi/trace: там ответ
// маленький и однозначный.

// Ядро: то, что спрашивают в любой стране.
export const GLOBAL_TARGETS = [
  { id: "cloudflare", name: "Cloudflare", url: "https://cloudflare.com/cdn-cgi/trace" },
  { id: "google", name: "Google", url: "https://www.gstatic.com/generate_204" },
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com/generate_204" },
  { id: "telegram", name: "Telegram", url: "https://core.telegram.org/" },
  { id: "discord", name: "Discord", url: "https://discord.com/api/v9/gateway" },
  { id: "whatsapp", name: "WhatsApp", url: "https://web.whatsapp.com/" },
  { id: "instagram", name: "Instagram", url: "https://www.instagram.com/" },
  { id: "x", name: "X", url: "https://x.com/" },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/cdn-cgi/trace" },
  { id: "netflix", name: "Netflix", url: "https://www.netflix.com/" },
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com/" },
  { id: "steam", name: "Steam", url: "https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/" },
  { id: "twitch", name: "Twitch", url: "https://www.twitch.tv/" },
  { id: "github", name: "GitHub", url: "https://github.com/" },
  { id: "wikipedia", name: "Wikipedia", url: "https://www.wikipedia.org/" },
];

// Пакеты стран: банк + госуслуги + крупный локальный сервис. Больше трёх целей
// на страну не берём — это диагностика, а не каталог.
export const REGION_TARGETS = {
  ru: [
    { id: "ru-bank", name: "Сбербанк Онлайн", url: "https://online.sberbank.ru/" },
    { id: "ru-gov", name: "Госуслуги", url: "https://esia.gosuslugi.ru/" },
    { id: "ru-yandex", name: "Яндекс", url: "https://yandex.ru/" },
  ],
  by: [
    { id: "by-bank", name: "Беларусбанк", url: "https://belarusbank.by/" },
    { id: "by-erip", name: "ЕРИП", url: "https://raschet.by/" },
  ],
  ua: [
    { id: "ua-bank", name: "ПриватБанк", url: "https://privatbank.ua/" },
    { id: "ua-gov", name: "Дія", url: "https://diia.gov.ua/" },
  ],
  ir: [
    { id: "ir-bank", name: "Bank Melli", url: "https://www.bmi.ir/" },
    { id: "ir-shop", name: "Digikala", url: "https://www.digikala.com/" },
    { id: "ir-video", name: "Aparat", url: "https://www.aparat.com/" },
  ],
  cn: [
    { id: "cn-search", name: "Baidu", url: "https://www.baidu.com/" },
    { id: "cn-shop", name: "Taobao", url: "https://www.taobao.com/" },
    { id: "cn-video", name: "Bilibili", url: "https://www.bilibili.com/" },
  ],
  tr: [
    { id: "tr-gov", name: "e-Devlet", url: "https://www.turkiye.gov.tr/" },
    { id: "tr-shop", name: "Trendyol", url: "https://www.trendyol.com/" },
  ],
  de: [
    { id: "de-bank", name: "Sparkasse", url: "https://www.sparkasse.de/" },
    { id: "de-media", name: "ARD", url: "https://www.ard.de/" },
  ],
  pl: [
    { id: "pl-bank", name: "mBank", url: "https://www.mbank.pl/" },
    { id: "pl-gov", name: "gov.pl", url: "https://www.gov.pl/" },
  ],
  fr: [
    { id: "fr-bank", name: "Crédit Agricole", url: "https://www.credit-agricole.fr/" },
    { id: "fr-media", name: "France TV", url: "https://www.france.tv/" },
  ],
  es: [
    { id: "es-bank", name: "BBVA", url: "https://www.bbva.es/" },
    { id: "es-media", name: "RTVE", url: "https://www.rtve.es/" },
  ],
  it: [
    { id: "it-bank", name: "Intesa Sanpaolo", url: "https://www.intesasanpaolo.com/" },
    { id: "it-media", name: "RAI", url: "https://www.rai.it/" },
  ],
  us: [
    { id: "us-bank", name: "Chase", url: "https://www.chase.com/" },
    { id: "us-media", name: "Hulu", url: "https://www.hulu.com/" },
  ],
  br: [
    { id: "br-bank", name: "Nubank", url: "https://nubank.com.br/" },
    { id: "br-media", name: "Globo", url: "https://www.globo.com/" },
  ],
  in: [
    { id: "in-bank", name: "HDFC Bank", url: "https://www.hdfcbank.com/" },
    { id: "in-media", name: "Hotstar", url: "https://www.hotstar.com/" },
  ],
  id: [
    { id: "id-bank", name: "BCA", url: "https://www.bca.co.id/" },
    { id: "id-shop", name: "Tokopedia", url: "https://www.tokopedia.com/" },
  ],
  kz: [
    { id: "kz-bank", name: "Kaspi", url: "https://kaspi.kz/" },
    { id: "kz-gov", name: "eGov", url: "https://egov.kz/" },
  ],
};

export const REGION_PACKS = Object.keys(REGION_TARGETS);

const MAX_PINNED = 12;

function normalizeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/// Закреплённая пользователем цель. Имя показываем как есть, адрес обязан быть
/// http(s): всё остальное бэкенд всё равно отвергнет, но лучше не доводить.
export function normalizePinned(entry) {
  const url = normalizeUrl(entry?.url);
  if (!url) return null;
  const name = String(entry?.name || "").trim().slice(0, 60) || new URL(url).host;
  const id = String(entry?.id || "").trim() || `pin-${new URL(url).host}`;
  return { id, name, url };
}

/// Итоговый набор целей для одного прогона.
///
/// Порядок важен: сначала личные цели (человек проверял их только что), затем
/// региональные (они чаще всего и ломаются от туннеля), затем глобальные.
export function buildProbeSet({ regionPack = "", pinned = [] } = {}) {
  const pack = String(regionPack || "").toLowerCase();
  const regional = REGION_TARGETS[pack] || [];

  const seen = new Set();
  const out = [];
  const push = (target, scope) => {
    if (!target?.id || !target?.url || seen.has(target.id)) return;
    seen.add(target.id);
    out.push({ ...target, scope, ...(scope === "region" ? { region: pack } : {}) });
  };

  for (const entry of (Array.isArray(pinned) ? pinned : []).slice(0, MAX_PINNED)) {
    const normalized = normalizePinned(entry);
    if (normalized) push(normalized, "pinned");
  }
  for (const target of regional) push(target, "region");
  for (const target of GLOBAL_TARGETS) push(target, "global");
  return out;
}

/// Полный каталог целей по id — для подписей уже полученных результатов.
/// Набор мог смениться между прогоном и отрисовкой, и без общего каталога
/// строка теряла имя сервиса и показывала сырой идентификатор.
export function targetsById(pinned = []) {
  const map = new Map();
  for (const target of GLOBAL_TARGETS) map.set(target.id, { ...target, scope: "global" });
  for (const [pack, list] of Object.entries(REGION_TARGETS)) {
    for (const target of list) map.set(target.id, { ...target, scope: "region", region: pack });
  }
  for (const entry of Array.isArray(pinned) ? pinned : []) {
    const normalized = normalizePinned(entry);
    if (normalized) map.set(normalized.id, { ...normalized, scope: "pinned" });
  }
  return map;
}

/// «Ещё не выбирали»: до первого осознанного выбора пакет угадывается.
export const AUTO_PACK = "auto";

/// Какой пакет использовать. Пустая строка — это ОСОЗНАННЫЙ выбор «только
/// глобальный набор», и подменять его автоопределением нельзя: иначе пункт
/// «Глобальный» молча не срабатывает — сохранили пустое, прочитали угаданное.
export function resolveRegionPack({ stored, region = "", lang = "" } = {}) {
  if (stored == null || stored === AUTO_PACK) return defaultRegionPack({ region, lang });
  const pack = String(stored).toLowerCase();
  return REGION_TARGETS[pack] ? pack : "";
}

/// Пакет по умолчанию: сначала настройка маршрутизации (человек уже указал свою
/// страну), затем язык интерфейса. Не угадали — остаётся только глобальное ядро,
/// и это честнее, чем показывать чужие банки.
export function defaultRegionPack({ region = "", lang = "" } = {}) {
  const byRegion = String(region || "").toLowerCase();
  if (REGION_TARGETS[byRegion]) return byRegion;
  const byLang = String(lang || "").toLowerCase();
  const LANG_TO_PACK = {
    ru: "ru", uk: "ua", fa: "ir", zh: "cn", tr: "tr", de: "de",
    pl: "pl", fr: "fr", es: "es", it: "it", pt: "br", en: "us",
  };
  return LANG_TO_PACK[byLang] || "";
}
