// Ninety · subscriptions
// URL-импорт списка vless://, парсинг subscription-userinfo, storage.

import { parseLink } from "/lib/singbox.js";
import { t } from "/lib/i18n/index.js";
import { uid } from "/lib/uid.js";
import { loadOptions } from "/lib/options.js";
import { safeDecodeBase64 } from "/lib/url-helpers.js";
import { hashRuntimeValue, stableNodeId } from "/lib/runtime-identity.js";

export { safeDecodeBase64 };

const PROTO_PREFIX_RE = /^(?:(?:vless|vmess|trojan|ss|hysteria2?|hy2|tuic|tt):\/\/|naive\+[a-z]+:\/\/)/i;

const SUBS_KEY = "ninety.subscriptions.v1";
const ACTIVE_SUB_KEY = "ninety.subscriptions.active";
const REFRESH_ALL_CONCURRENCY = 3;

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// ── base64 detection (Hiddify-style: try-and-see) ──────────
// Никаких regex-проверок «похоже на base64». Просто пытаемся decode —
// если успешно и есть осмысленные ссылки, берём декод; иначе оригинал.
const KNOWN_PROTO_RE = /vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\/|hysteria2?:\/\/|hy2:\/\/|tuic:\/\/|tt:\/\/|naive\+[a-z]+:\/\//i;
const KNOWN_PROTO_URL_RE = /(?:(?:vless|vmess|trojan|ss|hysteria2?|hy2|tuic|tt):\/\/|naive\+[a-z]+:\/\/)\S+/ig;

// TrustTunnel endpoint-.toml (export из endpoint): плоский toml с hostname/addresses.
const TT_TOML_RE = /^\s*hostname\s*=.*[\r\n]/m;
function looksLikeTrustTunnelToml(s) {
  return TT_TOML_RE.test(s) && /^\s*addresses\s*=/m.test(s) && /^\s*username\s*=/m.test(s);
}

/**
 * Парсит тело подписки в массив vless-профилей.
 * Hiddify подход: decode base64 → если содержит протоколы, используем декод.
 * Поддерживает: plain newline-список, base64-encoded список.
 */
export function parseSubscriptionBody(body) {
  let text = String(body || "").trim();
  if (!text) return [];

  // Сначала пробуем декодировать как base64 — если в результате есть
  // знакомые протокольные схемы, считаем что это base64-list.
  const decoded = safeDecodeBase64(text);
  if (decoded && KNOWN_PROTO_RE.test(decoded)) {
    text = decoded;
  }

  const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  const profiles = [];
  for (const line of lines) {
    if (!PROTO_PREFIX_RE.test(line)) continue;
    try {
      profiles.push(parseLink(line));
    } catch (e) {
      console.warn("subscription: skip invalid link", e?.message);
    }
  }
  return profiles;
}

