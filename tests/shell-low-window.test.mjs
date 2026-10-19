// Низкое окно (issue #187). Строка сетки `1fr` = minmax(auto, 1fr): она росла
// до минимального размера содержимого, сайдбар и главный экран вылезали за окно
// и срезались без прокрутки — пропадали «Настройки», трафик и строка статистики.
// Инвариант: ряды шелла ограничены окном, а сцена HUD меряется от своей ячейки.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("src/styles/app.css", "utf8");
const screens = readFileSync("src/styles/screens.css", "utf8");
const html = readFileSync("src/index.html", "utf8");
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `нет правила ${selector}`);
  return match[1];
}

test("ряды шелла не растут под содержимое", () => {
  assert.match(rule(css, ".app"), /grid-template-rows:\s*36px minmax\(0, 1fr\)/);
  assert.match(rule(css, ".layout"), /grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(rule(css, ".sidebar"), /min-height:\s*0/);
  assert.match(rule(css, ".nav"), /overflow-y:\s*auto/);
});

test("сцена HUD меряется от ячейки над статусом", () => {
  assert.match(rule(css, ".hero__cell"), /container-type:\s*size/);
  assert.doesNotMatch(rule(css, ".hero"), /container-type/);
  assert.match(rule(css, ".hero__stage"), /min\(100cqw, 100cqh\)/);
  assert.match(html, /<div class="hero__cell">\s*<div class="hero__stage">/);
  assert.match(screens, /\.screen > \.hero \{[^}]*min-height:\s*auto/);
});

test("минимальный размер окна не ниже проверенного", () => {
  const win = conf.app.windows[0];
  // 720×560 проверено замером: всё содержимое достижимо прокруткой.
  assert.ok(win.minWidth >= 720, `minWidth ${win.minWidth}`);
  assert.ok(win.minHeight >= 560, `minHeight ${win.minHeight}`);
});
