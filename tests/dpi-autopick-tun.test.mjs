// Auto-tuning kills winws and keeps the engine "off" while the run is going.
// If the VPN went into TUN during this time, setDpiVpnMode had nothing to pause,
// and the recovery after tuning brought winws up right in TUN — while the interface
// showed "Paused", and the engine chewed on the tunnel traffic.
import test from "node:test";
import assert from "node:assert/strict";

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise((r) => setImmediate(r));

const storage = new Map([
  ["ninety.dpi.enabled", "true"],
  ["ninety.dpi.ipset", "any"],
  ["ninety.options.v1", JSON.stringify({ privacy: { strictTunnel: false }, route: { tunSplitDiscord: false } })],
]);
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const handlers = {};
const chip = { innerHTML: "" };
globalThis.document = {
  getElementById: (id) => (id === "dpi-chip-slot" ? chip : null),
  addEventListener: (type, fn) => { handlers[type] = fn; },
};
let autotestGate = deferred();
const calls = [];
globalThis.window = {
  __TAURI__: { core: { invoke: async (cmd) => {
    calls.push(cmd);
    if (cmd === "dpi_strategies") return JSON.stringify([{ id: "general", name: "general", args: [] }]);
    if (cmd === "dpi_running") return true;
    if (cmd === "dpi_autotest") { await autotestGate.promise; return { best_id: null, total: 1, targets: 3, best_targets: 0, engine_failed: 0 }; }
    if (cmd === "dpi_start") return 2;
    if (cmd === "dpi_domains_count" || cmd === "dpi_ipset_count") return 0;
    if (cmd === "dpi_auto_domains") return [];
    if (cmd === "dpi_check_update") return { available: false };
    return null;
  } } },
  dispatchEvent: () => {},
};

const { mountDpiView, setDpiVpnMode } = await import("/lib/dpi-view.js");
const count = (cmd) => calls.filter((c) => c === cmd).length;
const chipState = () => /data-state="([^"]+)"/.exec(chip.innerHTML)?.[1];
const clickPickStart = () => {
  const fakeTarget = (sel) => ({ closest: (q) => (q === sel ? {} : null) });
  handlers.click({ target: fakeTarget("[data-dpi-pick-start]"), preventDefault() {}, stopPropagation() {} });
};

await mountDpiView({ ensureElevated: async () => true, onToast: () => {}, switchView: () => {} });

test("автоподбор, начатый вне TUN, после перехода в TUN оставляет паузу, а не winws", async () => {
  await setDpiVpnMode("systemProxy");
  clickPickStart();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(count("dpi_autotest"), 1, "подбор запущен");
  // The user (or wifi-guard) switches to TUN during tuning.
  assert.equal(await setDpiVpnMode("tun"), true);
  const startsBefore = count("dpi_start");
  autotestGate.resolve();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(count("dpi_start"), startsBefore, "winws не поднят в TUN");
  assert.equal(chipState(), "paused");
  assert.equal(storage.get("ninety.dpi.enabled"), "true", "желание DPI сохраняется до выхода из TUN");

  // Leaving TUN brings the engine back the regular way.
  assert.equal(await setDpiVpnMode("systemProxy"), true);
  assert.equal(count("dpi_start"), startsBefore + 1);
  assert.equal(chipState(), "running");
});

test("возврат из TUN во время подбора не стартует winws поверх прогона", async () => {
  // Right now the engine runs outside TUN. A new run during which the VPN
  // manages to go into TUN and back.
  autotestGate = deferred();
  clickPickStart();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(count("dpi_autotest"), 2);
  const startsBefore = count("dpi_start");
  await setDpiVpnMode("tun");
  await setDpiVpnMode("systemProxy");
  assert.equal(count("dpi_start"), startsBefore, "resume отложен до конца подбора");
  autotestGate.resolve();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(count("dpi_start"), startsBefore + 1, "движок возвращён ровно один раз");
  assert.equal(chipState(), "running");
});
