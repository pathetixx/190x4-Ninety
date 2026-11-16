// Хранилище профилей ограничено по размеру (#233). Слишком большая запись не
// должна выглядеть как «защищённое хранилище недоступно» и не должна молча
// оставлять приложение в состоянии «всё сохранено».
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const events = [];
globalThis.localStorage = makeStorage();
globalThis.window = {};
globalThis.dispatchEvent = (event) => { events.push(event); return true; };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const calls = [];
let backendRevision = 0;
const invoke = async (command, args) => {
  calls.push({ command, args });
  if (command === "profile_store_load") {
    return { exists: false, schemaVersion: 1, revision: 0, recoveredFromBackup: false, store: null };
  }
  if (command === "profile_store_replace") {
    if (args.expectedRevision !== backendRevision) throw new Error("profile store revision conflict");
    backendRevision += 1;
    return { revision: backendRevision };
  }
  if (command === "record_frontend_runtime_event") return null;
  throw new Error(`unexpected invoke: ${command}`);
};

const store = await import("/lib/profile-store.js");
await store.initializeProfileStore({ invoke, storage: localStorage });

const bigSubscription = () => ({
  id: "big",
  url: "https://example.com/sub",
  profiles: [{ id: "n1", raw: "x".repeat(store.PROFILE_STORE_MAX_BYTES) }],
});

test("лимит во фронте совпадает с лимитом Rust-хранилища", () => {
  const rust = readFileSync("src-tauri/src/profile_store.rs", "utf8");
  const match = rust.match(/const MAX_STORE_BYTES: usize = (\d+) \* 1024 \* 1024;/);
  assert.ok(match, "MAX_STORE_BYTES not found");
  assert.equal(store.PROFILE_STORE_MAX_BYTES, Number(match[1]) * 1024 * 1024);
});

test("слишком большая запись отклоняется понятной ошибкой без вызова backend", async () => {
  const before = calls.filter(c => c.command === "profile_store_replace").length;
  const result = await store.saveSubscriptionsToStore([bigSubscription()], { quietTooLarge: true });
  assert.equal(result.persisted, false);
  assert.equal(result.error.code, "too_large");
  assert.equal(calls.filter(c => c.command === "profile_store_replace").length, before);
  assert.equal(store.profileStoreWriteFailure().code, "too_large");
  // Хранилище исправно: это отказ одной записи, а не деградация.
  assert.equal(store.profileStoreIsDegraded(), false);
  await new Promise(resolve => setTimeout(resolve, 0));
  const logged = calls.find(c => c.command === "record_frontend_runtime_event");
  assert.deepEqual(logged?.args, { phase: "profile_store_write", result: "failed", reason: "too_large" });
});

test("ошибка размера приходит событием с кодом, а не общим отказом", async () => {
  events.length = 0;
  await store.saveSubscriptionsToStore([bigSubscription()]);
  await new Promise(resolve => setTimeout(resolve, 0));
  const error = events.find(e => e.type === "ninety:profile-store-error");
  assert.equal(error?.detail?.stage, "write");
  assert.equal(error?.detail?.code, "too_large");
});

test("после уменьшения данных запись снова проходит и флаг сбрасывается", async () => {
  const result = await store.saveSubscriptionsToStore([{ id: "small", url: "https://example.com/s", profiles: [] }]);
  assert.equal(result.persisted, true);
  assert.equal(store.profileStoreWriteFailure(), null);
  assert.equal(store.profileStoreIsDegraded(), false);
  assert.deepEqual(store.loadSubscriptionsFromStore().map(s => s.id), ["small"]);
});
