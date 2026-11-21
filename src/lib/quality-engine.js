// Connection quality engine (anti-throttle watchdog).
//
// The liveness watchdog (main.js::healthTick) only catches core death. TSPU, however, doesn't
// block but DEGRADES — it cuts the download to the first ~16 KB per connection. This
// engine detects degradation (passively by traffic + an active probe >16 KB),
// classifies the state and treats it with the R1–R6 ladder (cheap→expensive), remembering
// what worked for an ISP×hour pair.
//
// Decoupling: the engine does NOT import main.js (that would be a cycle). All the "hands" (node
// selection, reconnect, fragmentation, WARP rescan, toasts) come in as `actions`
// in createQualityEngine. This way the engine is tested in isolation and knows nothing about the DOM.

import { t } from "/lib/i18n/index.js";
import { STORAGE_KEYS } from "/lib/storage-policy.js";

// ── Thresholds (aligned with quality.rs STALL_*) ────────────────
const SLOW_FLOOR_BPS = 200_000;   // below = effectively "throttled to zero"
const BAD_STREAK = 2;             // this many bad probes in a row → treat
const GOOD_STREAK = 2;            // this many GOOD in a row → remove/commit
const LADDER_COOLDOWN_MS = 120_000;
const MAX_RECONNECTS_PER_HOUR = 4;
const PASSIVE_WINDOW_MS = 10_000; // sliding traffic window
const FLATLINE_BPS = 4_096;       // down below this — we consider "no stream"
const ACTIVITY_BPS = 32_768;      // was above this in the window → we were expecting data (not idle)
const PROBE_MIN_GAP_MS = 8_000;   // don't probe more often than this (except the ladder settle time)
// Our own probe downloads up to probeBytes through the same inbound, so its
// traffic is visible in clash:traffic. While it runs and for a couple of seconds after (telemetry
// lags by a tick), we don't record the passive signal: otherwise the probe's peak followed by
// a lull looked like a "curtain" and triggered the next probe — in a loop.
const PROBE_PASSIVE_GRACE_MS = 3_000;

// Settle time after a step (apply→settle→re-probe).
const SETTLE_CHEAP_MS = 2_500;    // R1/R2 (no reconnect)
const SETTLE_RECONNECT_MS = 5_000;// R3+ (reconnect)

const PROFILE_KEY = STORAGE_KEYS.qualityProfile;
const PROFILE_TTL_MS = 7 * 24 * 3600 * 1000;

