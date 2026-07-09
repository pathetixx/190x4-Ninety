// Theme registry: единый источник тем для main/settings/onboarding.
import { test } from "node:test";
import assert from "node:assert/strict";
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
