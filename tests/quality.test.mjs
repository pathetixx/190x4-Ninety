// Quality engine: probe classification, starting the ladder on BAD_STREAK, committing
// a win with a learning record. The engine is designed for isolation (invoke/actions
// are injected, the DOM isn't touched) — we run it with a mock localStorage and a controlled probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQualityEngine } from "/lib/quality-engine.js";

// Mock localStorage (the engine writes the ISP×hour learning profile there).
function installStorage() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
  return m;
}

const GOOD = { ok: true, stalled: false, goodput_bps: 5_000_000, ttfb_ms: 40, bytes: 262144, ms: 500 };
const STALLED = { ok: false, stalled: true, goodput_bps: 0, ttfb_ms: 30, bytes: 8192, ms: 900 };

test("quality probe is bound to the expected runtime generation, never to a frontend port", async () => {
  installStorage();
  let received;
  const engine = createQualityEngine({
    invoke: async (command, args) => {
      if (command === "probe_quality") received = args;
      return GOOD;
    },
    actions: {},
    opts: { enabled: true, expectedGeneration: 41 },
  });
  engine.onConnected({ expectedGeneration: 42 });
  armSuspect(engine);
  await engine.tick();
  assert.equal(received.expectedGeneration, 42);
  assert.equal(Object.hasOwn(received, "port"), false);
});

// Puts the engine into the "suspicion" state (there was a stream → it collapsed) so that
// tick probes immediately, without waiting for the idle heartbeat.
function armSuspect(engine) {
  engine.updatePassive({ down: 50_000 }); // above ACTIVITY_BPS
  engine.updatePassive({ down: 100 });    // below FLATLINE_BPS
}

// A skipped probe measures nothing. Without a record and a pause a gate refusal
// (no generation, the dataplane is busy) would look like "the channel is fine", and the engine
// would hit IPC on every watchdog tick.
test("skipped-проба логируется, не идёт в осциллограмму и держит паузу", async () => {
  installStorage();
  let calls = 0;
  const logs = [];
  const skips = [];
  const samples = [];
  let clock = 1_000_000;
  const engine = createQualityEngine({
    invoke: async (cmd) => {
      if (cmd !== "probe_quality") return undefined;
      calls += 1;
      return { ok: false, skipped: true, error: "generation_required", goodput_bps: 0 };
    },
    actions: {
      log: (line) => logs.push(line),
      onSkipped: (reason) => skips.push(reason),
      onSample: (sample) => samples.push(sample),
    },
    opts: { enabled: true },
    now: () => clock,
  });
  engine.onConnected({});
  armSuspect(engine);
  await engine.tick();
  assert.equal(calls, 1);
  assert.deepEqual(skips, ["generation_required"]);
  assert.equal(engine.skipReason, "generation_required");
  assert.equal(engine.getSamples().length, 0, "пропуск не является измерением");
  assert.equal(samples.length, 0);
  assert.ok(logs.some((line) => line.includes("generation_required")));

  // The next tick within the pause doesn't start a new probe.
  clock += 1_000;
  armSuspect(engine);
  await engine.tick();
  assert.equal(calls, 1, "движок не должен долбить пробой на каждом тике");

  // After the pause it probes again.
  clock += 10_000;
  armSuspect(engine);
  await engine.tick();
  assert.equal(calls, 2);
});

test("классификация: GOOD-проба → onState GOOD, лесенка молчит", async () => {
  installStorage();
  const states = [];
  let ladderRan = false;
  const engine = createQualityEngine({
    invoke: async (cmd) => (cmd === "probe_quality" ? GOOD : undefined),
    actions: {
      onState: (st) => states.push(st),
      selectNextNode: async () => { ladderRan = true; return true; },
      giveUp: () => { ladderRan = true; },
    },
    opts: { enabled: true, goodBps: 1_500_000 },
  });
  engine.onConnected({});
  armSuspect(engine);
  await engine.tick();
  assert.equal(states.at(-1), "GOOD");
  assert.equal(ladderRan, false, "на GOOD лесенка запускаться не должна");
});


