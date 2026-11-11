// Обсидиановый HUD главного экрана: камень, лава и корона — готовые рендеры,
// код только двигает слои. Здесь закреплены инварианты, на которых уже ловили
// баги: слой лавы шире камня, пауза вне главной, отдельное состояние отключения.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";

const html = readFileSync("src/index.html", "utf8");
const css = readFileSync("src/styles/obsidian-hud.css", "utf8");
const main = readFileSync("src/main.js", "utf8");

test("obsidian: ассеты на месте и подключены стилями", () => {
  for (const name of ["obsidian", "lava", "glint", "corona"]) {
    const file = `src/assets/hud/${name}.webp`;
    assert.ok(existsSync(file), file);
    assert.ok(statSync(file).size > 1000, `${file} пустой`);
  }
  assert.match(html, /src="\/assets\/hud\/obsidian\.webp"/);
  for (const name of ["lava", "glint", "corona"]) {
    assert.ok(css.includes(`url("/assets/hud/${name}.webp")`), name);
  }
  assert.match(html, /href="\/styles\/obsidian-hud\.css"/);
});

test("obsidian: старый SVG-HUD удалён целиком", () => {
  assert.equal(existsSync("src/lib/hero-hud.js"), false);
  assert.doesNotMatch(html, /id="hero-hud"/);
  assert.doesNotMatch(main, /hero-hud|initHeroHud|heroHud/);
});

test("obsidian: маска остаётся кнопкой подключения внутри сцены", () => {
  assert.match(html, /<div class="hero__cell">\s*<div class="hero__stage">/);
  assert.match(html, /<button class="hero__disc" id="hero-disc"[^>]*>\s*<span class="hero__face">\s*<video class="hero__mask" id="hero-mask"/);
});

test("obsidian: слой лавы шире камня — свечение не режется краем бокса", () => {
  const lava = css.match(/\.ob-lava \{([^}]*)\}/)?.[1] || "";
  assert.match(lava, /--ob-size:\s*100%/);
  assert.match(css, /\.ob-crack \{[^}]*inset:\s*8%/);
});

test("obsidian: отключение — своё состояние, лава остывает, а не мигает «подключением»", () => {
  assert.match(main, /disconnecting:\s*"unlinking"/);
  assert.match(css, /\.hero\[data-state="unlinking"\] \.ob-lava/);
});

test("obsidian: вне главной, в трее и без фокуса движение стоит", () => {
  assert.match(main, /function syncHeroMotion/);
  assert.match(main, /activityController\.subscribe\(\(snapshot\) => syncHeroMotion\(snapshot\)\)/);
  assert.match(main, /snapshot\.visible && snapshot\.focused && snapshot\.view === "home"/);
  assert.match(css, /\.hero\[data-motion="paused"\][^{]*\{[^}]*animation-play-state:\s*paused/);
});

test("obsidian: лава красится акцентом темы, в Kintsugi — золотом", () => {
  assert.match(css, /--lava:\s*var\(--accent\)/);
  const kintsugi = readFileSync("src/styles/premium-theme-kintsugi.css", "utf8");
  assert.match(kintsugi, /\.hero \{ --lava: #C9A45C; --lava-hot: #F1D594; \}/);
});
