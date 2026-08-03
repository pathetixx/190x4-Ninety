import test from "node:test";
import assert from "node:assert/strict";
import { waitForMatchingSourceTopology } from "../src/lib/source-switch-readiness.js";

test("source topology waits for the complete target selector instead of failing the first snapshot", async () => {
  let reads = 0;
  const result = await waitForMatchingSourceTopology({
    read: async () => ({ ready: ++reads >= 3 }),
    matches: value => value.ready,
    wait: async () => {},
  });
  assert.equal(result.status, "ready");
  assert.equal(result.attempts, 3);
  assert.equal(reads, 3);
});

test("source topology stops immediately when the target operation becomes stale", async () => {
  let current = true;
  let reads = 0;
  const result = await waitForMatchingSourceTopology({
    read: async () => {
      reads++;
      current = false;
      return { ready: false };
    },
    matches: value => value.ready,
    isCurrent: () => current,
    wait: async () => {},
  });
  assert.equal(result.status, "stale");
  assert.equal(reads, 1);
});

test("source topology returns a bounded unavailable verdict", async () => {
  let reads = 0;
  const result = await waitForMatchingSourceTopology({
    read: async () => {
      reads++;
      return { ready: false };
    },
    matches: value => value.ready,
    attempts: 4,
    wait: async () => {},
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "topology_mismatch");
  assert.equal(reads, 4);
});
