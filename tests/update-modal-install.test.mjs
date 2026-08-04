import { test } from "node:test";
import assert from "node:assert/strict";

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.style = {};
    this.listeners = new Map();
    this.classList = { add() {}, remove() {} };
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((item) => item !== listener));
  }

  async dispatch(type, event = {}) {
    const listeners = [...(this.listeners.get(type) || [])];
    await Promise.all(listeners.map((listener) => listener(event)));
  }
}

function makeStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

const elements = new Map([
  "update-modal",
  "update-backdrop",
  "update-current",
  "update-latest",
  "update-changelog",
  "update-progress",
  "update-later",
  "update-install",
  "update-bar",
  "update-progress-pct",
  "update-progress-label",
  "update-error",
].map((id) => [id, new FakeElement()]));

const documentListeners = new Map();
globalThis.document = {
  getElementById: (id) => elements.get(id) || null,
  addEventListener: (type, listener) => {
    const list = documentListeners.get(type) || [];
    list.push(listener);
    documentListeners.set(type, list);
  },
  removeEventListener: (type, listener) => {
    const list = documentListeners.get(type) || [];
    documentListeners.set(type, list.filter((item) => item !== listener));
  },
};
globalThis.localStorage = makeStorage();
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command) => {
        if (command === "singbox_running") return false;
        if (command === "stop_singbox") {
          return {
            portsReleased: true,
            processesExited: true,
            singbox: "stopped",
            xray: "stopped",
            sidecars: "stopped",
            systemProxy: "cleared",
          };
        }
        if (command === "dpi_unload_driver") return null;
        throw new Error(`unexpected invoke: ${command}`);
      },
    },
    process: { relaunch: async () => {} },
  },
};

const {
  openUpdateModal,
  shouldSkip,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
} = await import("/lib/update-modal.js");

function resetUi() {
  localStorage.clear();
  for (const element of elements.values()) {
    element.hidden = false;
    element.disabled = false;
    element.textContent = "";
    element.style = {};
    element.listeners.clear();
  }
  documentListeners.clear();
}

// Esc и клик мимо окна — это «убрать с глаз», а не «эту версию не показывать».
// Раньше оба пути вели в «Позже» и писали версию в localStorage навсегда.
test("Esc закрывает окно, но не отказывается от версии навсегда", async () => {
  resetUi();
  const modal = openUpdateModal({ currentVersion: "0.2.42", version: "0.3.10", body: "notes" });
  for (const listener of [...(documentListeners.get("keydown") || [])]) {
    listener({ key: "Escape" });
  }
  await modal;
  assert.equal(elements.get("update-modal").hidden, true);
  assert.equal(localStorage.getItem("ninety.update.skip"), null);
  // В этой сессии не навязываемся — но апдейт остаётся в трее и после рестарта.
  assert.equal(shouldSkip("0.3.10"), true);
});

test("«Позже» помнит отказ и между запусками", async () => {
  resetUi();
  const modal = openUpdateModal({ currentVersion: "0.2.42", version: "0.3.11", body: "notes" });
  await elements.get("update-later").dispatch("click");
  await modal;
  assert.equal(localStorage.getItem("ninety.update.skip"), "0.3.11");
});

test("install получает свежий Update и передаёт bounded download timeout", async () => {
  resetUi();
  let downloadOptions = null;
  let closes = 0;
  let runtimeStops = 0;
  const busyStates = [];
  const fresh = {
    currentVersion: "0.2.42",
    version: "0.2.43",
    body: "notes",
    download: async (_onEvent, options) => {
      downloadOptions = options;
      throw new Error("network stalled");
    },
    install: async () => {},
    close: async () => { closes++; },
  };
  const modal = openUpdateModal(
    { currentVersion: "0.2.42", version: "0.2.43", body: "notes" },
    {
      acquireUpdate: async () => fresh,
      onInstalling: (busy) => { busyStates.push(busy); },
      onBeforeRuntimeStop: () => { runtimeStops++; },
    },
  );

  await elements.get("update-install").dispatch("click");
  assert.deepEqual(downloadOptions, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });
  assert.deepEqual(busyStates, [true, false]);
  assert.equal(runtimeStops, 0);
  assert.equal(elements.get("update-install").disabled, false);
  assert.equal(closes, 1);

  await elements.get("update-later").dispatch("click");
  await modal;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
});

test("смена версии перед download требует повторного подтверждения", async () => {
  resetUi();
  let closes = 0;
  let downloads = 0;
  const newer = {
    currentVersion: "0.2.42",
    version: "0.2.44",
    body: "new notes",
    download: async () => { downloads++; },
    install: async () => {},
    close: async () => { closes++; },
  };
  const modal = openUpdateModal(
    { currentVersion: "0.2.42", version: "0.2.43", body: "old notes" },
    { acquireUpdate: async () => newer },
  );

  await elements.get("update-install").dispatch("click");
  assert.equal(downloads, 0);
  assert.equal(closes, 1);
  assert.equal(elements.get("update-latest").textContent, "0.2.44");
  assert.equal(elements.get("update-error").hidden, false);
  assert.match(elements.get("update-error").textContent, /0\.2\.44/);

  await elements.get("update-later").dispatch("click");
  await modal;
});

test("вернувшийся install не закрывает уже consumed Update повторно", async () => {
  resetUi();
  let closes = 0;
  const fresh = {
    currentVersion: "0.2.42",
    version: "0.2.43",
    body: "notes",
    download: async () => {},
    install: async () => {},
    close: async () => {
      closes++;
      throw new Error("resource already consumed by install");
    },
  };
  globalThis.window.__TAURI__.process.relaunch = async () => {
    throw new Error("relaunch unavailable");
  };
  const modal = openUpdateModal(
    { currentVersion: "0.2.42", version: "0.2.43", body: "notes" },
    { acquireUpdate: async () => fresh },
  );

  await elements.get("update-install").dispatch("click");
  assert.equal(closes, 0);
  assert.equal(elements.get("update-install").disabled, false);

  await elements.get("update-install").dispatch("click");
  await modal;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 0);

  globalThis.window.__TAURI__.process.relaunch = async () => {};
});
