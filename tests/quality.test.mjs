// Движок качества: классификация пробы, запуск лесенки по BAD_STREAK, коммит
// победы с записью обучения. Движок спроектирован под изоляцию (invoke/actions
// инъектятся, DOM не трогается) — гоняем с мок-localStorage и управляемой пробой.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQualityEngine } from "/lib/quality-engine.js";

// Мок localStorage (движок пишет туда профиль обучения ISP×час).
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

// Приводит движок в состояние «есть подозрение» (был поток → схлопнулся), чтобы
// tick пробовал немедленно, не дожидаясь idle-heartbeat.
function armSuspect(engine) {
  engine.updatePassive({ down: 50_000 }); // выше ACTIVITY_BPS
  engine.updatePassive({ down: 100 });    // ниже FLATLINE_BPS
}

// Пропущенная проба ничего не измеряет. Без записи и паузы отказ гейта
// (нет поколения, занят датаплейн) выглядел бы как «канал в порядке», а движок
// бил бы IPC на каждом тике сторожа.
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

  // Следующий тик в пределах паузы новой пробы не запускает.
  clock += 1_000;
  armSuspect(engine);
  await engine.tick();
  assert.equal(calls, 1, "движок не должен долбить пробой на каждом тике");

  // После паузы — снова пробует.
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
  await engine.tick(); // один плохой тик — до BAD_STREAK не дотягивает, лесенки нет
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
      // R1 неприменима (нет альтернативы) — движок идёт дальше; остальных
      // ступеней в actions нет → лесенка исчерпывается и честно сдаётся.
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
    // Первые 2 пробы (тики) — STALLED, дальше (верификация ступени) — GOOD.
    invoke: async (cmd) => {
      if (cmd !== "probe_quality") return undefined;
      probeCount++;
      return probeCount <= 2 ? STALLED : GOOD;
    },
    actions: {
      onState: () => {},
      selectNextNode: async () => true, // R1 применилась
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
    clock += 121_000; // cooldown прошёл, но все попытки всё ещё внутри одного часа
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

// Давление хоста — не свойство канала. Под нехваткой CPU/памяти проба меряет
// планировщик, а лесенка (смена ноды → реконнект) платит самым дорогим
// действием ровно тогда, когда машине и так плохо.
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
  await engine.tick(); // одна плохая проба — до BAD_STREAK не хватает одной
  assert.equal(ladderRan, false);

  engine.setHostPressure(true);
  engine.setHostPressure(false);
  armSuspect(engine);
  await engine.tick();
  // Серия начата заново, поэтому лесенка ещё не имеет права стартовать: иначе
  // проба, снятая на границе давления, досчитала бы чужой стрик.
  assert.equal(ladderRan, false);
});
