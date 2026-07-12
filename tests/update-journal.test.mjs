import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {};
const { buildUpdateJournal, resumeRuntimeReady } = await import("/lib/update-modal.js");

test("OTA journal versioned и хранит fingerprint/mode/desired state", () => {
  const j = buildUpdateJournal({
    targetVersion: "0.3.0", stage: "runtime_stopped", sourceFingerprint: "fp", mode: "tun",
    vpn: true, dpi: true, attempts: 2,
  });
  assert.equal(j.schemaVersion, 2);
  assert.equal(j.stage, "runtime_stopped");
  assert.deepEqual(j.desired, { vpn: true, dpi: true });
  assert.equal(j.attempts, 2);
});

test("UAC cancel / неготовый VPN не разрешает удалить resume journal", () => {
  const j = buildUpdateJournal({ stage: "installing", vpn: true, dpi: false });
  assert.equal(resumeRuntimeReady(j, { vpnReady: false, dpiReady: true }), false);
  assert.equal(resumeRuntimeReady(j, { vpnReady: true, dpiReady: true }), true);
});
