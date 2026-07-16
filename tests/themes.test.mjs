// Theme registry: единый источник тем для main/settings/onboarding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_THEME_ID,
  THEMES,
  getThemeMeta,
  isThemeId,
} from "/lib/themes.js";

test("themes: id уникальны", () => {
  const ids = THEMES.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("themes: default существует", () => {
  assert.equal(isThemeId(DEFAULT_THEME_ID), true);
});

test("themes: metadata заполнена", () => {
  for (const theme of THEMES) {
    assert.equal(typeof theme.id, "string");
    assert.equal(typeof theme.name, "string");
    assert.equal(typeof theme.kicker, "string");
    assert.equal(typeof theme.accent, "string");
    assert.equal(typeof theme.glow, "string");
    assert.ok(theme.id);
    assert.ok(theme.name);
    assert.ok(theme.kicker);
    assert.ok(theme.accent);
    assert.ok(theme.glow);
  }
});

test("themes: unknown не считается темой и fallback ведёт на default", () => {
  assert.equal(isThemeId("unknown"), false);
  assert.equal(getThemeMeta("unknown").id, DEFAULT_THEME_ID);
});

test("themes: sidebar получает материал из токенов активной темы", () => {
  const tokensCss = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const appCss = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
  for (const token of [
    "--sidebar-surface-top",
    "--sidebar-surface-bottom",
    "--sidebar-row-start",
    "--sidebar-row-middle",
    "--sidebar-row-hover",
    "--sidebar-row-active",
    "--sidebar-text",
    "--sidebar-text-active",
  ]) {
    assert.match(tokensCss, new RegExp(`${token}:`));
    assert.match(appCss, new RegExp(`var\\(${token}\\)`));
  }

  const sidebarCss = appCss.slice(appCss.indexOf(".sidebar {"), appCss.indexOf("/* ═══════════════════════════════════════════\n   CONTENT"));
  assert.doesNotMatch(sidebarCss, /#0b0c0e|#08090b|#060709|#85878c|#f1f1f2/i);
});
