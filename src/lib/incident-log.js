// Ninety · the "black box" — the connection incident feed.
//
// Why: the quality engine, watchdogs, node quarantine and the kill switch already fix the connection
// themselves, but their work is visible from outside only as a toast that lives three seconds.
// The feed keeps a short history: what happened, what the program did and how long
// it took — the "Feed" tab in the "Diagnostics" section.
//
// Entries store DATA, not ready text: the label is built from the i18n catalog
// at render time. Otherwise a history recorded in Russian would stay
// Russian after a language change (and vice versa).
//
// Storage limits: a ring of CAP entries + TTL. The feed isn't a log (there are
// "Logs" for that), but a manageable history of the last few days; there's no reason for it
// to grow without bounds, and the user has one localStorage for the whole app.

import { STORAGE_KEYS } from "/lib/storage-policy.js";

const KEY = STORAGE_KEYS.incidents;
const CAP = 200;
const TTL_MS = 14 * 24 * 3600 * 1000;
// An incident is considered closed if there were no events after it for longer than this
// window: the program may have fixed the connection silently (or the user switched the
// server themselves), and a forever-open incident would lie about "still ongoing".
const IDLE_CLOSE_MS = 10 * 60_000;

// Levels: err/warn open an incident, ok closes it with a confirmed
// recovery, end closes it without a verdict (the session ended earlier:
// disconnect, source switch, observation turned off), info is context inside.
export const INCIDENT_SEVERITIES = ["info", "ok", "end", "warn", "err"];

const isOpener = (severity) => severity === "warn" || severity === "err";

