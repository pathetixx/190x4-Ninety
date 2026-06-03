// Ninety · subscriptions
// URL-импорт списка vless://, парсинг subscription-userinfo, storage.

import { parseVless, parseLink } from "/lib/singbox.js";

const PROTO_PREFIX_RE = /^(?:(?:vless|vmess|trojan|ss|hysteria2?|hy2|tuic|tt):\/\/|naive\+[a-z]+:\/\/)/i;

const SUBS_KEY = "ninety.subscriptions.v1";
const ACTIVE_SUB_KEY = "ninety.subscriptions.active";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// ── base64 helpers (Hiddify-style: try-and-see) ────────────
// Никаких regex-проверок «похоже на base64». Просто пытаемся decode —
// если успешно и есть осмысленные ссылки, берём декод; иначе оригинал.
export function safeDecodeBase64(s) {
  try {
    const cleaned = String(s).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!cleaned) return "";
    const padded = cleaned + "=".repeat((4 - cleaned.length % 4) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

const KNOWN_PROTO_RE = /vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\/|hysteria2?:\/\/|tuic:\/\/|tt:\/\/|naive\+[a-z]+:\/\//i;

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

  // Direct protocol link (vless/vmess/trojan/ss/hysteria2/tuic)
  if (PROTO_PREFIX_RE.test(s)) return { kind: "config", content: s };

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
async function fetchInfo(url) {
  const info = await invoke("fetch_subscription", { url });
  if (info.status >= 400) {
    throw new Error(`HTTP ${info.status}`);
  }
  return info;
}

/**
 * Создаёт новую подписку по URL: тянет, парсит, сохраняет.
 * @returns {object} subscription record
 */
export async function addSubscriptionFromUrl(url, customName = "") {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) throw new Error("Нужен http(s):// URL");

  const info = await fetchInfo(u);
  const profiles = parseSubscriptionBody(info.body);
  if (profiles.length === 0) throw new Error("Подписка не содержит vless:// конфигов");

  const id = "sub_" + Math.random().toString(36).slice(2, 10);
  const sub = {
    id,
    url: u,
    name: customName || info.profile_title || hostnameOf(u) || "Подписка",
    lastUpdate: Date.now(),
    expire: info.expire ?? null,
    upload: info.upload ?? null,
    download: info.download ?? null,
    total: info.total ?? null,
    updateIntervalHours: info.profile_update_interval_hours ?? null,
    profiles,
  };

  const list = loadSubscriptions();
  list.push(sub);
  saveSubscriptions(list);
  if (!getActiveSubscriptionId()) setActiveSubscriptionId(id);
  return sub;
}

/**
 * Обновляет существующую подписку.
 */
export async function refreshSubscription(id) {
  const list = loadSubscriptions();
  const idx = list.findIndex(s => s.id === id);
  if (idx < 0) throw new Error("Подписка не найдена");
  const cur = list[idx];

  const info = await fetchInfo(cur.url);
  const profiles = parseSubscriptionBody(info.body);
  if (profiles.length === 0) throw new Error("Подписка пуста или невалидна");

  list[idx] = {
    ...cur,
    name: cur.name || info.profile_title || cur.name,
    lastUpdate: Date.now(),
    expire: info.expire ?? cur.expire,
    upload: info.upload ?? cur.upload,
    download: info.download ?? cur.download,
    total: info.total ?? cur.total,
    updateIntervalHours: info.profile_update_interval_hours ?? cur.updateIntervalHours,
    profiles,
  };
  saveSubscriptions(list);
  return list[idx];
}

export async function refreshAllSubscriptions() {
  const list = loadSubscriptions();
  const results = [];
  for (const s of list) {
    try {
      const r = await refreshSubscription(s.id);
      results.push({ id: s.id, ok: true, count: r.profiles.length });
    } catch (e) {
      results.push({ id: s.id, ok: false, error: e?.message || String(e) });
    }
  }
  return results;
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
  if (b <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
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
  if (secs < 60) return "только что";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} д назад`;
}
