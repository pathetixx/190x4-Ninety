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
let savedSnapshot = null;

globalThis.localStorage = localStorage;
globalThis.sessionStorage = sessionStorage;
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (cmd, args) => {
        if (cmd === "state_backup_save") {
          savedSnapshot = args.json;
          return;
        }
        if (cmd === "state_backup_load") return savedSnapshot;
        throw new Error(`unexpected invoke: ${cmd}`);
      },
    },
  },
};

const { backupForUpdate, backupNow, restoreIfEmpty, validateSnapshot } = await import("/lib/state-backup.js");

test("OTA-снимок возвращает активный профиль и resume-маркер", async () => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("ninety.profiles.v1", JSON.stringify([{ id: "p-last", name: "Последний" }]));
  localStorage.setItem("ninety.profiles.active", "p-last");
  localStorage.setItem("ninety.active.kind", "single");
  localStorage.setItem("ninety.update.resume", JSON.stringify({ vpn: true, dpi: false }));

  await backupNow();
  assert.equal(JSON.parse(savedSnapshot)["ninety.update.resume"], undefined);

  await backupForUpdate();
  const otaSnapshot = JSON.parse(savedSnapshot);
  assert.equal(otaSnapshot["ninety.profiles.active"], "p-last");
  assert.equal(otaSnapshot["ninety.update.resume"], JSON.stringify({ vpn: true, dpi: false }));

  localStorage.clear();
  assert.equal(await restoreIfEmpty(), true);
  assert.equal(localStorage.getItem("ninety.profiles.active"), "p-last");
  assert.equal(localStorage.getItem("ninety.update.resume"), JSON.stringify({ vpn: true, dpi: false }));
});

test("partial/corrupt backup отклоняется до записи", () => {
  assert.equal(validateSnapshot({
    __schemaVersion: 2,
    "ninety.options.v1": "{}",
    "ninety.profiles.v1": "not-json",
    "ninety.subscriptions.v1": "[]",
  }), false);
  assert.equal(validateSnapshot({
    __schemaVersion: 2,
    "ninety.options.v1": "{}",
    "ninety.profiles.v1": "[]",
    "ninety.subscriptions.v1": JSON.stringify([{ id: "s" }]),
    "ninety.active.kind": "sub",
    "ninety.subscriptions.active": "missing",
  }), false);
});
