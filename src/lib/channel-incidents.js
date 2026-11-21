// Ninety · channel state transitions → entries in the incident feed.
//
// The quality engine calls onState on every tick: the feed must store TRANSITIONS,
// not probes. The logic is moved out of main.js because it's easy to get wrong, and
// that only becomes visible after several days of observation — which is exactly what happened with
// UNKNOWN: "nothing to measure with" was remembered as a channel state and suppressed
// the next transition to GOOD. The most ordinary chain "went down → the probe didn't reach →
// recovered" didn't write a single ok, the incident closed on a timeout, and in
// the feed it stayed forever as "how it ended — unknown".
//
// Three incident outcomes and who writes them:
//   ok  — observe(GOOD): recovery confirmed by a measurement;
//   end — endSession(): the session ended before a measurement (disconnect, source
//         switch, observation turned off);
//   nothing — measurements stopped; then pause() at least names the reason
//         why the outcome remained unknown.

export const CHANNEL_SESSION_END_KINDS = {
  disconnected: "quality.endedByDisconnect",
  sourceChanged: "quality.endedBySourceChange",
  monitoringOff: "quality.endedByMonitoringOff",
};

export const CHANNEL_PAUSE_KINDS = {
  hostPressure: "quality.pausedHostPressure",
  lowDataMode: "quality.pausedLowData",
  probeSkipped: "quality.pausedProbeSkipped",
};

const DEGRADED = new Set(["SLOW", "STALLED"]);

// record(kind, {severity, params}) — an entry in the feed;
// isAnyIncidentOpen() — whether an incident is open that wasn't opened by the channel (core
//   death, recovery failure): it also ends together with the session;
// sessionSurvives(reason) — whether the session actually continues
//   (an internal reconnect stops the engine, but the user's intent stays
//   "connected", and measurements resume within seconds).
export function createChannelIncidentRecorder({
  record,
  isAnyIncidentOpen = () => false,
  sessionSurvives = () => false,
} = {}) {
  if (typeof record !== "function") {
    throw new TypeError("channel incident recorder requires a record function");
  }

  let channelState = null;
  let pauseReason = null;

  const isOpen = () => DEGRADED.has(channelState);

  function observe(st) {
    // UNKNOWN and PRESSURE are a measurement failure (nothing to measure with, or not allowed because of
    // PC load), not a channel state: they don't touch the history. Otherwise load
    // opened a false "speed dropped" incident, and inside a real one it erased
    // the pause reason, and pause("hostPressure") wrote nothing anymore.
    if (st === "UNKNOWN" || st === "PRESSURE" || st === channelState) return null;
    const prev = channelState;
    channelState = st;
    // The channel changed state — the previous pause reason no longer describes
    // what's happening, and the next one must be recorded anew.
    pauseReason = null;
    if (st === "GOOD") {
      return prev ? record("quality.restored", { severity: "ok", params: { from: prev } }) : null;
    }
    // An incident is opened on the first measurement of a session too: a channel that's bad right after
    // connecting is exactly what the user should see in the feed.
    if (!prev || prev === "GOOD") {
      return record("quality.degraded", {
        severity: st === "STALLED" ? "err" : "warn",
        params: { state: st },
      });
    }
    return null;
  }

  // Measurements stopped for a known reason. We write only inside an open
  // incident and only when the reason changes: otherwise the feed would fill with identical
  // lines from every watchdog tick.
  function pause(reason) {
    const kind = CHANNEL_PAUSE_KINDS[reason];
    if (!kind || !isOpen() || pauseReason === reason) return null;
    pauseReason = reason;
    return record(kind, { severity: "info", params: { reason } });
  }

  function endSession(reason) {
    if (sessionSurvives(reason)) return null;
    const open = isOpen() || isAnyIncidentOpen();
    // The previous session's state must not flow into the next one: after
    // connecting, the first measurement is a new baseline, not a continuation of the old one.
    channelState = null;
    pauseReason = null;
    if (!open) return null;
    return record(CHANNEL_SESSION_END_KINDS[reason] || CHANNEL_SESSION_END_KINDS.disconnected, {
      severity: "end",
      params: { reason },
    });
  }

  return { observe, pause, endSession, isOpen, state: () => channelState };
}
