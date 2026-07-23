import test from "node:test";
import assert from "node:assert/strict";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const storage = new Map([
  ["ninety.dpi.enabled", "true"],
  ["ninety.options.v1", JSON.stringify({
    privacy: { strictTunnel: false },
    route: { tunSplitDiscord: true },
  })],
]);
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.document = {
  getElementById: () => null,
};

const startGate = deferred();
const calls = [];
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command) => {
        calls.push(command);
        if (command === "dpi_start") await startGate.promise;
      },
    },
  },
  dispatchEvent: () => {},
};

const { setDpiVpnMode } = await import("/lib/dpi-view.js");

test("bootstrap TUN не запускает DPI, явная reevaluate делает один resume", async () => {
  setDpiVpnMode("tun");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((command) => command === "dpi_start").length, 0);

  setDpiVpnMode("tun", { reevaluate: true });
  setDpiVpnMode("tun", { reevaluate: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((command) => command === "dpi_start").length, 1);

  startGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
});
