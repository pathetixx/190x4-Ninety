// Раскладка подменю «Сервер»: маленькая подписка остаётся плоским списком,
// большая раскладывается по странам с быстрыми входами наверху.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  buildTrayServerMenu,
  TRAY_FAST_LIMIT,
  TRAY_FAVOURITE_LIMIT,
  TRAY_FLAT_LIMIT,
  TRAY_GROUP_LIMIT,
  TRAY_TOTAL_LIMIT,
} = await import("/lib/tray-servers.js");

const countryLabel = (iso) => ({ nl: "Нидерланды", de: "Германия", fi: "Финляндия" })[iso] || iso;

// n нод одной страны; задержка растёт с номером, поэтому порядок предсказуем.
const make = (iso, n, { from = 0, delay = (i) => 10 + i } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${iso}-${from + i}`,
    label: `${iso.toUpperCase()}-${from + i}`,
    iso,
    selected: false,
    delay: delay(i),
  }));

test("маленькая подписка остаётся плоским списком без группировки", () => {
  const menu = buildTrayServerMenu(make("nl", TRAY_FLAT_LIMIT));
  assert.equal(menu.flat.length, TRAY_FLAT_LIMIT);
  assert.deepEqual(menu.groups, []);
  assert.deepEqual(menu.favourites, []);
  assert.equal(menu.hidden, 0);
  assert.equal(menu.total, TRAY_FLAT_LIMIT);
  // Порядок подписки в плоском списке не переставляется.
  assert.deepEqual(menu.flat.map(e => e.id), make("nl", TRAY_FLAT_LIMIT).map(e => e.id));
});

test("пустой список не падает и ничего не показывает", () => {
  const menu = buildTrayServerMenu([]);
  assert.equal(menu.total, 0);
  assert.equal(menu.current, null);
  assert.deepEqual(menu.flat, []);
  assert.deepEqual(menu.groups, []);
});

test("большая подписка раскладывается по странам, страна текущей ноды — первой", () => {
  const entries = [...make("nl", 20), ...make("de", 30), ...make("fi", 5)];
  entries[25].selected = true; // нода в Германии
  const menu = buildTrayServerMenu(entries, { countryLabel });

  assert.deepEqual(menu.flat, []);
  assert.equal(menu.current.id, entries[25].id);
  assert.equal(menu.groups[0].label, "Германия", "страна текущего сервера идёт первой");
  // Дальше — по количеству нод.
  assert.deepEqual(menu.groups.map(g => g.label), ["Германия", "Нидерланды", "Финляндия"]);
  assert.equal(menu.total, 55);
});

test("внутри страны ноды идут по возрастанию задержки, неизмеренные — в хвосте", () => {
  const entries = [
    { id: "a", label: "A", iso: "nl", selected: false, delay: 120 },
    { id: "b", label: "B", iso: "nl", selected: false, delay: null },
    { id: "c", label: "C", iso: "nl", selected: false, delay: 40 },
    ...make("de", 12),
  ];
  const menu = buildTrayServerMenu(entries, { countryLabel });
  const nl = menu.groups.find(g => g.label === "Нидерланды");
  assert.deepEqual(nl.items.map(e => e.id), ["c", "a", "b"]);
});

test("быстрые входы берут только измеренные ноды и не дублируют текущую", () => {
  const entries = [...make("nl", 20), ...make("de", 20, { from: 100, delay: () => null })];
  entries[0].selected = true; // самая быстрая нода уже выбрана
  const menu = buildTrayServerMenu(entries, { countryLabel });

  assert.equal(menu.fast.length, TRAY_FAST_LIMIT);
  assert.ok(!menu.fast.some(e => e.selected), "текущий сервер во «быстрых» не повторяется");
  assert.ok(menu.fast.every(e => e.delay > 0), "нода без замера быстрой не считается");
  const delays = menu.fast.map(e => e.delay);
  assert.deepEqual(delays, [...delays].sort((a, b) => a - b));
});

test("избранное поднимается отдельным входом и ограничено по длине", () => {
  const entries = [...make("nl", 20), ...make("de", 20, { from: 100 })];
  const favourites = new Set(entries.slice(0, TRAY_FAVOURITE_LIMIT + 5).map(e => e.id));
  const menu = buildTrayServerMenu(entries, { countryLabel, favourites });
  assert.equal(menu.favourites.length, TRAY_FAVOURITE_LIMIT);
  assert.ok(menu.favourites.every(e => favourites.has(e.id)));
});

test("страна режется по лимиту, остаток честно попадает в счётчик скрытых", () => {
  const entries = make("nl", TRAY_GROUP_LIMIT + 14);
  const menu = buildTrayServerMenu(entries, { countryLabel });
  const nl = menu.groups[0];
  assert.equal(nl.items.length, TRAY_GROUP_LIMIT);
  assert.equal(nl.hidden, 14);
  assert.equal(menu.hidden, 14);
  assert.equal(menu.total, TRAY_GROUP_LIMIT + 14);
});

test("общий потолок меню не превышается даже на подписке в сотни нод", () => {
  const entries = [];
  for (const iso of ["nl", "de", "fi", "us", "jp", "sg", "gb", "fr", "ca", "au"]) {
    entries.push(...make(iso, 30, { from: entries.length }));
  }
  const menu = buildTrayServerMenu(entries, { countryLabel });
  const shown = menu.groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(menu.total, 300);
  assert.ok(shown <= TRAY_TOTAL_LIMIT, `в меню ${shown} нод, потолок ${TRAY_TOTAL_LIMIT}`);
  assert.equal(shown + menu.hidden, 300, "скрытые считаются точно, без потерь");
  assert.ok(menu.groups.every(g => g.items.length > 0), "пустых стран в меню нет");
});

test("ноды без страны собираются в отдельную группу и уходят вниз списка", () => {
  const entries = [
    ...make("nl", 15),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `x-${i}`, label: `Служебная ${i}`, iso: null, selected: false, delay: null,
    })),
  ];
  const menu = buildTrayServerMenu(entries, { countryLabel, otherLabel: "Без страны" });
  assert.equal(menu.groups.at(-1).label, "Без страны");
  assert.equal(menu.groups.at(-1).items.length, 4);
});
