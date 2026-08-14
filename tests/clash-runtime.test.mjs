import { test } from "node:test";
import assert from "node:assert/strict";

let releaseX;
let selected = "auto";
let closeResult = () => 3;
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
    if (cmd === "clash_close_proxy_connections") return closeResult();
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

test("подтверждённый выбор рвёт живые прокси-соединения", async () => {
  const before = calls.filter(([cmd]) => cmd === "clash_close_proxy_connections").length;
  const r = await selectProxy("proxy", "Z");
  assert.equal(r.stale, false);
  const closes = calls.filter(([cmd]) => cmd === "clash_close_proxy_connections");
  assert.equal(closes.length, before + 1);
  assert.equal(closes.at(-1)[1].port, 9191);
  // Разрыв идёт строго после PUT: иначе рвались бы соединения старой ноды,
  // которые ядро тут же переоткрыло бы через неё же.
  const order = calls.map(([cmd]) => cmd).filter(cmd => cmd === "clash_select_proxy" || cmd === "clash_close_proxy_connections");
  assert.equal(order.at(-2), "clash_select_proxy");
  assert.equal(order.at(-1), "clash_close_proxy_connections");
});

test("closeConnections=false оставляет соединения в покое", async () => {
  const before = calls.filter(([cmd]) => cmd === "clash_close_proxy_connections").length;
  await selectProxy("proxy", "W", { closeConnections: false });
  const after = calls.filter(([cmd]) => cmd === "clash_close_proxy_connections").length;
  assert.equal(after, before);
});

test("сбой разрыва не отменяет уже подтверждённый выбор", async () => {
  closeResult = () => { throw new Error("connections endpoint down"); };
  try {
    const r = await selectProxy("proxy", "V");
    assert.equal(r.stale, false);
    assert.equal(selected, "V");
  } finally {
    closeResult = () => 3;
  }
});
