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

// Смерть ядра под нагрузкой — тот отказ, ради которого сторож и существует.
// Погасить и написать «ядро остановилось» это не отказоустойчивость: юзер в
// другом приложении и увидит тост в лучшем случае через минуты.
test("сторож поднимает runtime заново после смерти ядра", async () => {
  let state = "connected";
  const order = [];
  const watchdog = initHealthWatchdog({
    getState: () => state,
    isUpdateInstalling: () => false,
    shutdownCore: async () => { order.push("stop"); state = "idle"; return true; },
    restoreAfterCoreDeath: async () => { order.push("restore"); state = "connected"; return true; },
    reconnectForSourceChange: () => {},
    switchView: () => { order.push("logs"); },
    getQualityEngine: () => null,
    invoke: async () => ({ singbox_running: false, last_error: "crashed" }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();

  assert.deepEqual(order, ["stop", "restore"]);
});

test("восстановление живёт внутри одной операции со shutdown", async () => {
  let state = "connected";
  const tokens = [];
  const watchdog = initHealthWatchdog({
    getState: () => state,
    isUpdateInstalling: () => false,
    shutdownCore: async (options) => {
      tokens.push(options.operationToken);
      state = "idle";
      return true;
    },
    restoreAfterCoreDeath: async (_reason, context) => {
      tokens.push(context.operationToken);
      state = "connected";
      return true;
    },
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    beginRuntimeOperation: async () => ({ id: 7 }),
    completeRuntimeOperation: async () => true,
    invoke: async () => ({ singbox_running: false, last_error: "crashed" }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();

  // Один и тот же токен: между остановкой и повторным стартом не должна
  // вклиниться чужая операция, иначе fail-closed окно останется без владельца.
  assert.equal(tokens.length, 2);
  assert.deepEqual(tokens[0], { id: 7 });
  assert.deepEqual(tokens[1], { id: 7 });
});

test("бюджет восстановления не даёт зациклиться на падающем ядре", async () => {
  let state = "connected";
  let restores = 0;
  let clock = 0;
  const watchdog = initHealthWatchdog({
    getState: () => state,
    isUpdateInstalling: () => false,
    shutdownCore: async () => { state = "idle"; return true; },
    restoreAfterCoreDeath: async () => { restores++; state = "connected"; return true; },
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    invoke: async () => ({ singbox_running: false, last_error: "crashed" }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
    now: () => clock,
  });

  watchdog.start();
  await watchdog.tick();
  state = "connected";
  clock += 60_000;
  await watchdog.tick();

  assert.equal(restores, 1, "вторая смерть в том же окне лечится не перезапуском");

  state = "connected";
  clock += 16 * 60_000; // окно бюджета истекло
  await watchdog.tick();
  assert.equal(restores, 2);
});

test("неудачное восстановление закрывает туннель честной ошибкой", async () => {
  let state = "connected";
  let errorToasts = 0;
  let switched = null;
  const watchdog = initHealthWatchdog({
    getState: () => state,
    isUpdateInstalling: () => false,
    shutdownCore: async () => { state = "idle"; return true; },
    restoreAfterCoreDeath: async () => false,
    reconnectForSourceChange: () => {},
    switchView: (view) => { switched = view; },
    getQualityEngine: () => null,
    invoke: async () => ({ singbox_running: false, last_error: "crashed" }),
    toast: (_msg, kind) => { if (kind === "error") errorToasts++; },
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();

  assert.equal(errorToasts, 1);
  assert.equal(switched, "logs");
});

test("событие смерти ядра из Rust вызывает проверку немедленно", async () => {
  let state = "connected";
  let handler = null;
  let unsubscribed = 0;
  let shutdowns = 0;
  const watchdog = initHealthWatchdog({
    getState: () => state,
    isUpdateInstalling: () => false,
    shutdownCore: async () => { shutdowns++; state = "idle"; return true; },
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    subscribeCoreDeath: (fn) => { handler = fn; return () => { unsubscribed++; }; },
    invoke: async () => ({ singbox_running: false, last_error: "crashed" }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    // Таймер намеренно мёртвый: детект обязан работать и тогда, когда WebView
    // в трее задушен Chromium и тик приходит раз в минуту.
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  assert.equal(typeof handler, "function");
  handler({ payload: { generation: 3, reason: "crashed" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(shutdowns, 1);

  watchdog.stop();
  assert.equal(unsubscribed, 1);
});

test("опоздавший тик попадает в журнал, а не остаётся незамеченным", async () => {
  let clock = 1_700_000_000_000; // реальная эпоха: нулевой старт скрыл бы первый замер
  let timerCallback = null;
  const diagnostics = [];
  const watchdog = initHealthWatchdog({
    getState: () => "idle",
    isUpdateInstalling: () => false,
    shutdownCore: async () => {},
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    recordDiagnostic: (phase, result, reason) => diagnostics.push([phase, result, reason]),
    invoke: async () => ({ singbox_running: true, xray: "none", sidecar: "none" }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: (fn) => { timerCallback = fn; return 1; },
    clearInterval: () => {},
    perf: { gauge: () => {}, increment: () => {} },
    now: () => clock,
  });

  watchdog.start();
  clock += 5_000; // штатный интервал
  timerCallback();
  assert.deepEqual(diagnostics, []);

  clock += 65_000; // страница скрыта, Chromium разбудил таймер раз в минуту
  timerCallback();
  assert.deepEqual(diagnostics, [["watchdog_tick", "degraded", "gap_65000ms"]]);
});

test("перезапуск сторожа не копит слушателей события", async () => {
  const live = new Set();
  let issued = 0;
  const pending = [];
  const watchdog = initHealthWatchdog({
    getState: () => "connected",
    isUpdateInstalling: () => false,
    shutdownCore: async () => true,
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    // Подписка приезжает асинхронно — как настоящий listen() из Tauri.
    subscribeCoreDeath: () => {
      const id = ++issued;
      live.add(id);
      const promise = Promise.resolve(() => live.delete(id));
      pending.push(promise);
      return promise;
    },
    invoke: async () => ({ singbox_running: true, xray: "none", sidecar: "none" }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  watchdog.stop();
  watchdog.start();
  await Promise.all(pending);
  watchdog.stop();

  assert.equal(issued, 2);
  assert.equal(live.size, 0, "обе подписки обязаны быть сняты");
});

// Бюджет восстановления один на 15 минут. Списанный до остановки, он сгорал на
// неподтверждённой очистке: попытки поднять ядро не было, а следующая смерть
// уже упиралась в исчерпанный бюджет.
test("неудачная остановка не съедает бюджет восстановления", async () => {
  let state = "connected";
  let restores = 0;
  let stopOk = false;
  const diagnostics = [];
  const watchdog = initHealthWatchdog({
    getState: () => state,
    isUpdateInstalling: () => false,
    shutdownCore: async () => {
      if (!stopOk) return false; // очистка не подтверждена — state остаётся прежним
      state = "idle";
      return true;
    },
    restoreAfterCoreDeath: async () => { restores++; state = "connected"; return true; },
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    recordDiagnostic: (phase, result, reason) => diagnostics.push([phase, result, reason]),
    invoke: async () => ({ singbox_running: false, last_error: "crashed" }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();
  assert.equal(restores, 0, "неподтверждённый stop до восстановления не доходит");
  assert.deepEqual(diagnostics, [], "провал остановки не пишется как исход смерти ядра");

  stopOk = true;
  state = "connected";
  await watchdog.tick();
  assert.equal(restores, 1, "бюджет должен был остаться нетронутым");
  assert.deepEqual(diagnostics, [["core_death", "restored", "restore_attempted"]]);
});

test("исчерпанный бюджет отмечается в журнале как restore_budget", async () => {
  let state = "connected";
  let restores = 0;
  const diagnostics = [];
  const watchdog = initHealthWatchdog({
    getState: () => state,
    isUpdateInstalling: () => false,
    shutdownCore: async () => { state = "idle"; return true; },
    restoreAfterCoreDeath: async () => { restores++; state = "connected"; return true; },
    reconnectForSourceChange: () => {},
    switchView: () => {},
    getQualityEngine: () => null,
    recordDiagnostic: (phase, result, reason) => diagnostics.push([phase, result, reason]),
    invoke: async () => ({ singbox_running: false, last_error: "crashed" }),
    toast: () => {},
    notify: () => {},
    t: (key) => key,
    setInterval: () => 1,
    clearInterval: () => {},
  });

  watchdog.start();
  await watchdog.tick();
  state = "connected";
  await watchdog.tick();

  assert.equal(restores, 1);
  assert.deepEqual(diagnostics, [
    ["core_death", "restored", "restore_attempted"],
    ["core_death", "stopped", "restore_budget"],
  ]);
});
