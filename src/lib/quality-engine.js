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

import { t } from "/lib/i18n/index.js";

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
  // Подпись ступени для юзера (простым языком, видна в промпте/тосте на R3/R4)
  // берётся из каталога i18n по id: t("qEngine.steps.<id>") через stepLabel().
  { id: "R1", action: "selectNextNode",  reconnect: false },
  { id: "R2", action: "excludeWorstNode", reconnect: false },
  { id: "R3", action: "applyFragmentation", reconnect: true },
  { id: "R4", action: "rescanWarp",       reconnect: true },
  // R5 — клиентское переключение на ноду другого транспорта; застрявшие флоу
  // рвёт selectProxy (clash_close_proxy_connections), полный реконнект ядра не
  // нужен — потому reconnect:false и без промпта.
  { id: "R5", action: "switchTransport",  reconnect: false },
];

const stepLabel = (step) => t("qEngine.steps." + step.id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createQualityEngine({
  invoke,
  actions = {},
  opts = {},
  sleep: sleepFn = sleep,
  now = Date.now,
} = {}) {
  // opts: { enabled, aggressive, lowDataMode, idleProbeSec, goodBps, probeBytes, endpoints }
  let cfg = normalizeOpts(opts);
  let running = false;          // connected + движок активен
  let sessionEpoch = 0;
  let probingEpoch = null;      // probe принадлежит конкретной VPN-сессии
  const SAMPLE_CAP = 120;       // ring-буфер последних проб (для осциллограммы)
  const samples = [];
  let remediatingEpoch = null;  // лесенка принадлежит конкретной VPN-сессии
  let badStreak = 0;
  let goodStreak = 0;
  let lastProbeAt = 0;
  // Ближайший момент, когда пробовать снова осмысленно. Двигается после
  // пропущенных проб и после лесенки: иначе движок бил бы IPC на каждом тике
  // сторожа, получая тот же отказ.
  let nextEligibleProbeAt = 0;
  let skippedReason = null;
  let lastLadderAt = 0;
  let reconnectTimes = [];      // timestamps реконнектов для часового капа
  let reconnectHandoff = false; // R3/R4 ждёт новую VPN-сессию
  let lastState = "UNKNOWN";
  let hostPressure = false;     // хосту не хватает CPU/памяти (сэмплер в Rust)
  const passive = [];           // [{t, down}] скользящее окно
  const sessionActive = (epoch) => running && epoch === sessionEpoch;

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
      expectedGeneration: Number(o.expectedGeneration) || 0,
    };
  }

  // ── Пассивный сигнал из clash:traffic ──────────────────
  function updatePassive({ down } = {}) {
    const timestamp = now();
    passive.push({ t: timestamp, down: Number(down) || 0 });
    while (passive.length && timestamp - passive[0].t > PASSIVE_WINDOW_MS) passive.shift();
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
      t: now(),
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
  async function probe(rung = null, epoch = sessionEpoch) {
    if (!sessionActive(epoch) || probingEpoch === epoch) return null;
    probingEpoch = epoch;
    lastProbeAt = now();
    try {
      const r = await invoke("probe_quality", {
        expectedGeneration: cfg.expectedGeneration || null,
        endpoints: cfg.endpoints,
        sampleBytes: cfg.probeBytes,
        budgetMs: 4000,
      });
      if (!sessionActive(epoch)) return null;
      // skipped = проба вообще не выполнялась (нет поколения, датаплейн занят,
      // runtime уже сменился). Это отказ гейта, а не измерение канала: в
      // осциллограмму он не идёт, но и молчать нельзя — без записи отказ
      // подсистемы выглядит ровно как «всё хорошо».
      if (r?.skipped) {
        const reason = r.error || "unknown";
        skippedReason = reason;
        nextEligibleProbeAt = now() + PROBE_MIN_GAP_MS;
        actions.log?.("quality probe skipped: " + reason);
        actions.onSkipped?.(reason);
        return r;
      }
      skippedReason = null;
      recordSample(r, rung);
      return r;
    } catch (e) {
      actions.log?.("probe_quality failed: " + e);
      return null;
    } finally {
      if (probingEpoch === epoch) probingEpoch = null;
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
    const epoch = sessionEpoch;
    // hostPressure гейтит ВЕСЬ тик, а не только лесенку: под голоданием CPU
    // проба меряет не канал, а планировщик, и её результат отравил бы и
    // статистику, и обучение ISP×час ложным «плохо».
    if (!sessionActive(epoch) || !cfg.enabled || hostPressure || reconnectHandoff
      || remediatingEpoch === epoch || probingEpoch === epoch) return;
    const timestamp = now();
    if (timestamp < nextEligibleProbeAt) return;

    const { peak, last } = passiveView();
    // Подозрение: в окне была активность (юзер качал), а сейчас поток схлопнулся
    // — классика занавеса. Тогда пробуем немедленно.
    const suspect = peak >= ACTIVITY_BPS && last < FLATLINE_BPS;
    const heartbeatDue = !cfg.lowDataMode &&
      timestamp - lastProbeAt >= cfg.idleProbeSec * 1000;

    if (!suspect && !heartbeatDue) return;
    if (timestamp - lastProbeAt < PROBE_MIN_GAP_MS && !suspect) return;

    const r = await probe(null, epoch);
    if (!sessionActive(epoch)) return;
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
    if (badStreak >= BAD_STREAK && timestamp - lastLadderAt >= LADDER_COOLDOWN_MS) {
      await runLadder(st, epoch);
    }
  }

  // ── Бюджет реконнектов (кап блипов) ────────────────────
  function canReconnect() {
    const cut = now() - 3600_000;
    reconnectTimes = reconnectTimes.filter((t) => t > cut);
    return reconnectTimes.length < MAX_RECONNECTS_PER_HOUR;
  }

  // ── Лесенка ────────────────────────────────────────────
  async function runLadder(triggerState, initialEpoch = sessionEpoch) {
    if (!sessionActive(initialEpoch) || remediatingEpoch === initialEpoch) return;
    let epoch = initialEpoch;
    remediatingEpoch = epoch;
    lastLadderAt = now();
    badStreak = 0;
    actions.notify?.(t("qEngine.notifyTitle"), t("qEngine.notifySlow"));

    try {
      const start = learnedStartIndex(); // обучение: стартуем с выученной ступени
      for (let i = start; i < LADDER.length; i++) {
        if (!sessionActive(epoch)) return;
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
            ? (actions.toast?.(t("qEngine.optimizing", { label: stepLabel(step) }), "warn", 3500, { group: "quality", connecting: true }), true)
            : await (actions.confirmReconnect?.(stepLabel(step)) ?? Promise.resolve(false));
          if (!sessionActive(epoch)) return;
          if (!ok) {
            actions.log?.("ladder: user declined reconnect at " + step.id);
            break;
          }
        }

        let applied = false;
        if (step.reconnect) reconnectHandoff = true;
        try { applied = (await fn()) !== false; }
        catch (e) { actions.log?.(`ladder ${step.id} failed: ${e}`); applied = false; }
        // Наружу (лента инцидентов) уходит и неудачная попытка: «пробовали и не
        // сработало» объясняет паузу перед следующей ступенью, а без неё в
        // истории видна только дыра между деградацией и восстановлением.
        actions.onRemedy?.({ step: step.id, applied, reconnect: !!step.reconnect });
        // R3/R4 физически пересобирают runtime. Успешное action завершается уже
        // после onIdle→onConnected, поэтому переносим remediation на новый epoch
        // вместо того, чтобы принять ожидаемый reconnect за ручной disconnect.
        if (step.reconnect && applied && running && sessionEpoch !== epoch) {
          epoch = sessionEpoch;
          remediatingEpoch = epoch;
        }
        if (step.reconnect) reconnectHandoff = false;
        if (!sessionActive(epoch)) return;
        if (!applied) continue;

        if (step.reconnect) reconnectTimes.push(now());
        await sleepFn(step.reconnect ? SETTLE_RECONNECT_MS : SETTLE_CHEAP_MS);
        if (!sessionActive(epoch)) return;

        // Верификация: GOOD_STREAK подряд чистых проб → коммит + обучение.
        let verified = 0;
        for (let k = 0; k < GOOD_STREAK; k++) {
          const r = await probe(step.id, epoch);
          if (!sessionActive(epoch)) return;
          const st = classify(r);
          if (st === "GOOD") {
            verified++;
            if (verified >= GOOD_STREAK) {
              await commitWin(step, r, epoch);
              return;
            }
            await sleepFn(800);
          } else if (st === "UNKNOWN") {
            // Проба сама не дотянулась (endpoint лёг / сеть моргнула) — проверить
            // ступень нечем. «Не удалось проверить» ≠ «не помогло»: эскалация
            // дальше жгла бы реконнекты вслепую. Прерываем лесенку до следующего
            // тика (tick при UNKNOWN и так бездействует).
            actions.log?.(`ladder ${step.id}: verify probe UNKNOWN — лесенка прервана`);
            return;
          } else {
            verified = 0;
            break; // эта ступень не помогла — следующая
          }
        }
      }
      // Все ступени исчерпаны — R6: сдаёмся честно.
      if (sessionActive(epoch)) actions.giveUp?.(triggerState);
    } finally {
      if (remediatingEpoch === epoch) {
        remediatingEpoch = null;
        lastProbeAt = now(); // не долбить пробой сразу после лесенки
        nextEligibleProbeAt = now() + PROBE_MIN_GAP_MS;
      }
      reconnectHandoff = false;
    }
  }

  // ── Обучение (localStorage, только локально) ───────────
  async function commitWin(step, r, epoch = sessionEpoch) {
    if (!sessionActive(epoch)) return;
    goodStreak = GOOD_STREAK;
    badStreak = 0;
    lastState = "GOOD";
    actions.toast?.(t("qEngine.restored"), "ok", 3000, { group: "quality" });
    actions.onState?.("GOOD", r);
    // Именно эта ступень закрыла инцидент — лента показывает, что помогло.
    actions.onRemedy?.({ step: step.id, applied: true, fixed: true });
    try {
      const ctx = (await actions.getContext?.()) || {};
      if (!sessionActive(epoch)) return;
      const key = await learnKey();
      if (!sessionActive(epoch)) return;
      const store = loadProfile();
      store[key] = {
        stepId: step.id,
        node: ctx.node || null,
        tlsTrick: ctx.tlsTrick || null,
        warpEndpoint: ctx.warpEndpoint || null,
        goodput_bps: Number(r?.goodput_bps) || 0,
        ts: now(),
      };
      saveProfile(store);
    } catch (e) { actions.log?.("learn save failed: " + e); }
  }

  function learnedStartIndex() {
    try {
      const store = loadProfile();
      const rec = store[learnKeySync()];
      if (!rec || now() - rec.ts > PROFILE_TTL_MS) return 0;
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
    const timestamp = now();
    for (const k of Object.keys(store)) {
      if (timestamp - (store[k]?.ts || 0) > PROFILE_TTL_MS) delete store[k];
    }
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(store)); } catch {}
  }

  // ── Жизненный цикл ─────────────────────────────────────
  function onConnected(o = {}) {
    sessionEpoch++;
    const epoch = sessionEpoch;
    cfg = normalizeOpts({ ...cfg, ...o });
    running = true;
    hostPressure = false;
    badStreak = 0; goodStreak = 0; lastState = "UNKNOWN";
    skippedReason = null;
    nextEligibleProbeAt = 0;
    passive.length = 0;
    lastProbeAt = now(); // дать туннелю осесть перед первой пробой
    cachedAsn = null;
    // Прогрев ASN сразу: learnedStartIndex читает ключ обучения СИНХРОННО в
    // начале лесенки (learnKeySync), а cachedAsn раньше заполнялся только в
    // commitWin — первая лесенка каждой сессии искала запись под "unknown:час"
    // и выученная ступень не применялась. Fire-and-forget: до первой лесенки
    // (минимум BAD_STREAK проб) ответ успевает осесть в кэше.
    if (cfg.enabled) {
      actions.localAsn?.().then((a) => {
        if (sessionActive(epoch)) cachedAsn = a || "unknown";
      }).catch(() => {});
    }
  }
  function onIdle() {
    sessionEpoch++;
    running = false;
    hostPressure = false;
    skippedReason = null;
    nextEligibleProbeAt = 0;
    passive.length = 0;
  }
  function setOptions(o) { cfg = normalizeOpts({ ...cfg, ...o }); }
  // Зовётся сторожем на каждом тике из health_snapshot.host_pressure.
  function setHostPressure(active) {
    const next = !!active;
    if (hostPressure === next) return;
    hostPressure = next;
    // Серии обнуляем в обе стороны: пробы, снятые на границе давления, не
    // должны ни досчитать лесенку после выхода, ни зачесть выздоровление.
    badStreak = 0;
    goodStreak = 0;
    lastState = next ? "PRESSURE" : "UNKNOWN";
    // При выходе не бьём пробой сразу в тот же миг, когда хост только отпустило:
    // даём каналу осесть обычный минимальный зазор.
    lastProbeAt = next ? now() : now() - PROBE_MIN_GAP_MS;
    // Пока давление держится, тик не делает НИ ОДНОЙ пробы. Без этого события
    // индикатор канала оставался на последнем измерении и показывал «Отлично»
    // ровно тогда, когда движок перестал что-либо мерить.
    actions.onState?.(lastState, null);
  }

  return {
    onConnected, onIdle, tick, updatePassive, setOptions, setHostPressure,
    getSamples: () => samples.slice(), // снимок ring-буфера для осциллограммы
    get state() { return lastState; },
    // Причина последнего пропуска пробы (null — последняя проба состоялась).
    // Отличает «канал в порядке» от «движок не измеряет ничего».
    get skipReason() { return skippedReason; },
    get isRemediating() { return remediatingEpoch === sessionEpoch; },
  };
}
