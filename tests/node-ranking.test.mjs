// Движок рекомендаций: калибровка шкалы задержки и честность подписи.
//
// Кейс, из-за которого шкалу переделали: на подписке, где все живые серверы
// укладываются в 26–40 мс, линейная шкала «25…300 мс» отдавала весь вес
// разбросу, и в «Рекомендованных» стоял сервер с 33 мс, пока в списке ниже
// пользователь видел 26 мс.
import test from "node:test";
import assert from "node:assert/strict";
import { scoreNode, reasonKeys, latencyScore } from "../src/lib/node-ranking.js";

const REALITY = { security: "reality" };
// Ровно 12 замеров вокруг медианы — столько история и хранит.
const probes = (med, jit) => Array.from({ length: 12 }, (_, i) => med + (i % 2 ? jit : -jit));
const rank = (entries) => entries
  .map(([name, med, jit]) => ({ name, s: scoreNode(REALITY, probes(med, jit)) }))
  .sort((a, b) => b.s.total - a.s.total);

test("на быстрой подписке выигрывает самый быстрый, а не самый ровный", () => {
  const order = rank([
    ["latvia", 26, 5],
    ["spb", 29, 3],
    ["msk", 31, 4],
    ["estonia", 33, 2],
  ]).map(x => x.name);
  assert.equal(order[0], "latvia");
  assert.ok(order.indexOf("spb") < order.indexOf("estonia"));
});

test("на медленной подписке ровный канал по-прежнему обходит соседа в пару мс", () => {
  const order = rank([
    ["steady", 262, 2],
    ["jumpy", 258, 14],
  ]).map(x => x.name);
  assert.equal(order[0], "steady");
});

test("разница в разы важнее ровности на любой скорости", () => {
  assert.equal(rank([["fast", 40, 9], ["slow", 120, 1]])[0].name, "fast");
  assert.equal(rank([["fast", 120, 9], ["slow", 360, 1]])[0].name, "fast");
});

test("шкала задержки монотонна и ограничена", () => {
  assert.ok(latencyScore(25) > latencyScore(30));
  assert.ok(latencyScore(30) > latencyScore(300));
  assert.equal(latencyScore(5), latencyScore(20)); // ниже пола шкала не растёт
  assert.equal(latencyScore(0), 0);
  assert.ok(latencyScore(5000) >= 0);
});

test("«самая низкая задержка» достаётся только минимуму поля", () => {
  const field = rank([["latvia", 26, 5], ["spb", 29, 3], ["estonia", 33, 2]]);
  const top = field.slice(0, 3);
  const keys = reasonKeys(top, field);
  const latency = keys.filter(k => k.key === "latency");
  assert.equal(latency.length > 0, true);
  for (const [i, k] of keys.entries()) {
    if (k.key !== "latency") { assert.equal(k.superlative, false); continue; }
    assert.equal(k.superlative, Math.round(top[i].s.med) === 26);
  }
});

test("превосходная степень не выдаётся, когда в поле есть сервер быстрее", () => {
  const field = rank([["fast", 20, 12], ["chosen", 45, 1]]);
  const chosen = field.find(x => x.name === "chosen");
  const [reason] = reasonKeys([chosen], field);
  if (reason.key === "latency") assert.equal(reason.superlative, false);
});

test("без успешных замеров оценки нет", () => {
  assert.equal(scoreNode(REALITY, []), null);
  assert.equal(scoreNode(REALITY, [0, 65535]), null);
  assert.equal(scoreNode(REALITY, undefined), null);
});

test("один замер: разброс не измерен, причина по нему не выдаётся", () => {
  const s = scoreNode(REALITY, [30]);
  assert.equal(s.jit, null);
  assert.equal(s.okN, 1);
  const [reason] = reasonKeys([{ s }], [{ s }]);
  assert.notEqual(reason.key, "stability");
});
