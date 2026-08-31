// Одна и та же ссылка не должна давать вторую копию подписки.
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

let invokeHandler = async () => {
  throw new Error("invoke handler is not configured");
};

globalThis.window = {
  __TAURI__: { core: { invoke: (...args) => invokeHandler(...args) } },
};
globalThis.localStorage = makeStorage();
// Окно добавления трогает DOM (полоса распознавания, кнопки). В тестах его нет,
// а весь код в add-modal.js null-safe — хватает пустых заглушек.
globalThis.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};

const {
  addSubscriptionFromUrl,
  findSubscriptionByUrl,
  loadSubscriptions,
  normalizeSubscriptionUrl,
  saveSubscriptions,
} = await import("/lib/subscriptions.js");
const { importAddInput } = await import("/lib/add-modal.js");

test("адрес сравнивается без учёта регистра схемы и хоста, порта по умолчанию и якоря", () => {
  const base = normalizeSubscriptionUrl("https://panel.example/sub/key");
  assert.equal(normalizeSubscriptionUrl("https://PANEL.Example/sub/key"), base);
  assert.equal(normalizeSubscriptionUrl("https://panel.example:443/sub/key"), base);
  assert.equal(normalizeSubscriptionUrl("  https://panel.example/sub/key#anchor  "), base);
  // Путь и параметры различают подписки одной панели — их не трогаем.
  assert.notEqual(normalizeSubscriptionUrl("https://panel.example/sub/other"), base);
  assert.notEqual(normalizeSubscriptionUrl("https://panel.example/sub/key?v=2"), base);
  assert.notEqual(normalizeSubscriptionUrl("http://panel.example/sub/key"), base);
});

test("повторное добавление возвращает уже добавленную подписку и не ходит в сеть", async () => {
  localStorage.clear();
  let fetches = 0;
  invokeHandler = async (cmd) => {
    if (cmd === "device_identity") return { hwid: null, deviceOs: "Windows", verOs: "" };
    fetches++;
    return { status: 200, body: "vless://uuid@node.example:443?security=tls#Amsterdam" };
  };

  const first = await importAddInput("https://panel.example/sub/key");
  assert.equal(first.type, "sub");
  assert.equal(first.duplicate, undefined);
  assert.equal(fetches, 1);

  const again = await importAddInput("https://PANEL.example/sub/key#anchor");
  assert.equal(again.duplicate, true);
  assert.equal(again.source.id, first.source.id);
  assert.equal(again.activate, false);
  assert.equal(fetches, 1, "повтор не делает второй запрос к панели");
  assert.equal(loadSubscriptions().length, 1);
});

test("addSubscriptionFromUrl отказывает и на прямом вызове, минуя окно добавления", async () => {
  localStorage.clear();
  saveSubscriptions([
    { id: "s1", name: "Panel", url: "https://panel.example/sub/key", profiles: [] },
  ]);
  invokeHandler = async () => { throw new Error("сеть трогать не должны"); };

  await assert.rejects(
    () => addSubscriptionFromUrl("https://panel.example:443/sub/key"),
    (err) => {
      assert.equal(err.code, "duplicate");
      assert.equal(err.subscriptionId, "s1");
      assert.match(err.message, /Panel/);
      return true;
    },
  );
  assert.equal(loadSubscriptions().length, 1);
});

test("другая подписка той же панели добавляется как отдельная", async () => {
  localStorage.clear();
  saveSubscriptions([
    { id: "s1", name: "Panel", url: "https://panel.example/sub/key", profiles: [] },
  ]);
  assert.equal(findSubscriptionByUrl("https://panel.example/sub/other"), null);

  invokeHandler = async (cmd) => {
    if (cmd === "device_identity") return { hwid: null, deviceOs: "Windows", verOs: "" };
    return { status: 200, body: "vless://uuid@node.example:443?security=tls#Amsterdam" };
  };
  const added = await addSubscriptionFromUrl("https://panel.example/sub/other");
  assert.ok(added.id);
  assert.equal(loadSubscriptions().length, 2);
});
