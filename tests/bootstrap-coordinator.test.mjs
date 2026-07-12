import { test } from "node:test";
import assert from "node:assert/strict";

const { createBootstrapCoordinator } = await import("/lib/bootstrap-coordinator.js");

test("bootstrap coordinator сериализует reconcile → autostart и single-flight", async () => {
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const coordinator = createBootstrapCoordinator({
    setBusy: busy => events.push(`busy:${busy}`),
    reconcile: async () => { events.push("reconcile:start"); await gate; events.push("reconcile:end"); },
    autostart: async () => { events.push("autostart"); },
  });

  const first = coordinator.run();
  const second = coordinator.run();
  assert.equal(first, second);
  assert.equal(coordinator.isRunning(), true);
  release();
  await first;
  assert.deepEqual(events, ["busy:true", "reconcile:start", "reconcile:end", "autostart", "busy:false"]);
  assert.equal(coordinator.isRunning(), false);
});
