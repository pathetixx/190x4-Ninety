// The tray menu must not be rebuilt while the user holds it open:
// the replacement destroys the shown popup. In that case Rust answers applied:false,
// and the frontend must come back to this rebuild later.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (i) => Array.from(data.keys())[i] ?? null,
    getItem: (k) => data.has(k) ? data.get(k) : null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}

const calls = [];
let outcome = { applied: true };

globalThis.localStorage = makeStorage();
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "set_tray_menu") return outcome;
        return null;
      },
    },
    event: { listen: async () => () => {} },
  },
};

const { initTray, syncTrayMenu } = await import("/lib/tray.js");

const ctx = {
  getState: () => "idle",
  getUpdateVersion: () => null,
  isUpdateBusy: () => false,
  onSetMode: () => {},
  onToggleVpn: () => {},
  onUpdateClick: () => {},
  onServerSelected: () => {},
};

const menuCalls = () => calls.filter(c => c.cmd === "set_tray_menu").length;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test("применённое меню запоминается: тот же payload второй раз не пересобирается", async () => {
  initTray(ctx);
  outcome = { applied: true };
  await syncTrayMenu();
  const after = menuCalls();
  assert.equal(after, 1);
  await syncTrayMenu();
  assert.equal(menuCalls(), after, "неизменившийся payload не гоняет меню заново");
});

test("отложенная пересборка не считается применённой и повторяется сама", async () => {
  const before = menuCalls();
  outcome = { applied: false };
  // force, otherwise dedup will decide the payload is the same and there's nothing to do.
  await syncTrayMenu({ force: true });
  assert.equal(menuCalls(), before + 1);

  // The menu closed — the retry goes through and the payload is finally remembered.
  outcome = { applied: true };
  await sleep(1700);
  assert.ok(menuCalls() >= before + 2, "отложенная пересборка должна повториться");

  const settled = menuCalls();
  await syncTrayMenu();
  assert.equal(menuCalls(), settled, "после успешного применения дедуп снова работает");
});
