import { test } from "node:test";
import assert from "node:assert/strict";

const data = new Map();
let resolveA;
let call = 0;
globalThis.localStorage = {
  getItem: k => data.get(k) ?? null,
  setItem: (k, v) => data.set(k, String(v)),
  removeItem: k => data.delete(k),
};
globalThis.window = { __TAURI__: { core: { invoke: async () => {
  call++;
  if (call === 1) return new Promise(r => { resolveA = r; });
  return { up: 100, down: 200 };
} } } };

const { configureTrafficRuntime, getMeasured, startMeter, stopMeter } = await import("/lib/traffic-meter.js");
const a = { processGeneration: 1, clashPort: 9191 };
const b = { processGeneration: 2, clashPort: 9191 };
let current = a;
configureTrafficRuntime({ capture: () => current, isCurrent: t => t === current });

test("поздний traffic poll A не пишет данные после запуска meter B", async () => {
  startMeter({ sourceKey: "sub:a", token: a, intervalMs: 60_000 });
  while (!resolveA) await new Promise(r => setTimeout(r, 0));
  current = b;
  startMeter({ sourceKey: "sub:b", token: b, intervalMs: 60_000 });
  resolveA({ up: 9999, down: 9999 });
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(getMeasured("sub:a"), { up: 0, down: 0, total: 0 });
  assert.deepEqual(getMeasured("sub:b"), { up: 0, down: 0, total: 0 });
  stopMeter();
});
