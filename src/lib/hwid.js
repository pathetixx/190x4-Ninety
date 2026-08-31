// Ninety · идентификатор устройства для подписок с лимитом устройств.
//
// Часть панелей (стандарт заголовков Happ, реализованный в Remnawave) считает
// устройства по заголовку `x-hwid` и без него отдаёт вместо серверов заглушку
// «Enable HWID parameter». Идентификатор постоянный: он выводится в Rust из
// машинного значения Windows односторонним хешем, а если оно недоступно —
// генерируется случайно и хранится вместе с остальным состоянием приложения.
// Уходит он только тем подпискам, для которых пользователь включил отправку.

import { STORAGE_KEYS } from "/lib/storage-policy.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// Панель Remnawave v3+ проверяет HWID этой же регуляркой и молча игнорирует
// то, что под неё не подходит.
export const HWID_PATTERN = /^[a-zA-Z0-9=-]{10,64}$/;

// Нейтральная модель: панель различает устройства, имя компьютера наружу не уходит.
const DEVICE_MODEL = "Ninety";
const DEFAULT_OS = "Windows";

export function isValidHwid(value) {
  return typeof value === "string" && HWID_PATTERN.test(value);
}

export function randomHwid() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.deviceHwid);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidHwid(parsed?.hwid) ? parsed : null;
  } catch { return null; }
}

function writeStored(identity) {
  try { localStorage.setItem(STORAGE_KEYS.deviceHwid, JSON.stringify(identity)); }
  catch (e) { console.warn("hwid: cannot persist identity", e?.message || e); }
}

let cached = null;
let pending = null;

async function resolveIdentity() {
  const stored = readStored();
  let machineHwid = null;
  let deviceOs = stored?.deviceOs || DEFAULT_OS;
  let verOs = stored?.verOs || "";
  try {
    const info = await invoke("device_identity");
    if (isValidHwid(info?.hwid)) machineHwid = info.hwid;
    if (info?.deviceOs) deviceOs = info.deviceOs;
    // Версия ОС меняется с обновлениями Windows, поэтому берётся заново, а не
    // из сохранённого снимка; сам HWID при этом остаётся прежним.
    if (info?.verOs) verOs = info.verOs;
  } catch (e) {
    console.warn("hwid: device identity unavailable", e?.message || e);
  }
  // Сохранённый HWID приоритетнее машинного: иначе смена машинного значения
  // (переустановка Windows, sysprep) молча заняла бы в панели новый слот.
  const hwid = stored?.hwid || machineHwid || randomHwid();
  cached = { hwid, deviceOs, verOs, deviceModel: DEVICE_MODEL };
  writeStored(cached);
  return cached;
}

/** Идентификатор устройства; при первом вызове заводится и сохраняется. */
export async function ensureDeviceIdentity() {
  if (cached) return cached;
  pending ??= resolveIdentity().finally(() => { pending = null; });
  return pending;
}

/** Уже известный идентификатор — для мгновенной отрисовки, без ожидания IPC. */
export function peekDeviceIdentity() {
  return cached || readStored();
}

/** Новый идентификатор: в панели это отдельное устройство, старое остаётся в её списке. */
export async function regenerateDeviceIdentity() {
  const previous = await ensureDeviceIdentity();
  cached = { ...previous, hwid: randomHwid() };
  writeStored(cached);
  return cached;
}

/** Заголовки для подписки, у которой включена отправка HWID. */
export async function hwidHeaders() {
  const identity = await ensureDeviceIdentity();
  return {
    hwid: identity.hwid,
    deviceOs: identity.deviceOs || DEFAULT_OS,
    verOs: identity.verOs || "",
    deviceModel: identity.deviceModel || DEVICE_MODEL,
  };
}

// Панель без ответных заголовков (Remnawave до 2.7.5 и её форки) сообщает о
// требовании HWID единственным сервером-заглушкой: адрес 0.0.0.0 и имя вроде
// «Enable HWID parameter» / «Включите HWID параметр». Показывать его как
// рабочий сервер бессмысленно, поэтому распознаём по обоим признакам.
export function looksLikeHwidStub(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (list.length === 0 || list.length > 2) return false;
  return list.every(node => node?.host === "0.0.0.0" || /hwid/i.test(node?.name || ""));
}

/**
 * Что панель сообщила про лимит устройств в этом ответе.
 * @returns {{required: boolean, limitReached: boolean}}
 */
export function hwidSignal(info, profiles, { sent = false } = {}) {
  const limitReached = info?.hwid_limit_reached === true;
  if (sent) return { required: false, limitReached };
  const list = Array.isArray(profiles) ? profiles : [];
  // Один только `x-hwid-active` поводом не считаем: панель шлёт его всегда,
  // когда лимит включён, в том числе тем, кому его персонально отключили и
  // кому список серверов приходит нормально.
  const required = info?.hwid_not_supported === true
    || info?.status === 404
    || (info?.hwid_active === true && list.length === 0)
    || looksLikeHwidStub(list);
  return { required, limitReached };
}
