// Наборы целей матрицы доступности: слои, дедуп и выбор пакета страны.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_PACK,
  GLOBAL_TARGETS,
  REGION_TARGETS,
  buildProbeSet,
  defaultRegionPack,
  normalizePinned,
  resolveRegionPack,
} from "/lib/probe-sets.js";

test("probe sets: у каждой цели уникальный id и http(s)-адрес", () => {
  const all = [...GLOBAL_TARGETS, ...Object.values(REGION_TARGETS).flat()];
  const ids = new Set();
  for (const target of all) {
    assert.ok(target.id && !ids.has(target.id), `дубликат id: ${target.id}`);
    ids.add(target.id);
    assert.match(target.url, /^https?:\/\//, `плохой адрес у ${target.id}`);
    assert.ok(target.name?.length, `нет имени у ${target.id}`);
  }
});

test("probe sets: набор = закреплённые + региональные + глобальные, в этом порядке", () => {
  const set = buildProbeSet({
    regionPack: "de",
    pinned: [{ id: "mine", name: "Мой сервер", url: "https://docs.example/" }],
  });
  assert.equal(set[0].scope, "pinned");
  assert.equal(set[1].scope, "region");
  assert.equal(set[1].region, "de");
  assert.ok(set.some((t) => t.scope === "global" && t.id === "youtube"));
});

test("probe sets: без пакета остаётся только глобальное ядро", () => {
  const set = buildProbeSet({ regionPack: "" });
  assert.equal(set.length, GLOBAL_TARGETS.length);
  assert.ok(set.every((t) => t.scope === "global"));
});

test("probe sets: неизвестный пакет не роняет набор", () => {
  const set = buildProbeSet({ regionPack: "atlantis" });
  assert.equal(set.length, GLOBAL_TARGETS.length);
});

test("probe sets: закреплённая цель с битым адресом отбрасывается", () => {
  assert.equal(normalizePinned({ url: "не адрес" }), null);
  assert.equal(normalizePinned({ url: "ftp://example.com/" }), null);
  const ok = normalizePinned({ url: "https://example.com/health" });
  assert.equal(ok.name, "example.com");
});

test("probe sets: дубликат по id не попадает в набор дважды", () => {
  const set = buildProbeSet({
    regionPack: "ru",
    pinned: [
      { id: "ru-bank", name: "дубль", url: "https://online.sberbank.ru/" },
      { id: "ru-bank", name: "дубль 2", url: "https://online.sberbank.ru/" },
    ],
  });
  assert.equal(set.filter((t) => t.id === "ru-bank").length, 1);
  assert.equal(set[0].scope, "pinned"); // личная цель победила региональную
});

test("probe sets: пакет по умолчанию берётся из региона, потом из языка", () => {
  assert.equal(defaultRegionPack({ region: "ru", lang: "en" }), "ru");
  assert.equal(defaultRegionPack({ region: "other", lang: "de" }), "de");
  assert.equal(defaultRegionPack({ region: "", lang: "uk" }), "ua");
  assert.equal(defaultRegionPack({ region: "", lang: "ja" }), "");
});

test("probe sets: «Глобальный» — это выбор, а не отсутствие выбора", () => {
  // Пустая строка приходит из пункта «Глобальный». Если её принять за «ещё не
  // выбирали», автоопределение вернёт страну — и пункт молча не сработает.
  assert.equal(resolveRegionPack({ stored: "", region: "ru", lang: "ru" }), "");
  assert.equal(resolveRegionPack({ stored: AUTO_PACK, region: "ru", lang: "ru" }), "ru");
  assert.equal(resolveRegionPack({ stored: undefined, region: "", lang: "de" }), "de");
  assert.equal(resolveRegionPack({ stored: "de", region: "ru", lang: "ru" }), "de");
  // Неизвестный пакет из чужого/старого конфига — это глобальный набор.
  assert.equal(resolveRegionPack({ stored: "atlantis", region: "ru", lang: "ru" }), "");
});
