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

test("импорт .conf создаёт профиль и сообщает о непринятых строках", async () => {
  localStorage.clear();
  const conf = `[Interface]
Address = 172.16.0.2/32
DNS = 1.1.1.1
Table = off
MTU = 1280
Jc = 4
Jmin = 8
Jmax = 80
PrivateKey = nlhuTLXG3gAV8AJmw8jYngX3QkwdDoSPi2HxhGGSKrs=

[Peer]
PublicKey = zjVMotkY/dyEZygQ7crKvCtV1ODNZkVx1xe/1Bvvo8A=
Endpoint = 162.159.192.1:2408
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 15`;
  const result = await importAddInput(conf, { name: "Kosmos" });
  assert.equal(result.type, "config");
  assert.equal(result.source.kind, "single");
  assert.deepEqual(result.ignored, ["DNS", "Table"]);

  const { loadProfiles } = await import("/lib/singbox.js");
  const profile = loadProfiles().find(p => p.id === result.source.id);
  assert.equal(profile.proto, "wireguard");
  assert.equal(profile.name, "Kosmos");
  assert.deepEqual(profile.awg.jc, 4);
  // DNS и Table в профиль не переносятся — о них предупреждают.
  assert.deepEqual(profile.ignored, ["DNS", "Table"]);
});
