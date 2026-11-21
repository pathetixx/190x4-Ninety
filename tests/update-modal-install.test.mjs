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

// Esc and a click outside the window mean "move it out of sight", not "don't show this version".
// Previously both paths led to "Later" and wrote the version to localStorage forever.
test("Esc закрывает окно, но не отказывается от версии навсегда", async () => {
  resetUi();
  const modal = openUpdateModal({ currentVersion: "0.2.42", version: "0.3.10", body: "notes" });
  for (const listener of [...(documentListeners.get("keydown") || [])]) {
    listener({ key: "Escape" });
  }
  await modal;
  assert.equal(elements.get("update-modal").hidden, true);
  assert.equal(localStorage.getItem("ninety.update.skip"), null);
  // We don't impose in this session — but the update stays in the tray, even after a restart.
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

function withPortableTauri(downloadHandler) {
  const core = globalThis.window.__TAURI__.core;
  const originalInvoke = core.invoke;
  const calls = [];
  let opened = 0;
  core.Channel = class { constructor() { this.onmessage = null; } };
  core.invoke = async (command, args) => {
    if (command === "portable_update_download") {
      calls.push(args);
      return downloadHandler(args);
    }
    return originalInvoke(command, args);
  };
  globalThis.window.__TAURI__.shell = { open: async () => { opened++; } };
  return {
    calls,
    opened: () => opened,
    restore() {
      core.invoke = originalInvoke;
      delete core.Channel;
      delete globalThis.window.__TAURI__.shell;
    },
  };
}

function pressEscape() {
  for (const listener of [...(documentListeners.get("keydown") || [])]) {
    listener({ key: "Escape" });
  }
}

test("portable: смена версии ведёт на повторное подтверждение, а не на страницу релиза", async () => {
  resetUi();
  const tauri = withPortableTauri(async ({ expectedVersion }) => {
    if (expectedVersion !== "0.2.44") {
      throw '[[updModal.versionChanged {"version":"0.2.44"}]]';
    }
    throw "error sending request: connection reset";
  });
  const changed = [];
  const busyStates = [];
  let closes = 0;
  try {
    const modal = openUpdateModal(
      { currentVersion: "0.2.42", version: "0.2.43", body: "old notes" },
      {
        portable: true,
        acquireUpdate: async () => ({
          currentVersion: "0.2.42",
          version: "0.2.44",
          body: "new notes",
          close: async () => { closes++; },
        }),
        onVersionChanged: (version) => { changed.push(version); },
        onInstalling: (busy) => { busyStates.push(busy); },
      },
    );

    await elements.get("update-install").dispatch("click");
    assert.equal(tauri.calls.length, 1);
    assert.equal(tauri.calls[0].expectedVersion, "0.2.43");
    assert.equal(tauri.calls[0].timeoutMs, UPDATE_DOWNLOAD_TIMEOUT_MS);
    assert.deepEqual(changed, ["0.2.44"]);
    assert.deepEqual(busyStates, [true, false]);
    assert.equal(closes, 1);
    assert.equal(elements.get("update-latest").textContent, "0.2.44");
    assert.match(elements.get("update-changelog").textContent, /new notes/);
    assert.match(elements.get("update-error").textContent, /0\.2\.44/);
    assert.doesNotMatch(elements.get("update-error").textContent, /\[\[/);
    assert.equal(elements.get("update-progress").hidden, true);
    assert.equal(elements.get("update-later").hidden, false);
    assert.equal(elements.get("update-install").disabled, false);

    // A repeated "Update" downloads the new version and doesn't open the release page.
    await elements.get("update-install").dispatch("click");
    assert.equal(tauri.calls.length, 2);
    assert.equal(tauri.calls[1].expectedVersion, "0.2.44");
    assert.equal(tauri.opened(), 0);

    // A download error (including a timeout) frees the window.
    pressEscape();
    await modal;
    assert.equal(elements.get("update-modal").hidden, true);
  } finally {
    tauri.restore();
  }
});

test("portable: без свежих заметок смена версии не показывает старые", async () => {
  resetUi();
  const tauri = withPortableTauri(async () => {
    throw '[[updModal.versionChanged {"version":"0.2.46"}]]';
  });
  try {
    const modal = openUpdateModal(
      { currentVersion: "0.2.42", version: "0.2.45", body: "old notes" },
      {
        portable: true,
        acquireUpdate: async () => { throw new Error("offline"); },
      },
    );
    await elements.get("update-install").dispatch("click");
    assert.equal(elements.get("update-latest").textContent, "0.2.46");
    assert.doesNotMatch(elements.get("update-changelog").textContent, /old notes/);
    assert.match(elements.get("update-error").textContent, /0\.2\.46/);
    pressEscape();
    await modal;
  } finally {
    tauri.restore();
  }
});

test("portable: таймаут скачивания разблокирует окно и предлагает ZIP", async () => {
  resetUi();
  const tauri = withPortableTauri(async () => { throw "[[backend.diag.timeout]]"; });
  const busyStates = [];
  try {
    const modal = openUpdateModal(
      { currentVersion: "0.2.42", version: "0.2.47", body: "notes" },
      { portable: true, onInstalling: (busy) => { busyStates.push(busy); } },
    );
    await elements.get("update-install").dispatch("click");
    assert.deepEqual(busyStates, [true, false]);
    assert.equal(elements.get("update-progress").hidden, true);
    assert.equal(elements.get("update-later").hidden, false);
    assert.doesNotMatch(elements.get("update-error").textContent, /\[\[/);

    // The fallback button leads to the page of this same version.
    await elements.get("update-install").dispatch("click");
    assert.equal(tauri.opened(), 1);
    await modal;
  } finally {
    tauri.restore();
  }
});
