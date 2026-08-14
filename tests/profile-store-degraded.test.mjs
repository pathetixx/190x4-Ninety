// Отказ ЧТЕНИЯ защищённого хранилища. Раньше фасад в этом случае уходил в
// legacy-режим и продолжал зеркалить состояние в localStorage — то есть учётные
// данные нод (UUID, пароли, URL подписок), ради которых и заведён шифрованный
// стор, снова оказывались на диске открытым текстом. Контракт миграции
// (docs/PROFILE_STORE_MIGRATION.md) это запрещает прямо: «A Rust write failure
// must not update the legacy mirror».
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    get length() { return data.size; },
    key: (i) => Array.from(data.keys())[i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
    snapshot: () => Object.fromEntries(data),
  };
}

const localStorage = makeStorage();
globalThis.localStorage = localStorage;
globalThis.window = {};
const events = [];
globalThis.dispatchEvent = (event) => { events.push(event); return true; };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const invoke = async (command) => {
  if (command === "profile_store_load") throw new Error("DPAPI unavailable");
  throw new Error(`unexpected invoke: ${command}`);
};

const store = await import("/lib/profile-store.js");

test("отказ чтения переводит стор в деградацию и сообщает об этом", async () => {
  const result = await store.initializeProfileStore({ invoke, storage: localStorage });
  assert.equal(result.source, "legacy-fallback");
  assert.equal(result.persisted, false);
  assert.equal(store.profileStoreIsDegraded(), true);
  assert.ok(
    events.some((e) => e.type === "ninety:profile-store-error" && e.detail?.stage === "load"),
    "об отказе чтения обязано быть событие",
  );
});

test("в деградации секреты профиля не уезжают в localStorage", () => {
  store.saveProfilesToStore([
    {
      id: "p1",
      name: "node",
      host: "example.com",
      port: 443,
      uuid: "11111111-2222-3333-4444-555555555555",
      password: "s3cret",
    },
  ]);

  const snapshot = localStorage.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(
    Object.prototype.hasOwnProperty.call(snapshot, "ninety.profiles.v1"),
    false,
    `профили записаны в localStorage: ${serialized}`,
  );
  for (const secret of ["11111111-2222-3333-4444-555555555555", "s3cret", "example.com"]) {
    assert.equal(serialized.includes(secret), false, `секрет ${secret} оказался на диске`);
  }

  // Данные при этом остаются доступны приложению — они живут в памяти.
  assert.equal(store.loadProfilesFromStore().length, 1);
});
