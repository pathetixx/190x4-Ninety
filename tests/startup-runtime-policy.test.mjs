import test from "node:test";
import assert from "node:assert/strict";
import { startupRuntimePlan } from "../src/lib/startup-runtime-policy.js";

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
