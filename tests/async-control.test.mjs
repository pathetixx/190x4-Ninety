import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLatestRunner,
  createPromotableSingleFlight,
} from "../src/lib/async-control.js";

test("latest runner не теряет запрос во время активного прохода", async () => {
  let state = "first";
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const seen = [];
  const runner = createLatestRunner(async () => {
    seen.push(state);
    if (seen.length === 1) await firstGate;
  });

  const first = runner.request();
  state = "second";
  const second = runner.request();
  state = "latest";
  const third = runner.request();
  releaseFirst();

  await Promise.all([first, second, third]);
  assert.deepEqual(seen, ["first", "latest"]);
  assert.equal(runner.isRunning(), false);
});

test("ручной запрос повышает уже идущий background single-flight", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const coordinator = createPromotableSingleFlight(async (request) => {
    calls++;
    await gate;
    return request.interactive;
  });

  const background = coordinator.run();
  const manual = coordinator.run({ interactive: true });
  assert.equal(background, manual);
  assert.equal(coordinator.isRunning(), true);

  release();
  assert.equal(await background, true);
  assert.equal(calls, 1);
  assert.equal(coordinator.isRunning(), false);
});
