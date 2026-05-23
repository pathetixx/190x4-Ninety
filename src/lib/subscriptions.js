// Ninety · subscriptions
// URL-импорт списка vless://, парсинг subscription-userinfo, storage.

import { parseVless } from "/lib/singbox.js";

const SUBS_KEY = "ninety.subscriptions.v1";
const ACTIVE_SUB_KEY = "ninety.subscriptions.active";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// ── base64 detect + decode ─────────────────────────────────
function isLikelyBase64(s) {
  const trimmed = s.trim();
  if (trimmed.length < 24) return false;
  if (trimmed.startsWith("vless://") || trimmed.startsWith("vmess://") || trimmed.startsWith("trojan://")) return false;
  // base64 alphabet (стандартный + url-safe), allow newlines/spaces
  return /^[A-Za-z0-9+/=_\-\s]+$/.test(trimmed);
}

function tryBase64Decode(s) {
  const cleaned = s.replace(/\s+/g, "");
  try {
    // url-safe → standard
    const std = cleaned.replace(/-/g, "+").replace(/_/g, "/");
    const padded = std + "=".repeat((4 - std.length % 4) % 4);
    return decodeURIComponent(escape(atob(padded)));
  } catch {
    return null;
  }
}

/**
 * Парсит тело подписки в массив vless-профилей.
 * Поддерживает: plain newline-список, base64-encoded список.
 */
export function parseSubscriptionBody(body) {
  let text = String(body || "").trim();
  if (!text) return [];

  if (isLikelyBase64(text)) {
    const decoded = tryBase64Decode(text);
    if (decoded) text = decoded;
  }

  const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  const profiles = [];
  for (const line of lines) {
    if (!line.startsWith("vless://")) continue;
    try {
      profiles.push(parseVless(line));
    } catch (e) {
      console.warn("subscription: skip invalid vless line", e?.message);
    }
  }
  return profiles;
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
