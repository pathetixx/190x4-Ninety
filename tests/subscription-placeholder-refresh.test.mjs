// Обновление подписки, когда панель вместо серверов вернула только заглушку
// (лимит устройств, «включите HWID», конец тарифа). Рабочие серверы не должны
// затираться нодой 0.0.0.0 — иначе фоновое обновление молча ломало VPN.
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), clear: () => store.clear(),
};
let body = "";
globalThis.window = { __TAURI__: { core: { invoke: async (cmd, args) => {
  if (cmd === "device_identity") return { hwid: null, deviceOs: "Windows", verOs: "" };
  if (cmd === "fetch_subscription") {
    if (args?.format) return { status: 200, body: "" };
    return { status: 200, body, hwid_active: true };
  }
  return null;
} } } };
globalThis.document = { getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };

const { addSubscriptionFromUrl, refreshSubscription, loadSubscriptions } = await import("/lib/subscriptions.js");

const REAL = [
  "vless://11111111-2222-3333-4444-555555555555@nl.example.com:443?security=tls#NL",
  "vless://11111111-2222-3333-4444-555555555555@de.example.com:443?security=tls#DE",
].join("\n");
const STUB = "vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1?security=none#Enable%20HWID%20parameter";

test("ответ из одних заглушек не затирает рабочие серверы и несёт сигнал HWID", async () => {
  body = REAL;
  const sub = await addSubscriptionFromUrl("https://panel.example/sub/stub");
  assert.equal(sub.profiles.length, 2);

  body = STUB;
  await assert.rejects(refreshSubscription(sub.id), (err) => {
    assert.equal(err.code, "placeholder_only");
    assert.ok(err.hwid, "ошибка несёт сигнал HWID для подсказки");
    return true;
  });
  const stored = loadSubscriptions().find((s) => s.id === sub.id);
  assert.deepEqual(stored.profiles.map((p) => p.host), ["nl.example.com", "de.example.com"]);
});

test("смешанный ответ с настоящими серверами обновляется как обычно", async () => {
  body = REAL;
  const sub = await addSubscriptionFromUrl("https://panel.example/sub/mixed");
  body = [STUB, "vless://11111111-2222-3333-4444-555555555555@fi.example.com:443?security=tls#FI"].join("\n");
  const r = await refreshSubscription(sub.id);
  assert.deepEqual(r.profiles.map((p) => p.host), ["fi.example.com"]);
});
