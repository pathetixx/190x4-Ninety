// winws crashing mid-session: the Rust watchdog sends dpi:exited, and the interface
// must go into an error rather than show "Running" over a dead engine.
// An old session's event and a planned stop don't touch the state.
import test from "node:test";
import assert from "node:assert/strict";

const tick = () => new Promise((r) => setImmediate(r));

const storage = new Map([
  ["ninety.dpi.enabled", "false"],
  ["ninety.options.v1", JSON.stringify({ privacy: { strictTunnel: false }, route: { tunSplitDiscord: false } })],
]);
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const chip = { innerHTML: "" };
globalThis.document = {
  getElementById: (id) => (id === "dpi-chip-slot" ? chip : null),
  addEventListener: () => {},
};
const listeners = {};
let nextSession = 41;
const toasts = [];
globalThis.window = {
  __TAURI__: {
    core: { invoke: async (cmd) => {
      if (cmd === "dpi_strategies") return JSON.stringify([{ id: "alt11", name: "ALT11", args: [] }]);
      if (cmd === "dpi_running") return false;
      if (cmd === "dpi_start") return ++nextSession;
      return null;
    } },
    event: { listen: async (name, fn) => { listeners[name] = fn; return () => {}; } },
  },
  dispatchEvent: () => {},
};

const { mountDpiView, toggleDpi } = await import("/lib/dpi-view.js");
await mountDpiView({ ensureElevated: async () => true, onToast: (msg, kind) => toasts.push({ msg, kind }), switchView: () => {} });
const chipState = () => /data-state="([^"]+)"/.exec(chip.innerHTML)?.[1];
const fire = (payload) => listeners["dpi:exited"]({ payload });

test("подписка на dpi:exited оформлена при монтировании", () => {
  assert.equal(typeof listeners["dpi:exited"], "function");
});

test("падение текущего сеанса переводит DPI в ошибку", async () => {
  await toggleDpi();
  assert.equal(chipState(), "running");
  // An event from a previous session (e.g. it arrived after a restart) — ignored.
  fire({ generation: nextSession - 1, code: 1, message: "[[backend.dpi.exitedUnexpectedly {\"code\":\"1\"}]]" });
  assert.equal(chipState(), "running");

  fire({ generation: nextSession, code: 3, message: "[[backend.dpi.exitedUnexpectedly {\"code\":\"3\"}]]" });
  await tick();
  assert.equal(chipState(), "error");
  assert.equal(toasts.at(-1)?.kind, "error");
  // This is a failure, not the user's decision: the "enabled" wish stays.
  assert.equal(storage.get("ninety.dpi.enabled"), "true");
});

test("после плановой остановки запоздалое событие игнорируется", async () => {
  // A click in the error state with desired=true is a confirmed stop.
  await toggleDpi();
  assert.equal(chipState(), "off");
  await toggleDpi();
  assert.equal(chipState(), "running");
  const session = nextSession;
  await toggleDpi(); // planned stop
  assert.equal(chipState(), "off");
  fire({ generation: session, code: 1, message: "x" });
  assert.equal(chipState(), "off");
});
