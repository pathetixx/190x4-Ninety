import { test } from "node:test";
import assert from "node:assert/strict";

const revisions = new Map();
globalThis.localStorage = {
  getItem: k => revisions.get(k) ?? null,
  setItem: (k, v) => revisions.set(k, String(v)),
};

const { createSourceMutationController, planSourceDeletion } = await import("/lib/source-mutations.js");

function fixture(state = "connected") {
  const sources = new Map([
    ["sub:a", { kind: "sub", subscription: { id: "a" }, nodes: [{ stableId: "a1", host: "old", port: 443 }] }],
    ["sub:b", { kind: "sub", subscription: { id: "b" }, nodes: [{ stableId: "b1", host: "idle", port: 443 }] }],
  ]);
  const calls = [];
  const controller = createSourceMutationController({
    getActiveSource: () => sources.get("sub:a"),
    getSource: (kind, id) => sources.get(`${kind}:${id}`),
    getState: () => state,
    invalidateRuntime: () => calls.push("invalidate"),
    resetEffectiveNode: () => calls.push("effective"),
    resetProxiesView: () => calls.push("proxies"),
    resetTraffic: () => calls.push("traffic"),
    resetQuality: () => calls.push("quality"),
    refreshProfiles: () => calls.push("refresh"),
    syncTray: () => calls.push("tray"),
    reconnect: async () => { calls.push("reconnect"); return true; },
  });
  return { sources, calls, controller };
}

for (const state of ["connected", "connecting"]) {
  test(`refresh active source при ${state} сбрасывает caches и делает один reconnect`, async () => {
    const f = fixture(state);
    await f.controller.run([{ kind: "sub", id: "a" }], async () => {
      f.sources.get("sub:a").nodes[0].host = "new";
    });
    assert.equal(f.calls.filter(x => x === "reconnect").length, 1);
    for (const call of ["invalidate", "effective", "proxies", "traffic", "quality", "tray"]) assert.ok(f.calls.includes(call), call);
  });
}

test("refresh inactive source не реконнектит", async () => {
  const f = fixture();
  await f.controller.run([{ kind: "sub", id: "b" }], async () => { f.sources.get("sub:b").nodes[0].host = "new"; });
  assert.equal(f.calls.includes("reconnect"), false);
});

test("refresh all с разным порядком completion даёт один reconnect", async () => {
  const f = fixture();
  await f.controller.run([{ kind: "sub", id: "a" }, { kind: "sub", id: "b" }], async () => {
    await Promise.all([
      new Promise(r => setTimeout(() => { f.sources.get("sub:b").nodes[0].host = "b2"; r(); }, 1)),
      new Promise(r => setTimeout(() => { f.sources.get("sub:a").nodes[0].host = "a2"; r(); }, 5)),
    ]);
  });
  assert.equal(f.calls.filter(x => x === "reconnect").length, 1);
});

test("delete active source выбирает fallback, delete inactive не переключает", () => {
  const common = { subscriptions: [{ id: "a" }, { id: "b" }], profiles: [{ id: "p" }], state: "connected" };
  const active = planSourceDeletion({ ...common, kind: "sub", id: "a", activeKey: "sub:a" });
  assert.deepEqual(active.fallback, { kind: "sub", id: "b" });
  assert.equal(active.mustStopBeforeDelete, false);
  const inactive = planSourceDeletion({ ...common, kind: "sub", id: "b", activeKey: "sub:a" });
  assert.equal(inactive.fallback, null);
});

for (const state of ["connected", "connecting"]) {
  test(`delete последнего active source при ${state} требует verified stop до удаления`, () => {
    const plan = planSourceDeletion({ kind: "sub", id: "a", activeKey: "sub:a", subscriptions: [{ id: "a" }], state });
    assert.equal(plan.fallback, null);
    assert.equal(plan.mustStopBeforeDelete, true);
  });
}
