// Контракт IPC защищённого хранилища профилей. Регрессия здесь не видна в UI:
// команда отвечает ошибкой, фасад молча уходит в legacy-localStorage, и профили
// (URL подписок, UUID, пароли нод) остаются на диске незашифрованными.
// Имена аргументов Tauri-команд — lowerCamelCase от имён параметров Rust.
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
  };
}

const localStorage = makeStorage({
  "ninety.profiles.v1": JSON.stringify([{ id: "p1", name: "node", host: "example.com" }]),
  "ninety.active.kind": "single",
  "ninety.profiles.active": "p1",
});
globalThis.localStorage = localStorage;
globalThis.window = {};
globalThis.dispatchEvent = () => true;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const calls = [];
let backendRevision = 0;
const invoke = async (command, args) => {
  calls.push({ command, args });
  if (command === "profile_store_load") {
    return { exists: false, schemaVersion: 1, revision: 0, recoveredFromBackup: false, store: null };
  }
  if (command === "profile_store_replace") {
    // Ровно то, что делает Tauri: неизвестный ключ = отсутствующий аргумент.
    if (!Object.prototype.hasOwnProperty.call(args, "expectedRevision")) {
      throw new Error("command profile_store_replace missing required key expectedRevision");
    }
    if (args.expectedRevision !== backendRevision) throw new Error("profile store revision conflict");
    backendRevision += 1;
    return { revision: backendRevision };
  }
  throw new Error(`unexpected invoke: ${command}`);
};

const {
  initializeProfileStore,
  profileStoreIsPersisted,
  saveProfilesToStore,
  loadProfilesFromStore,
} = await import("/lib/profile-store.js");

const migration = await initializeProfileStore({ invoke, storage: localStorage });

test("legacy-профили мигрируют в защищённый store, а не откатываются в localStorage", () => {
  assert.equal(migration.source, "migrated");
  assert.equal(migration.persisted, true);
  assert.equal(profileStoreIsPersisted(), true);
  // Чувствительные legacy-ключи снимаются только после подтверждённой записи.
  assert.equal(localStorage.getItem("ninety.profiles.v1"), null);
});

test("аргументы profile_store_replace передаются в camelCase", () => {
  const replace = calls.filter(c => c.command === "profile_store_replace");
  assert.ok(replace.length >= 1, "миграция обязана записать store");
  for (const call of replace) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(call.args, "expectedRevision"),
      "Tauri ждёт expectedRevision (lowerCamelCase от expected_revision)",
    );
    assert.equal(Object.prototype.hasOwnProperty.call(call.args, "expected_revision"), false);
    assert.equal(typeof call.args.expectedRevision, "number");
  }
});

test("последующая мутация уходит в backend с актуальной ревизией", async () => {
  const before = calls.filter(c => c.command === "profile_store_replace").length;
  saveProfilesToStore([
    { id: "p1", name: "node", host: "example.com" },
    { id: "p2", name: "second", host: "two.example.com" },
  ]);
  // enqueuePersist ставит запись в очередь — дожидаемся её завершения.
  await new Promise(resolve => setTimeout(resolve, 0));
  const replace = calls.filter(c => c.command === "profile_store_replace");
  assert.equal(replace.length, before + 1);
  assert.equal(replace.at(-1).args.expectedRevision, backendRevision - 1);
  assert.equal(loadProfilesFromStore().length, 2);
});
