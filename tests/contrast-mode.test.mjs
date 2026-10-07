// Режим «Повышенный контраст»: явный выбор пользователя важнее системной
// настройки, а без выбора режим следует prefers-contrast и её смене на лету.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const data = new Map();
globalThis.localStorage = {
  getItem: (k) => (data.has(k) ? data.get(k) : null),
  setItem: (k, v) => data.set(k, String(v)),
  removeItem: (k) => data.delete(k),
};

const media = { matches: false, listeners: [] };
globalThis.matchMedia = (query) => {
  assert.equal(query, "(prefers-contrast: more)");
  return {
    get matches() { return media.matches; },
    addEventListener: (type, cb) => media.listeners.push(cb),
  };
};
const root = { dataset: {} };
globalThis.document = { documentElement: root };

const { STORAGE_KEYS } = await import("/lib/storage-policy.js");
const { applyContrast, initContrast, isHighContrast, setHighContrast } = await import("/lib/contrast.js");

beforeEach(() => {
  data.clear();
  media.matches = false;
  media.listeners.length = 0;
  root.dataset = {};
});

test("без выбора пользователя режим повторяет системную настройку", () => {
  assert.equal(isHighContrast(), false);
  media.matches = true;
  assert.equal(isHighContrast(), true);
  applyContrast();
  assert.equal(root.dataset.contrast, "more");
});

test("выбор пользователя сохраняется и перекрывает систему", () => {
  media.matches = true;
  setHighContrast(false);
  assert.equal(localStorage.getItem(STORAGE_KEYS.contrast), "normal");
  assert.equal(isHighContrast(), false);
  assert.equal("contrast" in root.dataset, false);

  media.matches = false;
  setHighContrast(true);
  assert.equal(localStorage.getItem(STORAGE_KEYS.contrast), "more");
  assert.equal(root.dataset.contrast, "more");
});

test("мусор в хранилище не включает режим", () => {
  localStorage.setItem(STORAGE_KEYS.contrast, "yes");
  assert.equal(isHighContrast(), false);
});

test("смена системной настройки подхватывается, пока выбора нет", () => {
  initContrast();
  assert.equal("contrast" in root.dataset, false);
  media.matches = true;
  media.listeners.forEach((cb) => cb());
  assert.equal(root.dataset.contrast, "more");

  setHighContrast(false);
  media.listeners.forEach((cb) => cb());
  assert.equal("contrast" in root.dataset, false);
});
