import { test } from "node:test";
import assert from "node:assert/strict";
import { completeSuccessfulConnect, runReconnectAttempt } from "/lib/connect-network-result.js";
import { createLatestWinsReconnectQueue } from "/lib/reconnect-queue.js";
import { createSourceSwitchController } from "/lib/source-activation.js";

const source = (id) => ({ kind: "sub", id });

function createHarness({
  targetResult = true,
  rollbackResult = true,
  targetVerdict = { status: "ready" },
  rollbackVerdict = { status: "ready" },
} = {}) {
  let active = source("A");
  let runtimeSource = source("A");
  let runtimeState = "connected";
  const connectCalls = [];
  const generations = [];
  const queueResults = [];
  const verifierCalls = [];
  const persisted = [];
  const completed = [];
  let rollbackCount = 0;
  let rollbackFailedCount = 0;

  const connectNetwork = async ({ phase, target, operationToken }) => {
    connectCalls.push({ phase, target: target.id, operationId: operationToken?.id });
    const shouldConnect = phase === "rollback" ? rollbackResult : targetResult;
    if (!shouldConnect) {
      runtimeState = "idle";
      return false;
    }
    generations.push({ phase, target: target.id });
    return completeSuccessfulConnect({
      finalizeConnected: () => {
        runtimeState = "connected";
        return true;
      },
      onConnected: () => { runtimeSource = target; },
    });
  };

  const performAutoReconnectOnce = (request) => runReconnectAttempt(connectNetwork, request);
  const reconnectQueue = createLatestWinsReconnectQueue({ run: performAutoReconnectOnce });
  const reconnect = async (_reason, context) => {
    const result = await reconnectQueue.enqueue(context);
    queueResults.push(result);
    return result.status === "completed" && result.value === true;
  };

  const controller = createSourceSwitchController({
    getActiveSource: () => active,
    applySource: (next) => { active = next; },
    beginOperation: async (_target, context) => ({
      id: context.phase === "rollback" ? 2 : 1,
      kind: "sourceSwitch",
    }),
    completeOperation: async (token) => { completed.push(token.id); },
    reconnect,
    confirm: async (target, { token, isCurrent }) => {
      verifierCalls.push({ target: target.id, operationId: token?.id, current: isCurrent() });
      return target.id === "B" ? targetVerdict : rollbackVerdict;
    },
    canContinue: () => true,
    persist: async (next) => { persisted.push(next.id); },
    onRollback: () => { rollbackCount++; },
    onRollbackFailed: () => { rollbackFailedCount++; },
  });

  return {
    controller,
    connectCalls,
    generations,
    queueResults,
    verifierCalls,
    persisted,
    completed,
    getActive: () => active,
    getRuntimeSource: () => runtimeSource,
    getRuntimeState: () => runtimeState,
    rollbackCount: () => rollbackCount,
    rollbackFailedCount: () => rollbackFailedCount,
  };
}

test("successful connect branch returns true only after finalization", () => {
  const order = [];
  const result = completeSuccessfulConnect({
    finalizeConnected: () => { order.push("finalize"); return true; },
    onConnected: () => { order.push("connected"); },
  });

  assert.equal(result, true);
  assert.deepEqual(order, ["finalize", "connected"]);
});

test("failed connect branch returns false and does not publish connected state", () => {
  let published = false;
  const result = completeSuccessfulConnect({
    finalizeConnected: () => false,
    onConnected: () => { published = true; },
  });

  assert.equal(result, false);
  assert.equal(published, false);
});

test("cancelled connect branch returns false after the final identity check", () => {
  let networkIntent = "idle";
  let cleanedUp = false;
  const result = completeSuccessfulConnect({
    finalizeConnected: () => {
      if (networkIntent !== "connected") {
        cleanedUp = true;
        return false;
      }
      return true;
    },
    onConnected: () => { throw new Error("cancelled connect must not publish connected"); },
  });

  assert.equal(result, false);
  assert.equal(cleanedUp, true);
  networkIntent = "connected";
});

test("source switch propagates the real completed result to verifier without rollback", async () => {
  const h = createHarness();
  const result = await h.controller.activate(source("B"), { reason: "switch" });

  assert.equal(result.ready, true);
  assert.deepEqual(h.getActive(), source("B"));
  assert.deepEqual(h.getRuntimeSource(), source("B"));
  assert.equal(h.getRuntimeState(), "connected");
  assert.deepEqual(h.connectCalls, [{ phase: "target", target: "B", operationId: 1 }]);
  assert.deepEqual(h.queueResults, [{ status: "completed", value: true }]);
  assert.deepEqual(h.verifierCalls, [{ target: "B", operationId: 1, current: true }]);
  assert.deepEqual(h.generations, [{ phase: "target", target: "B" }]);
  assert.deepEqual(h.persisted, ["B"]);
  assert.deepEqual(h.completed, [1]);
  assert.equal(h.rollbackCount(), 0);
  assert.equal(h.rollbackFailedCount(), 0);
});

test("real target failure performs one bounded rollback and never verifies a dead target", async () => {
  const h = createHarness({ targetResult: false });
  const result = await h.controller.activate(source("B"), { reason: "switch" });

  assert.equal(result.restored, true);
  assert.deepEqual(h.getActive(), source("A"));
  assert.deepEqual(h.getRuntimeSource(), source("A"));
  assert.deepEqual(h.connectCalls, [
    { phase: "target", target: "B", operationId: 1 },
    { phase: "rollback", target: "A", operationId: 2 },
  ]);
  assert.deepEqual(h.verifierCalls, [{ target: "A", operationId: 2, current: true }]);
  assert.deepEqual(h.generations, [{ phase: "rollback", target: "A" }]);
  assert.equal(h.rollbackCount(), 1);
  assert.equal(h.rollbackFailedCount(), 0);
});

test("confirmed verifier hard failure rolls back exactly once", async () => {
  const h = createHarness({ targetVerdict: { status: "hardFailed" } });
  const result = await h.controller.activate(source("B"), { reason: "switch" });

  assert.equal(result.restored, true);
  assert.deepEqual(h.verifierCalls, [
    { target: "B", operationId: 1, current: true },
    { target: "A", operationId: 2, current: true },
  ]);
  assert.deepEqual(h.generations, [
    { phase: "target", target: "B" },
    { phase: "rollback", target: "A" },
  ]);
  assert.equal(h.rollbackCount(), 1);
});

test("unverified target remains selected without destructive rollback", async () => {
  const h = createHarness({ targetVerdict: { status: "unverified" } });
  const result = await h.controller.activate(source("B"), { reason: "switch" });

  assert.equal(result.unverified, true);
  assert.deepEqual(h.getActive(), source("B"));
  assert.deepEqual(h.generations, [{ phase: "target", target: "B" }]);
  assert.deepEqual(h.connectCalls, [{ phase: "target", target: "B", operationId: 1 }]);
  assert.equal(h.rollbackCount(), 0);
  assert.equal(h.rollbackFailedCount(), 0);
});
