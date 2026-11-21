// The latency history is kept by the app, not the core: sing-box stores one result
// per tag (map[string]*adapter.URLTestHistory) and returns it as a single-element
// array. The test pins down that points accumulate, aren't duplicated by polling
// and don't get mixed between sources.
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

// The source shape is exactly what getActiveSource() returns: {kind, subscription}
// / {kind, profile}. The previous version of the test made up {kind, id} and therefore didn't
// notice that the key was computed from a nonexistent field and all subscriptions
// fell into one bucket.
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
  pruneProbeHistory(SRC, []);                 // the first subscription has no nodes left
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

// The index must not trust two measurements like twenty: the derived components
// gain weight as they accumulate, otherwise one bad sample throws the fastest
// server out of the recommendations.
test("усадка: при малом числе замеров стабильность тянется к нейтральной", () => {
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const stabilityFor = (probes, jit) => {
    const evidence = clamp01((probes - 1) / 4);
    const raw = clamp01(1 - jit / 55);
    return 0.5 + (raw - 0.5) * evidence;
  };
  // one measurement — no jitter at all, exactly neutral
  assert.equal(stabilityFor(1, 0), 0.5);
  // two measurements with a monstrous spread don't zero the component
  assert.ok(stabilityFor(2, 500) > 0.35, "два замера не должны давать ноль");
  // with accumulation the score becomes real
  assert.ok(stabilityFor(5, 500) < 0.05, "пять замеров уже наказывают разброс");
  assert.ok(stabilityFor(5, 0) > 0.95, "ровный канал на пяти замерах оценивается высоко");
});

test("осиротевшие ведра сломанного ключа вычищаются при записи", () => {
  // Builds before the key fix wrote everything into "sub:" — these entries belong to nobody and
  // keep server tags on disk.
  storage.set("ninety.delayHistory.v1", JSON.stringify({
    "sub:": { n0: { at: "t0", d: [999] } },
    "sub:s1": { n0: { at: "t0", d: [41] } },
  }));
  clearProbeHistory({ kind: "sub", subscription: { id: "zzz" }, nodes: [] });
  const raw = JSON.parse(storage.get("ninety.delayHistory.v1"));
  assert.equal(Object.prototype.hasOwnProperty.call(raw, "sub:"), false, "старое ведро должно исчезнуть");
  assert.ok(raw["sub:s1"], "чужие корректные ведра трогать нельзя");
});

test("источник без собственного ключа не пишет в архив вовсе", () => {
  // WARP and any source without an id have no key. Previously the entry went into the
  // "none" bucket, which dropLegacyBuckets erased in this same write: an idle
  // stringify + a localStorage write on every poll, and with changed=true on top.
  storage.clear();
  const orphan = { kind: "warp", nodes: [] };
  assert.equal(recordProbes(orphan, snap("n0", "t1", 41), ["n0"]), false);
  assert.equal(storage.has("ninety.delayHistory.v1"), false, "записи быть не должно");
  assert.deepEqual(getProbeHistory(orphan, "n0"), []);
  // A neighboring source with a key keeps working.
  recordProbes(SRC, snap("n0", "t1", 41), ["n0"]);
  assert.deepEqual(getProbeHistory(SRC, "n0"), [41]);
  assert.deepEqual(getProbeHistory(orphan, "n0"), []);
});
