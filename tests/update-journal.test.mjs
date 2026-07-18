import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = {};
const {
  buildUpdateJournal,
  clearUpdateJournal,
  persistUpdateJournal,
  portableReleaseUrl,
  resumeRuntimeReady,
  updateRecoveryRequired,
} = await import("/lib/update-modal.js");

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    setItem: (key, value) => data.set(key, String(value)),
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => data.delete(key),
  };
}

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
  const storage = makeStorage();
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

test("OTA journal cleanup is verified instead of silently succeeding", () => {
  const storage = makeStorage({ "ninety.update.resume": "journal" });
  clearUpdateJournal(storage);
  assert.equal(storage.getItem("ninety.update.resume"), null);

  assert.throws(() => clearUpdateJournal({
    removeItem: () => {},
    getItem: () => "journal",
  }), /cleanup verification failed/);
});

test("RuntimeReady closes resume marker only after both desired runtimes are ready", () => {
  const journal = buildUpdateJournal({ stage: "installing", vpn: true, dpi: false });
  const storage = makeStorage({ "ninety.update.resume": JSON.stringify(journal) });
  assert.equal(resumeRuntimeReady(journal, { vpnReady: false, dpiReady: true }, storage), false);
  assert.notEqual(storage.getItem("ninety.update.resume"), null);
  assert.equal(resumeRuntimeReady(journal, { vpnReady: true, dpiReady: true }, storage), true);
  assert.equal(storage.getItem("ninety.update.resume"), null);
});

test("RuntimeReady does not report success when resume marker cannot be removed", () => {
  const journal = buildUpdateJournal({ stage: "installing", vpn: true, dpi: false });
  const storage = {
    removeItem: () => {},
    getItem: () => JSON.stringify(journal),
  };
  assert.equal(resumeRuntimeReady(journal, { vpnReady: true, dpiReady: true }, storage), false);
});

test("OTA recovery is skipped while the original runtime is still healthy", async () => {
  const journal = buildUpdateJournal({ stage: "backup_ready", vpn: true, dpi: true });
  const healthyInvoke = async (command) => {
    if (command === "runtime_snapshot") {
      return { running: true, clashReady: true, sidecars: { xray: "alive", clients: "alive" } };
    }
    if (command === "dpi_running") return true;
    throw new Error(`unexpected command: ${command}`);
  };
  assert.equal(await updateRecoveryRequired(journal, healthyInvoke, false), false);
  assert.equal(await updateRecoveryRequired(journal, healthyInvoke, true), false);
});

test("OTA recovery is required after shutdown or uncertain runtime state", async () => {
  const journal = buildUpdateJournal({ stage: "runtime_stopped", vpn: true, dpi: false });
  assert.equal(await updateRecoveryRequired(journal, async (command) => {
    if (command === "runtime_snapshot") return { running: false, clashReady: false };
    throw new Error(`unexpected command: ${command}`);
  }, true), true);
  assert.equal(await updateRecoveryRequired(journal, async () => { throw new Error("IPC failed"); }, true), true);
});
