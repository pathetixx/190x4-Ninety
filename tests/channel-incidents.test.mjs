// Переходы состояния канала → записи ленты. Главный инвариант: инцидент должен
// получать исход в каждом случае, когда исход есть. «Чем закончилось —
// неизвестно» разрешено только там, где замеров действительно не было.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChannelIncidentRecorder } from "/lib/channel-incidents.js";

function recorder(deps = {}) {
  const written = [];
  const rec = createChannelIncidentRecorder({
    record: (kind, entry) => {
      written.push({ kind, severity: entry.severity, params: entry.params });
      return entry;
    },
    ...deps,
  });
  return { rec, written, kinds: () => written.map((e) => e.kind) };
}

test("падение и восстановление канала — открывающая и закрывающая записи", () => {
  const { rec, written } = recorder();
  rec.observe("GOOD");
  rec.observe("SLOW");
  rec.observe("GOOD");

  assert.deepEqual(written.map((e) => [e.kind, e.severity]), [
    ["quality.degraded", "warn"],
    ["quality.restored", "ok"],
  ]);
});

// Ровно тот случай, из-за которого лента была забита «неизвестно»: в плохом
// канале проба чаще всего и не дотягивается, а UNKNOWN запоминался как
// состояние и глушил следующий переход в GOOD.
test("проба, которая не дотянулась, не мешает записать восстановление", () => {
  const { rec, kinds } = recorder();
  rec.observe("GOOD");
  rec.observe("SLOW");
  rec.observe("UNKNOWN");
  rec.observe("UNKNOWN");
  rec.observe("GOOD");

  assert.deepEqual(kinds(), ["quality.degraded", "quality.restored"]);
});

test("STALLED открывает инцидент уровня err, повтор состояния не дублируется", () => {
  const { rec, written } = recorder();
  rec.observe("GOOD");
  rec.observe("STALLED");
  rec.observe("STALLED");
  assert.deepEqual(written.map((e) => [e.kind, e.severity]), [["quality.degraded", "err"]]);
});

test("плохой канал на первом же замере сессии открывает инцидент", () => {
  const { rec, kinds } = recorder();
  rec.observe("SLOW");
  assert.deepEqual(kinds(), ["quality.degraded"]);
});

test("первый замер GOOD ничего не восстанавливает", () => {
  const { rec, kinds } = recorder();
  rec.observe("GOOD");
  assert.deepEqual(kinds(), []);
});

test("конец сессии закрывает открытый инцидент записью end", () => {
  const { rec, written } = recorder();
  rec.observe("GOOD");
  rec.observe("SLOW");
  rec.endSession("disconnected");

  assert.deepEqual(written.at(-1), {
    kind: "quality.endedByDisconnect",
    severity: "end",
    params: { reason: "disconnected" },
  });
  assert.equal(rec.isOpen(), false);
});

test("смена источника и выключенное наблюдение — свои исходы", () => {
  for (const [reason, kind] of [
    ["sourceChanged", "quality.endedBySourceChange"],
    ["monitoringOff", "quality.endedByMonitoringOff"],
  ]) {
    const { rec, written } = recorder();
    rec.observe("GOOD");
    rec.observe("SLOW");
    rec.endSession(reason);
    assert.equal(written.at(-1).kind, kind);
  }
});

test("конец сессии без открытого инцидента ничего не пишет", () => {
  const { rec, kinds } = recorder();
  rec.observe("GOOD");
  rec.endSession("disconnected");
  assert.deepEqual(kinds(), []);
});

// Инцидент могла открыть смерть ядра: он тоже кончается вместе с сессией, хотя
// движок качества о нём ничего не знает.
test("чужой открытый инцидент тоже получает исход", () => {
  const { rec, kinds } = recorder({ isAnyIncidentOpen: () => true });
  rec.endSession("disconnected");
  assert.deepEqual(kinds(), ["quality.endedByDisconnect"]);
});

// Реконнект гасит движок, но сессию не заканчивает: инцидент обязан дожить до
// настоящего исхода, иначе вылечивший его реконнект не будет виден как
// восстановление.
test("внутренний реконнект не обрывает инцидент и не теряет восстановление", () => {
  const { rec, kinds } = recorder({ sessionSurvives: (reason) => reason === "disconnected" });
  rec.observe("GOOD");
  rec.observe("SLOW");
  rec.endSession("disconnected");
  assert.equal(rec.isOpen(), true, "состояние канала переживает реконнект");
  rec.observe("GOOD");
  assert.deepEqual(kinds(), ["quality.degraded", "quality.restored"]);
});

test("причина паузы пишется один раз на инцидент и только внутри него", () => {
  const { rec, kinds } = recorder();
  rec.pause("hostPressure");
  assert.deepEqual(kinds(), [], "вне инцидента пауза лентой не является");

  rec.observe("GOOD");
  rec.observe("SLOW");
  rec.pause("hostPressure");
  rec.pause("hostPressure");
  rec.pause("lowDataMode");
  rec.pause("нет такой причины");

  assert.deepEqual(kinds(), [
    "quality.degraded",
    "quality.pausedHostPressure",
    "quality.pausedLowData",
  ]);
});

test("смена состояния канала разрешает записать причину паузы заново", () => {
  const { rec, kinds } = recorder();
  rec.observe("GOOD");
  rec.observe("SLOW");
  rec.pause("hostPressure");
  rec.observe("STALLED");
  rec.pause("hostPressure");

  assert.deepEqual(kinds(), [
    "quality.degraded",
    "quality.pausedHostPressure",
    "quality.pausedHostPressure",
  ]);
});
