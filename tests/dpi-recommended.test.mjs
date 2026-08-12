// Бейдж «рекоменд.» на карточке стратегии. До этого он был прибит к ALT11
// строкой в разметке: приложение утверждало рекомендацию независимо от того,
// что авто-подбор намерил на сети пользователя, и не отличало замер от дефолта.
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
  // Дефолт, подтверждённый замером, — это уже замер, а не «из коробки».
  assert.deepEqual(recommendedStrategy(SET, "ALT11"), { name: "ALT11", measured: true });
});

test("исчезнувшая из набора стратегия не помечается", () => {
  // Канал стратегий обновляется без обновления приложения: сохранённое имя
  // может пропасть или смениться, и бейдж не должен указывать в пустоту.
  assert.deepEqual(recommendedStrategy(SET, "ALT99"), { name: "ALT11", measured: false });
  assert.deepEqual(recommendedStrategy([], "ALT7"), { name: "ALT11", measured: false });
  assert.deepEqual(recommendedStrategy(undefined, "ALT7"), { name: "ALT11", measured: false });
});
