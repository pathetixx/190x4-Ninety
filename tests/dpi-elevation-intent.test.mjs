import test from "node:test";
import assert from "node:assert/strict";
import { persistDpiIntentForRelaunch } from "../src/lib/dpi-elevation-intent.js";

function harness(initial = false) {
  let enabled = initial;
  const trace = [];
  return {
    trace,
    enabled: () => enabled,
    deps: {
      getEnabled: () => enabled,
      setEnabled: (value) => { enabled = value; trace.push(["enabled", value]); },
      backup: async () => { trace.push(["backup", enabled]); },
    },
  };
}

test("намерение включить DPI записывается и бэкапится до UAC-relaunch", async () => {
  const h = harness(false);
  const started = await persistDpiIntentForRelaunch({
    ...h.deps,
    relaunch: async () => { h.trace.push(["relaunch", h.enabled()]); return true; },
  });
  assert.equal(started, true);
  assert.equal(h.enabled(), true);
  assert.deepEqual(h.trace, [
    ["enabled", true],
    ["backup", true],
    ["relaunch", true],
  ]);
});

test("отмена UAC возвращает прежний выключенный DPI и обновляет backup", async () => {
  const h = harness(false);
  const started = await persistDpiIntentForRelaunch({
    ...h.deps,
    relaunch: async () => false,
  });
  assert.equal(started, false);
  assert.equal(h.enabled(), false);
  assert.deepEqual(h.trace, [
    ["enabled", true],
    ["backup", true],
    ["enabled", false],
    ["backup", false],
  ]);
});
