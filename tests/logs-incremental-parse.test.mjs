import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
const { parseLogEntries } = await import("/lib/logs-view.js");

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