test("классификация: STALLED-проба → onState STALLED", async () => {
  installStorage();
  const states = [];
  const engine = createQualityEngine({
    invoke: async (cmd) => (cmd === "probe_quality" ? STALLED : undefined),
    actions: { onState: (st) => states.push(st) },
    opts: { enabled: true },
  });
  engine.onConnected({});
  armSuspect(engine);
  await engine.tick(); // one bad tick — doesn't reach BAD_STREAK, no ladder
  assert.equal(states.at(-1), "STALLED");
});

test("две STALLED-пробы подряд → лесенка, giveUp при неприменимых ступенях", async () => {
  installStorage();
  let selectCalls = 0;
  let gaveUp = false;
  const engine = createQualityEngine({
    invoke: async (cmd) => (cmd === "probe_quality" ? STALLED : undefined),
    actions: {
      onState: () => {},
      // R1 isn't applicable (no alternative) — the engine moves on; there are no other
      // steps in actions → the ladder is exhausted and honestly gives up.
      selectNextNode: async () => { selectCalls++; return false; },
      giveUp: () => { gaveUp = true; },
      notify: () => {},
      log: () => {},
    },
    opts: { enabled: true },
  });
  engine.onConnected({});
  armSuspect(engine);
  await engine.tick(); // badStreak = 1
  await engine.tick(); // badStreak = 2 → runLadder
  assert.equal(selectCalls, 1, "R1 (selectNextNode) должна быть опробована");
  assert.equal(gaveUp, true, "все ступени исчерпаны → giveUp");
});

test("ступень R1 помогла → commitWin пишет профиль обучения", async () => {
  const store = installStorage();
  let probeCount = 0;
  const engine = createQualityEngine({
    // The first 2 probes (ticks) are STALLED, then (step verification) GOOD.
    invoke: async (cmd) => {
      if (cmd !== "probe_quality") return undefined;
      probeCount++;
      return probeCount <= 2 ? STALLED : GOOD;
    },
    actions: {
      onState: () => {},
      selectNextNode: async () => true, // R1 was applied
      giveUp: () => { throw new Error("giveUp не должен вызваться — ступень помогла"); },
      getContext: () => ({ node: "n1" }),
      localAsn: async () => "12345",
      notify: () => {}, toast: () => {}, log: () => {},
    },
    opts: { enabled: true, goodBps: 1_500_000 },
  });
  engine.onConnected({});
  armSuspect(engine);
  await engine.tick();
  await engine.tick(); // → runLadder → R1 → verify GOOD×2 → commitWin
  const raw = store.get("ninety.quality.profile");
  assert.ok(raw, "профиль обучения должен быть записан");
  const learned = JSON.parse(raw);
  const rec = Object.values(learned)[0];
  assert.equal(rec.stepId, "R1");
  assert.equal(rec.node, "n1");
});

test("disconnect отменяет выполняющуюся remediation-лесенку", async () => {
  installStorage();
  let releaseAction;
  const action = new Promise((resolve) => { releaseAction = resolve; });
  let gaveUp = false;
  let selectCalls = 0;
  const engine = createQualityEngine({
    invoke: async (cmd) => (cmd === "probe_quality" ? STALLED : undefined),
    actions: {
      onState: () => {},
      selectNextNode: async () => { selectCalls++; return action; },
      giveUp: () => { gaveUp = true; },
      notify: () => {}, log: () => {},
    },
    sleep: async () => {},
    opts: { enabled: true },
  });
  engine.onConnected({});
  armSuspect(engine);
  await engine.tick();
  const ladderTick = engine.tick();
  while (selectCalls === 0) await Promise.resolve();
  engine.onIdle();
  releaseAction(true);
  await ladderTick;

  assert.equal(selectCalls, 1);
  assert.equal(gaveUp, false, "старая сессия не должна продолжать лесенку после disconnect");
  assert.equal(engine.isRemediating, false);
});

