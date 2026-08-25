import { test } from "node:test";
import assert from "node:assert/strict";

const { pickTrayServers, TRAY_SERVER_LIMIT } = await import("/lib/tray-servers.js");

const make = (n, selectedIndex = -1) =>
  Array.from({ length: n }, (_, i) => ({ id: `node-${i}`, label: `S${i}`, selected: i === selectedIndex, iso: null }));

test("короткий список уходит в трей целиком и в исходном порядке", () => {
  const entries = make(5, 2);
  assert.equal(pickTrayServers(entries, new Set()), entries);
});

test("длинный список обрезается до лимита", () => {
  const picked = pickTrayServers(make(268, 100), new Set());
  assert.equal(picked.length, TRAY_SERVER_LIMIT);
});

test("текущая нода попадает в меню, даже если она в хвосте подписки", () => {
  const picked = pickTrayServers(make(268, 200), new Set());
  assert.equal(picked[0].id, "node-200");
  assert.equal(picked[0].selected, true);
});

test("избранные идут следом за текущей, остальные — по порядку подписки", () => {
  const picked = pickTrayServers(make(268, 5), new Set(["node-250", "node-100"]));
  assert.deepEqual(picked.slice(0, 3).map(s => s.id), ["node-5", "node-100", "node-250"]);
  assert.equal(picked[3].id, "node-0");
});

test("порядок устойчив между пересборками — меню не перетасовывается", () => {
  const favs = new Set(["node-30"]);
  const first = pickTrayServers(make(268, 7), favs).map(s => s.id);
  const second = pickTrayServers(make(268, 7), favs).map(s => s.id);
  assert.deepEqual(first, second);
});

test("сломанный источник избранного не роняет отбор", () => {
  const broken = { has() { throw new Error("storage gone"); } };
  assert.equal(pickTrayServers(make(268, 1), broken).length, TRAY_SERVER_LIMIT);
  assert.deepEqual(pickTrayServers(null, broken), []);
});
