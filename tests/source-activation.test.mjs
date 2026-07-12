import { test } from "node:test";
import assert from "node:assert/strict";
import { applyActiveSourceTransaction } from "/lib/source-activation.js";
import { createConnectionAttemptGate } from "/lib/connection-attempt.js";

function harness(initialState) {
  const calls = [];
  let state = initialState;
  let reconnects = 0;
  const gate = createConnectionAttemptGate();
  const oldEpoch = gate.begin();
  const deps = {
    setActiveKind: (kind) => calls.push(["kind", kind]),
    setActiveProfileId: (id) => calls.push(["profile", id]),
    setActiveSubscriptionId: (id) => calls.push(["sub", id]),
    resetEffectiveNode: () => calls.push(["reset-effective"]),
    resetProxiesView: () => calls.push(["reset-proxies"]),
    refreshProfiles: () => calls.push(["refresh"]),
    syncTray: () => calls.push(["tray"]),
    getState: () => state,
    reconnectForSourceChange: () => {
      reconnects++;
      gate.cancel();
      state = "idle";
      return true;
    },
  };
  return {
    calls,
    deps,
    gate,
    oldEpoch,
    reconnects: () => reconnects,
    state: () => state,
  };
}

test("импорт подписки при connected атомарно активирует B и запускает ровно один reconnect", () => {
  const h = harness("connected");
  const result = applyActiveSourceTransaction(
    { kind: "sub", id: "sub-B" },
    h.deps,
    { reconnect: true, silent: true, reason: "switch" },
  );

  assert.deepEqual(h.calls.slice(0, 2), [["sub", "sub-B"], ["kind", "sub"]]);
  assert.deepEqual(h.calls.slice(2), [
    ["reset-effective"], ["reset-proxies"], ["refresh"], ["tray"],
  ]);
  assert.equal(h.reconnects(), 1);
  assert.equal(result.reconnected, true);
  assert.equal(h.gate.isCurrent(h.oldEpoch), false);
});

test("импорт во время connecting инвалидирует старый epoch до позднего завершения", () => {
  const h = harness("connecting");
  applyActiveSourceTransaction(
    { kind: "sub", id: "sub-B" },
    h.deps,
    { reconnect: true, silent: true },
  );

  let lateStartChangedUi = false;
  if (h.gate.isCurrent(h.oldEpoch)) lateStartChangedUi = true;
  assert.equal(lateStartChangedUi, false);
  assert.equal(h.state(), "idle");
  assert.equal(h.reconnects(), 1);
});

test("импорт в idle применяет источник без reconnect и оставляет его следующему connect", () => {
  const h = harness("idle");
  const result = applyActiveSourceTransaction(
    { kind: "sub", id: "sub-B" },
    h.deps,
    { reconnect: true, silent: true },
  );

  assert.equal(result.reconnected, false);
  assert.equal(h.reconnects(), 0);
  assert.deepEqual(h.calls.slice(0, 2), [["sub", "sub-B"], ["kind", "sub"]]);
});

test("первый импорт в onboarding не создаёт reconnect и оставляет wizard один connect", () => {
  const h = harness("idle");
  let wizardConnects = 0;
  applyActiveSourceTransaction(
    { kind: "sub", id: "first-sub" },
    h.deps,
    { reconnect: true, silent: true },
  );
  wizardConnects++;
  assert.equal(h.reconnects(), 0);
  assert.equal(wizardConnects, 1);
});

test("standalone после подписки всегда получает явный active profile id", () => {
  const h = harness("idle");
  applyActiveSourceTransaction(
    { kind: "single", id: "profile-new" },
    h.deps,
    { reconnect: true, silent: true },
  );
  assert.deepEqual(h.calls.slice(0, 2), [["profile", "profile-new"], ["kind", "single"]]);
});
