import test from "node:test";
import assert from "node:assert/strict";

const storage = new Map([
  ["ninety.dpi.enabled", "true"],
  ["ninety.options.v1", JSON.stringify({
    privacy: { strictTunnel: false },
    route: { tunSplitDiscord: false },
  })],
]);
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.document = {
  getElementById: () => null,
  addEventListener: () => {},
};

let stopFails = true;
const calls = [];
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command) => {
        calls.push(command);
        if (command === "dpi_running") return true;
        if (command === "dpi_strategies") {
          return JSON.stringify([{ id: "alt11", name: "ALT11", desc: "" }]);
        }
        if (command === "dpi_stop") {
          if (stopFails) throw new Error("winws всё ещё работает");
          return null;
        }
        if (command === "dpi_versions") return {};
        if (command === "dpi_fake_payloads") return {};
        if (command === "dpi_hosts_status") return {};
        return 0;
      },
    },
  },
  dispatchEvent: () => {},
};

const errors = [];
const { mountDpiView, prepareDpiVpnMode } = await import("/lib/dpi-view.js");
await mountDpiView({ onToast: (message, kind) => errors.push({ message, kind }) });

test("вход в TUN блокируется, пока остановка winws не подтверждена", async () => {
  const blocked = await prepareDpiVpnMode("tun");
  assert.equal(blocked, false);
  assert.equal(storage.get("ninety.dpi.enabled"), "true");
  assert.equal(calls.filter((command) => command === "dpi_stop").length, 1);
  assert.equal(errors.at(-1)?.kind, "error");

  stopFails = false;
  const ready = await prepareDpiVpnMode("tun");
  assert.equal(ready, true);
  assert.equal(calls.filter((command) => command === "dpi_stop").length, 2);
});