// The treatment ladder. order = the order; reconnect=true → an expensive step (gated by
// aggressive/prompt + the reconnect budget). action = the name in the actions map; if
// the action is missing or returned {applied:false}, the step is skipped.
const LADDER = [
  // The step's label for the user (in plain language, visible in the prompt/toast on R3/R4)
  // is taken from the i18n catalog by id: t("qEngine.steps.<id>") via stepLabel().
  { id: "R1", action: "selectNextNode",  reconnect: false },
  { id: "R2", action: "excludeWorstNode", reconnect: false },
  { id: "R3", action: "applyFragmentation", reconnect: true },
  { id: "R4", action: "rescanWarp",       reconnect: true },
  // R5 — a client-side switch to a node with a different transport; stuck flows
  // are torn down by selectProxy (clash_close_proxy_connections), a full core reconnect isn't
  // needed — hence reconnect:false and no prompt.
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
  let running = false;          // connected + the engine is active
  let sessionEpoch = 0;
  let probingEpoch = null;      // a probe belongs to a specific VPN session
  const SAMPLE_CAP = 120;       // ring buffer of the latest probes (for the oscilloscope)
  const samples = [];
  let remediatingEpoch = null;  // the ladder belongs to a specific VPN session
  let badStreak = 0;
  let goodStreak = 0;
  let lastProbeAt = 0;
  let passiveMutedUntil = 0;    // until this moment we don't record the passive signal
  // One "curtain" (a peak of user traffic) triggers no more than
  // BAD_STREAK probes — as many as the ladder needs — not a probe on every tick.
  let suspectPeakT = null;
  let suspectPeakProbes = 0;
  // The nearest moment when probing again makes sense. Moved after
  // skipped probes and after the ladder: otherwise the engine would hit IPC on every
  // watchdog tick, getting the same refusal.
  let nextEligibleProbeAt = 0;
  let skippedReason = null;
  let lastLadderAt = 0;
  let reconnectTimes = [];      // reconnect timestamps for the hourly cap
  let reconnectHandoff = false; // R3/R4 waits for a new VPN session
  let lastState = "UNKNOWN";
  let hostPressure = false;     // the host lacks CPU/memory (the Rust sampler)
  const passive = [];           // [{t, down}] sliding window
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

  // ── Passive signal from clash:traffic ──────────────────
  // Old samples are evicted by time and on read: while frames are muted
  // (the probe and a couple of seconds after it), no new ones arrive, and without this the window
  // would keep the previous "peak → lull" indefinitely.
  function prunePassive(timestamp) {
    while (passive.length && timestamp - passive[0].t > PASSIVE_WINDOW_MS) passive.shift();
  }
  function updatePassive({ down } = {}) {
    const timestamp = now();
    prunePassive(timestamp);
    if (probingEpoch != null || timestamp < passiveMutedUntil) return;
    passive.push({ t: timestamp, down: Number(down) || 0 });
  }
  function passiveView(timestamp = now()) {
    prunePassive(timestamp);
    if (!passive.length) return { peak: 0, peakT: null, last: 0 };
    let peak = 0;
    let peakT = null;
    for (const s of passive) if (s.down > peak) { peak = s.down; peakT = s.t; }
    return { peak, peakT, last: passive[passive.length - 1].down };
  }

  // Record a probe sample into the ring buffer + hand it out (onSample → bus → oscilloscope).
  // rung — id of the applied ladder step (R1..R6) if the probe is part of treatment
  // verification; otherwise null (background heartbeat). Additive: doesn't affect the ladder/toasts.
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

  // ── Active probe ─────────────────────────────────────
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
      if (!r?.skipped) quietPassiveAfterProbe();
      // skipped = the probe didn't run at all (no generation, the dataplane is busy,
      // the runtime already changed). This is a gate refusal, not a channel measurement: it
      // doesn't go into the oscilloscope, but staying silent isn't allowed either — without a record a
      // subsystem refusal looks exactly like "everything is fine".
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
      // Bytes may have gotten through before the error too.
      if (sessionActive(epoch)) quietPassiveAfterProbe();
      actions.log?.("probe_quality failed: " + e);
      return null;
    } finally {
      if (probingEpoch === epoch) probingEpoch = null;
    }
  }

  // User measurements recorded before the probe are kept: the second
  // probe in a row that the ladder needs (BAD_STREAK) relies on them. We only don't record the traffic
  // of the probe itself — that's what created the "peak → lull" without the user's involvement.
  function quietPassiveAfterProbe() {
    passiveMutedUntil = now() + PROBE_PASSIVE_GRACE_MS;
  }

  // r → UNKNOWN | GOOD | SLOW | STALLED
  function classify(r) {
    if (!r) return "UNKNOWN";
    if (r.stalled) return "STALLED";
    // The probe didn't reach (both endpoints went down) — we DON'T penalize the path: it may be
    // the probe targets themselves being unavailable, not throttling. UNKNOWN = don't act.
    // The exception is an incomplete sample: bytes were flowing, but the budget ran out first.
    // That's exactly the narrow channel the ladder exists for. A high speed
    // with an incomplete sample only means the stream broke off and doesn't count as success.
    const undersized = !r.ok && /^incomplete sample/.test(String(r.error || "")) && Number(r.bytes) > 0;
    if (!r.ok && r.error && !undersized) return "UNKNOWN";
    const bps = Number(r.goodput_bps) || 0;
    if (bps >= cfg.goodBps) return undersized ? "UNKNOWN" : "GOOD";
    if (bps >= SLOW_FLOOR_BPS) return "SLOW";
    return "STALLED";
  }

  // ── Tick (called from healthTick after liveness OK) ──────
  async function tick() {
    const epoch = sessionEpoch;
    if (!sessionActive(epoch) || !cfg.enabled) return;
    // hostPressure gates the WHOLE tick, not just the ladder: under CPU starvation
    // the probe measures not the channel but the scheduler, and its result would poison both
    // the statistics and the ISP×hour learning with a false "bad". We report this outward:
    // "not measuring" and "everything is fine" are different things, and for the incident feed the difference
    // is crucial (otherwise an open incident silently stays without an outcome).
    if (hostPressure) { actions.onPaused?.("hostPressure"); return; }
    if (reconnectHandoff || remediatingEpoch === epoch || probingEpoch === epoch) return;
    const timestamp = now();
    if (timestamp < nextEligibleProbeAt) return;

    const { peak, peakT, last } = passiveView(timestamp);
    // Suspicion: there was activity in the window (the user was downloading), and now the stream collapsed
    // — a classic curtain. Then we probe immediately.
    const suspect = peak >= ACTIVITY_BPS && last < FLATLINE_BPS
      && !(peakT === suspectPeakT && suspectPeakProbes >= BAD_STREAK);
    const heartbeatDue = !cfg.lowDataMode &&
      timestamp - lastProbeAt >= cfg.idleProbeSec * 1000;

    if (!suspect && !heartbeatDue) {
      // In traffic saving mode the heartbeat is off entirely: while the user
      // isn't downloading, there won't be a single measurement. For the feed this isn't "the channel is
      // fine" but "measuring stopped".
      if (cfg.lowDataMode) actions.onPaused?.("lowDataMode");
      return;
    }
    if (timestamp - lastProbeAt < PROBE_MIN_GAP_MS && !suspect) return;
    if (suspect) {
      if (peakT === suspectPeakT) suspectPeakProbes += 1;
      else { suspectPeakT = peakT; suspectPeakProbes = 1; }
    }

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

  // ── Reconnect budget (blip cap) ────────────────────
  function canReconnect() {
    const cut = now() - 3600_000;
    reconnectTimes = reconnectTimes.filter((at) => at > cut);
    return reconnectTimes.length < MAX_RECONNECTS_PER_HOUR;
  }

  // ── Ladder ────────────────────────────────────────────
  async function runLadder(triggerState, initialEpoch = sessionEpoch) {
    if (!sessionActive(initialEpoch) || remediatingEpoch === initialEpoch) return;
    let epoch = initialEpoch;
    remediatingEpoch = epoch;
    lastLadderAt = now();
    badStreak = 0;
    actions.notify?.(t("qEngine.notifyTitle"), t("qEngine.notifySlow"));

    try {
      const start = learnedStartIndex(); // learning: start from the learned step
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
          // Hybrid: aggressive→auto+toast; otherwise a soft prompt.
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
        const epochBeforeStep = sessionEpoch;
        if (step.reconnect) reconnectHandoff = true;
        try { applied = (await fn()) !== false; }
        catch (e) { actions.log?.(`ladder ${step.id} failed: ${e}`); applied = false; }
        // A failed attempt goes outward too (the incident feed): "tried and it didn't
        // work" explains the pause before the next step, and without it
        // the history shows only a gap between degradation and recovery.
        actions.onRemedy?.({ step: step.id, applied, reconnect: !!step.reconnect });
        // R3/R4 physically rebuild the runtime. A successful action finishes only
        // after onIdle→onConnected, so we move the remediation to the new epoch
        // instead of taking the expected reconnect for a manual disconnect.
        if (step.reconnect && applied && running && sessionEpoch !== epoch) {
          epoch = sessionEpoch;
          remediatingEpoch = epoch;
        }
        if (step.reconnect) reconnectHandoff = false;
        // Every runtime rebuild that took place counts toward the hourly limit, even if
        // the check after it didn't confirm: otherwise an uncertain check
        // allowed reconnecting without limit.
        if (step.reconnect && (applied || sessionEpoch !== epochBeforeStep)) reconnectTimes.push(now());
        if (!sessionActive(epoch)) return;
        if (!applied) continue;

        await sleepFn(step.reconnect ? SETTLE_RECONNECT_MS : SETTLE_CHEAP_MS);
        if (!sessionActive(epoch)) return;

        // Verification: GOOD_STREAK clean probes in a row → commit + learning.
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
            // The probe itself didn't reach (an endpoint went down / the network blinked) — there's nothing
            // to check the step with. "Couldn't check" ≠ "didn't help": escalating
            // further would burn reconnects blindly. We abort the ladder until the next
            // tick (tick does nothing on UNKNOWN anyway).
            actions.log?.(`ladder ${step.id}: verify probe UNKNOWN — лесенка прервана`);
            return;
          } else {
            verified = 0;
            break; // this step didn't help — next
          }
        }
      }
      // All steps exhausted — R6: we give up honestly.
      if (sessionActive(epoch)) actions.giveUp?.(triggerState);
    } finally {
      if (remediatingEpoch === epoch) {
        remediatingEpoch = null;
        lastProbeAt = now(); // don't hammer with a probe right after the ladder
        nextEligibleProbeAt = now() + PROBE_MIN_GAP_MS;
      }
      reconnectHandoff = false;
    }
  }

  // ── Learning (localStorage, local only) ───────────
  async function commitWin(step, r, epoch = sessionEpoch) {
    if (!sessionActive(epoch)) return;
    goodStreak = GOOD_STREAK;
    badStreak = 0;
    lastState = "GOOD";
    actions.toast?.(t("qEngine.restored"), "ok", 3000, { group: "quality" });
    actions.onState?.("GOOD", r);
    // Exactly this step closed the incident — the feed shows what helped.
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
      return idx > 0 ? idx : 0; // start from the learned step (it used to help)
    } catch { return 0; }
  }

  // Key ${asn}:${hour}. The ASN of the LOCAL ISP (not the exit) — one no_proxy request.
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
    // Clean up stale entries along the way.
    const timestamp = now();
    for (const k of Object.keys(store)) {
      if (timestamp - (store[k]?.ts || 0) > PROFILE_TTL_MS) delete store[k];
    }
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(store)); } catch {}
  }

  // ── Lifecycle ─────────────────────────────────────
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
    lastProbeAt = now(); // let the tunnel settle before the first probe
    passiveMutedUntil = 0;
    suspectPeakT = null;
    suspectPeakProbes = 0;
    cachedAsn = null;
    // Warming up the ASN right away: learnedStartIndex reads the learning key SYNCHRONOUSLY at
    // the start of the ladder (learnKeySync), while cachedAsn used to be filled only in
    // commitWin — the first ladder of every session looked for an entry under "unknown:hour"
    // and the learned step wasn't applied. Fire-and-forget: before the first ladder
    // (at least BAD_STREAK probes) the response has time to settle in the cache.
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
  // Called by the watchdog on every tick from health_snapshot.host_pressure.
  function setHostPressure(active) {
    const next = !!active;
    if (hostPressure === next) return;
    hostPressure = next;
    // We reset the streaks in both directions: probes taken at the pressure boundary must
    // neither complete the ladder after exiting nor count as recovery.
    badStreak = 0;
    goodStreak = 0;
    lastState = next ? "PRESSURE" : "UNKNOWN";
    // On exit we don't hit with a probe at the very moment the host was just released:
    // we give the channel the usual minimum gap to settle.
    lastProbeAt = next ? now() : now() - PROBE_MIN_GAP_MS;
    // While the pressure holds, the tick doesn't make A SINGLE probe. Without this event
    // the channel indicator stayed at the last measurement and showed "Excellent"
    // exactly when the engine stopped measuring anything.
    actions.onState?.(lastState, null);
  }

  return {
    onConnected, onIdle, tick, updatePassive, setOptions, setHostPressure,
    getSamples: () => samples.slice(), // a snapshot of the ring buffer for the oscilloscope
    get state() { return lastState; },
    // The reason the last probe was skipped (null — the last probe took place).
    // Distinguishes "the channel is fine" from "the engine isn't measuring anything".
    get skipReason() { return skippedReason; },
    get isRemediating() { return remediatingEpoch === sessionEpoch; },
  };
}
