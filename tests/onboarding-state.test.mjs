import test from "node:test";
import assert from "node:assert/strict";
import { shouldShowOnboarding } from "../src/lib/onboarding-state.js";

test("пропуск онбординга оставляет пустое приложение открытым", () => {
  assert.equal(shouldShowOnboarding({ sourceEmpty: true, done: true }), false);
});

test("первый запуск без источников показывает онбординг", () => {
  assert.equal(shouldShowOnboarding({ sourceEmpty: true, done: false }), true);
});
