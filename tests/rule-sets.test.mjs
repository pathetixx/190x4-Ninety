import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POPULAR_GEOIP, POPULAR_GEOSITE, REGION_GEOSITE, isKnownSet, normalizeSetRef, parseSetRef, searchSets, setUrl,
} from "/lib/rule-sets.js";

test("ссылка на список приводится к каноническому виду", () => {
  assert.deepEqual(parseSetRef(" GeoSite:YouTube "), { kind: "geosite", name: "youtube" });
  assert.equal(normalizeSetRef("geoip:RU"), "geoip:ru");
  assert.equal(normalizeSetRef("geosite:category-ai-!cn"), "geosite:category-ai-!cn");
  assert.equal(parseSetRef("youtube"), null);
  assert.equal(parseSetRef("geo:ru"), null);
  assert.equal(parseSetRef("geosite:"), null);
});

// Имя вне каталога ядро не скачает — в правило оно попасть не должно.
test("в правило попадают только списки из каталога", () => {
  assert.equal(normalizeSetRef("geosite:no-such-service-123"), "");
  assert.equal(normalizeSetRef("geoip:zz"), "");
  for (const name of POPULAR_GEOSITE) assert.ok(isKnownSet({ kind: "geosite", name }), name);
  for (const code of POPULAR_GEOIP) assert.ok(isKnownSet({ kind: "geoip", name: code }), code);
  for (const name of Object.values(REGION_GEOSITE)) assert.ok(isKnownSet({ kind: "geosite", name }), name);
});

test("адрес списка ведёт в первоисточник SagerNet", () => {
  assert.equal(setUrl({ kind: "geosite", name: "youtube" }),
    "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-youtube.srs");
  assert.equal(setUrl({ kind: "geoip", name: "ru" }),
    "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs");
});

test("поиск: пустой запрос — популярные, совпадения с начала имени — выше", () => {
  assert.deepEqual(searchSets("geosite", ""), POPULAR_GEOSITE);
  const found = searchSets("geosite", "tele");
  assert.ok(found.includes("telegram"));
  assert.ok(found.every((name) => name.includes("tele")));
  const firstInner = found.findIndex((name) => !name.startsWith("tele"));
  if (firstInner >= 0) assert.ok(found.slice(firstInner).every((name) => !name.startsWith("tele")));
  assert.deepEqual(searchSets("geosite", "zzzz-nothing"), []);
});
