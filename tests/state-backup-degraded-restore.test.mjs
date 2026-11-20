// Хранилище профилей не прочиталось (деградация): восстановление из state-backup
// не должно класть URL подписок и учётные данные открытым текстом в WebView.
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
globalThis.localStorage = makeStorage();
globalThis.sessionStorage = makeStorage();
globalThis.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

const snapshot = JSON.stringify({
  __schemaVersion: 2,
  "ninety.options.v1": "{}",
  "ninety.profiles.v1": "[]",
  "ninety.subscriptions.v1": JSON.stringify([{ id: "s1", url: "https://panel/secret-token", profiles: [] }]),
  "ninety.active.kind": "sub",
  "ninety.subscriptions.active": "s1",
});
const invoke = async (cmd) => {
  if (cmd === "profile_store_load") throw new Error("portable store is locked");
  if (cmd === "state_backup_load") return snapshot;
  throw new Error(`unexpected ${cmd}`);
};
globalThis.window = { __TAURI__: { core: { invoke } } };

const store = await import("/lib/profile-store.js");
const { restoreIfEmpty } = await import("/lib/state-backup.js");

test("в деградации профили не попадают в WebView-хранилище открытым текстом", async () => {
  await store.initializeProfileStore({ invoke, storage: globalThis.localStorage });
  assert.equal(store.profileStoreIsDegraded(), true);
  await restoreIfEmpty();
  assert.equal(globalThis.localStorage.getItem("ninety.subscriptions.v1"), null);
  assert.equal(globalThis.localStorage.getItem("ninety.options.v1"), "{}", "настройки восстанавливаются");
});
