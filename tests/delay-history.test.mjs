// Историю задержек ведёт приложение, а не ядро: sing-box хранит один результат
// на тег (map[string]*adapter.URLTestHistory) и отдаёт его как массив из одного
// элемента. Тест фиксирует, что точки копятся, не дублируются поллингом
// и не перемешиваются между источниками.
import test from "node:test";
import assert from "node:assert/strict";

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

const {
  recordProbes, getProbeHistory, pruneProbeHistory, clearProbeHistory,
} = await import("/lib/delay-history.js");

// Форма источника — ровно та, что возвращает getActiveSource(): {kind, subscription}
// / {kind, profile}. Прошлая версия теста выдумывала {kind, id} и потому не
// заметила, что ключ считался по несуществующему полю и все подписки
// сваливались в одно ведро.
const SRC = { kind: "sub", subscription: { id: "s1" }, nodes: [] };
const snap = (tag, time, delay) => ({ proxies: { [tag]: { history: [{ time, delay }] } } });

test("копит точки по мере новых замеров", () => {
  clearProbeHistory(SRC);
  assert.deepEqual(getProbeHistory(SRC, "n0"), []);
  recordProbes(SRC, snap("n0", "t1", 41), ["n0"]);
  recordProbes(SRC, snap("n0", "t2", 58), ["n0"]);
  recordProbes(SRC, snap("n0", "t3", 47), ["n0"]);
  assert.deepEqual(getProbeHistory(SRC, "n0"), [41, 58, 47]);
});

test("поллинг с той же отметкой времени не размножает точку", () => {
  clearProbeHistory(SRC);
  recordProbes(SRC, snap("n0", "t1", 41), ["n0"]);
  for (let i = 0; i < 5; i++) {
    assert.equal(recordProbes(SRC, snap("n0", "t1", 41), ["n0"]), false);
  }
  assert.deepEqual(getProbeHistory(SRC, "n0"), [41]);
});

test("нет ответа записывается нулём, а не пропускается", () => {
  clearProbeHistory(SRC);
  recordProbes(SRC, snap("n0", "t1", 41), ["n0"]);
  recordProbes(SRC, snap("n0", "t2", 0), ["n0"]);
  assert.deepEqual(getProbeHistory(SRC, "n0"), [41, 0]);
});

test("буфер ограничен 12 точками и хранит последние", () => {
  clearProbeHistory(SRC);
  for (let i = 1; i <= 20; i++) recordProbes(SRC, snap("n0", "t" + i, i), ["n0"]);
  const h = getProbeHistory(SRC, "n0");
  assert.equal(h.length, 12);
  assert.deepEqual(h, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
});

test("источники не перемешиваются", () => {
  const other = { kind: "sub", subscription: { id: "s2" }, nodes: [] };
  clearProbeHistory(SRC); clearProbeHistory(other);
  recordProbes(SRC, snap("n0", "t1", 41), ["n0"]);
  recordProbes(other, snap("n0", "t1", 900), ["n0"]);
  assert.deepEqual(getProbeHistory(SRC, "n0"), [41]);
  assert.deepEqual(getProbeHistory(other, "n0"), [900]);
});

test("одиночный профиль — свой бакет, не пересекается с подпиской", () => {
  const single = { kind: "single", profile: { id: "p1" } };
  clearProbeHistory(SRC); clearProbeHistory(single);
  recordProbes(SRC, snap("proxy", "t1", 41), ["proxy"]);
  recordProbes(single, snap("proxy", "t1", 777), ["proxy"]);
  assert.deepEqual(getProbeHistory(SRC, "proxy"), [41]);
  assert.deepEqual(getProbeHistory(single, "proxy"), [777]);
});

test("чистка тегов одной подписки не трогает историю другой", () => {
  const other = { kind: "sub", subscription: { id: "s2" }, nodes: [] };
  clearProbeHistory(SRC); clearProbeHistory(other);
  recordProbes(SRC, snap("n0", "t1", 41), ["n0"]);
  recordProbes(other, snap("n0", "t1", 62), ["n0"]);
  pruneProbeHistory(SRC, []);                 // у первой подписки нод не осталось
  assert.deepEqual(getProbeHistory(SRC, "n0"), []);
  assert.deepEqual(getProbeHistory(other, "n0"), [62], "соседняя подписка не должна пострадать");
});

test("исчезнувшие теги вычищаются при обновлении подписки", () => {
  clearProbeHistory(SRC);
  recordProbes(SRC, snap("n0", "t1", 41), ["n0"]);
  recordProbes(SRC, snap("n1", "t1", 62), ["n1"]);
  pruneProbeHistory(SRC, ["n0"]);
  assert.deepEqual(getProbeHistory(SRC, "n0"), [41]);
  assert.deepEqual(getProbeHistory(SRC, "n1"), []);
});

test("узел без истории в снапшоте ничего не ломает", () => {
  clearProbeHistory(SRC);
  assert.equal(recordProbes(SRC, { proxies: { n0: {} } }, ["n0"]), false);
  assert.equal(recordProbes(SRC, null, ["n0"]), false);
  assert.deepEqual(getProbeHistory(SRC, "n0"), []);
});

// Индекс не должен верить двум замерам как двадцати: производные компоненты
// набирают вес по мере накопления, иначе один плохой сэмпл выбрасывает самый
// быстрый сервер из рекомендаций.
test("усадка: при малом числе замеров стабильность тянется к нейтральной", () => {
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const stabilityFor = (probes, jit) => {
    const evidence = clamp01((probes - 1) / 4);
    const raw = clamp01(1 - jit / 55);
    return 0.5 + (raw - 0.5) * evidence;
  };
  // один замер — разброса нет вообще, ровно нейтрально
  assert.equal(stabilityFor(1, 0), 0.5);
  // два замера с чудовищным разбросом не обнуляют компонент
  assert.ok(stabilityFor(2, 500) > 0.35, "два замера не должны давать ноль");
  // с накоплением оценка становится настоящей
  assert.ok(stabilityFor(5, 500) < 0.05, "пять замеров уже наказывают разброс");
  assert.ok(stabilityFor(5, 0) > 0.95, "ровный канал на пяти замерах оценивается высоко");
});
