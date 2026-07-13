import { test } from "node:test";
import assert from "node:assert/strict";

let resolveListen;
let listenStarted = false;
let unlistened = 0;
const calls = [];
globalThis.window = {
  __TAURI__: {
    core: { invoke: async (cmd) => { calls.push(cmd); } },
    event: {
      listen: async () => {
        listenStarted = true;
        await new Promise((resolve) => { resolveListen = resolve; });
        return () => { unlistened++; };
      },
    },
  },
};

const { createSingleFlightRunner, startClashStream, stopClashStream } = await import("/lib/clash-stream.js");

test("clash poll: второй тик присоединяется к незавершённому запросу", async () => {
  let callsCount = 0;
  let release;
  const run = createSingleFlightRunner(async () => {
    callsCount++;
    await new Promise((resolve) => { release = resolve; });
    return callsCount;
  });

  const first = run();
  const second = run();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(callsCount, 1);
  release();
  await Promise.all([first, second]);

  const third = run();
  await Promise.resolve();
  assert.equal(callsCount, 2);
  release();
  await third;
});

test("clash stream: stop отменяет start, ожидающий event.listen", async () => {
  const start = startClashStream({ onTraffic: () => {} });
  while (!listenStarted) await Promise.resolve();
  const stop = stopClashStream();
  resolveListen();
  await Promise.all([start, stop]);

  assert.equal(unlistened, 1);
  assert.equal(calls.includes("clash_traffic_start"), false);
  assert.equal(calls.at(-1), "clash_traffic_stop");
});
