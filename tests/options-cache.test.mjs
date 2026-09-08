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
  assert.equal(sharedA.route.processLookup, true);
  assert.equal(JSON.parse(localStorage.getItem("ninety.options.v1")).schemaVersion, options.OPTIONS_SCHEMA_VERSION);

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
  assert.throws(
    () => options.updateOption("unknown.path", true),
    /unsafe option path/i,
  );
  assert.equal(({}).ninetyPolluted, undefined);
});

test("legacy regression false is migrated, while a versioned opt-out remains false", async () => {
  globalThis.localStorage = storage({
    "ninety.options.v1": JSON.stringify({ route: { processLookup: false } }),
  });
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  const options = await import("../src/lib/options.js?options-cache-process-lookup");
  assert.equal(options.loadOptions().route.processLookup, true);
  const migrated = JSON.parse(localStorage.getItem("ninety.options.v1"));
  assert.equal(migrated.schemaVersion, options.OPTIONS_SCHEMA_VERSION);
  assert.equal(migrated.route.processLookup, true);

  const explicit = options.loadOptions();
  explicit.route.processLookup = false;
  options.saveOptions(explicit);
  assert.equal(options.loadOptions().route.processLookup, false);
  const saved = JSON.parse(localStorage.getItem("ninety.options.v1"));
  assert.equal(saved.schemaVersion, options.OPTIONS_SCHEMA_VERSION);
  assert.equal(saved.route.processLookup, false);
});

test("updateOption does not freeze caller-owned structures", async () => {
  globalThis.localStorage = storage({ "ninety.options.v1.logWarnMigrated": "1" });
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  const options = await import("../src/lib/options.js?options-cache-caller-freeze");

  // Экран правил маршрутизации держит СВОЙ массив и мутирует его дальше:
  // push второго правила, замену отредактированного, toggle, drag-reorder.
  const rules = [{ id: "r-1", enabled: true, type: "domain", match: "suffix", values: ["a.com"], action: "proxy" }];
  options.updateOption("route.customRules", rules);

  assert.equal(Object.isFrozen(rules), false);
  assert.equal(Object.isFrozen(rules[0]), false);
  // Раньше обе операции падали TypeError: снапшот морозился вместе с массивом
  // вызывающего, и «Сохранить» переставала отвечать после первого правила.
  rules.push({ id: "r-2", enabled: true, type: "ip", values: ["1.2.3.4/32"], action: "direct" });
  rules[0].enabled = false;

  // Снапшот при этом не едет задним числом — он независимая копия.
  assert.equal(options.getOptionsSnapshot().route.customRules.length, 1);
  assert.equal(options.getOptionsSnapshot().route.customRules[0].enabled, true);
  assert.equal(Object.isFrozen(options.getOptionsSnapshot().route.customRules), true);
});

test("snapshot fallback does not freeze module defaults", async () => {
  globalThis.localStorage = {
    getItem() { throw new Error("storage blocked"); },
    setItem() { throw new Error("storage blocked"); },
    removeItem() {},
  };
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  const options = await import("../src/lib/options.js?options-cache-default-freeze");
  const snapshot = options.getOptionsSnapshot();

  // Снапшот обязан быть read-only — это его контракт.
  assert.equal(Object.isFrozen(snapshot), true);
  // Но normalizeOptions отдаёт out со ССЫЛКАМИ на массивы DEFAULT_OPTIONS
  // (deepMerge не копирует массивы), поэтому без клона фолбэк морозил сам
  // модульный дефолт — на всё время жизни процесса.
  assert.equal(Object.isFrozen(options.DEFAULT_OPTIONS.route.customRules), false);
  assert.equal(Object.isFrozen(options.DEFAULT_OPTIONS.diagnose.pinned), false);
});
