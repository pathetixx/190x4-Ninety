// Лента инцидентов: кольцо/TTL хранилища и группировка событий в инциденты.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIncidentLog, degradedMs, groupIncidents } from "/lib/incident-log.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

test("incident log: запись переживает перечитывание хранилища", () => {
  const storage = fakeStorage();
  const log = createIncidentLog({ storage, now: () => 1_000 });
  log.record("quality.degraded", { severity: "warn", params: { bps: 180_000 } });

  const reopened = createIncidentLog({ storage, now: () => 2_000 });
  const [entry] = reopened.list();
  assert.equal(entry.kind, "quality.degraded");
  assert.equal(entry.severity, "warn");
  assert.deepEqual(entry.params, { bps: 180_000 });
});

test("incident log: кольцо режет старые записи по cap", () => {
  const log = createIncidentLog({ storage: fakeStorage(), now: () => 1_000, cap: 3 });
  for (let i = 0; i < 5; i++) log.record(`k${i}`, { severity: "info" });
  assert.deepEqual(log.list().map((e) => e.kind), ["k2", "k3", "k4"]);
});

test("incident log: записи старше TTL не читаются", () => {
  let clock = 10_000;
  const storage = fakeStorage();
  const log = createIncidentLog({ storage, now: () => clock, ttlMs: 1_000 });
  log.record("old", { severity: "info" });
  clock = 12_000;
  log.record("fresh", { severity: "info" });
  assert.deepEqual(log.list().map((e) => e.kind), ["fresh"]);
});

test("incident log: недоступное хранилище не роняет запись", () => {
  const throwing = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  const log = createIncidentLog({ storage: throwing, now: () => 1_000 });
  assert.ok(log.record("quality.degraded", { severity: "warn" }));
  assert.equal(log.list().length, 1);
});

test("incident log: подписчик видит новую запись", () => {
  const seen = [];
  const log = createIncidentLog({ storage: fakeStorage(), now: () => 1_000 });
  const off = log.subscribe((e) => seen.push(e?.kind ?? null));
  log.record("a", { severity: "info" });
  off();
  log.record("b", { severity: "info" });
  assert.deepEqual(seen, ["a"]);
});

const entry = (ts, kind, severity) => ({ id: String(ts), ts, kind, severity, params: {} });

test("группировка: деградация → лечение → восстановление это один инцидент", () => {
  const groups = groupIncidents([
    entry(1_000, "quality.degraded", "warn"),
    entry(2_000, "quality.remedy", "info"),
    entry(9_000, "quality.restored", "ok"),
  ], { now: () => 10_000 });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].events.length, 3);
  assert.equal(groups[0].resolved, true);
  assert.equal(groups[0].durationMs, 8_000);
  assert.equal(groups[0].ongoing, undefined);
});

test("группировка: инцидент без развязки помечается как идущий", () => {
  const groups = groupIncidents([entry(9_000, "core.died", "err")], { now: () => 9_500, idleMs: 5_000 });
  assert.equal(groups[0].ongoing, true);
  assert.equal(groups[0].resolved, false);
});

test("группировка: молчание дольше окна закрывает инцидент без «ок»", () => {
  const groups = groupIncidents([entry(1_000, "quality.degraded", "warn")], { now: () => 100_000, idleMs: 5_000 });
  assert.equal(groups[0].ongoing, false);
  assert.equal(groups[0].resolved, false);
});

test("группировка: инцидент наследует худший уровень своих событий", () => {
  const groups = groupIncidents([
    entry(1_000, "quality.degraded", "warn"),
    entry(2_000, "core.died", "err"),
    entry(3_000, "quality.restored", "ok"),
  ], { now: () => 4_000 });
  assert.equal(groups[0].severity, "err");
});

test("группировка: свежие инциденты идут первыми, одиночные info не теряются", () => {
  const groups = groupIncidents([
    entry(1_000, "node.switched", "info"),
    entry(50_000, "quality.degraded", "warn"),
    entry(51_000, "quality.restored", "ok"),
  ], { now: () => 60_000, idleMs: 5_000 });

  assert.equal(groups.length, 2);
  assert.equal(groups[0].startTs, 50_000);
  assert.equal(groups[1].events[0].kind, "node.switched");
});

test("degradedMs: суммарное время считает только инциденты, а не заметки", () => {
  const groups = groupIncidents([
    entry(1_000, "node.switched", "info"),
    entry(2_000, "quality.degraded", "warn"),
    entry(6_000, "quality.restored", "ok"),
    entry(60_000, "core.died", "err"),
    entry(63_000, "core.restarted", "ok"),
  ], { now: () => 70_000, idleMs: 20_000 });

  assert.equal(degradedMs(groups), 4_000 + 3_000);
  assert.equal(degradedMs(groups, { since: 50_000 }), 3_000);
});
