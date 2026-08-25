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
  assert.equal(
    getRememberedProxySelection({ kind: "sub", subscription: { id: "first" } }),
    null,
  );
});

test("сохранённая нода восстанавливается после временных ошибок API", async () => {
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
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { type: "Selector", now: "auto", all: ["auto", "node-a"] } } },
    apply: async () => assert.fail("apply не должен вызываться"),
  });
  assert.deepEqual(result, {
    status: "reset",
    tag: "auto",
    previousTag: "proxy",
    reason: "legacy_singleton_selection",
  });
  assert.equal(getRememberedProxySelection(source), "auto");
});

test("устаревшая ручная нода сбрасывается на auto и не блокирует SourceSwitch", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "rotated" } };
  rememberProxySelection(source, "node-provider-removed");
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { type: "Selector", now: "auto", all: ["auto", "lowest", "node-new"] } } },
    apply: async () => assert.fail("apply не должен вызываться"),
  });
  assert.deepEqual(result, {
    status: "reset",
    tag: "auto",
    previousTag: "node-provider-removed",
    reason: "remembered_selection_unavailable",
  });
  assert.equal(getRememberedProxySelection(source), "auto");
});

test("fallback сохраняется только после подтверждённого Clash apply", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "rotated-apply" } };
  rememberProxySelection(source, "node-old");
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { type: "Selector", now: "lowest", all: ["auto", "lowest", "node-new"] } } },
    apply: async (tag) => {
      assert.equal(tag, "auto");
      assert.equal(getRememberedProxySelection(source), "node-old");
      return { stale: false };
    },
  });
  assert.equal(result.status, "reset");
  assert.equal(getRememberedProxySelection(source), "auto");
});

test("ошибка fallback не уничтожает старое предпочтение", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "rotated-fail" } };
  rememberProxySelection(source, "node-old");
  await assert.rejects(restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { type: "Selector", now: "lowest", all: ["auto", "lowest", "node-new"] } } },
    attempts: 1,
    apply: async () => { throw new Error("Clash unavailable"); },
  }), /Clash unavailable/);
  assert.equal(getRememberedProxySelection(source), "node-old");
});

test("selector без auto не подменяет удалённую ноду произвольным маршрутом", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "malformed" } };
  rememberProxySelection(source, "node-removed");
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { type: "Selector", now: "node-new", all: ["lowest", "node-new"] } } },
    apply: async () => assert.fail("apply не должен вызываться"),
  });
  assert.deepEqual(result, { status: "unavailable", tag: "node-removed" });
  assert.equal(getRememberedProxySelection(source), "node-removed");
});

test("старый selector tag нормализуется в proxy когда источник стал одиночным", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "shrunk" } };
  rememberProxySelection(source, "node-old");
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { type: "VLESS" } } },
    apply: async () => assert.fail("apply не должен вызываться"),
  });
  assert.deepEqual(result, {
    status: "reset",
    tag: "proxy",
    previousTag: "node-old",
    reason: "single_route_normalized",
  });
  assert.equal(getRememberedProxySelection(source), "proxy");
});

test("stale операция не сохраняет fallback", async () => {
  installStorage();
  const source = { kind: "sub", subscription: { id: "stale" } };
  rememberProxySelection(source, "node-old");
  const result = await restoreRememberedProxySelection({
    source,
    topology: { proxies: { proxy: { type: "Selector", now: "auto", all: ["auto", "node-new"] } } },
    isCurrent: () => false,
    apply: async () => assert.fail("apply не должен вызываться"),
  });
  assert.equal(result.status, "stale");
  assert.equal(getRememberedProxySelection(source), "node-old");
});
