import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupportedNodeVersion, parseNodeVersion } from "../scripts/preflight.mjs";

test("Node preflight accepts 20.19 and Node 22, rejects older versions", () => {
  assert.deepEqual(parseNodeVersion("20.19.0"), [20, 19, 0]);
  assert.equal(isSupportedNodeVersion("20.18.9"), false);
  assert.equal(isSupportedNodeVersion("20.19.0"), true);
  assert.equal(isSupportedNodeVersion("22.0.0"), true);
  assert.equal(isSupportedNodeVersion("garbage"), false);
});
