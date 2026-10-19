// Ninety · спокойный главный экран.
// Включается только вручную в Настройках → Оформление: кольца HUD стоят,
// видео-маска на паузе, надписи не мигают и не дрожат, а обновляются редко.
// Системный prefers-reduced-motion сюда намеренно не подключён: на Windows его
// часто включают ради производительности, и живой HUD тогда пропадал бы у тех,
// кто его не выключал.
// Режим — атрибут data-hud-mode="calm" на <html>; стили в styles/calm-hud.css.

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
