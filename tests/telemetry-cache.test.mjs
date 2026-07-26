import test from "node:test";
import assert from "node:assert/strict";

import { createTelemetryCache } from "../src/lib/telemetry-cache.js";

test("cache reuses fresh values and expires by TTL", async () => {
  let now = 100;
  let calls = 0;
  const cache = createTelemetryCache({ clock: () => now });
  const load = async () => ++calls;

  assert.equal(await cache.get("proxies:9090", load, { ttlMs: 1000 }), 1);
  assert.equal(await cache.get("proxies:9090", load, { ttlMs: 1000 }), 1);
  assert.equal(calls, 1);

  now = 1200;
  assert.equal(await cache.get("proxies:9090", load, { ttlMs: 1000 }), 2);
  assert.equal(calls, 2);
});

test("concurrent requests join one loader", async () => {
  let release;
  let calls = 0;
  const cache = createTelemetryCache();
  const loader = () => {
    calls++;
    return new Promise((resolve) => { release = resolve; });
  };

  const a = cache.get("connections", loader, { ttlMs: 0 });
  const b = cache.get("connections", loader, { ttlMs: 0, force: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  release([1, 2, 3]);
  assert.deepEqual(await a, [1, 2, 3]);
  assert.deepEqual(await b, [1, 2, 3]);
});

test("prefix invalidation only removes matching telemetry", async () => {
  const cache = createTelemetryCache();
  await cache.get("proxies:9090", async () => "p", { ttlMs: 1000 });
  await cache.get("connections:9090", async () => "c", { ttlMs: 1000 });
  cache.invalidate("proxies:");
  assert.equal(cache.peek("proxies:9090"), undefined);
  assert.equal(cache.peek("connections:9090"), "c");
});
