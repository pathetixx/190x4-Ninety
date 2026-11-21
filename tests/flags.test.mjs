// flagIsoFromName: emoji flag → full name → UPPER code → alias, and no
// false flags from ordinary lowercase words ("My"/"Do").
import { test } from "node:test";
import assert from "node:assert/strict";
import { flagIsoFromName, stripFlag } from "/lib/flags.js";

test("regional-indicator эмодзи → iso", () => {
  assert.equal(flagIsoFromName("🇩🇪 Germany #1"), "de");
  assert.equal(flagIsoFromName("🇫🇮 Helsinki"), "fi");
});

test("полное имя страны (англ/рус) → iso", () => {
  assert.equal(flagIsoFromName("Netherlands-2"), "nl");
  assert.equal(flagIsoFromName("Россия Москва"), "ru");
  assert.equal(flagIsoFromName("United States East"), "us");
});

test("UPPER 2-3 буквенный код → iso / алиас", () => {
  assert.equal(flagIsoFromName("DE-1"), "de");
  assert.equal(flagIsoFromName("US East"), "us");
  assert.equal(flagIsoFromName("UK London"), "gb"); // alias uk→gb
  assert.equal(flagIsoFromName("USA West"), "us");   // alias usa→gb? no — us
});

test("обычные слова в нижнем регистре НЕ дают ложный флаг", () => {
  assert.equal(flagIsoFromName("My Server"), null);   // not → my (Malaysia)
  assert.equal(flagIsoFromName("Do Something"), null); // not → do (Dominica)
  assert.equal(flagIsoFromName("in transit"), null);
});

test("stripFlag убирает эмодзи-флаг", () => {
  assert.equal(stripFlag("🇩🇪 Germany"), "Germany");
  assert.equal(stripFlag("Plain Name"), "Plain Name");
});
