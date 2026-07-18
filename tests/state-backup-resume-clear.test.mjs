import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (i) => Array.from(data.keys())[i] ?? null,
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

const localStorage = makeStorage();
let saveError = null;
let savedSnapshot = null;

globalThis.localStorage = localStorage;
globalThis.sessionStorage = makeStorage();
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args) => {
        if (command !== "state_backup_save") throw new Error(`unexpected invoke: ${command}`);
        if (saveError) throw saveError;
        savedSnapshot = args.json;
      },
    },
  },
};

localStorage.setItem("ninety.options.v1", "{}");
localStorage.setItem("ninety.profiles.v1", "[]");
localStorage.setItem("ninety.subscriptions.v1", "[]");
localStorage.setItem("ninety.update.resume", JSON.stringify({ vpn: true, dpi: false }));

const { backupForUpdate, backupNow } = await import("/lib/state-backup.js");

test("failed RuntimeReady backup restores resume marker", async () => {
  await backupForUpdate();
  const resume = localStorage.getItem("ninety.update.resume");
  localStorage.removeItem("ninety.update.resume");
  saveError = new Error("disk full");

  await assert.rejects(backupNow(), /disk full/);
  assert.equal(localStorage.getItem("ninety.update.resume"), resume);

  saveError = null;
  localStorage.removeItem("ninety.update.resume");
  await backupNow();
  assert.equal(localStorage.getItem("ninety.update.resume"), null);
  assert.equal(JSON.parse(savedSnapshot)["ninety.update.resume"], undefined);
});
