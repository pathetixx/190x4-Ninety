// The "recommended" badge on the strategy card. Previously it was nailed to ALT11
// by a string in the markup: the app claimed a recommendation regardless of
// what auto-tuning measured on the user's network, and didn't tell a measurement from the default.
import test from "node:test";
import assert from "node:assert/strict";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.document = { getElementById: () => null };
globalThis.window = { __TAURI__: { core: { invoke: async () => {} } }, dispatchEvent: () => {} };

const { recommendedStrategy } = await import("/lib/dpi-view.js");

const SET = [
  { id: "general", name: "general" },
  { id: "alt7", name: "ALT7" },
  { id: "alt11", name: "ALT11" },
];

test("без замеров рекомендация — профиль по умолчанию", () => {
  assert.deepEqual(recommendedStrategy(SET, ""), { name: "ALT11", measured: false });
  assert.deepEqual(recommendedStrategy(SET, null), { name: "ALT11", measured: false });
});

test("после авто-подбора помечается намеренная стратегия", () => {
  assert.deepEqual(recommendedStrategy(SET, "ALT7"), { name: "ALT7", measured: true });
  // A default confirmed by a measurement is already a measurement, not "out of the box".
  assert.deepEqual(recommendedStrategy(SET, "ALT11"), { name: "ALT11", measured: true });
});

test("исчезнувшая из набора стратегия не помечается", () => {
  // The strategy channel updates without updating the app: the saved name
  // may disappear or change, and the badge must not point at nothing.
  assert.deepEqual(recommendedStrategy(SET, "ALT99"), { name: "ALT11", measured: false });
  assert.deepEqual(recommendedStrategy([], "ALT7"), { name: "ALT11", measured: false });
  assert.deepEqual(recommendedStrategy(undefined, "ALT7"), { name: "ALT11", measured: false });
});
