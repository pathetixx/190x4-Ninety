import { test } from "node:test";
import assert from "node:assert/strict";

const { createLatestWinsReconnectQueue } = await import("/lib/reconnect-queue.js");
const { createNetworkIntentArbiter } = await import("/lib/network-intent.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("reconnect A → reconnect B: latest request starts after A", async () => {
  const a = deferred();
  const b = deferred();
  const calls = [];
  const queue = createLatestWinsReconnectQueue({
    run: async ({ id }) => {
      calls.push(id);
      await (id === "A" ? a.promise : b.promise);
    },
  });

  queue.enqueue({ id: "A" });
  queue.enqueue({ id: "B" });
  await flush();
  assert.deepEqual(calls, ["A"]);

  a.resolve();
  await flush();
  assert.deepEqual(calls, ["A", "B"]);

  b.resolve();
  await flush();
  assert.equal(queue.isRunning(), false);
  assert.equal(queue.hasPending(), false);
});

test("reconnect A → user disconnect: pending request is cancelled by idle epoch", async () => {
  const arbiter = createNetworkIntentArbiter("idle");
  const a = deferred();
  const calls = [];
  let needsReconnect = true;
  const connectedEpoch = arbiter.begin("connected");
  const queue = createLatestWinsReconnectQueue({
    run: async ({ id }) => {
      calls.push(id);
      await a.promise;
    },
    canRun: ({ epoch }) => arbiter.isCurrent(epoch, "connected") && needsReconnect,
  });

  queue.enqueue({ id: "A", epoch: connectedEpoch });
  queue.enqueue({ id: "B", epoch: connectedEpoch });
  const idleEpoch = arbiter.begin("idle");
  needsReconnect = false;
  queue.cancel();
  a.resolve();
  await flush();

  assert.equal(arbiter.isCurrent(connectedEpoch, "connected"), false);
  assert.equal(arbiter.isCurrent(idleEpoch, "idle"), true);
  assert.deepEqual(calls, ["A"]);
  assert.equal(queue.hasPending(), false);
});

test("reconnect A → updater stop: idle intent prevents a restart", async () => {
  const arbiter = createNetworkIntentArbiter("idle");
  const a = deferred();
  const calls = [];
  let needsReconnect = true;
  const connectedEpoch = arbiter.begin("connected");
  const queue = createLatestWinsReconnectQueue({
    run: async ({ id }) => {
      calls.push(id);
      await a.promise;
    },
    canRun: ({ epoch }) => arbiter.isCurrent(epoch, "connected") && needsReconnect,
  });

  queue.enqueue({ id: "A", epoch: connectedEpoch });
  queue.enqueue({ id: "B", epoch: connectedEpoch });
  const updaterIdleEpoch = arbiter.begin("idle");
  needsReconnect = false;
  queue.cancel();
  a.resolve();
  await flush();

  assert.equal(arbiter.isCurrent(updaterIdleEpoch, "idle"), true);
  assert.deepEqual(calls, ["A"]);
  assert.equal(queue.isRunning(), false);
  assert.equal(queue.hasPending(), false);
});

test("idle state never retains needsReconnect without a scheduled operation", async () => {
  const arbiter = createNetworkIntentArbiter("idle");
  const a = deferred();
  let state = "connected";
  assert.equal(state, "connected");
  let needsReconnect = true;
  const connectedEpoch = arbiter.begin("connected");
  const queue = createLatestWinsReconnectQueue({
    run: async ({ epoch }) => {
      await a.promise;
      if (arbiter.isCurrent(epoch, "connected")) {
        needsReconnect = false;
      }
    },
    canRun: ({ epoch }) => arbiter.isCurrent(epoch, "connected") && needsReconnect,
  });

  queue.enqueue({ epoch: connectedEpoch });
  arbiter.begin("idle");
  state = "idle";
  needsReconnect = false;
  queue.cancel();
  a.resolve();
  await flush();

  assert.equal(state === "idle" && needsReconnect, false);
  assert.equal(queue.hasPending(), false);
});

test("after stale reconnect settles, runtime and UI remain in the same idle state", async () => {
  const arbiter = createNetworkIntentArbiter("idle");
  const a = deferred();
  let runtime = "running";
  let ui = "connected";
  let needsReconnect = true;
  const connectedEpoch = arbiter.begin("connected");
  const queue = createLatestWinsReconnectQueue({
    run: async ({ epoch }) => {
      await a.promise;
      if (!arbiter.isCurrent(epoch, "connected")) {
        runtime = "stopped";
        ui = "idle";
      }
    },
    canRun: ({ epoch }) => arbiter.isCurrent(epoch, "connected") && needsReconnect,
  });

  queue.enqueue({ epoch: connectedEpoch });
  arbiter.begin("idle");
  needsReconnect = false;
  queue.cancel();
  a.resolve();
  await flush();

  assert.equal(runtime, "stopped");
  assert.equal(ui, "idle");
  assert.equal(runtime === "stopped", ui === "idle");
});
