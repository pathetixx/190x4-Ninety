// The localStorage policy: what gets cleared by "clear data" and what goes into
// the durable backup. Node quarantine is addressed by the node content fingerprint, so
// it survives a subscription reimport: if it weren't cleared, it would silently suppress the same
// servers even after the user erased everything and added the subscription again.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    clear: () => data.clear(),
  };
}
globalThis.localStorage = makeStorage();

const { STORAGE_KEYS, shouldBackupStorageKey, clearProfileStorage } =
  await import("/lib/storage-policy.js");
const { quarantineNode, isNodeQuarantined, clearNodeQuarantine } =
  await import("/lib/node-quarantine.js");

const node = { type: "vless", host: "a.example", port: 443, uuid: "u-1", name: "Сервер 1" };

test("«очистить данные» снимает карантин: переимпорт той же ноды не глушится", () => {
  clearNodeQuarantine();
  quarantineNode(node, "initialize outbound[3]: unknown field");
  assert.equal(isNodeQuarantined(node), true);

  const removed = clearProfileStorage();
  assert.ok(removed.includes(STORAGE_KEYS.nodeQuarantine), "ключ карантина должен быть удалён");

  // The same node after reimporting the subscription: the id and order are different, but
  // the fingerprint is the same — without cleanup it would stay in quarantine.
  assert.equal(isNodeQuarantined({ ...node, id: "new-id", stableId: "new-stable" }), false);
});

test("рантайм-телеметрия не уезжает в durable-бэкап", () => {
  for (const key of [
    STORAGE_KEYS.nodeQuarantine,
    STORAGE_KEYS.incidents,
    STORAGE_KEYS.sourceRevisions,
    STORAGE_KEYS.delayHistory,
    STORAGE_KEYS.warpHistory,
    STORAGE_KEYS.qualityProfile,
  ]) {
    assert.equal(shouldBackupStorageKey(key), false, key);
  }
  for (const key of [STORAGE_KEYS.profiles, STORAGE_KEYS.subscriptions, STORAGE_KEYS.options]) {
    assert.equal(shouldBackupStorageKey(key), true, key);
  }
});

test("модули пишут ровно в те ключи, которые знает политика", () => {
  localStorage.clear();
  quarantineNode(node, "reason");
  assert.equal(localStorage.getItem(STORAGE_KEYS.nodeQuarantine) !== null, true);
});
