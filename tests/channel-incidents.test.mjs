// Channel state transitions → feed entries. The main invariant: an incident must
// get an outcome in every case where there is one. "How it ended —
// unknown" is allowed only where there really were no measurements.
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

// Exactly the case that filled the feed with "unknown": in a bad
// channel the probe most often doesn't reach, and UNKNOWN was remembered as
// a state and suppressed the next transition to GOOD.
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

// An incident may have been opened by core death: it also ends together with the session, although
// the quality engine knows nothing about it.
test("чужой открытый инцидент тоже получает исход", () => {
  const { rec, kinds } = recorder({ isAnyIncidentOpen: () => true });
  rec.endSession("disconnected");
  assert.deepEqual(kinds(), ["quality.endedByDisconnect"]);
});

// A reconnect stops the engine but doesn't end the session: the incident must survive until
// its real outcome, otherwise the reconnect that cured it won't show as
// a recovery.
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

// PC load isn't a channel state: the engine stops measuring, but the speed
// doesn't "drop" because of it.
test("нагрузка ПК не открывает инцидент и не стирает причину паузы", () => {
  const { rec, kinds } = recorder();
  rec.observe("GOOD");
  rec.observe("PRESSURE");
  assert.deepEqual(kinds(), [], "из GOOD нагрузка не открывает «скорость упала»");

  rec.observe("SLOW");
  rec.observe("PRESSURE");
  rec.pause("hostPressure");
  assert.equal(rec.state(), "SLOW");
  assert.deepEqual(kinds(), ["quality.degraded", "quality.pausedHostPressure"]);
});
