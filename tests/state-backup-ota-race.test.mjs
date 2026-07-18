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
let savedSnapshot = null;
let saveCalls = 0;

globalThis.localStorage = localStorage;
globalThis.sessionStorage = makeStorage();
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args) => {
        if (command !== "state_backup_save") throw new Error(`unexpected invoke: ${command}`);
        saveCalls++;
        savedSnapshot = args.json;
      },
    },
  },
};

const { backupForUpdate, backupSoon } = await import("/lib/state-backup.js");

test("delayed background backup cannot overwrite the OTA resume snapshot", async () => {
  localStorage.setItem("ninety.options.v1", "{}");
  localStorage.setItem("ninety.profiles.v1", "[]");
  localStorage.setItem("ninety.subscriptions.v1", "[]");
  localStorage.setItem("ninety.update.resume", JSON.stringify({ vpn: true, dpi: false }));

  backupSoon(5);
  await backupForUpdate();
  const afterStrictSave = saveCalls;

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(saveCalls, afterStrictSave);
  assert.deepEqual(JSON.parse(savedSnapshot)["ninety.update.resume"], JSON.stringify({ vpn: true, dpi: false }));
});
