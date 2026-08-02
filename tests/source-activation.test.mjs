import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyActiveSourceTransaction,
  createSourceSwitchController,
} from "/lib/source-activation.js";
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

test("нерабочий профиль откатывается на последний подтверждённый источник", async () => {
  let active = { kind: "sub", id: "A" };
  const applied = [];
  const phases = [];
  let persisted = null;
  let rollbackNotified = 0;
  const controller = createSourceSwitchController({
    getActiveSource: () => active,
    applySource: (source) => { active = source; applied.push(source.id); },
    reconnect: async (_reason, context) => {
      phases.push(context.phase);
      return context.phase === "rollback";
    },
    confirm: async () => false,
    canContinue: () => true,
    persist: async (source) => { persisted = source.id; },
    onRollback: () => { rollbackNotified++; },
  });

  const result = await controller.activate({ kind: "sub", id: "B" }, {
    reason: "switch",
    rollbackReason: "restore",
  });

  assert.deepEqual(applied, ["B", "A"]);
  assert.deepEqual(phases, ["target", "rollback"]);
  assert.deepEqual(active, { kind: "sub", id: "A" });
  assert.equal(persisted, "A");
  assert.equal(result.restored, true);
  assert.equal(rollbackNotified, 1);
});

test("быстрое B → C не позволяет позднему B откатить подтверждённый C", async () => {
  let resolveB;
  const b = new Promise((resolve) => { resolveB = resolve; });
  let active = { kind: "sub", id: "A" };
  const applied = [];
  const controller = createSourceSwitchController({
    getActiveSource: () => active,
    applySource: (source) => { active = source; applied.push(source.id); },
    reconnect: async (_reason, { target }) => target.id === "B" ? b : true,
    confirm: async (target) => target.id === "C",
    canContinue: () => true,
  });

  const switchingB = controller.activate({ kind: "sub", id: "B" });
  const switchingC = controller.activate({ kind: "sub", id: "C" });
  const cResult = await switchingC;
  resolveB(false);
  const bResult = await switchingB;

  assert.equal(cResult.ready, true);
  assert.equal(bResult.stale, true);
  assert.deepEqual(active, { kind: "sub", id: "C" });
  assert.deepEqual(applied, ["B", "C"]);
});

test("ручное отключение во время проверки сохраняет выбранный профиль без автозапуска", async () => {
  let active = { kind: "single", id: "A" };
  let desired = true;
  let reconnects = 0;
  const controller = createSourceSwitchController({
    getActiveSource: () => active,
    applySource: (source) => { active = source; },
    reconnect: async () => { reconnects++; desired = false; return true; },
    confirm: async () => false,
    canContinue: () => desired,
  });

  const result = await controller.activate({ kind: "single", id: "B" });
  assert.equal(result.cancelled, true);
  assert.equal(reconnects, 1);
  assert.deepEqual(active, { kind: "single", id: "B" });
});
