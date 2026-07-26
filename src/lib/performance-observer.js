// Ninety · lightweight performance observability.
//
// The collector is intentionally dependency-free and safe for production builds:
// callers opt in explicitly, samples are bounded, and snapshots contain only
// timings/counters (never profile URLs, node credentials or destinations).

const DEFAULT_SAMPLE_CAP = 120;

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nowMs(clock) {
  try { return finiteNumber(clock?.(), Date.now()); }
  catch { return Date.now(); }
}

export function createPerformanceObserver({
  enabled = true,
  sampleCap = DEFAULT_SAMPLE_CAP,
  clock = () => globalThis.performance?.now?.() ?? Date.now(),
  wallClock = () => Date.now(),
} = {}) {
  const cap = Math.max(1, Math.min(1000, Math.trunc(finiteNumber(sampleCap, DEFAULT_SAMPLE_CAP))));
  const counters = new Map();
  const gauges = new Map();
  const samples = new Map();
  const marks = new Map();
  const startedAt = nowMs(wallClock);

  function active() { return enabled === true; }

  function increment(name, amount = 1) {
    if (!active() || !name) return 0;
    const next = finiteNumber(counters.get(name)) + finiteNumber(amount, 1);
    counters.set(String(name), next);
    return next;
  }

  function gauge(name, value) {
    if (!active() || !name) return 0;
    const next = finiteNumber(value);
    gauges.set(String(name), next);
    return next;
  }

  function sample(name, value, meta = null) {
    if (!active() || !name) return null;
    const entry = {
      at: nowMs(wallClock),
      value: finiteNumber(value),
      ...(meta && typeof meta === "object" ? { meta: { ...meta } } : {}),
    };
    const key = String(name);
    const list = samples.get(key) || [];
    list.push(entry);
    if (list.length > cap) list.splice(0, list.length - cap);
    samples.set(key, list);
    return entry;
  }

  function mark(name) {
    if (!active() || !name) return null;
    const value = nowMs(clock);
    marks.set(String(name), value);
    return value;
  }

  function measure(name, startName, endName = null, meta = null) {
    if (!active() || !name || !startName) return null;
    const start = marks.get(String(startName));
    if (!Number.isFinite(start)) return null;
    const end = endName == null ? nowMs(clock) : marks.get(String(endName));
    if (!Number.isFinite(end)) return null;
    return sample(String(name), Math.max(0, end - start), meta);
  }

  function time(name, meta = null) {
    if (!active() || !name) return () => null;
    const started = nowMs(clock);
    let finished = false;
    return (extraMeta = null) => {
      if (finished) return null;
      finished = true;
      const mergedMeta = meta || extraMeta
        ? { ...(meta || {}), ...(extraMeta || {}) }
        : null;
      return sample(String(name), Math.max(0, nowMs(clock) - started), mergedMeta);
    };
  }

  function reset() {
    counters.clear();
    gauges.clear();
    samples.clear();
    marks.clear();
  }

  function snapshot() {
    const sampleSnapshot = {};
    for (const [name, list] of samples) sampleSnapshot[name] = list.map((entry) => ({ ...entry }));
    return {
      schemaVersion: 1,
      createdAt: nowMs(wallClock),
      startedAt,
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
      samples: sampleSnapshot,
    };
  }

  return {
    increment,
    gauge,
    sample,
    mark,
    measure,
    time,
    reset,
    snapshot,
  };
}

// Shared collector for modules that do not need dependency injection. Tests and
// sensitive workflows can create isolated collectors via createPerformanceObserver.
export const perfObserver = createPerformanceObserver();
