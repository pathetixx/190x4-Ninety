import { test } from "node:test";
import assert from "node:assert/strict";

const { createNetworkIntentArbiter } = await import("/lib/network-intent.js");

test("user disconnect invalidates late auto-connect completion", () => {
  const arbiter = createNetworkIntentArbiter();
  const connectEpoch = arbiter.begin("connected");
  const idleEpoch = arbiter.begin("idle");
  assert.equal(arbiter.isCurrent(connectEpoch, "connected"), false);
  assert.equal(arbiter.isCurrent(idleEpoch, "idle"), true);
});

test("connected + needsReconnect still uses a new idle intent", () => {
  const arbiter = createNetworkIntentArbiter();
  const reconnectEpoch = arbiter.begin("connected");
  const disconnectEpoch = arbiter.begin("idle");
  assert.notEqual(reconnectEpoch, disconnectEpoch);
  assert.equal(arbiter.isCurrent(reconnectEpoch, "connected"), false);
  assert.equal(arbiter.isCurrent(disconnectEpoch, "idle"), true);
});
