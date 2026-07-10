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

const { startClashStream, stopClashStream } = await import("/lib/clash-stream.js");

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
