import { test } from "node:test";
import assert from "node:assert/strict";

let releaseX;
let selected = "auto";
const calls = [];
globalThis.window = {
  __TAURI__: { core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "clash_select_proxy") {
      if (args.name === "X") await new Promise(r => { releaseX = r; });
      selected = args.name;
      return;
    }
    if (cmd === "clash_get_proxies") return { proxies: { proxy: { type: "Selector", now: selected } } };
    throw new Error(cmd);
  } } },
};

const { configureClashRuntime, getProxies, selectProxy } = await import("/lib/clash-api.js");
const token = Object.freeze({ clashPort: 9191, processGeneration: 7 });
let current = token;
configureClashRuntime({ capture: () => current, assertCurrent: t => assert.equal(t, current) });

test("custom Clash port применяется ко всем вызовам", async () => {
  await getProxies();
  assert.equal(calls.at(-1)[1].port, 9191);
});

test("X → Y сериализуется latest-wins и подтверждает selector.now", async () => {
  const x = selectProxy("proxy", "X");
  while (!releaseX) await new Promise(r => setTimeout(r, 0));
  const y = selectProxy("proxy", "Y");
  releaseX();
  assert.equal((await x).stale, true);
  const yr = await y;
  assert.equal(yr.stale, false);
  assert.equal(selected, "Y");
  assert.deepEqual(calls.filter(([cmd]) => cmd === "clash_select_proxy").map(([, a]) => a.name), ["X", "Y"]);
});

test("новый process generation не получает telemetry snapshot старого runtime", async () => {
  const before = calls.filter(([cmd]) => cmd === "clash_get_proxies").length;
  current = Object.freeze({ clashPort: 9191, processGeneration: 8 });
  await getProxies();
  const after = calls.filter(([cmd]) => cmd === "clash_get_proxies").length;
  assert.equal(after, before + 1);
});
