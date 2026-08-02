import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeIdleGate } from "/lib/runtime-idle-gate.js";

test("source reconnect waits for idle and resumes once", async () => {
  let state = "disconnecting";
  let current = true;
  const gate = createRuntimeIdleGate({
    getState: () => state,
    isCurrent: () => current,
  });

  const waiting = gate.wait(7);
  assert.equal(gate.pending(), 1);
  state = "idle";
  gate.notify();
  assert.equal(await waiting, true);
  assert.equal(gate.pending(), 0);
});

test("stale disconnecting waiter is cancelled by a newer intent", async () => {
  let state = "disconnecting";
  let currentEpoch = 7;
  const gate = createRuntimeIdleGate({
    getState: () => state,
    isCurrent: (epoch) => epoch === currentEpoch,
  });

  const waiting = gate.wait(7);
  currentEpoch = 8;
  gate.notify();
  assert.equal(await waiting, false);
  assert.equal(gate.pending(), 0);
});

test("cleanup error does not leave a reconnect waiter hanging", async () => {
  let state = "disconnecting";
  const gate = createRuntimeIdleGate({
    getState: () => state,
    isCurrent: () => true,
  });

  const waiting = gate.wait(7);
  state = "cleanup_error";
  gate.notify();
  assert.equal(await waiting, false);
  assert.equal(gate.pending(), 0);
});

test("already idle current intent does not enqueue a waiter", async () => {
  const gate = createRuntimeIdleGate({
    getState: () => "idle",
    isCurrent: () => true,
  });
  assert.equal(await gate.wait(1), true);
  assert.equal(gate.pending(), 0);
});
