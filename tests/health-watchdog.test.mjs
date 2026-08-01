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

test("cooldown не превращается в terminal exhaustion", async () => {
  let now = 0;
  let recoveries = 0;
  let terminal = 0;
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => true,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    recoverDataplane: async () => { recoveries++; return false; },
    onDataplaneFailed: async () => { terminal++; return true; },
    now: () => now,
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      dataplane: { state: "failed", hostPressure: false },
    }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();
  now = 1000;
  await watchdog.tick();
  assert.equal(recoveries, 1, "cooldown не должен запускать второй recovery");
  assert.equal(terminal, 0, "cooldown не является terminal состоянием");
  now = 61_000;
  await watchdog.tick();
  assert.equal(recoveries, 2);
});

test("recovery budget считает три попытки и очищает старые попытки по окну", async () => {
  let now = 0;
  let recoveries = 0;
  let terminal = 0;
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => true,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    recoverDataplane: async () => { recoveries++; return false; },
    onDataplaneFailed: async () => { terminal++; return false; },
    now: () => now,
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      dataplane: { state: "failed", hostPressure: false },
    }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();
  now = 60_000;
  await watchdog.tick();
  now = 120_000;
  await watchdog.tick();
  assert.equal(recoveries, 3);
  now = 900_001;
  await watchdog.tick();
  assert.equal(recoveries, 4, "попытки старше recovery window больше не блокируют recovery");
  assert.equal(terminal, 0);
});

test("успешное recovery получает grace и не запускается повторно до его окончания", async () => {
  let now = 0;
  let recoveries = 0;
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => true,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    recoverDataplane: async () => { recoveries++; return true; },
    onDataplaneFailed: async () => true,
    now: () => now,
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      dataplane: { state: "failed", hostPressure: false },
    }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();
  now = 30_000;
  await watchdog.tick();
  assert.equal(recoveries, 1, "stale failure во время grace не должен запускать новый action");
  now = 30_001;
  await watchdog.tick();
  assert.equal(recoveries, 1, "после grace ещё действует cooldown первой попытки");
});

test("terminal latch появляется только после подтверждённого cleanup", async () => {
  let now = 0;
  let recoveries = 0;
  let terminalAttempts = 0;
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => false,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    recoverDataplane: async () => { recoveries++; return false; },
    onDataplaneFailed: async () => { terminalAttempts++; return false; },
    now: () => now,
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      dataplane: { state: "failed", hostPressure: false },
    }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  for (let attempt = 0; attempt < 4; attempt++) {
    await watchdog.tick();
    if (attempt < 3) now += 60_000;
  }
  assert.equal(recoveries, 3);
  assert.equal(terminalAttempts, 1);
  await watchdog.tick();
  assert.equal(terminalAttempts, 1, "неудачный cleanup не должен спамить вызовами");
});

test("native owner не запускает frontend recovery даже при failed dataplane", async () => {
  let recoveries = 0;
  let pauses = 0;
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => true,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => ({
      setHostPressure: () => {},
      pauseForEmergency: () => { pauses++; },
      tick: async () => {},
    }),
    recoverDataplane: async () => { recoveries++; return true; },
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      dataplane: {
        state: "failed",
        dataplaneState: "failed",
        nativeRecoveryOwner: "native",
        nativeRecoveryState: "recovering",
        hostPressure: true,
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
  assert.equal(recoveries, 0);
  assert.equal(pauses, 1);
});

test("native handoff сразу передаёт failed dataplane переключению ноды", async () => {
  let now = 0;
  let recoveries = 0;
  let pauses = 0;
  let resumes = 0;
  const states = [];
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => true,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => ({
      setHostPressure: () => {},
      pauseForEmergency: () => { pauses++; },
      resumeAfterEmergency: () => { resumes++; },
      tick: async () => {},
    }),
    recoverDataplane: async () => { recoveries++; return true; },
    onDataplaneState: (state) => states.push(state),
    now: () => now,
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      dataplane: {
        state: "failed",
        dataplaneState: "failed",
        nativeRecoveryOwner: "native",
        nativeRecoveryState: "handoff",
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
  now = 60_000;
  await watchdog.tick();
  assert.equal(recoveries, 1, "handoff не должен ждать три одинаковых restart");
  assert.equal(pauses, 1);
  assert.equal(resumes, 1);
  assert.deepEqual(states, ["failed"]);
});

test("переход native health в healthy запрашивает одну немедленную quality-пробу", async () => {
  let requested = 0;
  let qualityTicks = 0;
  const states = [];
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => true,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => ({
      setHostPressure: () => {},
      requestProbeSoon: () => { requested++; },
      tick: async () => { qualityTicks++; },
    }),
    onDataplaneState: (state) => states.push(state),
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      dataplane: {
        state: "healthy",
        dataplaneState: "healthy",
        nativeRecoveryOwner: "native",
        nativeRecoveryState: "idle",
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
  assert.equal(requested, 1);
  assert.equal(qualityTicks, 2);
  assert.deepEqual(states, ["healthy"]);
});

test("native terminal cleanup остаётся подтверждаемым и bounded", async () => {
  let now = 0;
  let terminalAttempts = 0;
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => false,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    onDataplaneFailed: async () => { terminalAttempts++; return false; },
    now: () => now,
    invoke: async () => ({
      singbox_running: true,
      xray: "none",
      sidecar: "none",
      dataplane: {
        state: "failed",
        dataplaneState: "failed",
        nativeRecoveryOwner: "native",
        nativeRecoveryState: "terminal",
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
  assert.equal(terminalAttempts, 1, "terminal snapshot должен запускать cleanup один раз");
  now = 60_000;
  await watchdog.tick();
  assert.equal(terminalAttempts, 2, "после cooldown cleanup может быть повторён");
});
