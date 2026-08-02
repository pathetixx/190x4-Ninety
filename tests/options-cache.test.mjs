import test from "node:test";
import assert from "node:assert/strict";

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

test("options cache exposes frozen snapshot and mutable compatibility clones", async () => {
  globalThis.localStorage = storage({
    "ninety.options.v1": JSON.stringify({ region: "cn", inbound: { mixedPort: 8080 } }),
    "ninety.options.v1.logWarnMigrated": "1",
  });
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  const options = await import("../src/lib/options.js?options-cache-1");
  const sharedA = options.getOptionsSnapshot();
  const sharedB = options.getOptionsSnapshot();
  assert.equal(sharedA, sharedB);
  assert.equal(Object.isFrozen(sharedA), true);
  assert.equal(Object.isFrozen(sharedA.inbound), true);
  assert.equal(sharedA.region, "cn");
  assert.equal(sharedA.inbound.mixedPort, 8080);

  const cloneA = options.loadOptions();
  const cloneB = options.loadOptions();
  assert.notEqual(cloneA, cloneB);
  cloneA.region = "ir";
  assert.equal(options.getOptionsSnapshot().region, "cn");
});

test("save and update atomically replace cached snapshot", async () => {
  globalThis.localStorage = storage();
  const events = [];
  globalThis.window = {
    addEventListener() {},
    dispatchEvent(event) { events.push(event); },
  };
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  const options = await import("../src/lib/options.js?options-cache-2");
  options.saveOptions({ region: "tr" });
  assert.equal(options.getOptionsSnapshot().region, "tr");

  options.updateOption("warp.enabled", true);
  assert.equal(options.getOptionsSnapshot().warp.enabled, true);
  assert.equal(events.at(-1).type, "ninety:option-changed");
  assert.deepEqual(events.at(-1).detail, { path: "warp.enabled", value: true });
});

test("updateOption rejects prototype-pollution paths", async () => {
  globalThis.localStorage = storage();
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  const options = await import("../src/lib/options.js?options-cache-3");
  assert.throws(
    () => options.updateOption("__proto__.ninetyPolluted", true),
    /unsafe option path/i,
  );
  assert.throws(
    () => options.updateOption("constructor.prototype.ninetyPolluted", true),
    /unsafe option path/i,
  );
  assert.equal(({}).ninetyPolluted, undefined);
});
