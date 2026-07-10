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
