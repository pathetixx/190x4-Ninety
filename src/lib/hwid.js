// Ninety · device identifier for subscriptions with a device limit.
//
// Some panels (the Happ header standard, implemented in Remnawave) count
// devices by the `x-hwid` header and without it return, instead of servers, a placeholder
// "Enable HWID parameter". The identifier is permanent: it is derived in Rust from
// the Windows machine value with a one-way hash, and if that's unavailable it's
// generated randomly and stored together with the rest of the app state.
// It's sent only to the subscriptions for which the user enabled sending.

import { STORAGE_KEYS } from "/lib/storage-policy.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// The Remnawave v3+ panel checks the HWID with this same regex and silently ignores
// anything that doesn't match it.
export const HWID_PATTERN = /^[a-zA-Z0-9=-]{10,64}$/;

// A neutral model: the panel tells devices apart, the computer name doesn't go out.
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
    // The OS version changes with Windows updates, so it's taken fresh, not
    // from a saved snapshot; the HWID itself stays the same.
    if (info?.verOs) verOs = info.verOs;
  } catch (e) {
    console.warn("hwid: device identity unavailable", e?.message || e);
  }
  // The saved HWID takes priority over the machine one: otherwise a change of the machine value
  // (reinstalling Windows, sysprep) would silently take a new slot in the panel.
  const hwid = stored?.hwid || machineHwid || randomHwid();
  cached = { hwid, deviceOs, verOs, deviceModel: DEVICE_MODEL };
  writeStored(cached);
  return cached;
}

/** Device identifier; created and saved on the first call. */
export async function ensureDeviceIdentity() {
  if (cached) return cached;
  pending ??= resolveIdentity().finally(() => { pending = null; });
  return pending;
}

/** An already known identifier — for instant rendering, without waiting for IPC. */
export function peekDeviceIdentity() {
  return cached || readStored();
}

/** A new identifier: in the panel it's a separate device, the old one stays in its list. */
export async function regenerateDeviceIdentity() {
  const previous = await ensureDeviceIdentity();
  cached = { ...previous, hwid: randomHwid() };
  writeStored(cached);
  return cached;
}

// The subscription's HWID scheme. "provider" — each provider gets its own value,
// derived in Rust from the shared identifier and the subscription host: two providers
// can't match that it's the same device. Subscriptions added after it appeared
// get it. Older ones have no such field — they send the shared identifier as
// before: changing the value would take a new device slot in their panel.
export const HWID_SCOPE_PROVIDER = "provider";

export function subscriptionUsesScopedHwid(sub) {
  return sub?.hwidScope === HWID_SCOPE_PROVIDER;
}

/** Headers for a subscription with HWID sending enabled. */
export async function hwidHeaders({ scoped = false } = {}) {
  const identity = await ensureDeviceIdentity();
  return {
    hwid: identity.hwid,
    scoped: !!scoped,
    deviceOs: identity.deviceOs || DEFAULT_OS,
    verOs: identity.verOs || "",
    deviceModel: identity.deviceModel || DEVICE_MODEL,
  };
}

/** The x-hwid value this subscription's panel will see. */
export async function subscriptionHwid(sub) {
  const identity = await ensureDeviceIdentity();
  return invoke("subscription_hwid", {
    url: String(sub?.url || ""),
    hwid: identity.hwid,
    scoped: subscriptionUsesScopedHwid(sub),
  });
}

// A panel without response headers (Remnawave before 2.7.5 and its forks) reports
// the HWID requirement with a single placeholder server: the address 0.0.0.0 and a name like
// "Enable HWID parameter" / "Включите HWID параметр". Showing it as
// a working server is pointless, so we recognize it by both signs.
export function looksLikeHwidStub(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (list.length === 0 || list.length > 2) return false;
  return list.every(node => node?.host === "0.0.0.0" || /hwid/i.test(node?.name || ""));
}

/**
 * What the panel reported about the device limit in this response.
 * @returns {{required: boolean, limitReached: boolean}}
 */
export function hwidSignal(info, profiles, { sent = false } = {}) {
  const limitReached = info?.hwid_limit_reached === true;
  if (sent) return { required: false, limitReached };
  const list = Array.isArray(profiles) ? profiles : [];
  // `x-hwid-active` alone isn't a reason: the panel always sends it
  // when the limit is enabled, including to those for whom it was personally disabled and
  // who get the server list normally.
  const required = info?.hwid_not_supported === true
    || info?.status === 404
    || (info?.hwid_active === true && list.length === 0)
    || looksLikeHwidStub(list);
  return { required, limitReached };
}
