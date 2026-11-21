// Ninety · calm main screen.
// Enabled only manually in Settings → Appearance: the HUD rings stand still,
// the video mask is paused, labels don't blink or jitter and update rarely.
// The system prefers-reduced-motion is deliberately not wired here: on Windows it's
// often enabled for performance, and the live HUD would then disappear for those
// who never turned it off.
// The mode is the data-hud-mode="calm" attribute on <html>; styles in styles/calm-hud.css.

import { STORAGE_KEYS } from "/lib/storage-policy.js";
import { emit } from "/lib/bus.js";

export const CALM_HUD_EVENT = "hud:calm";

export function isCalmHud() {
  try {
    return localStorage.getItem(STORAGE_KEYS.calmHud) === "on";
  } catch {
    return false;
  }
}

export function applyCalmHud(root = globalThis.document?.documentElement) {
  if (!root) return;
  if (isCalmHud()) root.dataset.hudMode = "calm";
  else delete root.dataset.hudMode;
}

export function setCalmHud(on) {
  try {
    if (on) localStorage.setItem(STORAGE_KEYS.calmHud, "on");
    else localStorage.removeItem(STORAGE_KEYS.calmHud);
  } catch {}
  applyCalmHud();
  emit(CALM_HUD_EVENT, Boolean(on));
}
