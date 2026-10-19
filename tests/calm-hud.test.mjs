// Спокойный главный экран (issue #186): включается только явным выбором в
// настройках, системный reduced-motion его не включает, а переключение
// сразу доходит до HUD через шину.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const data = new Map();
globalThis.localStorage = {
  getItem: (k) => (data.has(k) ? data.get(k) : null),
  setItem: (k, v) => data.set(k, String(v)),
  removeItem: (k) => data.delete(k),
};
let mediaAsked = false;
globalThis.matchMedia = () => { mediaAsked = true; return { matches: true, addEventListener() {} }; };
const root = { dataset: {} };
globalThis.document = { documentElement: root };

const { STORAGE_KEYS } = await import("/lib/storage-policy.js");
const { on } = await import("/lib/bus.js");
const { applyCalmHud, CALM_HUD_EVENT, isCalmHud, setCalmHud } = await import("/lib/calm-hud.js");

beforeEach(() => {
  data.clear();
  root.dataset = {};
  mediaAsked = false;
});

test("по умолчанию HUD живой, системные настройки не спрашиваются", () => {
  assert.equal(isCalmHud(), false);
  applyCalmHud();
  assert.equal("hudMode" in root.dataset, false);
  assert.equal(mediaAsked, false);
});

test("включение пишет выбор, ставит атрибут и оповещает HUD", () => {
  const seen = [];
  const off = on(CALM_HUD_EVENT, (v) => seen.push(v));
  setCalmHud(true);
  assert.equal(localStorage.getItem(STORAGE_KEYS.calmHud), "on");
  assert.equal(root.dataset.hudMode, "calm");
  setCalmHud(false);
  assert.equal(localStorage.getItem(STORAGE_KEYS.calmHud), null);
  assert.equal("hudMode" in root.dataset, false);
  off();
  assert.deepEqual(seen, [true, false]);
});

test("мусор в хранилище не включает режим", () => {
  localStorage.setItem(STORAGE_KEYS.calmHud, "yes");
  assert.equal(isCalmHud(), false);
});

test("стили режима подключены и кольца в нём стоят", () => {
  const html = readFileSync("src/index.html", "utf8");
  assert.match(html, /href="\/styles\/calm-hud\.css"/);
  const css = readFileSync("src/styles/calm-hud.css", "utf8");
  assert.match(css, /html\[data-hud-mode="calm"\] \.hud__ticks \{\s*animation: none/);
  assert.match(css, /\.hud__ca-fx \{ filter: none !important; \}/);
});

test("подписи переключателя есть во всех языках", async () => {
  const { readdirSync } = await import("node:fs");
  const langs = readdirSync("src/lib/i18n").filter((f) => /^[a-z]{2}\.js$/.test(f));
  assert.ok(langs.length >= 15);
  for (const file of langs) {
    const src = readFileSync(`src/lib/i18n/${file}`, "utf8");
    assert.match(src, /calmHudTitle: "/, file);
    assert.match(src, /calmHudHint: "/, file);
  }
});
