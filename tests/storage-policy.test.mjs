// Политика localStorage: что чистится по «очистить данные» и что уезжает в
// durable-бэкап. Карантин нод адресуется отпечатком содержимого ноды, поэтому
// переживает переимпорт подписки: не очистившись, он молча глушил бы те же
// сервера и после того, как пользователь всё стёр и добавил подписку заново.
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

  // Та же нода после повторного импорта подписки: id и порядок другие, а
  // отпечаток тот же — без очистки она осталась бы в карантине.
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
