import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __TAURI__: { core: { invoke: async () => {} } } };
const {
  createKillSwitchController,
  snapshotConfirmsOrdinaryKillSwitch,
  snapshotConfirmsStrictKillSwitch,
} = await import("/lib/kill-switch.js");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("backend snapshot подтверждает fail-closed policy даже после смерти ядра", () => {
  const options = { general: { killSwitch: true } };
  const snapshot = {
    running: false,
    mode: "systemProxy",
    killSwitchActive: true,
    strictPrivacy: false,
  };

  assert.equal(snapshotConfirmsOrdinaryKillSwitch(snapshot, options), true);
  assert.equal(snapshotConfirmsOrdinaryKillSwitch({ ...snapshot, mode: "tun" }, options), false);
  assert.equal(snapshotConfirmsOrdinaryKillSwitch({ ...snapshot, strictPrivacy: true }, options), false);
  assert.equal(snapshotConfirmsOrdinaryKillSwitch(snapshot, {
    general: { killSwitch: false },
  }), false);

  const strictOptions = { privacy: { strictTunnel: true } };
  const strictSnapshot = {
    running: false,
    // Strict preconnect существует раньше RuntimeRecord: metadata ещё пусты.
    mode: null,
    killSwitchActive: true,
    strictPrivacy: false,
  };
  assert.equal(snapshotConfirmsStrictKillSwitch(strictSnapshot, strictOptions), true);
  assert.equal(snapshotConfirmsStrictKillSwitch({
    ...strictSnapshot,
    killSwitchActive: false,
  }, strictOptions), false);
});

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

test("строгий TUN ставит fail-closed заслон до старта и привязывается к интерфейсу после", async () => {
  const calls = [];
  let active = false;
  const controller = createKillSwitchController({
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "is_elevated") return true;
      if (cmd === "killswitch_active") return active;
      if (cmd === "killswitch_arm") { active = true; return; }
      if (cmd === "killswitch_disarm") { active = false; }
    },
    loadOptions: () => ({
      general: { killSwitch: false },
      privacy: { strictTunnel: true },
      route: { bypassLan: true },
    }),
    getMode: () => "tun",
    toast: () => {}, t: x => x,
  });

  assert.equal(await controller.apply(true, { phase: "preconnect" }), true);
  assert.deepEqual(calls.find(([cmd]) => cmd === "killswitch_arm")?.[1], {
    allowLan: false,
    tunInterface: null,
    strictTunnel: true,
  });

  calls.length = 0;
  assert.equal(await controller.apply(true), true);
  assert.equal(calls.some(([cmd]) => cmd === "killswitch_disarm"), false);
  assert.deepEqual(calls.find(([cmd]) => cmd === "killswitch_arm")?.[1], {
    allowLan: false,
    tunInterface: "ninety-tun",
    strictTunnel: true,
  });
});

test("preserve оставляет строгий WFP активным между аварией и реконнектом", async () => {
  const calls = [];
  const controller = createKillSwitchController({
    invoke: async (cmd) => {
      calls.push(cmd);
      if (cmd === "killswitch_active") return true;
    },
    loadOptions: () => ({ privacy: { strictTunnel: true } }),
    getMode: () => "tun",
    toast: () => {}, t: x => x,
  });

  assert.equal(await controller.apply(false, { preserve: true }), true);
  assert.deepEqual(calls, ["killswitch_active"]);
});

test("preserve восстанавливает потерянный строгий WFP как preconnect barrier", async () => {
  const calls = [];
  let active = false;
  const controller = createKillSwitchController({
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "killswitch_active") return active;
      if (cmd === "is_elevated") return true;
      if (cmd === "killswitch_arm") active = true;
    },
    loadOptions: () => ({
      privacy: { strictTunnel: true },
      general: { killSwitch: false },
      route: { bypassLan: true },
    }),
    getMode: () => "tun",
    toast: () => {}, t: x => x,
  });

  assert.equal(await controller.apply(false, { preserve: true }), true);
  assert.deepEqual(calls, [
    ["killswitch_active", undefined],
    ["is_elevated", undefined],
    ["killswitch_arm", {
      allowLan: false,
      tunInterface: null,
      strictTunnel: true,
    }],
    ["killswitch_active", undefined],
  ]);
});

test("обычный Kill Switch сохраняет и восстанавливает block-all после аварии ядра", async () => {
  const calls = [];
  let active = false;
  const controller = createKillSwitchController({
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "killswitch_active") return active;
      if (cmd === "is_elevated") return true;
      if (cmd === "killswitch_arm") active = true;
    },
    loadOptions: () => ({
      privacy: { strictTunnel: false },
      general: { killSwitch: true },
      route: { bypassLan: false },
    }),
    getMode: () => "systemProxy",
    toast: () => {}, t: x => x,
  });

  assert.equal(await controller.apply(false, { preserve: true }), true);
  assert.deepEqual(calls, [
    ["killswitch_active", undefined],
    ["is_elevated", undefined],
    ["killswitch_arm", {
      allowLan: false,
      tunInterface: null,
      strictTunnel: false,
    }],
    ["killswitch_active", undefined],
  ]);
});

test("ordinary barrier переживает proxy → TUN transition до final readiness", async () => {
  const calls = [];
  let active = true;
  const controller = createKillSwitchController({
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "killswitch_active") return active;
      if (cmd === "killswitch_disarm") active = false;
    },
    loadOptions: () => ({
      privacy: { strictTunnel: false },
      general: { killSwitch: true },
      route: { bypassLan: false },
    }),
    getMode: () => "tun",
    toast: () => {}, t: x => x,
  });

  assert.equal(await controller.apply(false, {
    preserve: true,
    policyMode: "systemProxy",
  }), true);
  assert.deepEqual(calls, [["killswitch_active", undefined]]);

  calls.length = 0;
  assert.equal(await controller.apply(true), true);
  assert.deepEqual(calls, [["killswitch_disarm", undefined]]);
});

test("ordinary barrier можно поставить до TUN → proxy transition", async () => {
  const calls = [];
  let active = false;
  const controller = createKillSwitchController({
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "killswitch_active") return active;
      if (cmd === "is_elevated") return true;
      if (cmd === "killswitch_arm") active = true;
    },
    loadOptions: () => ({
      privacy: { strictTunnel: false },
      general: { killSwitch: true },
      route: { bypassLan: true },
    }),
    getMode: () => "tun",
    toast: () => {}, t: x => x,
  });

  assert.equal(await controller.apply(false, {
    preserve: true,
    policyMode: "proxy",
  }), true);
  assert.deepEqual(calls, [
    ["killswitch_active", undefined],
    ["is_elevated", undefined],
    ["killswitch_arm", {
      allowLan: true,
      tunInterface: null,
      strictTunnel: false,
    }],
    ["killswitch_active", undefined],
  ]);
});
