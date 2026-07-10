import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectionAttemptGate } from "/lib/connection-attempt.js";

test("connection attempt gate инвалидирует preflight до завершения await", async () => {
  const gate = createConnectionAttemptGate();
  const first = gate.begin();
  assert.equal(gate.isCurrent(first), true);
  gate.cancel();
  await Promise.resolve();
  assert.equal(gate.isCurrent(first), false);
  const second = gate.begin();
  assert.equal(gate.isCurrent(second), true);
  assert.notEqual(second, first);
});
