// Читатели хранилища вызываются сотнями раз за один рендер списка серверов.
// Копия делается один раз на версию состояния — но результат обязан оставаться
// независимым: иначе правка списка у одного вызывающего протекла бы во все
// остальные и в само хранилище.
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
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const store = await import("/lib/profile-store.js");

let revision = 0;
let persisted = { profiles: [], subscriptions: [] };
await store.initializeProfileStore({
  invoke: async (command, args) => {
    if (command === "profile_store_load") {
      return {
        revision,
        store: {
          schemaVersion: 1,
          revision,
          profiles: [],
          subscriptions: [{ id: "s1", name: "sub", profiles: [{ host: "a.example", port: 443 }] }],
          active: { kind: "sub", profileId: null, subscriptionId: "s1" },
          proxySelection: {},
        },
      };
    }
    if (command === "profile_store_replace") {
      persisted = args.store;
      revision = args.expectedRevision + 1;
      return { revision };
    }
    return null;
  },
});

test("повторные чтения дают равные, но независимые списки", () => {
  const a = store.loadSubscriptionsFromStore();
  const b = store.loadSubscriptionsFromStore();
  assert.deepEqual(a, b);
  assert.notEqual(a, b, "массив обязан быть новым — по нему делают push/filter");

  a.push({ id: "s2", name: "local" });
  assert.equal(store.loadSubscriptionsFromStore().length, 1, "правка копии не трогает хранилище");
});

test("после записи чтение видит новое состояние", async () => {
  const list = store.loadSubscriptionsFromStore();
  store.saveSubscriptionsToStore([...list, { id: "s2", name: "second", profiles: [] }]);

  const after = store.loadSubscriptionsFromStore();
  assert.deepEqual(after.map((s) => s.id), ["s1", "s2"]);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(persisted.subscriptions.map((s) => s.id), ["s1", "s2"]);
});
