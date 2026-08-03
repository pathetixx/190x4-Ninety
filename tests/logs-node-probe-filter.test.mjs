import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
const { parseLogEntries } = await import("/lib/logs-view.js");

// Балансеру нужны задержки всех нод подписки, поэтому health-checker опрашивает
// каждую и на каждую недоступную пишет WARN. В журнале от этого не видно ничего
// другого, хотя трафик идёт через один сервер.
const LOG = [
  "+0300 2026-08-03 22:19:19 WARN monitoring: outbound node-aaa URL test failed: i/o timeout",
  "+0300 2026-08-03 22:19:19 WARN monitoring: outbound node-bbb URL test failed: i/o timeout",
  "+0300 2026-08-03 22:19:20 INFO inbound/mixed[mixed-in]: tcp connection from 127.0.0.1",
].join("\n");

test("отчёты по неактивным нодам в журнал не попадают", () => {
  const entries = parseLogEntries(LOG, "node-bbb");
  assert.deepEqual(entries.map((entry) => entry.msg), [
    "monitoring: outbound node-bbb URL test failed: i/o timeout",
    "inbound/mixed[mixed-in]: tcp connection from 127.0.0.1",
  ]);
});

test("без активной ноды отчёты health-checker'а скрыты целиком", () => {
  const entries = parseLogEntries(LOG, null);
  assert.deepEqual(entries.map((entry) => entry.msg), [
    "inbound/mixed[mixed-in]: tcp connection from 127.0.0.1",
  ]);
});

test("продолжение отброшенной записи не прилипает к соседней", () => {
  const entries = parseLogEntries([
    "+0300 2026-08-03 22:19:18 INFO router: loaded rule-set",
    "+0300 2026-08-03 22:19:19 WARN monitoring: outbound node-aaa URL test failed:",
    "    dial tcp 38.244.173.25:443: i/o timeout",
  ].join("\n"), "node-bbb");
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].cont, []);
});