test("R3 переносит remediation на новую сессию и сохраняет результат проверки", async () => {
  const store = installStorage();
  let probeCount = 0;
  let reconnects = 0;
  const clock = 1_000_000;
  let engine;
  engine = createQualityEngine({
    invoke: async (cmd) => {
      if (cmd !== "probe_quality") return undefined;
      probeCount++;
      return probeCount <= 2 ? STALLED : GOOD;
    },
    actions: {
      onState: () => {},
      selectNextNode: async () => false,
      excludeWorstNode: async () => false,
      applyFragmentation: async () => {
        reconnects++;
        engine.onIdle();
        engine.onConnected({ enabled: true, aggressive: true });
        return true;
      },
      getContext: () => ({ tlsTrick: "record" }),
      localAsn: async () => "12345",
      giveUp: () => { throw new Error("R3 должна пройти верификацию"); },
      notify: () => {}, toast: () => {}, log: () => {},
    },
    sleep: async () => {},
    now: () => clock,
    opts: { enabled: true, aggressive: true },
  });

  engine.onConnected({});
  armSuspect(engine);
  await engine.tick();
  await engine.tick();

  assert.equal(reconnects, 1);
  const learned = JSON.parse(store.get("ninety.quality.profile"));
  assert.equal(Object.values(learned)[0].stepId, "R3");
  assert.equal(engine.state, "GOOD");
});

test("часовой лимит реконнектов сохраняется между VPN-сессиями", async () => {
  installStorage();
  let clock = 1_000_000;
  let reconnects = 0;
  let engine;
  engine = createQualityEngine({
    invoke: async (cmd) => (cmd === "probe_quality" ? STALLED : undefined),
    actions: {
      onState: () => {},
      selectNextNode: async () => false,
      excludeWorstNode: async () => false,
      applyFragmentation: async () => {
        reconnects++;
        engine.onIdle();
        engine.onConnected({ enabled: true, aggressive: true });
        return true;
      },
      localAsn: async () => "12345",
      giveUp: () => {},
      notify: () => {}, toast: () => {}, log: () => {},
    },
    sleep: async () => {},
    now: () => clock,
    opts: { enabled: true, aggressive: true },
  });

  engine.onConnected({});
  for (let i = 0; i < 6; i++) {
    armSuspect(engine);
    await engine.tick();
    await engine.tick();
    clock += 121_000; // the cooldown passed, but all attempts are still within one hour
  }

  assert.equal(reconnects, 4, "пятая и последующие попытки должны блокироваться часовым капом");
});

test("выключенный quality engine не прогревает локальный ASN", async () => {
  installStorage();
  let asnCalls = 0;
  const engine = createQualityEngine({
    invoke: async () => GOOD,
    actions: {
      localAsn: async () => { asnCalls++; return "12345"; },
    },
    opts: { enabled: false },
  });

  engine.onConnected({ enabled: false });
  await Promise.resolve();
  assert.equal(asnCalls, 0);
});

// Host pressure isn't a property of the channel. Under a CPU/memory shortage the probe measures
// the scheduler, and the ladder (node switch → reconnect) pays with the most expensive
// action exactly when the machine is already struggling.
test("под давлением хоста движок не пробует канал и не лечит его", async () => {
  installStorage();
  let probes = 0;
  let ladderRan = false;
  const engine = createQualityEngine({
    invoke: async (cmd) => {
      if (cmd === "probe_quality") { probes++; return STALLED; }
      return undefined;
    },
    actions: {
      selectNextNode: async () => { ladderRan = true; return true; },
      giveUp: () => { ladderRan = true; },
    },
    opts: { enabled: true },
  });

  engine.onConnected({});
  engine.setHostPressure(true);
  for (let i = 0; i < 4; i++) {
    armSuspect(engine);
    await engine.tick();
  }

  assert.equal(probes, 0, "проба под давлением хоста меряет не канал");
  assert.equal(ladderRan, false);
});

