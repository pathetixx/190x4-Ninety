// Ninety · повышенный контраст.
// Режим включается атрибутом data-contrast="more" на <html>; цвета задаёт
// styles/contrast.css. Пока пользователь не выбрал сам, режим следует системной
// настройке контрастности (prefers-contrast: more) и подхватывает её смену на лету.

import { STORAGE_KEYS } from "/lib/storage-policy.js";

const SYSTEM_QUERY = "(prefers-contrast: more)";

function storedChoice() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.contrast);
    return raw === "more" || raw === "normal" ? raw : null;
  } catch {
    return null;
  }
}

function systemPrefersMore() {
  try {
    return !!globalThis.matchMedia?.(SYSTEM_QUERY).matches;
  } catch {
    return false;
  }
}

export function isHighContrast() {
  const choice = storedChoice();
  return choice ? choice === "more" : systemPrefersMore();
}

export function applyContrast(root = globalThis.document?.documentElement) {
  if (!root) return;
  if (isHighContrast()) root.dataset.contrast = "more";
  else delete root.dataset.contrast;
}

export function setHighContrast(on) {
  try {
    localStorage.setItem(STORAGE_KEYS.contrast, on ? "more" : "normal");
  } catch {}
  applyContrast();
}

export function initContrast() {
  applyContrast();
  try {
    globalThis.matchMedia?.(SYSTEM_QUERY).addEventListener("change", () => {
      if (!storedChoice()) applyContrast();
    });
  } catch {}
}
