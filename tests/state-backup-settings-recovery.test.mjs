// Профили живут в Rust-owned store, настройки — только в localStorage WebView2.
// Очистка профиля WebView оставляет профили нетронутыми, и общая проверка
// «хранилище целое» объявляла состояние полным: режим, строгий туннель,
// Kill Switch, маршрутизация, DPI и тема не возвращались, а автозапуск
// поднимался с настройками по умолчанию.
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

const localStorage = makeStorage();
const sessionStorage = makeStorage();
globalThis.localStorage = localStorage;
globalThis.sessionStorage = sessionStorage;

const liveStore = {
  schemaVersion: 1,
  revision: 7,
  profiles: [{ id: "p-live", name: "Живой", host: "1.2.3.4", port: 443 }],
  subscriptions: [],
  active: { kind: "single", profileId: "p-live", subscriptionId: null },
  proxySelection: {},
};

// Бэкап заведомо старее живого стора: в нём другой профиль. Его профильная
// часть не должна доехать до Rust-хранилища.
const diskSnapshot = JSON.stringify({
  __schemaVersion: 2,
  "ninety.options.v1": JSON.stringify({ privacy: { strictTunnel: true }, general: { killSwitch: true } }),
  "ninety.profiles.v1": JSON.stringify([{ id: "p-stale", name: "Старый" }]),
  "ninety.subscriptions.v1": "[]",
  "ninety.active.kind": "single",
  "ninety.profiles.active": "p-stale",
  "ninety.mode": "tun",
  "ninety.dpi.enabled": "true",
  "ninety.theme": "dark",
});

const replaceCalls = [];
async function invokeImpl(cmd, args) {
  if (cmd === "profile_store_load") {
    return { exists: true, schemaVersion: 1, revision: 7, recoveredFromBackup: false, store: liveStore };
  }
  if (cmd === "profile_store_replace") {
    replaceCalls.push(args);
    return { revision: (args?.expectedRevision ?? 0) + 1 };
  }
  if (cmd === "state_backup_load") return diskSnapshot;
  if (cmd === "state_backup_save") return;
  throw new Error(`unexpected invoke: ${cmd}`);
}
globalThis.window = {
  __TAURI__: { core: { invoke: invokeImpl } },
  dispatchEvent: () => {},
};

const { initializeProfileStore, loadProfilesFromStore } = await import("/lib/profile-store.js");
const { restoreIfEmpty, storageIntegrity } = await import("/lib/state-backup.js");

test("потеря WebView-хранилища при живом Rust-сторе возвращает настройки, но не профили", async () => {
  await initializeProfileStore({ invoke: invokeImpl, storage: localStorage });
  localStorage.clear();
  sessionStorage.clear();

  const integrity = storageIntegrity();
  assert.equal(integrity.profiles, true, "профили в Rust-сторе целы");
  assert.equal(integrity.settings, false, "настроек в localStorage нет");

  assert.equal(await restoreIfEmpty(), true);

  // Настройки вернулись.
  assert.equal(localStorage.getItem("ninety.mode"), "tun");
  assert.equal(localStorage.getItem("ninety.dpi.enabled"), "true");
  assert.equal(localStorage.getItem("ninety.theme"), "dark");
  assert.equal(JSON.parse(localStorage.getItem("ninety.options.v1")).privacy.strictTunnel, true);

  // Профили из старого бэкапа не тронули ни Rust-стор, ни localStorage.
  assert.deepEqual(replaceCalls, []);
  assert.equal(localStorage.getItem("ninety.profiles.v1"), null);
  assert.equal(localStorage.getItem("ninety.profiles.active"), null);
  assert.equal(loadProfilesFromStore()[0]?.id, "p-live");
});

test("полностью живое хранилище восстановление не запускает", async () => {
  localStorage.setItem("ninety.options.v1", "{}");
  sessionStorage.clear();
  const integrity = storageIntegrity();
  assert.equal(integrity.profiles, true);
  assert.equal(integrity.settings, true);
  assert.equal(await restoreIfEmpty(), false);
});
