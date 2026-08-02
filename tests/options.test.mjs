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
    quality: { endpoints: ["file:///tmp/a", "https://speed.example/test"] },
  });
  assert.equal(out.region, DEFAULT_OPTIONS.region);
  assert.equal(out.general.killSwitch, DEFAULT_OPTIONS.general.killSwitch);
  assert.equal(out.inbound.mixedPort, 1024);
  assert.equal(out.urlTest.connectionTestUrl, DEFAULT_OPTIONS.urlTest.connectionTestUrl);
  assert.deepEqual(out.quality.endpoints, ["https://speed.example/test"]);
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