function safeStorage(storage) {
  // A private window, disabled site data, an early start — access to localStorage
  // may throw on the access itself, not only on reading a key.
  try {
    if (storage) return storage;
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function createIncidentLog({
  storage,
  now = Date.now,
  cap = CAP,
  ttlMs = TTL_MS,
  key = KEY,
} = {}) {
  const store = safeStorage(storage);
  const listeners = new Set();
  let memory = null; // fallback when localStorage is unavailable

  function read() {
    if (memory) return memory;
    if (!store) return (memory = []);
    try {
      const raw = store.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      memory = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      memory = [];
    }
    return memory;
  }

  function write(entries) {
    memory = entries;
    if (!store) return;
    try {
      store.setItem(key, JSON.stringify(entries));
    } catch {
      // Full storage must not break recording an incident: the feed
      // keeps living in memory until the end of the session.
    }
  }

  function isEntry(e) {
    return !!e && typeof e === "object" && typeof e.kind === "string" && Number.isFinite(e.ts);
  }

  function prune(entries) {
    const edge = now() - ttlMs;
    const fresh = entries.filter((e) => e.ts >= edge);
    return fresh.length > cap ? fresh.slice(fresh.length - cap) : fresh;
  }

  function record(kind, { severity = "info", params = {}, ts = now() } = {}) {
    const normalizedKind = String(kind || "").trim();
    if (!normalizedKind) return null;
    const entry = {
      id: `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ts,
      kind: normalizedKind,
      severity: INCIDENT_SEVERITIES.includes(severity) ? severity : "info",
      params: params && typeof params === "object" ? params : {},
    };
    const entries = prune([...read(), entry]);
    write(entries);
    for (const fn of listeners) {
      try { fn(entry); } catch { /* a subscriber must not break the recording */ }
    }
    return entry;
  }

  function list() {
    const entries = prune(read());
    write(entries);
    return [...entries].sort((a, b) => a.ts - b.ts);
  }

  function clear() {
    write([]);
    for (const fn of listeners) {
      try { fn(null); } catch { /* see above */ }
    }
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { record, list, clear, subscribe };
}

// Grouping entries into incidents: "something broke → what was done → how it
// ended". The first warn/err opens an incident. It can be closed by:
//   ok  — recovery confirmed by a measurement (outcome "resolved");
//   end — the session ended before a measurement (outcome "ended"): the outcome is unknown,
//         but the duration is known — until that moment the connection was bad;
//   silence longer than idleMs (outcome "unmeasured") — there were no more measurements, and
//         the app doesn't know how long the degradation lasted.
// info outside an open incident — a separate single-event note (outcome
// "note"): it matters to the user to see "just switched the server" too, otherwise the feed
// looks empty on quiet days. end outside an incident isn't shown — a regular
// disconnect by itself isn't a connection event.
export function groupIncidents(entries, { idleMs = IDLE_CLOSE_MS, now = Date.now } = {}) {
  const sorted = [...(entries || [])].filter((e) => e && Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
  const groups = [];
  let open = null;

  const close = (group, endTs, outcome) => {
    group.endTs = endTs;
    group.outcome = outcome;
    // The old field stays: "recovered" means only a confirmed ok, everything
    // else is still false for old consumers.
    group.resolved = outcome === "resolved";
    group.durationMs = Math.max(0, endTs - group.startTs);
  };

  for (const entry of sorted) {
    if (open && entry.ts - open.lastTs > idleMs) {
      close(open, open.lastTs, "unmeasured");
      open = null;
    }

    if (isOpener(entry.severity)) {
      if (!open) {
        open = { startTs: entry.ts, lastTs: entry.ts, severity: entry.severity, events: [] };
        groups.push(open);
      }
      // An incident inherits the worst level of its events: a couple of warns with one err
      // inside is still a breakdown, not a slowdown.
      if (entry.severity === "err") open.severity = "err";
      open.events.push(entry);
      open.lastTs = entry.ts;
      continue;
    }

    if (entry.severity === "end") {
      // The end of a session closes only an already open incident. Outside it this is
      // an ordinary disconnect, and it must not be a note in the feed.
      if (!open) continue;
      open.events.push(entry);
      open.lastTs = entry.ts;
      close(open, entry.ts, "ended");
      open = null;
      continue;
    }

    if (open) {
      open.events.push(entry);
      open.lastTs = entry.ts;
      if (entry.severity === "ok") {
        close(open, entry.ts, "resolved");
        open = null;
      }
      continue;
    }

    // An event outside an incident.
    const solo = { startTs: entry.ts, lastTs: entry.ts, severity: entry.severity, events: [entry] };
    close(solo, entry.ts, entry.severity === "ok" ? "resolved" : "note");
    groups.push(solo);
  }

  if (open) {
    // An incident without a resolution: if the silence is already longer than the window, it's closed by
    // timeout, otherwise it's ongoing right now.
    const silent = now() - open.lastTs > idleMs;
    close(open, open.lastTs, "unmeasured");
    open.ongoing = !silent;
  }

  return groups.reverse(); // newest first — that's how the feed shows them
}

// Total degradation time for a period (for the line "this week the connection
// was degraded for N minutes"). We count only closed/ongoing incidents of level
// warn+, single info entries don't count.
//
// For "resolved" and "ended" this is the exact duration, for "unmeasured" a lower
// bound: after the last event there were no measurements, and the degradation may have lasted
// much longer. So the sum is a lower estimate, and the summary must say "at least"
// and show unmeasuredIncidents() next to it; otherwise an incident with a single entry
// (duration 0) silently improves the week's picture.
export function degradedMs(groups, { since = 0 } = {}) {
  return (groups || [])
    .filter((g) => isOpener(g.severity) && g.startTs >= since)
    .reduce((total, g) => total + (g.durationMs || 0), 0);
}

// How many incidents in the period closed without an outcome — the very ones whose time
// degradedMs undercounts. An incident ongoing right now isn't included: it
// may still end with a measurement.
export function unmeasuredIncidents(groups, { since = 0 } = {}) {
  return (groups || []).filter((g) => isOpener(g.severity)
    && g.startTs >= since
    && g.outcome === "unmeasured"
    && !g.ongoing).length;
}

// The app's shared feed. Tests create their own via createIncidentLog.
export const incidentLog = createIncidentLog();
