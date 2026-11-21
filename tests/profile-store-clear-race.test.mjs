// "Clear data", while a background subscription update is saving the list at the same time.
// A write with the state from before the clear must not bring the deleted subscription back to disk.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; }, key: (i) => Array.from(data.keys())[i] ?? null,
    getItem: (k) => data.has(k) ? data.get(k) : null, setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k), clear: () => data.clear(),
  };
}
globalThis.localStorage = makeStorage();
globalThis.window = {};
globalThis.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = i?.detail; } };

let disk = { revision: 5, store: { schemaVersion: 1, revision: 5, profiles: [], active: { kind: "sub", profileId: null, subscriptionId: "s1" }, proxySelection: {},
  subscriptions: [{ id: "s1", url: "https://panel/secret-token", profiles: [{ id: "n1", uuid: "SECRET" }] }] } };
let releaseClear;
const clearGate = new Promise(r => { releaseClear = r; });
const invoke = async (cmd, args) => {
  if (cmd === "profile_store_load") return { exists: true, schemaVersion: 1, revision: disk.revision, recoveredFromBackup: false, store: disk.store };
  if (cmd === "profile_store_clear") { await clearGate; disk = null; return { removed: 2 }; }
  if (cmd === "profile_store_replace") {
    const cur = disk ? disk.revision : 0;
    if (cur !== args.expectedRevision) throw new Error("profile store revision conflict");
    disk = { revision: cur + 1, store: args.store };
    return { revision: cur + 1 };
  }
  throw new Error(cmd);
};
const s = await import("/lib/profile-store.js");

test("запись во время очистки не возвращает удалённую подписку", async () => {
  await s.initializeProfileStore({ invoke, storage: globalThis.localStorage });
  const clearing = s.clearProfileStore();
  await new Promise(r => setTimeout(r, 5));
  // the background subscription refresh finished while clear was in flight
  const list = s.loadSubscriptionsFromStore();
  list[0] = { ...list[0], lastUpdate: Date.now() };
  const saved = s.saveSubscriptionsToStore(list);
  releaseClear();
  await clearing;
  await saved;
  assert.equal(disk, null, "после очистки на диске снова есть подписка");
  assert.equal(s.loadSubscriptionsFromStore().length, 0);
});
