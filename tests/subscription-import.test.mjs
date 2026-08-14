// Импорт подписки: битые ноды не попадают в конфиг, счётчик пропущенных честный,
// и добавление НЕ переключает активный источник.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
  };
}

globalThis.localStorage = makeStorage();

// Минимальный DOM: модалка добавления трогает поля формы, а уведомление о
// пропущенных серверах — стек тостов. Логика импорта от разметки не зависит.
const fakeEl = () => {
  const el = {
    className: "", id: "", dataset: {}, innerHTML: "", hidden: false, children: [],
    style: { setProperty() {}, removeProperty() {} },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { el.children.push(child); return child; },
    insertBefore(child) { el.children.push(child); return child; },
    remove() {}, focus() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    contains() { return false; },
  };
  return el;
};
globalThis.document = {
  body: fakeEl(),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => fakeEl(),
  addEventListener() {}, removeEventListener() {},
};

const PBK = "0i4XeZ4CjhIRfQvvyPP6mQR5X5Ov1DKV0KRWFhvQF1s";
const BODY = [
  `vless://00000000-0000-4000-8000-000000000001@ok1.example:443?security=reality&pbk=${PBK}&sni=a.example#ok1`,
  "vless://00000000-0000-4000-8000-000000000002@broken.example:443?security=reality&sni=a.example#broken",
  `vless://00000000-0000-4000-8000-000000000003@ok2.example:443?security=reality&pbk=${PBK}&sni=a.example#ok2`,
  "не ссылка вовсе",
].join("\n");

// Мок ставим ДО импорта модулей: subscriptions.js забирает invoke на загрузке.
globalThis.window = globalThis.window || {};
globalThis.window.__TAURI__ = {
  core: {
    invoke: async (cmd) => {
      if (cmd === "fetch_subscription") {
        return { status: 200, body: BODY, profile_title: "panel" };
      }
      return null;
    },
  },
};

const { parseSubscriptionEntries } = await import("/lib/subscriptions.js");
const { importAddInput } = await import("/lib/add-modal.js");
const { getActiveSource } = await import("/lib/singbox.js");

test("парсер считает и отбрасывает всё, что ядро не примет", () => {
  const { profiles, skipped } = parseSubscriptionEntries(BODY);
  assert.equal(profiles.length, 2);
  assert.equal(skipped, 1);
  assert.deepEqual(profiles.map((p) => p.host), ["ok1.example", "ok2.example"]);
});

test("импорт подписки сохраняет её, но не делает активной", async () => {
  localStorage.clear();
  const res = await importAddInput("https://panel.example/sub");

  assert.equal(res.type, "sub");
  assert.equal(res.activate, false);
  assert.equal(localStorage.getItem("ninety.subscriptions.active"), null);

  const subs = JSON.parse(localStorage.getItem("ninety.subscriptions.v1"));
  assert.equal(subs.length, 1);
  assert.equal(subs[0].profiles.length, 2);
  assert.equal(subs[0].skipped, 1);
});

test("источник подписки отдаёт только пригодные ноды даже из старой записи", async () => {
  localStorage.clear();
  const { profiles } = parseSubscriptionEntries(BODY);
  const broken = { proto: "vless", name: "broken", host: "broken.example", port: 443, security: "reality", pbk: "" };
  localStorage.setItem("ninety.subscriptions.v1", JSON.stringify([
    { id: "sub-legacy", url: "https://panel.example/sub", name: "legacy", profiles: [...profiles, broken] },
  ]));
  localStorage.setItem("ninety.subscriptions.active", "sub-legacy");
  localStorage.setItem("ninety.active.kind", "sub");

  const source = getActiveSource();
  assert.equal(source.kind, "sub");
  assert.equal(source.nodes.length, 2);
  assert.ok(!source.nodes.some((n) => n.host === "broken.example"));
});

// Список ссылок отбраковывает записи по тем же правилам, что и подписка, но
// раньше сообщал только про добавленные: пользователь вставлял 12 ссылок, видел
// «Импортировано 8 конфигов» и не знал, что четыре ядро не приняло.
test("импорт списка ссылок сообщает о пропущенных", async () => {
  localStorage.clear();
  const res = await importAddInput(BODY);
  assert.equal(res.type, "list");
  assert.equal(res.skipped, 1);
  assert.match(res.message, /1/);
});
