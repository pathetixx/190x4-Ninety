// A subscription that doesn't fit into storage (#233): adding and updating
// are rolled back precisely, while other write failures are still visible to the user.
import { test } from "node:test";
import assert from "node:assert/strict";

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
globalThis.dispatchEvent = (event) => { events.push(event); return true; };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

// Backend: a write with "big.example" is rejected the same way Rust rejects
// a snapshot larger than MAX_STORE_BYTES; failNext is a regular disk failure.
let backendRevision = 0;
let failNext = null;
let gate = null;
let body = "vless://uuid@small.example:443?security=tls#Small";
let serverInterval = null;
const tooBig = (store) => JSON.stringify(store).includes("big.example");
const invokeHandler = async (cmd, args) => {
  if (cmd === "profile_store_load") {
    return { exists: false, schemaVersion: 1, revision: 0, recoveredFromBackup: false, store: null };
  }
  if (cmd === "profile_store_replace") {
    if (gate) await gate;
    if (failNext) { const error = failNext; failNext = null; throw error; }
    if (args.expectedRevision !== backendRevision) throw "profile store revision conflict";
    if (tooBig(args.store)) throw "profile store exceeds 33554432 bytes";
    backendRevision += 1;
    return { revision: backendRevision };
  }
  if (cmd === "record_frontend_runtime_event") return null;
  if (cmd === "device_identity") return { hwid: null, deviceOs: "Windows", verOs: "" };
  if (args?.format) return { status: 200, body: "" };
  return { status: 200, body, profile_update_interval_hours: serverInterval };
};
globalThis.window = { __TAURI__: { core: { invoke: (...a) => invokeHandler(...a) } } };
globalThis.localStorage = makeStorage();
globalThis.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};

const store = await import("/lib/profile-store.js");
await store.initializeProfileStore({ invoke: (...a) => invokeHandler(...a), storage: localStorage });
const {
  addSubscriptionFromUrl,
  loadSubscriptions,
  refreshSubscription,
  saveSubscriptions,
} = await import("/lib/subscriptions.js");

const storeErrors = () => events.filter(e => e.type === "ninety:profile-store-error");

test("не помещающаяся подписка не добавляется и объясняется в окне, а не общим тостом", async () => {
  events.length = 0;
  body = "vless://uuid@big.example:443?security=tls#Big";
  await assert.rejects(
    () => addSubscriptionFromUrl("https://panel.example/big"),
    (err) => err.code === "too_large",
  );
  assert.equal(loadSubscriptions().some(s => s.url === "https://panel.example/big"), false);
  assert.equal(storeErrors().length, 0);
  assert.equal(store.profileStoreWriteFailure(), null, "откат записался");
});

test("обычный отказ записи при добавлении по-прежнему сообщается", async () => {
  events.length = 0;
  body = "vless://uuid@small.example:443?security=tls#Small";
  failNext = new Error("disk is full");
  await addSubscriptionFromUrl("https://panel.example/disk");
  assert.equal(storeErrors().at(-1)?.detail?.code, "write");
  assert.equal(store.profileStoreWriteFailure()?.code, "write");
});

test("откат refresh сохраняет переименование, сделанное во время записи", async () => {
  const id = loadSubscriptions().find(s => s.url === "https://panel.example/disk").id;
  // A successful write clears the previous failure flag.
  await saveSubscriptions(loadSubscriptions());
  const before = loadSubscriptions().find(s => s.id === id);

  body = "vless://uuid@big.example:443?security=tls#Big";
  let release;
  gate = new Promise(resolve => { release = resolve; });
  const refresh = refreshSubscription(id);
  // We let refresh publish the candidate and get into the write queue.
  await new Promise(resolve => setTimeout(resolve, 20));
  const renamed = loadSubscriptions().map(s => (s.id === id ? { ...s, name: "Мой сервер" } : s));
  saveSubscriptions(renamed);
  gate = null;
  release();

  await assert.rejects(() => refresh, (err) => err.code === "too_large");
  const after = loadSubscriptions().find(s => s.id === id);
  assert.equal(after.name, "Мой сервер");
  assert.deepEqual(after.profiles, before.profiles);
  assert.equal(JSON.stringify(after).includes("big.example"), false);
  assert.equal(store.profileStoreWriteFailure(), null);
});

test("откат refresh не смешивает интервал сервера с ручным интервалом пользователя", async () => {
  const id = loadSubscriptions().find(s => s.url === "https://panel.example/disk").id;
  saveSubscriptions(loadSubscriptions().map(s => (s.id === id
    ? { ...s, updateIntervalMode: "auto", updateIntervalHours: 6, serverUpdateIntervalHours: 6 }
    : s)));
  body = "vless://uuid@big.example:443?security=tls#Big";
  let release;
  gate = new Promise(resolve => { release = resolve; });
  // The panel sent a 12 h interval: refresh switches the auto mode to 12.
  serverInterval = 12;
  const refresh = refreshSubscription(id);
  await new Promise(resolve => setTimeout(resolve, 20));
  saveSubscriptions(loadSubscriptions().map(s => (s.id === id
    ? { ...s, updateIntervalMode: "manual", updateIntervalHours: 12 }
    : s)));
  gate = null;
  release();
  await assert.rejects(() => refresh, (err) => err.code === "too_large");
  const after = loadSubscriptions().find(s => s.id === id);
  assert.equal(after.updateIntervalMode, "manual");
  assert.equal(after.updateIntervalHours, 12);
  serverInterval = null;
});
