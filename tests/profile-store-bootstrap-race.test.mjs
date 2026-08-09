// Профиль, добавленный до ответа Rust-хранилища (deep-link или автоимпорт на
// старте), раньше затирался backend-снимком, а removeLegacySensitiveKeys()
// удалял и зеркало в localStorage — запись исчезала бесследно.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (i) => Array.from(data.keys())[i] ?? null,
    getItem: (k) => data.has(k) ? data.get(k) : null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}
globalThis.localStorage = makeStorage();
globalThis.window = { dispatchEvent: () => {} };

const backendStore = {
  schemaVersion: 1,
  revision: 3,
  profiles: [{ id: "p-backend", name: "Из хранилища", host: "1.2.3.4", port: 443 }],
  subscriptions: [],
  active: { kind: "single", profileId: "p-backend", subscriptionId: null },
  proxySelection: {},
};

let releaseLoad;
const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
const replaceCalls = [];
const invoke = async (cmd, args) => {
  if (cmd === "profile_store_load") {
    await loadGate;
    return { exists: true, schemaVersion: 1, revision: 3, recoveredFromBackup: false, store: backendStore };
  }
  if (cmd === "profile_store_replace") {
    replaceCalls.push(args);
    return { revision: (args?.expectedRevision ?? 0) + 1 };
  }
  throw new Error(`unexpected invoke: ${cmd}`);
};

const {
  initializeProfileStore,
  loadProfilesFromStore,
  saveProfilesToStore,
  setActiveProfileIdInStore,
} = await import("/lib/profile-store.js");

test("профиль, добавленный до ответа хранилища, переживает инициализацию", async () => {
  const init = initializeProfileStore({ invoke, storage: localStorage });

  // Пользователь успел добавить ноду, пока IPC ещё в полёте.
  saveProfilesToStore([{ id: "p-early", name: "Ранний", host: "5.6.7.8", port: 443 }]);
  setActiveProfileIdInStore("p-early");

  releaseLoad();
  await init;

  const ids = loadProfilesFromStore().map((p) => p.id).sort();
  assert.deepEqual(ids, ["p-backend", "p-early"], "обе записи должны остаться");
  // Слитое состояние обязано уехать в Rust-хранилище, иначе оно живёт только в памяти.
  assert.equal(replaceCalls.length, 1);
  const persisted = replaceCalls[0].store.profiles.map((p) => p.id).sort();
  assert.deepEqual(persisted, ["p-backend", "p-early"]);
});
