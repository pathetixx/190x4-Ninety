// Карточка «Обновления» раньше показывала одну и ту же фразу независимо от
// того, шла проверка, нашлась ли версия и когда последний раз удалось
// достучаться до эндпоинтов. Здесь фиксируется, что строка следует состоянию.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || {};
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { aboutUpdateStatusText } = await import("/lib/settings-view.js");
const { t } = await import("/lib/i18n/index.js");

test("нет данных — прежнее обещание автоматических проверок", () => {
  assert.equal(aboutUpdateStatusText(null), t("settings.about.updStatus"));
  assert.equal(aboutUpdateStatusText({}), t("settings.about.updStatus"));
});

test("идущая проверка важнее всего остального", () => {
  const text = aboutUpdateStatusText({
    checking: true,
    pendingVersion: "0.5.5",
    lastSuccessAt: Date.now(),
  });
  assert.equal(text, t("settings.about.updStatusChecking"));
});

test("найденная версия называется прямо в строке", () => {
  const text = aboutUpdateStatusText({ pendingVersion: "0.5.5", lastSuccessAt: Date.now() });
  assert.ok(text.includes("0.5.5"), text);
});

test("без находки показывается давность последней удачной проверки", () => {
  const text = aboutUpdateStatusText({ lastSuccessAt: Date.now() - 5 * 60_000 });
  assert.notEqual(text, t("settings.about.updStatus"));
  assert.ok(text.includes("5"), text);
});