test("после снятия давления движок снова пробует канал", async () => {
  installStorage();
  let probes = 0;
  const engine = createQualityEngine({
    invoke: async (cmd) => {
      if (cmd === "probe_quality") { probes++; return GOOD; }
      return undefined;
    },
    actions: {},
    opts: { enabled: true },
  });

  engine.onConnected({});
  engine.setHostPressure(true);
  armSuspect(engine);
  await engine.tick();
  assert.equal(probes, 0);

  engine.setHostPressure(false);
  armSuspect(engine);
  await engine.tick();
  assert.equal(probes, 1);
});

test("вход в давление обнуляет накопленную серию плохих проб", async () => {
  installStorage();
  let ladderRan = false;
  const engine = createQualityEngine({
    invoke: async (cmd) => (cmd === "probe_quality" ? STALLED : undefined),
    actions: {
      selectNextNode: async () => { ladderRan = true; return true; },
      giveUp: () => { ladderRan = true; },
    },
    opts: { enabled: true },
  });

  engine.onConnected({});
  armSuspect(engine);
  await engine.tick(); // one bad probe — one short of BAD_STREAK
  assert.equal(ladderRan, false);

  engine.setHostPressure(true);
  engine.setHostPressure(false);
  armSuspect(engine);
  await engine.tick();
  // The streak was started anew, so the ladder has no right to start yet: otherwise
  // a probe taken at the pressure boundary would complete someone else's streak.
  assert.equal(ladderRan, false);
});

// "Not measuring" and "everything is fine" are different things. The engine must report the measurement
// refusal outward: without it an open incident in the feed stayed without an outcome,
// and the user had nothing to explain why the outcome was unknown.
test("движок сообщает причину, по которой перестал измерять", async () => {
  installStorage();
  let probes = 0;
  const paused = [];
  const engine = createQualityEngine({
    invoke: async (cmd) => { if (cmd === "probe_quality") { probes += 1; return GOOD; } return undefined; },
    actions: { onPaused: (reason) => paused.push(reason) },
    opts: { enabled: true },
  });

  engine.onConnected({});
  engine.setHostPressure(true);
  armSuspect(engine);
  await engine.tick();
  assert.equal(probes, 0);
  assert.deepEqual(paused, ["hostPressure"]);
});

test("режим экономии трафика без подозрения объявляется паузой, а не тишиной", async () => {
  installStorage();
  let probes = 0;
  const paused = [];
  let clock = 1_000_000;
  const engine = createQualityEngine({
    invoke: async (cmd) => { if (cmd === "probe_quality") { probes += 1; return GOOD; } return undefined; },
    actions: { onPaused: (reason) => paused.push(reason) },
    opts: { enabled: true, lowDataMode: true },
    now: () => clock,
  });

  engine.onConnected({});
  // There was no traffic, and the heartbeat is off in this mode: there will be no probes at all.
  clock += 3600_000;
  await engine.tick();
  assert.equal(probes, 0);
  assert.deepEqual(paused, ["lowDataMode"]);

  // A collapsed stream is still probed immediately — saving doesn't mean
  // "not noticing a break".
  armSuspect(engine);
  await engine.tick();
  assert.equal(probes, 1);
});

test("недокачанная выборка на узком канале считается замедлением, а не UNKNOWN", async () => {
  const qualityOf = async (result) => {
    installStorage();
    const engine = createQualityEngine({
      invoke: async () => result,
      actions: {},
      opts: { enabled: true },
    });
    engine.onConnected({});
    armSuspect(engine);
    await engine.tick();
    return engine.getSamples().at(-1)?.q;
  };
  const incomplete = { ok: false, stalled: false, ttfb_ms: 40, ms: 4000, bytes: 60000, error: "incomplete sample: 60000/262144 bytes" };
  assert.notEqual(await qualityOf({ ...incomplete, goodput_bps: 120_000 }), "UNKNOWN");
  assert.equal(await qualityOf({ ...incomplete, goodput_bps: 50_000_000 }), "UNKNOWN");
  assert.equal(await qualityOf({ ok: false, stalled: false, error: "no body bytes", bytes: 0, goodput_bps: 0 }), "UNKNOWN");
});

