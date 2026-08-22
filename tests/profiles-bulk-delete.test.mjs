// Массовое удаление одиночных конфигов. Список пополняется пачками (импорт
// буфера, deep links), поэтому у группы есть «удалить все». Проверяем, что
// операция снимает активный профиль: иначе стор ушёл бы на диск со ссылкой на
// удалённую запись, а Rust-валидация такой конверт не принимает.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (i) => Array.from(data.keys())[i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}

globalThis.window = {};
globalThis.localStorage = makeStorage();
globalThis.dispatchEvent = () => true;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const {
  loadProfiles,
  saveProfiles,
  removeAllProfiles,
  getActiveProfileId,
  setActiveProfileId,
} = await import("/lib/singbox.js");

test("removeAllProfiles чистит список и снимает активный профиль", () => {
  saveProfiles([
    { id: "p1", name: "one", host: "a", port: 443 },
    { id: "p2", name: "two", host: "b", port: 443 },
    { id: "p3", name: "three", host: "c", port: 443 },
  ]);
  setActiveProfileId("p2");

  assert.equal(removeAllProfiles(), 3);
  assert.deepEqual(loadProfiles(), []);
  assert.equal(getActiveProfileId(), null);
});

test("removeAllProfiles на пустом списке ничего не делает", () => {
  saveProfiles([]);
  setActiveProfileId(null);
  assert.equal(removeAllProfiles(), 0);
  assert.deepEqual(loadProfiles(), []);
});
