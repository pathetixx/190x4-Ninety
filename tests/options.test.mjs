import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OPTIONS,
  OPTIONS_SCHEMA_VERSION,
  normalizeOptions,
} from "/lib/options.js";

test("process lookup is enabled by default and preserves a versioned opt-out", () => {
  assert.equal(DEFAULT_OPTIONS.route.processLookup, true);
  assert.equal(normalizeOptions({}).route.processLookup, true);
  assert.equal(
    normalizeOptions({
      schemaVersion: OPTIONS_SCHEMA_VERSION,
      route: { processLookup: false },
    }).route.processLookup,
    false,
  );
});

test("normalizeOptions чинит повреждённые enum, boolean, port и URL", () => {
  const out = normalizeOptions({
    region: "invalid",
    general: { killSwitch: "false" },
    inbound: { mixedPort: 99 },
    urlTest: { connectionTestUrl: "javascript:alert(1)" },
    quality: { endpoints: ["file:///tmp/a", "https://speed.cloudflare.com/__down?bytes=262144"] },
  });
  assert.equal(out.region, DEFAULT_OPTIONS.region);
  assert.equal(out.general.killSwitch, DEFAULT_OPTIONS.general.killSwitch);
  assert.equal(out.inbound.mixedPort, 1024);
  assert.equal(out.urlTest.connectionTestUrl, DEFAULT_OPTIONS.urlTest.connectionTestUrl);
  assert.deepEqual(out.quality.endpoints, ["https://speed.cloudflare.com/__down?bytes=262144"]);
});

// Rust accepts the quality probe only on its allowlist (quality.rs).
// A foreign address let through here wouldn't be rejected by the setting but would silently break the whole
// engine: the backend returns an error on every probe, and the channel is forever "UNKNOWN".
test("quality endpoints ограничены тем же allowlist, что и backend", () => {
  const foreign = normalizeOptions({
    quality: { endpoints: ["https://speed.example/test", "http://speed.cloudflare.com/__down"] },
  });
  assert.deepEqual(foreign.quality.endpoints, DEFAULT_OPTIONS.quality.endpoints);

  const credentials = normalizeOptions({
    quality: { endpoints: ["https://user:pass@speed.cloudflare.com/__down"] },
  });
  assert.deepEqual(credentials.quality.endpoints, DEFAULT_OPTIONS.quality.endpoints);

  const allowed = normalizeOptions({
    quality: { endpoints: ["https://SPEED.CLOUDFLARE.COM/__down?bytes=16384"] },
  });
  assert.deepEqual(allowed.quality.endpoints, ["https://SPEED.CLOUDFLARE.COM/__down?bytes=16384"]);
});

test("normalizeOptions упорядочивает диапазоны и не мутирует input", () => {
  const input = { tlsTricks: { paddingSize: { from: 900, to: 100 } } };
  const out = normalizeOptions(input);
  assert.deepEqual(out.tlsTricks.paddingSize, { from: 100, to: 900 });
  assert.deepEqual(input.tlsTricks.paddingSize, { from: 900, to: 100 });
});

test("normalizeOptions игнорирует prototype-pollution ключи из localStorage", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const out = normalizeOptions(input);
  assert.equal(out.polluted, undefined);
  assert.equal({}.polluted, undefined);
});

// The mixed inbound and the clash API listen on one loopback: matching ports brought down the bind
// inside the core, while the UI showed a nameless "failed to connect".
test("options: порт clash-API не может совпасть с mixed-портом", () => {
  const clashCollision = normalizeOptions({
    inbound: { mixedPort: 7890 },
    experimental: { clashApiPort: 7890 },
  });
  assert.equal(clashCollision.inbound.mixedPort, 7890);
  assert.notEqual(clashCollision.experimental.clashApiPort, 7890);

  // The user took the clash API default itself for mixed — then the mixed port yields.
  const bothDefaults = normalizeOptions({
    inbound: { mixedPort: 9090 },
    experimental: { clashApiPort: 9090 },
  });
  assert.notEqual(bothDefaults.inbound.mixedPort, bothDefaults.experimental.clashApiPort);
});

test("настройки диагностики можно сохранить: путь есть в белом списке", async () => {
  // updateOption throws on an unknown path, and a whitelist miss looks
  // like "the interface doesn't respond": that's exactly how the country pack selection
  // silently broke — the screen drew the list, and the write failed with an exception.
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  const { updateOption } = await import("../src/lib/options.js?diagnose-paths");
  assert.equal(updateOption("diagnose.regionPack", "de").diagnose.regionPack, "de");
  assert.equal(
    updateOption("diagnose.pinned", [{ id: "x", name: "x", url: "https://x/" }]).diagnose.pinned.length,
    1,
  );
});

test("порт для локальной сети уступает mixed и clash-API", () => {
  const out = normalizeOptions({
    inbound: { mixedPort: 7891, lanPort: 7891 },
    experimental: { clashApiPort: 7892 },
  });
  assert.equal(out.inbound.mixedPort, 7891);
  assert.equal(out.experimental.clashApiPort, 7892);
  assert.equal(out.inbound.lanPort, 7893);
  assert.equal(normalizeOptions({}).inbound.lanPort, 7891);
});

// The neighbors' login and password are kept by the backend in encrypted form: they must not get into
// settings (localStorage is plain text on disk).
test("normalizeOptions выбрасывает логин и пароль для сети", () => {
  const out = normalizeOptions({
    inbound: { lanAuth: true, lanUsername: "ninety", lanPassword: "Secret123" },
  });
  assert.equal(out.inbound.lanAuth, true);
  assert.equal("lanUsername" in out.inbound, false);
  assert.equal("lanPassword" in out.inbound, false);
  assert.doesNotMatch(JSON.stringify(out), /Secret123/);
});

// 0.8.0 kept the pair in settings: it's taken once before the first normalize.
test("пара для сети из 0.8.0 забирается из настроек один раз", async () => {
  const data = new Map([["ninety.options.v1", JSON.stringify({
    inbound: { lanAuth: true, lanUsername: "ninety", lanPassword: "Secret123" },
  })]]);
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  const { takeLegacyLanCredentials, loadOptions, saveOptions } = await import("../src/lib/options.js?legacy-lan");
  assert.deepEqual(takeLegacyLanCredentials(), { username: "ninety", password: "Secret123" });
  assert.equal(takeLegacyLanCredentials(), null);
  saveOptions(loadOptions());
  assert.doesNotMatch(data.get("ninety.options.v1"), /Secret123/);
});

// "Make them mine" detaches the base of the current region only: another region again
// works with its own base, otherwise choosing a country in settings would silently change nothing.
test("смена региона возвращает его базу", async () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  const { updateOption } = await import("../src/lib/options.js?region-detached");
  updateOption("region", "ru");
  assert.equal(updateOption("route.regionDetached", true).route.regionDetached, true);
  assert.equal(updateOption("region", "ru").route.regionDetached, true, "тот же регион базу не возвращает");
  assert.equal(updateOption("region", "by").route.regionDetached, false);
});
