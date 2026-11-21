// The urltest health checker polls EVERY node of the subscription — the balancer needs
// everyone's latencies to pick the best one. Reports about the others have nothing
// to do with how the selected server works, and on a large subscription they push everything
// else out of the log. Returns the tag of the node the line reports about; the caller
// keeps only the active one. The lines stay in the file on disk: "Copy"
// returns it as is.
const NODE_PROBE_RE = /^(?:monitoring:\s*)?outbound\s+(\S+)\s+URL test\b/i;

// WSAECONNABORTED and its Go equivalents: a local app (browser, Steam,
// a game) closed the socket before the core finished writing the response. The initiator is a client on
// this same machine, the tunnel has nothing to do with it, but sing-box prints this at
// ERROR level, and with active traffic the "Errors" filter consists almost entirely of them.
// We don't hide them: a mass burst of disconnects can also be a symptom (the kill switch cuts
// sessions, the core restarted) — we downgrade them to debug level.
const LOCAL_ABORT_RE = /(aborted by the software in your host machine|use of closed network connection)/i;

// The same case, but Windows returns a different code: the app didn't "abort" but
// reset the connection (WSAECONNRESET). "remote host" in the text is the same
// 127.0.0.1, i.e. a local client, so the anchor is on the source address,
// not on the wording: a reset from a real remote peer must stay
// an error.
const LOOPBACK_RESET_RE = /^inbound\/\S+:\s*process connection from 127\.0\.0\.1:\d+:.*forcibly closed by the remote host/i;

export function healthProbeNodeTag(message) {
  const match = NODE_PROBE_RE.exec(String(message || "").trim());
  return match ? match[1] : null;
}

export function classifyEngineLogSeverity(level, message) {
  const normalizedLevel = String(level || "").toUpperCase();
  const text = String(message || "");
  if (LOCAL_ABORT_RE.test(text) || LOOPBACK_RESET_RE.test(text)) {
    return { level: "DEBUG", grade: "ok", nonFatal: true };
  }
  const grade = normalizedLevel === "ERROR" || normalizedLevel === "FATAL" || normalizedLevel === "PANIC"
    ? "err"
    : normalizedLevel === "WARN" || normalizedLevel === "WARNING"
      ? "warn"
      : normalizedLevel === "TRACE" || normalizedLevel === "DEBUG"
        ? "ok"
        : "info";
  return { level: normalizedLevel, grade, nonFatal: false };
}
