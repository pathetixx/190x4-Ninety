// The storage couldn't be read (portable with a password not entered, broken DPAPI):
// "Clear" must delete the files through Rust rather than report success in vain.
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
globalThis.localStorage = makeStorage();
globalThis.window = {};
globalThis.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

const calls = [];
const invoke = async (command, args) => {
  calls.push(command);
  if (command === "profile_store_load") throw new Error("portable store is locked");
  if (command === "profile_store_clear") return { removed: 3 };
  throw new Error(`unexpected ${command}`);
};
const store = await import("/lib/profile-store.js");

test("очистка в деградации удаляет файлы через Rust и снимает деградацию", async () => {
  await store.initializeProfileStore({ invoke, storage: globalThis.localStorage });
  assert.equal(store.profileStoreIsDegraded(), true);
  await store.clearProfileStore();
  assert.ok(calls.includes("profile_store_clear"), "удаление должен подтвердить Rust");
  assert.equal(store.profileStoreIsDegraded(), false);
});
