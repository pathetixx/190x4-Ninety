import test from "node:test";
import assert from "node:assert/strict";
import { startupConnectRequested, startupRuntimePlan } from "../src/lib/startup-runtime-policy.js";

test("DPI восстанавливается после обычного запуска приложения", () => {
  const plan = startupRuntimePlan({ autoconnect: false, resume: null, dpiEnabled: true, mode: "systemProxy" });
  assert.deepEqual(plan, { vpnWanted: false, tunWanted: false, dpiWanted: true, shouldRun: true });
});

test("DPI остаётся на паузе в TUN без split Discord", () => {
  const plan = startupRuntimePlan({ autoconnect: false, resume: null, dpiEnabled: true, mode: "tun", tunSplitDiscord: false });
  assert.equal(plan.dpiWanted, false);
  assert.equal(plan.shouldRun, false);
});

test("автозапуск по-прежнему поднимает VPN", () => {
  const plan = startupRuntimePlan({ autoconnect: true, resume: null, dpiEnabled: false, mode: "proxy" });
  assert.equal(plan.vpnWanted, true);
  assert.equal(plan.shouldRun, true);
});

test("настройка «При запуске»: off не подключает", () => {
  assert.equal(startupConnectRequested({ setting: "off", lastState: "on" }), false);
  assert.equal(startupConnectRequested({ setting: undefined, lastState: "on" }), false);
});

test("настройка «При запуске»: always подключает всегда", () => {
  assert.equal(startupConnectRequested({ setting: "always", lastState: "off" }), true);
  assert.equal(startupConnectRequested({ setting: "always", lastState: null }), true);
});

test("настройка «При запуске»: restore уважает ручное отключение", () => {
  assert.equal(startupConnectRequested({ setting: "restore", lastState: "on" }), true);
  assert.equal(startupConnectRequested({ setting: "restore", lastState: "off" }), false);
  assert.equal(startupConnectRequested({ setting: "restore", lastState: null }), false);
});
