import test from "node:test";
import assert from "node:assert/strict";

import { createDistinctEmitter } from "../src/lib/distinct-emitter.js";

test("distinct emitter suppresses equivalent payloads", () => {
  const values = [];
  const emit = createDistinctEmitter((value) => values.push(value));

  assert.equal(emit({ delay: 30, nodeTag: "a" }), true);
  assert.equal(emit({ delay: 30, nodeTag: "a" }), false);
  assert.equal(emit({ delay: 31, nodeTag: "a" }), true);
  assert.equal(values.length, 2);
});

test("reset makes current payload observable again", () => {
  let calls = 0;
  const emit = createDistinctEmitter(() => calls++, (value) => value.id);
  emit({ id: 1 });
  emit({ id: 1 });
  emit.reset();
  emit({ id: 1 });
  assert.equal(calls, 2);
});
