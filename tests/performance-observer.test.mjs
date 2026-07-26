import test from "node:test";
import assert from "node:assert/strict";

import { createPerformanceObserver } from "../src/lib/performance-observer.js";

test("collector tracks counters, gauges and bounded samples", () => {
  let wall = 1000;
  const observer = createPerformanceObserver({
    sampleCap: 2,
    clock: () => 50,
    wallClock: () => wall++,
  });

  assert.equal(observer.increment("ipc.calls"), 1);
  assert.equal(observer.increment("ipc.calls", 2), 3);
  assert.equal(observer.gauge("window.visible", true), 1);
  observer.sample("render.ms", 1);
  observer.sample("render.ms", 2);
  observer.sample("render.ms", 3, { view: "home" });

  const snapshot = observer.snapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.counters["ipc.calls"], 3);
  assert.equal(snapshot.gauges["window.visible"], 1);
  assert.deepEqual(snapshot.samples["render.ms"].map((x) => x.value), [2, 3]);
  assert.deepEqual(snapshot.samples["render.ms"][1].meta, { view: "home" });
});

test("marks and one-shot timers record durations", () => {
  let monotonic = 10;
  const observer = createPerformanceObserver({
    clock: () => monotonic,
    wallClock: () => 500,
  });

  observer.mark("startup.begin");
  monotonic = 25;
  observer.mark("startup.ready");
  observer.measure("startup.ms", "startup.begin", "startup.ready");

  monotonic = 40;
  const finish = observer.time("ipc.ms", { command: "health_snapshot" });
  monotonic = 46;
  finish();
  monotonic = 99;
  assert.equal(finish(), null);

  const snapshot = observer.snapshot();
  assert.equal(snapshot.samples["startup.ms"][0].value, 15);
  assert.equal(snapshot.samples["ipc.ms"][0].value, 6);
  assert.deepEqual(snapshot.samples["ipc.ms"][0].meta, { command: "health_snapshot" });
});

test("disabled collector is a no-op", () => {
  const observer = createPerformanceObserver({ enabled: false });
  observer.increment("x");
  observer.gauge("y", 1);
  observer.sample("z", 1);
  observer.mark("a");
  assert.deepEqual(observer.snapshot().counters, {});
  assert.deepEqual(observer.snapshot().gauges, {});
  assert.deepEqual(observer.snapshot().samples, {});
});
