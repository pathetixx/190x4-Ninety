import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __TAURI__: { core: { invoke: async () => {} } } };
const { createKillSwitchController } = await import("/lib/kill-switch.js");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("kill switch: disconnect во время is_elevated не оставляет armed state", async () => {
  const elevated = deferred();
  const calls = [];
  const controller = createKillSwitchController({
    invoke: async (cmd) => {
      calls.push(cmd);
      if (cmd === "is_elevated") return elevated.promise;
      return undefined;
    },
    loadOptions: () => ({ general: { killSwitch: true }, route: { bypassLan: true } }),
    getMode: () => "systemProxy",
    toast: () => {},
    t: (key) => key,
  });

  const arm = controller.apply(true);
  await Promise.resolve();
  const disarm = controller.apply(false);
  elevated.resolve(true);
  await Promise.all([arm, disarm]);

  assert.deepEqual(calls, ["is_elevated", "killswitch_disarm"]);
});

test("kill switch: disarm выполняется после уже начатого arm", async () => {
  const armed = deferred();
  const calls = [];
  const controller = createKillSwitchController({
    invoke: async (cmd) => {
      calls.push(cmd);
      if (cmd === "is_elevated") return true;
      if (cmd === "killswitch_arm") return armed.promise;
      return undefined;
    },
    loadOptions: () => ({ general: { killSwitch: true }, route: { bypassLan: false } }),
    getMode: () => "proxy",
    toast: () => {},
    t: (key) => key,
  });

  const arm = controller.apply(true);
  await Promise.resolve();
  await Promise.resolve();
  const disarm = controller.apply(false);
  armed.resolve();
  await Promise.all([arm, disarm]);

  assert.equal(calls.at(-1), "killswitch_disarm");
  assert.equal(calls.filter((x) => x === "killswitch_arm").length, 1);
});

test("неподтверждённый killswitch_active не считается защищённым соединением", async () => {
  const controller = createKillSwitchController({
    invoke: async (cmd) => {
      if (cmd === "is_elevated") return true;
      if (cmd === "killswitch_active") return false;
      return undefined;
    },
    loadOptions: () => ({ general: { killSwitch: true }, route: {} }),
    getMode: () => "systemProxy",
    toast: () => {}, t: x => x, warn: () => {},
  });
  assert.equal(await controller.apply(true), false);
});
