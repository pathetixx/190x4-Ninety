// flagIsoFromName: эмодзи-флаг → полное имя → UPPER-код → алиас, и никаких
// ложных флагов от обычных слов ("My"/"Do") в нижнем регистре.
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
  assert.equal(flagIsoFromName("UK London"), "gb"); // алиас uk→gb
  assert.equal(flagIsoFromName("USA West"), "us");   // алиас usa→gb? нет — us
});

test("обычные слова в нижнем регистре НЕ дают ложный флаг", () => {
  assert.equal(flagIsoFromName("My Server"), null);   // не → my (Малайзия)
  assert.equal(flagIsoFromName("Do Something"), null); // не → do (Доминика)
  assert.equal(flagIsoFromName("in transit"), null);
});

test("stripFlag убирает эмодзи-флаг", () => {
  assert.equal(stripFlag("🇩🇪 Germany"), "Germany");
  assert.equal(stripFlag("Plain Name"), "Plain Name");
});
