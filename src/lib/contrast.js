// Ninety · increased contrast.
// The mode is enabled by the data-contrast="more" attribute on <html>; colors are set by
// styles/contrast.css. Until the user chooses themselves, the mode follows the system
// contrast setting (prefers-contrast: more) and picks up its change on the fly.

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
