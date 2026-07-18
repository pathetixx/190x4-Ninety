import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {};
const {
  buildUpdateJournal,
  persistUpdateJournal,
  portableReleaseUrl,
  resumeRuntimeReady,
} = await import("/lib/update-modal.js");

test("portable release URL targets the exact encoded tag", () => {
  assert.equal(
    portableReleaseUrl("0.2.18"),
    "https://github.com/pathetixx/190x4-Ninety/releases/tag/v0.2.18",
  );
  assert.equal(portableReleaseUrl("1/2"),
    "https://github.com/pathetixx/190x4-Ninety/releases/tag/v1%2F2");
});

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

test("OTA journal persistence is verified before runtime shutdown", () => {
  const data = new Map();
  const storage = {
    setItem: (key, value) => data.set(key, String(value)),
    getItem: (key) => data.get(key) ?? null,
  };
  const journal = buildUpdateJournal({ stage: "backup_ready", vpn: true, dpi: false });
  const encoded = persistUpdateJournal(journal, storage);
  assert.equal(storage.getItem("ninety.update.resume"), encoded);
});

test("OTA journal storage failures abort instead of being ignored", () => {
  const journal = buildUpdateJournal({ stage: "backup_ready", vpn: true, dpi: false });
  assert.throws(() => persistUpdateJournal(journal, {
    setItem: () => { throw new Error("quota exceeded"); },
    getItem: () => null,
  }), /quota exceeded/);
  assert.throws(() => persistUpdateJournal(journal, {
    setItem: () => {},
    getItem: () => "truncated",
  }), /verification failed/);
});

test("UAC cancel / неготовый VPN не разрешает удалить resume journal", () => {
  const j = buildUpdateJournal({ stage: "installing", vpn: true, dpi: false });
  assert.equal(resumeRuntimeReady(j, { vpnReady: false, dpiReady: true }), false);
  assert.equal(resumeRuntimeReady(j, { vpnReady: true, dpiReady: true }), true);
});
