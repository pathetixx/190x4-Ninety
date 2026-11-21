// Ninety · saving the mode before enabling the strict tunnel.
//
// The strict policy temporarily switches the runtime to TUN, but the user's
// mode must survive this overlay. We store only allowed values so that
// a damaged or outdated value doesn't switch the app unexpectedly.

import { STORAGE_KEYS } from "/lib/storage-policy.js";

export const STRICT_TUNNEL_PREVIOUS_MODE_KEY = STORAGE_KEYS.strictTunnelPreviousMode;

const VALID_MODES = new Set(["proxy", "systemProxy", "tun"]);

export function normalizeStrictTunnelMode(value) {
  return typeof value === "string" && VALID_MODES.has(value) ? value : null;
}

export function rememberStrictTunnelPreviousMode(mode, storage = globalThis.localStorage) {
  const normalized = normalizeStrictTunnelMode(mode);
  if (!normalized) return false;
  try {
    storage.setItem(STRICT_TUNNEL_PREVIOUS_MODE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

export function readStrictTunnelPreviousMode(storage = globalThis.localStorage) {
  try {
    return normalizeStrictTunnelMode(storage.getItem(STRICT_TUNNEL_PREVIOUS_MODE_KEY));
  } catch {
    return null;
  }
}

export function clearStrictTunnelPreviousMode(storage = globalThis.localStorage) {
  try {
    storage.removeItem(STRICT_TUNNEL_PREVIOUS_MODE_KEY);
  } catch {}
}
