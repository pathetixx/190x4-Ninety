// Ninety · target sets for the reachability matrix ("Diagnostics").
//
// The set is built from three layers:
//   global — the same for everyone: messengers, video, games, AI, infrastructure;
//   region — the pack of the country where the person lives: banks and government services that
//            usually DON'T let in a foreign address, i.e. break precisely because of
//            the enabled tunnel;
//   pinned — what the user pinned themselves after a manual check.
//
// The regional pack isn't a "Russian specific" but a mandatory part of
// diagnostics in any country: a local bank refuses a tunnel address
// equally in Moscow and in Berlin. The list of countries here is WIDER than in the
// "Region" setting (that one controls routing and is limited to the core's geosite/geoip sets),
// so the pack is chosen with its own key, diagnose.regionPack.
//
// Requirements for a target address: responds quickly, doesn't require authorization, stable
// for years. Ideally an endpoint like /generate_204 or /cdn-cgi/trace: the response there is
// small and unambiguous.

// The core: what people ask about in any country.
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

// Country packs: a bank + government services + a big local service. We don't take more than three targets
// per country — this is diagnostics, not a catalog.
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

/// A target pinned by the user. The name is shown as is, the address must be
/// http(s): the backend would reject everything else anyway, but better not to get there.
export function normalizePinned(entry) {
  const url = normalizeUrl(entry?.url);
  if (!url) return null;
  const name = String(entry?.name || "").trim().slice(0, 60) || new URL(url).host;
  const id = String(entry?.id || "").trim() || `pin-${new URL(url).host}`;
  return { id, name, url };
}

/// The final set of targets for one run.
///
/// Order matters: first personal targets (the person just checked them), then
/// regional ones (they're the ones that break from the tunnel most often), then global ones.
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

/// The full catalog of targets by id — for labels of already received results.
/// The set may have changed between the run and rendering, and without a shared catalog
/// a row lost the service name and showed a raw identifier.
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

/// "Not chosen yet": until the first deliberate choice the pack is guessed.
export const AUTO_PACK = "auto";
/// A deliberate choice of "global set only". A separate value, not an empty
/// string: historically an empty one means "nothing saved", and treating it as
/// a choice would mean changing behavior for old configs on update.
export const GLOBAL_PACK = "global";

/// Which pack to use: "" (global targets only) or a country code.
export function resolveRegionPack({ stored, region = "", lang = "" } = {}) {
  const pack = String(stored ?? "").toLowerCase();
  if (!pack || pack === AUTO_PACK) return defaultRegionPack({ region, lang });
  if (pack === GLOBAL_PACK) return "";
  return REGION_TARGETS[pack] ? pack : "";
}

/// Default pack: first the routing setting (the person has already specified their
/// country), then the interface language. If we didn't guess, only the global core remains,
/// and that's more honest than showing someone else's banks.
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
