import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

globalThis.localStorage = makeStorage();
globalThis.window = globalThis.window || {};

const { importAddInput } = await import("/lib/add-modal.js");

test("первый импорт только сохраняет профиль и возвращает source, не активируя его сам", async () => {
  localStorage.clear();
  const result = await importAddInput(
    "vless://00000000-0000-4000-8000-000000000001@first.example:443?security=tls#first",
  );
  assert.ok(result.source.id);
  assert.equal(localStorage.getItem("ninety.profiles.active"), null);
});

test("standalone import возвращает ID и сам не переключает активную подписку", async () => {
  localStorage.clear();
  localStorage.setItem("ninety.active.kind", "sub");
  localStorage.setItem("ninety.subscriptions.active", "sub-old");

  const result = await importAddInput(
    "vless://00000000-0000-4000-8000-000000000001@example.com:443?security=tls#new",
  );

  assert.equal(result.source.kind, "single");
  assert.ok(result.source.id);
  assert.equal(localStorage.getItem("ninety.active.kind"), "sub");
  assert.equal(localStorage.getItem("ninety.subscriptions.active"), "sub-old");
});

test("импорт списка детерминированно возвращает ID первого нового профиля", async () => {
  localStorage.clear();
  localStorage.setItem("ninety.active.kind", "sub");
  const result = await importAddInput([
    "vless://00000000-0000-4000-8000-000000000001@one.example:443?security=tls#first",
    "trojan://password@two.example:443?security=tls#second",
  ].join("\n"));

  const profiles = JSON.parse(localStorage.getItem("ninety.profiles.v1"));
  assert.equal(result.source.kind, "single");
  assert.equal(result.source.id, profiles[0].id);
  assert.equal(localStorage.getItem("ninety.active.kind"), "sub");
});