// Our own probe's traffic is visible in clash:traffic. Previously its peak followed by
// a lull looked like a "curtain", and without the user's involvement a probe went out on
// every watchdog tick: ~660 probes and ~165 MiB per idle hour.
test("проба не запускает следующую своим же трафиком", async () => {
  installStorage();
  let clock = 1_000_000;
  let probes = 0;
  let pending = 0;
  const engine = createQualityEngine({
    invoke: async (cmd) => {
      if (cmd !== "probe_quality") return undefined;
      probes++;
      pending += 262_144; // the probe's bytes will arrive in the next telemetry frame
      return GOOD;
    },
    actions: {},
    opts: { enabled: true },
    now: () => clock,
    sleep: async () => {},
  });
  engine.onConnected({ expectedGeneration: 3 });
  for (let s = 1; s <= 3600; s++) { // an idle hour, a /traffic frame once a second
    clock += 1000;
    const down = pending;
    pending = 0;
    engine.updatePassive({ down });
    if (s % 5 === 0) await engine.tick(); // watchdog tick
  }
  // By design — only the heartbeat once every idleProbeSec (300 s).
  assert.ok(probes <= 13, `ожидалось ≈12 проб за час, было ${probes}`);
});

// R3/R4 rebuild the runtime even if the check after that didn't confirm.
// Such reconnects also count toward the hourly limit.
test("неподтверждённые переподключения лесенки входят в часовой лимит", async () => {
  installStorage();
  let clock = 1_000_000;
  let reconnects = 0;
  let engine;
  const SLOW = { ok: true, stalled: false, goodput_bps: 400_000, bytes: 262_144 };
  engine = createQualityEngine({
    invoke: async (cmd) => (cmd === "probe_quality" ? SLOW : undefined),
    actions: {
      applyFragmentation: async () => {
        reconnects++;
        engine.onIdle();
        engine.onConnected({ expectedGeneration: 1 });
        return false; // verify_runtime_dataplane didn't return Ready
      },
    },
    opts: { enabled: true, aggressive: true, idleProbeSec: 60 },
    now: () => clock,
    sleep: async () => {},
  });
  engine.onConnected({ expectedGeneration: 1 });
  for (let s = 0; s < 3600; s += 5) {
    clock += 5000;
    await engine.tick();
  }
  assert.ok(reconnects <= 4, `часовой лимит 4, было ${reconnects}`);
});

// The probe is longer than the mute window: while frames are muted, old samples must
// age, and one traffic peak must trigger no more than two probes.
test("долгая проба не зацикливает пробы на старом пике", async () => {
  installStorage();
  let clock = 1_000_000;
  let probes = 0;
  const engine = createQualityEngine({
    invoke: async (cmd) => {
      if (cmd !== "probe_quality") return undefined;
      probes++;
      clock += 3_500; // the probe runs 3.5 s — longer than the mute window after it
      return GOOD;
    },
    actions: {},
    opts: { enabled: true, lowDataMode: true },
    now: () => clock,
    sleep: async () => {},
  });
  engine.onConnected({});
  clock += 10_000;
  engine.updatePassive({ down: 500_000 }); // the user was downloading
  clock += 1_000;
  engine.updatePassive({ down: 0 });       // and the stream collapsed
  for (let s = 0; s < 120; s++) {          // 10 minutes of watchdog ticks, frames are muted/zero
    clock += 5_000;
    engine.updatePassive({ down: 0 });
    await engine.tick();
  }
  assert.ok(probes <= 2, `один занавес — не больше двух проб, было ${probes}`);
});
