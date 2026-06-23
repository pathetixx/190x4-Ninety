// Движок качества связи (anti-throttle watchdog).
//
// Liveness-watchdog (main.js::healthTick) ловит только смерть ядра. ТСПУ же не
// блокирует, а ДЕГРАДИРУЕТ — режет отдачу до первых ~16 КБ на соединение. Этот
// движок детектит деградацию (пассивно по трафику + активной пробой >16 КБ),
// классифицирует состояние и лечит лесенкой R1–R6 (дёшево→дорого), запоминая
// что сработало для пары ISP×час.
//
// Декаплинг: движок НЕ импортирует main.js (был бы цикл). Все «руки» (выбор
// ноды, реконнект, фрагментация, WARP-rescan, тосты) приходят как `actions`
// при createQualityEngine. Так движок тестируется в изоляции и не знает про DOM.

// ── Пороги (выровнены с quality.rs STALL_*) ────────────────
const SLOW_FLOOR_BPS = 200_000;   // ниже = фактически «душат в ноль»
const BAD_STREAK = 2;             // столько подряд плохих проб → лечим
const GOOD_STREAK = 2;            // столько подряд GOOD → снять/закоммитить
const LADDER_COOLDOWN_MS = 120_000;
const MAX_RECONNECTS_PER_HOUR = 4;
const PASSIVE_WINDOW_MS = 10_000; // окно скользящего трафика
const FLATLINE_BPS = 4_096;       // down ниже — считаем «потока нет»
const ACTIVITY_BPS = 32_768;      // был выше в окне → ждали данные (не idle)
const PROBE_MIN_GAP_MS = 8_000;   // не чаще пробуем (кроме осадки лесенки)

// Осадка после ступени (применить→осесть→перепробить).
const SETTLE_CHEAP_MS = 2_500;    // R1/R2 (без реконнекта)
const SETTLE_RECONNECT_MS = 5_000;// R3+ (реконнект)

const PROFILE_KEY = "ninety.quality.profile";
const PROFILE_TTL_MS = 7 * 24 * 3600 * 1000;

