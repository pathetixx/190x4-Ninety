// Ninety · сохранение режима перед включением строгого туннеля.
//
// Строгая политика временно переводит runtime в TUN, но пользовательский
// режим должен пережить этот overlay. Храним только допустимые значения, чтобы
// повреждённое или устаревшее значение не переключило приложение неожиданно.

export const STRICT_TUNNEL_PREVIOUS_MODE_KEY = "ninety.privacy.strictTunnel.previousMode";

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