// ── Hiddify-style LinkParser: распознаёт что юзер вставил ──
//   { kind: "url", url }              — подписка по http(s) URL
//   { kind: "config", content }       — одиночная vless:// ссылка
//   { kind: "list", content }         — несколько vless:// (raw или base64)
//   { kind: "empty" } / { kind: "unknown" }
export function detectAddInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return { kind: "empty" };

  const protocolUrls = Array.from(s.matchAll(KNOWN_PROTO_URL_RE), m => m[0]);
  if (protocolUrls.length > 1) return { kind: "list", content: s };
  // Direct protocol link (vless/vmess/trojan/ss/hysteria2/tuic)
  if (protocolUrls.length === 1 && PROTO_PREFIX_RE.test(s) && protocolUrls[0] === s) {
    return { kind: "config", content: s };
  }

  // Hiddify-style deeplink: hiddify://import/<url> или ?url=
  const dl = s.match(/^(?:hiddify|v2ray|v2rayn|v2rayng|clash|clashmeta|sing-box):\/\/(.+)$/i);
  if (dl) {
    const rest = dl[1];
    if (/^https?:\/\//i.test(rest)) return { kind: "url", url: rest };
    try {
      const u = new URL(s.replace(/^[a-z0-9-]+:\/\//i, "http://"));
      const url = u.searchParams.get("url");
      if (url) return { kind: "url", url };
      const importPath = rest.replace(/^import\//i, "");
      if (/^https?:\/\//i.test(importPath)) return { kind: "url", url: importPath };
    } catch {}
  }

  // Plain http(s) URL
  if (/^https?:\/\//i.test(s)) return { kind: "url", url: s };

  // Base64 список?
  const decoded = safeDecodeBase64(s);
  if (decoded && KNOWN_PROTO_RE.test(decoded)) return { kind: "list", content: decoded };

  // Plain список с любыми поддерживаемыми протоколами
  if (KNOWN_PROTO_RE.test(s)) return { kind: "list", content: s };

  // TrustTunnel endpoint-.toml (вставлен текстом или загружен файлом)
  if (looksLikeTrustTunnelToml(s)) return { kind: "tt-toml", content: s };

  return { kind: "unknown", raw: s };
}

// ── storage ────────────────────────────────────────────────
export function loadSubscriptions() {
  try {
    const raw = localStorage.getItem(SUBS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveSubscriptions(list) {
  localStorage.setItem(SUBS_KEY, JSON.stringify(list));
}

// Stable ID переживает rename/reorder и повторный refresh. Для новых одинаковых
// структур добавляется occurrence; после первого сохранения ID матчится обратно.
export function assignStableNodeIds(profiles, previous = [], namespace = "sub") {
  const oldByShape = new Map();
  for (const node of previous || []) {
    const shape = hashRuntimeValue(stableNodeId({ ...node, stableId: undefined, id: undefined }, "shape"));
    const q = oldByShape.get(shape) || [];
    if (node.stableId) q.push(node.stableId);
    oldByShape.set(shape, q);
  }
  const seen = new Map();
  return (profiles || []).map(node => {
    if (node.stableId || node.id) return node;
    const shape = hashRuntimeValue(stableNodeId({ ...node, stableId: undefined, id: undefined }, "shape"));
    const occurrence = seen.get(shape) || 0;
    seen.set(shape, occurrence + 1);
    const reused = oldByShape.get(shape)?.shift();
    return { ...node, stableId: reused || `${namespace}-${shape}-${occurrence}` };
  });
}

export function getActiveSubscriptionId() {
  return localStorage.getItem(ACTIVE_SUB_KEY);
}

export function setActiveSubscriptionId(id) {
  if (id) localStorage.setItem(ACTIVE_SUB_KEY, id);
  else localStorage.removeItem(ACTIVE_SUB_KEY);
}

export function getActiveSubscription() {
  const id = getActiveSubscriptionId();
  if (!id) return null;
  return loadSubscriptions().find(s => s.id === id) || null;
}

export function removeSubscription(id) {
  const list = loadSubscriptions().filter(s => s.id !== id);
  saveSubscriptions(list);
  if (getActiveSubscriptionId() === id) {
    setActiveSubscriptionId(list[0]?.id ?? null);
  }
}

// Точечное обновление полей подписки (rename, autoUpdate, interval, …).
// Сохраняет неуказанные поля, не трогает .profiles и .lastUpdate.
export function updateSubscription(id, patch) {
  const list = loadSubscriptions();
  const idx = list.findIndex(s => s.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  saveSubscriptions(list);
  return list[idx];
}

// ── fetch + merge ───────────────────────────────────────────
// Прокси для fetch_subscription: main.js подставляет локальный инбаунд при
// поднятом VPN — запрос к панели уходит через туннель (не светит реальный IP
// и работает там, где панель заблокирована напрямую). null → напрямую.
let subProxyProvider = null;
export function setSubscriptionProxy(fn) { subProxyProvider = fn; }

async function fetchInfo(url) {
  let proxy = null;
  try { proxy = subProxyProvider?.() || null; } catch {}
  let info;
  try {
    info = await invoke("fetch_subscription", { url, proxy });
  } catch (e) {
    if (!proxy) throw e;
    const allowDirectFallback = !!loadOptions().general?.allowDirectSubscriptionFallback;
    if (!allowDirectFallback) {
      throw new Error(t("subs.proxyFallbackDisabled"), { cause: e });
    }
    // Туннель мог только что умереть — если юзер явно разрешил, повторяем напрямую.
    info = await invoke("fetch_subscription", { url, proxy: null });
  }
  if (info.status >= 400) {
    throw new Error(`HTTP ${info.status}`);
  }
  return info;
}

/**
 * Создаёт новую подписку по URL: тянет, парсит, сохраняет.
 * @returns {object} subscription record
 */
export async function addSubscriptionFromUrl(url, customName = "", intervalHoursOverride = null) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) throw new Error(t("subs.needHttpUrl"));

  const info = await fetchInfo(u);
  const profiles = parseSubscriptionBody(info.body);
  if (profiles.length === 0) throw new Error(t("subs.noVless"));

  const id = uid("sub_");
  // Явный выбор слайдера (>0) приоритетнее заголовка панели; 0 = «Авто» → берём
  // profile-update-interval сервера, а без него silentRefreshSubs даёт 6ч дефолт.
  const hours = Number(intervalHoursOverride);
  const serverUpdateIntervalHours = info.profile_update_interval_hours ?? null;
  const updateIntervalMode = hours > 0 ? "manual" : "auto";
  const sub = {
    id,
    url: u,
    name: customName || info.profile_title || hostnameOf(u) || t("subs.subFallback"),
    lastUpdate: Date.now(),
    expire: info.expire ?? null,
    upload: info.upload ?? null,
    download: info.download ?? null,
    total: info.total ?? null,
    updateIntervalMode,
    updateIntervalHours: updateIntervalMode === "manual" ? hours : serverUpdateIntervalHours,
    serverUpdateIntervalHours,
    profiles: assignStableNodeIds(profiles, [], id),
  };

  const list = loadSubscriptions();
  list.push(sub);
  saveSubscriptions(list);
  return sub;
}

/**
 * Обновляет существующую подписку.
 */
export async function refreshSubscription(id) {
  const cur = loadSubscriptions().find(s => s.id === id);
  if (!cur) throw new Error(t("subs.notFound"));

  const info = await fetchInfo(cur.url);
  const profiles = parseSubscriptionBody(info.body);
  if (profiles.length === 0) throw new Error(t("subs.emptyOrInvalid"));

  // Список перечитывается ПОСЛЕ await: за время fetch'а юзер мог переименовать
  // или удалить подписку, а параллельный refresh — обновить соседнюю. Сохранение
  // снапшота, взятого до await, молча откатывало бы эти изменения.
  const list = loadSubscriptions();
  const idx = list.findIndex(s => s.id === id);
  if (idx < 0) throw new Error(t("subs.notFound"));
  const fresh = list[idx];
  list[idx] = mergeSubscriptionRefresh(fresh, info, profiles);
  saveSubscriptions(list);
  return list[idx];
}

export function mergeSubscriptionRefresh(fresh, info, profiles) {
  const hasServerInterval = info.profile_update_interval_hours != null;
  const serverUpdateIntervalHours = hasServerInterval
    ? info.profile_update_interval_hours
    : (fresh.serverUpdateIntervalHours ?? null);
  const mode = fresh.updateIntervalMode || (Number(fresh.updateIntervalHours) > 0 ? "manual" : "auto");
  const updateIntervalHours = mode === "manual"
    ? fresh.updateIntervalHours
    : (hasServerInterval ? info.profile_update_interval_hours : fresh.updateIntervalHours);
  return {
    ...fresh,
    name: fresh.name || info.profile_title || "",
    lastUpdate: Date.now(),
    expire: info.expire ?? fresh.expire,
    upload: info.upload ?? fresh.upload,
    download: info.download ?? fresh.download,
    total: info.total ?? fresh.total,
    updateIntervalMode: mode,
    updateIntervalHours: updateIntervalHours ?? null,
    serverUpdateIntervalHours,
    profiles: assignStableNodeIds(profiles, fresh.profiles, fresh.id),
  };
}

async function allSettledLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      try {
        out[idx] = { status: "fulfilled", value: await fn(items[idx], idx) };
      } catch (reason) {
        out[idx] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// Ограниченно параллельно: последовательный обход складывал сетевые таймауты,
// а Promise.all по всем подпискам создавал burst при больших списках. Гонок за
// localStorage нет — каждый refresh перечитывает список после своего await.
export async function refreshAllSubscriptions() {
  const list = loadSubscriptions();
  const settled = await allSettledLimit(list, REFRESH_ALL_CONCURRENCY, s => refreshSubscription(s.id));
  return settled.map((r, i) => r.status === "fulfilled"
    ? { id: list[i].id, ok: true, count: r.value.profiles.length }
    : { id: list[i].id, ok: false, error: r.reason?.message || String(r.reason) });
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

// ── helpers для UI ─────────────────────────────────────────
export function subscriptionDaysLeft(sub) {
  if (!sub?.expire) return null;
  const secsLeft = sub.expire - Math.floor(Date.now() / 1000);
  if (secsLeft <= 0) return 0;
  return Math.ceil(secsLeft / 86400);
}

export function subscriptionUsedBytes(sub) {
  const up = sub?.upload ?? 0;
  const down = sub?.download ?? 0;
  return up + down;
}

export function formatGiB(bytes) {
  if (bytes == null) return "—";
  return (bytes / 1024 / 1024 / 1024).toFixed(bytes < 1e9 ? 2 : 1);
}

// Умный форматтер трафика: сам подбирает единицу (Б/КБ/МБ/ГБ/ТБ), даёт
// «12.3 МБ» / «1.45 ГБ» / «857 ГБ» вместо вечного «0.00 ГБ» на мелких объёмах.
export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return t("subs.zero");
  const units = [t("subs.bytes.b"), t("subs.bytes.kb"), t("subs.bytes.mb"), t("subs.bytes.gb"), t("subs.bytes.tb")];
  let v = b, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const dec = i <= 1 || v >= 100 ? 0 : (v >= 10 ? 1 : 2);
  return `${v.toFixed(dec)} ${units[i]}`;
}

// total=0 (или отсутствует) у многих панелей = безлимит/не метится. Возвращаем
// число только если это реальный положительный лимит, иначе null = безлимит.
export function subscriptionLimitBytes(sub) {
  const t = sub?.total;
  return typeof t === "number" && t > 0 ? t : null;
}

export function relativeTime(ts) {
  if (!ts) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return t("subs.relNow");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t("subs.relMin", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("subs.relHour", { n: hours });
  const days = Math.floor(hours / 24);
  return t("subs.relDay", { n: days });
}
