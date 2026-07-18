// Premium theme collection: registry and material layer stay in sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THEMES } from "/lib/themes.js";

const PREMIUM_THEME_IDS = ["kintsugi", "aurora", "porcelain", "titanium"];
const style = name => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), "utf8");
const css = [
  style("premium-theme-kintsugi.css"),
  style("premium-theme-aurora.css"),
  style("premium-theme-porcelain.css"),
  style("premium-theme-titanium.css"),
  style("premium-theme-shared.css"),
].join("\n");
const manifestCss = style("premium-themes.css");
const rtlCss = style("rtl.css");

test("premium themes: все четыре темы зарегистрированы", () => {
  const ids = new Set(THEMES.map(theme => theme.id));
  for (const id of PREMIUM_THEME_IDS) assert.equal(ids.has(id), true, id);
});

test("premium themes: manifest подключает все material styles", () => {
  for (const id of [...PREMIUM_THEME_IDS, "shared"]) {
    assert.match(manifestCss, new RegExp(`premium-theme-${id}\\.css`));
  }
  assert.match(rtlCss, /^@import url\(["']\/styles\/premium-themes\.css["']\);/);
});

test("premium themes: каждая тема имеет material tokens и preview", () => {
  for (const id of PREMIUM_THEME_IDS) {
    assert.match(css, new RegExp(`data-theme=["']${id}["']`));
    assert.match(css, new RegExp(`\\.theme-card\\[data-theme=["']${id}["']\\]`));
  }

  for (const token of [
    "--premium-secondary",
    "--premium-status",
    "--premium-card",
    "--premium-card-hover",
    "--premium-disc",
    "--premium-border",
    "--premium-shadow",
    "--premium-mask-idle",
    "--premium-mask-secured",
  ]) {
    assert.match(css, new RegExp(`${token}:`));
  }
});

test("premium themes: porcelain отключает тяжёлый glitch transform", () => {
  assert.match(css, /data-theme="porcelain"[^}]*[\s\S]*?\[data-hud="ca"\][^{]*\{[^}]*transform:\s*none\s*!important/);
});
