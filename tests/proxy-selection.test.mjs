import test from "node:test";
import assert from "node:assert/strict";
import {
  getRememberedProxySelection,
  rememberProxySelection,
  restoreRememberedProxySelection,
  selectionSourceKey,
} from "../src/lib/proxy-selection.js";

function installStorage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("выбранный сервер хранится отдельно для каждой подписки", () => {
  installStorage();
  const first = { kind: "sub", subscription: { id: "first" } };
  const second = { kind: "sub", subscription: { id: "second" } };
  rememberProxySelection(first, "node-stable-a");
  rememberProxySelection(second, "auto");
  assert.equal(getRememberedProxySelection(first), "node-stable-a");
  assert.equal(getRememberedProxySelection(second), "auto");
  assert.equal(selectionSourceKey(first), "sub:first");
});

test("повреждённое хранилище безопасно игнорируется", () => {
  installStorage();
  localStorage.setItem("ninety.proxy.selection.v1", "{");
  assert.equal(getRememberedProxySelection({ kind: "sub", subscription: { id: "first" } }), null);
});

test("сохранённая нода восстанавливается после временных ошибок API, не оставаясь на Авто", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "stable" } };
  rememberProxySelection(source, "node-last");
  let calls = 0;
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { now: "auto", all: ["auto", "node-last"] } } },
    apply: async (tag) => {
      calls++;
      assert.equal(tag, "node-last");
      if (calls < 3) throw new Error("Clash API ещё не готов");
      return { stale: false };
    },
    wait: async () => {},
  });
  assert.deepEqual(result, { status: "restored", tag: "node-last" });
  assert.equal(calls, 3);
});

test("legacy singleton proxy мигрирует в auto у многонодовой подписки", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "expanded" } };
  rememberProxySelection(source, "proxy");
  let calls = 0;
  const result = await restoreRememberedProxySelection({
    source,
    topology: {
      proxies: {
        proxy: { type: "Selector", now: "auto", all: ["auto", "lowest", "node-a"] },
      },
    },
    apply: async () => { calls++; },
  });
  assert.deepEqual(result, { status: "current", tag: "auto" });
  assert.equal(getRememberedProxySelection(source), "auto");
  assert.equal(calls, 0);
});

test("auto безопасно нормализуется в proxy когда источник стал одиночным", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "shrunk" } };
  rememberProxySelection(source, "auto");
  let calls = 0;
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { type: "VLESS" } } },
    apply: async () => { calls++; },
  });
  assert.deepEqual(result, { status: "current", tag: "proxy" });
  assert.equal(getRememberedProxySelection(source), "proxy");
  assert.equal(calls, 0);
});

test("удалённая из подписки нода не подменяется произвольной и остаётся запомненной", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "stable" } };
  rememberProxySelection(source, "node-removed");
  let calls = 0;
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { now: "auto", all: ["auto", "node-new"] } } },
    apply: async () => { calls++; },
  });
  assert.deepEqual(result, { status: "unavailable", tag: "node-removed" });
  assert.equal(getRememberedProxySelection(source), "node-removed");
  assert.equal(calls, 0);
});
