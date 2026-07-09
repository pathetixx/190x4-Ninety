// Settings view: числовые поля нормализуются в JS, а не только HTML min/max.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async () => null,
    },
  },
};

const { normalizeNumberOption } = await import("/lib/settings-view.js");

test("normalizeNumberOption берёт fallback для пустого и некорректного значения", () => {
  assert.equal(normalizeNumberOption("urlTest.intervalSec", ""), 600);
  assert.equal(normalizeNumberOption("urlTest.intervalSec", "abc"), 600);
});

test("normalizeNumberOption клампит ниже min и выше max", () => {
  assert.equal(normalizeNumberOption("inbound.mixedPort", "80"), 1024);
  assert.equal(normalizeNumberOption("inbound.mixedPort", "70000"), 65535);
});

test("normalizeNumberOption сохраняет валидное число", () => {
  assert.equal(normalizeNumberOption("mux.maxStreams", "16"), 16);
});
