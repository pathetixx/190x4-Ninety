import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __TAURI__: { core: { invoke: async () => ({}) } } };
const { initHealthWatchdog } = await import("/lib/health-watchdog.js");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("health watchdog: in-flight snapshot после stop не запускает shutdown", async () => {
  const snapshot = deferred();
  let state = "connected";
  let shutdowns = 0;
  let toasts = 0;
  const watchdog = initHealthWatchdog({
    getState: () => state,
    isUpdateInstalling: () => false,
    shutdownCore: async () => { shutdowns++; state = "idle"; },
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    invoke: async () => snapshot.promise,
    toast: () => { toasts++; },
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  const tick = watchdog.tick();
  watchdog.stop();
  state = "idle";
  snapshot.resolve({ singbox_running: false, last_error: "stopped" });
  await tick;

  assert.equal(shutdowns, 0);
  assert.equal(toasts, 0);
});

test("health watchdog сохраняет строгий WFP при аварии ядра", async () => {
  let state = "connected";
  const shutdownOptions = [];
  const watchdog = initHealthWatchdog({
    getState: () => state,
    isUpdateInstalling: () => false,
    shutdownCore: async (options) => {
      shutdownOptions.push(options);
      state = "idle";
      return true;
    },
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    shouldPreserveKillSwitch: () => true,
    invoke: async () => ({ singbox_running: false, last_error: "crashed" }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();

  assert.deepEqual(shutdownOptions, [{ preserveKillSwitch: true }]);
});

test("health watchdog переармирует потерянные WFP-фильтры и не спамит ошибкой", async () => {
  let rearmAttempts = 0;
  let alerts = 0;
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => {},
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    isKillSwitchRequired: () => true,
    rearmKillSwitch: async () => {
      rearmAttempts++;
      return false;
    },
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      kill_switch_active: false,
    }),
    toast: () => { alerts++; },
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();
  await watchdog.tick();

  assert.equal(rearmAttempts, 2);
  assert.equal(alerts, 1);
});

test("health watchdog продолжает guard-only проверку после аварийного idle", async () => {
  let rearmAttempts = 0;
  let shutdowns = 0;
  const watchdog = initHealthWatchdog({
    getState: () => "idle",
    isUpdateInstalling: () => false,
    shutdownCore: async () => { shutdowns++; },
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    isKillSwitchRequired: () => true,
    rearmKillSwitch: async () => {
      rearmAttempts++;
      return true;
    },
    invoke: async () => ({
      singbox_running: false,
      xray: "none",
      sidecar: "none",
      kill_switch_active: false,
    }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();

  assert.equal(rearmAttempts, 1);
  assert.equal(shutdowns, 0, "guard-only режим не должен повторно гасить ядро");
});

test("поздний rearm отменённой policy завершается актуальным reconcile", async () => {
  const rearm = deferred();
  const entered = deferred();
  let required = true;
  let reconciles = 0;
  const watchdog = initHealthWatchdog({
    getState: () => "connecting",
    isUpdateInstalling: () => false,
    shutdownCore: async () => {},
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    isKillSwitchRequired: () => required,
    rearmKillSwitch: async () => {
      entered.resolve();
      return rearm.promise;
    },
    reconcileKillSwitch: async () => {
      reconciles++;
      return true;
    },
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      kill_switch_active: false,
    }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  const tick = watchdog.tick();
  await entered.promise;
  required = false;
  watchdog.stop();
  rearm.resolve(true);
  await tick;

  assert.equal(reconciles, 1);
});

test("dataplane failed запускает bounded recovery и блокирует quality engine", async () => {
  let recoveries = 0;
  let pauses = 0;
  let resumes = 0;
  let qualityTicks = 0;
  const quality = {
    setHostPressure: () => {},
    pauseForEmergency: () => { pauses++; },
    resumeAfterEmergency: () => { resumes++; },
    tick: async () => { qualityTicks++; },
  };
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => true,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => quality,
    recoverDataplane: async () => { recoveries++; return true; },
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      kill_switch_active: false,
      dataplane: {
        state: "failed",
        reason: "dataplane_stalled",
        hostPressure: false,
      },
    }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();
  await watchdog.tick();

  assert.equal(recoveries, 1);
  assert.equal(pauses, 1);
  assert.equal(resumes, 1);
  assert.equal(qualityTicks, 0, "обычный quality engine не должен вмешиваться");
});

test("pressure mode не запускает recovery и гасит фоновую quality-пробу", async () => {
  let recoveries = 0;
  let pressure = false;
  let qualityTicks = 0;
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => true,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => ({
      setHostPressure: (value) => { pressure = value; },
      tick: async () => { qualityTicks++; },
    }),
    recoverDataplane: async () => { recoveries++; return true; },
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      kill_switch_active: false,
      dataplane: { state: "pressure", hostPressure: true },
    }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();

  assert.equal(pressure, true);
  assert.equal(recoveries, 0);
  assert.equal(qualityTicks, 0);
});
