import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoreStartBarrier } from "/lib/connection-start-barrier.js";

test("новый старт ждёт физического завершения отменённого start_singbox", async () => {
  const barrier = createCoreStartBarrier();
  let finishOld;
  const oldStart = new Promise(resolve => { finishOld = resolve; });
  const tracked = barrier.track(oldStart);
  assert.equal(barrier.isPending(), true);

  let barrierPassed = false;
  const waiting = barrier.wait().then(() => { barrierPassed = true; });
  await Promise.resolve();
  assert.equal(barrierPassed, false);

  finishOld();
  await tracked;
  await waiting;
  assert.equal(barrierPassed, true);
  assert.equal(barrier.isPending(), false);
});

test("ошибка старого start_singbox также освобождает barrier", async () => {
  const barrier = createCoreStartBarrier();
  const tracked = barrier.track(Promise.reject(new Error("cancelled")));
  await assert.rejects(tracked, /cancelled/);
  assert.equal(await barrier.wait(), false);
  assert.equal(barrier.isPending(), false);
});
