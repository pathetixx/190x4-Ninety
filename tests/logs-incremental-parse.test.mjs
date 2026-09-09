import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
const { parseLogEntries, applyLogChunk } = await import("/lib/logs-view.js");

// Журнал дочитывается с прошлой позиции, поэтому разбирается только дописанный
// кусок. Проверяем ровно то, что от этого может сломаться: границу между старым
// и новым текстом.

test("дописанный кусок разбирается сам по себе", () => {
  const first = parseLogEntries("+0300 2026-08-03 22:19:18 INFO router: loaded rule-set", null);
  const added = parseLogEntries(
    "+0300 2026-08-03 22:19:20 WARN router: rule-set reload failed",
    null,
    { carry: first.at(-1) },
  );
  assert.deepEqual(added.map((e) => [e.lvl, e.msg]), [
    ["WARN", "router: rule-set reload failed"],
  ]);
  // Запись из прошлого куска не продублирована в результате.
  assert.equal(first.length, 1);
});

test("продолжение многострочной записи приклеивается к записи из прошлого куска", () => {
  const first = parseLogEntries("+0300 2026-08-04 19:55:27 ERROR connection: dial failed:", null);
  const carry = first.at(-1);
  const added = parseLogEntries("    dial tcp 10.0.0.1:443: i/o timeout", null, { carry });
  assert.equal(added.length, 0, "продолжение не должно становиться новой записью");
  assert.deepEqual(carry.cont, ["    dial tcp 10.0.0.1:443: i/o timeout"]);
});

test("без carry продолжение остаётся самостоятельной записью", () => {
  const added = parseLogEntries("    dial tcp 10.0.0.1:443: i/o timeout", null);
  assert.equal(added.length, 1);
  assert.equal(added[0].lvl, "");
});

test("carry не мешает первой строке с собственным уровнем", () => {
  const first = parseLogEntries("+0300 2026-08-04 19:55:27 INFO a", null);
  const carry = first.at(-1);
  const added = parseLogEntries("+0300 2026-08-04 19:55:28 INFO b", null, { carry });
  assert.equal(added.length, 1);
  assert.equal(carry.cont.length, 0);
});

// Рендер дописывает в конец списка только то, что пришло в `added`. Когда кусок
// начинается с продолжения уже нарисованной записи, дописывать нечего, а запись
// изменилась — об этом обязан сказать carryGrew, иначе хвост ошибки не виден на
// экране до полной пересборки.
test("продолжение прошлой записи помечается carryGrew", () => {
  const entries = [];
  const first = applyLogChunk(entries, "+0300 2026-08-04 19:55:27 ERROR connection: dial failed:\n", null);
  assert.equal(first.added.length, 1);
  assert.equal(first.carryGrew, false);

  const second = applyLogChunk(entries, "    dial tcp 10.0.0.1:443: i/o timeout\n", null);
  assert.equal(second.added.length, 0, "продолжение не становится новой записью");
  assert.equal(second.carryGrew, true, "изменение уже нарисованной записи должно быть видно рендеру");
  assert.deepEqual(entries.at(-1).cont, ["    dial tcp 10.0.0.1:443: i/o timeout"]);
});

test("обычный кусок с новой записью carryGrew не поднимает", () => {
  const entries = [];
  applyLogChunk(entries, "+0300 2026-08-04 19:55:27 INFO a\n", null);
  const next = applyLogChunk(entries, "+0300 2026-08-04 19:55:28 INFO b\n", null);
  assert.equal(next.added.length, 1);
  assert.equal(next.carryGrew, false);
});

test("вытеснение по лимиту отдаёт выпавшие записи", () => {
  const entries = [];
  applyLogChunk(entries, "+0300 2026-08-04 19:55:27 INFO a\n", null, 2);
  applyLogChunk(entries, "+0300 2026-08-04 19:55:28 INFO b\n", null, 2);
  const third = applyLogChunk(entries, "+0300 2026-08-04 19:55:29 INFO c\n", null, 2);
  assert.deepEqual(third.dropped.map((e) => e.msg), ["a"]);
  assert.deepEqual(entries.map((e) => e.msg), ["b", "c"]);
});