// Лесенка лечения. order = порядок; reconnect=true → ступень дорогая (гейт
// aggressive/промпт + бюджет реконнектов). action = имя в actions-map; если
// действие отсутствует или вернуло {applied:false} — ступень пропускается.
const LADDER = [
  // label — текст для юзера, ПРОСТЫМ языком (видно в промпте/тосте на R3/R4).
  { id: "R1", action: "selectNextNode",  reconnect: false, label: "Смена сервера" },
  { id: "R2", action: "excludeWorstNode", reconnect: false, label: "Другой сервер" },
  { id: "R3", action: "applyFragmentation", reconnect: true, label: "Маскировка трафика" },
  { id: "R4", action: "rescanWarp",       reconnect: true,  label: "Запасной канал" },
  // R5 — клиентское переключение на ноду другого транспорта; селектор "proxy"
  // собран с interrupt_exist_connections=true → застрявшие флоу рвутся сами,
  // полный реконнект ядра не нужен (потому reconnect:false, не гейтим промптом).
  { id: "R5", action: "switchTransport",  reconnect: false, label: "Другой способ подключения" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createQualityEngine({ invoke, actions = {}, opts = {} } = {}) {
  // opts: { enabled, aggressive, lowDataMode, idleProbeSec, goodBps, probeBytes, endpoints }
  let cfg = normalizeOpts(opts);
  let running = false;          // connected + движок активен
  let probing = false;          // идёт probe_quality (не наслаивать)
  const SAMPLE_CAP = 120;       // ring-буфер последних проб (для осциллограммы)
  const samples = [];
  let remediating = false;      // идёт лесенка (tick молчит)
  let badStreak = 0;
  let goodStreak = 0;
  let lastProbeAt = 0;
  let lastLadderAt = 0;
  let reconnectTimes = [];      // timestamps реконнектов для часового капа
  let lastState = "UNKNOWN";
  const passive = [];           // [{t, down}] скользящее окно

  function normalizeOpts(o) {
    return {
      enabled: o.enabled !== false,
      aggressive: !!o.aggressive,
      lowDataMode: !!o.lowDataMode,
      idleProbeSec: Number(o.idleProbeSec) || 300,
      goodBps: Number(o.goodBps) || 1_500_000,
      probeBytes: o.probeBytes || 262_144,
      endpoints: Array.isArray(o.endpoints) && o.endpoints.length
        ? o.endpoints
        : ["https://speed.cloudflare.com/__down?bytes=262144"],
      // 0 = direct (TUN-режим); >0 = mixed-inbound порт. ?? сохраняет 0.
      port: o.port ?? 7890,
    };
  }

  // ── Пассивный сигнал из clash:traffic ──────────────────
  function updatePassive({ down } = {}) {
    const now = Date.now();
    passive.push({ t: now, down: Number(down) || 0 });
    while (passive.length && now - passive[0].t > PASSIVE_WINDOW_MS) passive.shift();
  }
  function passiveView() {
    if (!passive.length) return { peak: 0, last: 0 };
    let peak = 0;
    for (const s of passive) if (s.down > peak) peak = s.down;
    return { peak, last: passive[passive.length - 1].down };
  }

  // Записать сэмпл пробы в ring-буфер + отдать наружу (onSample → шина → осциллограмма).
  // rung — id применённой ступени лесенки (R1..R6), если проба идёт в верификации
  // лечения; иначе null (фоновый heartbeat). Аддитивно: на лесенку/тосты не влияет.
  function recordSample(r, rung) {
    if (!r) return;
    const sample = {
      t: Date.now(),
      bps: Number(r.goodput_bps) || 0,
      q: classify(r),
      rung: rung || null,
      stalled: !!r.stalled,
    };
    samples.push(sample);
    if (samples.length > SAMPLE_CAP) samples.shift();
    actions.onSample?.(sample);
  }

  // ── Активная проба ─────────────────────────────────────
  async function probe(rung = null) {
    if (probing) return null;
    probing = true;
    lastProbeAt = Date.now();
    try {
      const r = await invoke("probe_quality", {
        port: cfg.port,
        endpoints: cfg.endpoints,
        sampleBytes: cfg.probeBytes,
        budgetMs: 4000,
      });
      recordSample(r, rung);
      return r;
    } catch (e) {
      actions.log?.("probe_quality failed: " + e);
      return null;
    } finally {
      probing = false;
    }
  }

  // r → UNKNOWN | GOOD | SLOW | STALLED
  function classify(r) {
    if (!r) return "UNKNOWN";
    if (r.stalled) return "STALLED";
    // Проба не дотянулась (оба endpoint'а легли) — НЕ караем путь: это может быть
    // недоступность самих пробников, а не троттл. UNKNOWN = не действуем.
    if (!r.ok && r.error) return "UNKNOWN";
    const bps = Number(r.goodput_bps) || 0;
    if (bps >= cfg.goodBps) return "GOOD";
    if (bps >= SLOW_FLOOR_BPS) return "SLOW";
    return "STALLED";
  }

  // ── Тик (зовётся из healthTick после liveness-OK) ──────
  async function tick() {
    if (!running || !cfg.enabled || remediating || probing) return;
    const now = Date.now();

    const { peak, last } = passiveView();
    // Подозрение: в окне была активность (юзер качал), а сейчас поток схлопнулся
    // — классика занавеса. Тогда пробуем немедленно.
    const suspect = peak >= ACTIVITY_BPS && last < FLATLINE_BPS;
    const heartbeatDue = !cfg.lowDataMode &&
      now - lastProbeAt >= cfg.idleProbeSec * 1000;

    if (!suspect && !heartbeatDue) return;
    if (now - lastProbeAt < PROBE_MIN_GAP_MS && !suspect) return;

    const r = await probe();
    const st = classify(r);
    lastState = st;
    actions.onState?.(st, r);

    if (st === "GOOD" || st === "UNKNOWN") {
      goodStreak = st === "GOOD" ? goodStreak + 1 : 0;
      badStreak = 0;
      return;
    }
    // SLOW / STALLED
    goodStreak = 0;
    badStreak += 1;
    if (badStreak >= BAD_STREAK && now - lastLadderAt >= LADDER_COOLDOWN_MS) {
      await runLadder(st);
    }
  }

  // ── Бюджет реконнектов (кап блипов) ────────────────────
  function canReconnect() {
    const cut = Date.now() - 3600_000;
    reconnectTimes = reconnectTimes.filter((t) => t > cut);
    return reconnectTimes.length < MAX_RECONNECTS_PER_HOUR;
  }

  // ── Лесенка ────────────────────────────────────────────
  async function runLadder(triggerState) {
    if (remediating) return;
    remediating = true;
    lastLadderAt = Date.now();
    badStreak = 0;
    actions.notify?.("Ninety · качество связи", "Соединение замедлилось — пробую ускорить");

    try {
      const start = learnedStartIndex(); // обучение: стартуем с выученной ступени
      for (let i = start; i < LADDER.length; i++) {
        const step = LADDER[i];
        const fn = actions[step.action];
        if (typeof fn !== "function") continue;

        if (step.reconnect) {
          if (!canReconnect()) {
            actions.log?.("ladder: reconnect budget exhausted, stop at " + step.id);
            break;
          }
          // Гибрид: aggressive→авто+тост; иначе мягкий промпт.
          const ok = cfg.aggressive
            ? (actions.toast?.(`Оптимизирую: ${step.label}…`, "warn", 3500, { group: "quality", connecting: true }), true)
            : await (actions.confirmReconnect?.(step.label) ?? Promise.resolve(false));
          if (!ok) {
            actions.log?.("ladder: user declined reconnect at " + step.id);
            break;
          }
        }

        let applied = false;
        try { applied = (await fn()) !== false; }
        catch (e) { actions.log?.(`ladder ${step.id} failed: ${e}`); applied = false; }
        if (!applied) continue;

        if (step.reconnect) reconnectTimes.push(Date.now());
        await sleep(step.reconnect ? SETTLE_RECONNECT_MS : SETTLE_CHEAP_MS);

        // Верификация: GOOD_STREAK подряд чистых проб → коммит + обучение.
        let verified = 0;
        for (let k = 0; k < GOOD_STREAK; k++) {
          const r = await probe(step.id);
          if (classify(r) === "GOOD") {
            verified++;
            if (verified >= GOOD_STREAK) {
              await commitWin(step, r);
              return;
            }
            await sleep(800);
          } else {
            verified = 0;
            break; // эта ступень не помогла — следующая
          }
        }
      }
      // Все ступени исчерпаны — R6: сдаёмся честно.
      actions.giveUp?.(triggerState);
    } finally {
      remediating = false;
      lastProbeAt = Date.now(); // не долбить пробой сразу после лесенки
    }
  }

  // ── Обучение (localStorage, только локально) ───────────
  async function commitWin(step, r) {
    goodStreak = GOOD_STREAK;
    badStreak = 0;
    lastState = "GOOD";
    actions.toast?.("Связь восстановлена", "ok", 3000, { group: "quality" });
    actions.onState?.("GOOD", r);
    try {
      const ctx = (await actions.getContext?.()) || {};
      const key = await learnKey();
      const store = loadProfile();
      store[key] = {
        stepId: step.id,
        node: ctx.node || null,
        tlsTrick: ctx.tlsTrick || null,
        warpEndpoint: ctx.warpEndpoint || null,
        goodput_bps: Number(r?.goodput_bps) || 0,
        ts: Date.now(),
      };
      saveProfile(store);
    } catch (e) { actions.log?.("learn save failed: " + e); }
  }

  function learnedStartIndex() {
    try {
      const store = loadProfile();
      const rec = store[learnKeySync()];
      if (!rec || Date.now() - rec.ts > PROFILE_TTL_MS) return 0;
      const idx = LADDER.findIndex((s) => s.id === rec.stepId);
      return idx > 0 ? idx : 0; // стартуем с выученной ступени (она помогала)
    } catch { return 0; }
  }

  // Ключ ${asn}:${hour}. ASN ЛОКАЛЬНОГО ISP (не exit'а) — один no_proxy запрос.
  let cachedAsn = null;
  async function learnKey() {
    const hour = new Date().getHours();
    if (cachedAsn == null) {
      try { cachedAsn = (await actions.localAsn?.()) || "unknown"; }
      catch { cachedAsn = "unknown"; }
    }
    return `${cachedAsn}:${hour}`;
  }
  function learnKeySync() {
    return `${cachedAsn || "unknown"}:${new Date().getHours()}`;
  }

  function loadProfile() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveProfile(store) {
    // Чистим протухшие записи заодно.
    const now = Date.now();
    for (const k of Object.keys(store)) {
      if (now - (store[k]?.ts || 0) > PROFILE_TTL_MS) delete store[k];
    }
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(store)); } catch {}
  }

  // ── Жизненный цикл ─────────────────────────────────────
  function onConnected(o = {}) {
    cfg = normalizeOpts({ ...cfg, ...o });
    running = true;
    badStreak = 0; goodStreak = 0; lastState = "UNKNOWN";
    passive.length = 0;
    lastProbeAt = Date.now(); // дать туннелю осесть перед первой пробой
    cachedAsn = null;
  }
  function onIdle() {
    running = false;
    remediating = false;
    passive.length = 0;
  }
  function setOptions(o) { cfg = normalizeOpts({ ...cfg, ...o }); }

  return {
    onConnected, onIdle, tick, updatePassive, setOptions,
    getSamples: () => samples.slice(), // снимок ring-буфера для осциллограммы
    get state() { return lastState; },
    get isRemediating() { return remediating; },
  };
}
