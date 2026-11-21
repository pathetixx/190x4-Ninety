// Ninety · Diagnostics — the verdict: one sentence instead of a sheet of measurements.
//
// Only inference rules here, no DOM and no IPC: the input is the raw results of three
// checks, the output is { kind, severity, params, action }. The label is built by
// the i18n catalog by kind, the action is performed by the screen.
//
// Rule order = priority. It isn't random: first what breaks
// the connection entirely (a filter on the path, a dead server), then what breaks
// individual services, and only then privacy observations. Otherwise the verdict
// would talk about an IPv6 leak at a moment when nothing opens for the person
// at all.

import { forwardingAliases, forwardingProblem } from "/lib/forwarding.js";

// The share of targets below which "some services" doesn't turn into a conclusion about the network:
// one failed target is a failed target, not a block.
const BLOCK_SHARE = 0.34;

const isBlockedState = (state) => state === "timeout" || state === "refused" || state === "dns" || state === "tls";
const isOkState = (state) => state === "ok";

function shareOf(rows, predicate) {
  const considered = rows.filter((row) => row.direct?.state !== "skipped" || row.tunnel?.state !== "skipped");
  if (!considered.length) return 0;
  return considered.filter(predicate).length / considered.length;
}

/// Rows where the tunnel helps: doesn't open directly, opens through Ninety.
export function blockedDirectRows(rows) {
  return (rows || []).filter((row) => isBlockedState(row.direct?.state) && isOkState(row.tunnel?.state));
}

/// Rows where the tunnel itself gets in the way: opens directly, doesn't open through Ninety.
/// These are the candidates for a "send direct" rule.
export function blockedTunnelRows(rows) {
  return (rows || []).filter(
    (row) =>
      isOkState(row.direct?.state) &&
      (isBlockedState(row.tunnel?.state) || row.tunnel?.state === "http"),
  );
}

/// Rows where the service refused specifically the server's address (403/429, etc.).
export function refusedByServiceRows(rows) {
  return (rows || []).filter((row) => row.tunnel?.state === "http" && (row.tunnel?.httpStatus ?? 0) >= 400);
}

/// Verdict based on the collected data. Any part may be missing (the check wasn't
/// run or couldn't complete) — the rules account for this.
export function buildVerdict({
  reach = [],
  trace = null,
  leaks = null,
  forwarding = null,
  tunMode = false,
  connected = false,
  reachFailed = false,
} = {}) {
  const rows = Array.isArray(reach) ? reach : [];

  // 0. IP forwarding on the external adapter. In TUN it loops the core's own
  // connections, and nothing works — the other measurements then describe
  // the consequence. In proxy mode there's no loop, and we stay silent.
  if (tunMode && forwardingProblem(forwarding)) {
    return {
      kind: "ipForwarding",
      severity: "err",
      action: "copyForwardingFix",
      params: { iface: forwardingAliases(forwarding) },
    };
  }

  // 1. Connection to the server. The conclusion is built on THREE measurements at once: whether
  // the ping got through, whether the port opened and whether the control address opened. Individually they
  // prove nothing: a closed port and a dead network look the same.
  if (trace && !trace.tcpOpen) {
    const controlOk = trace.control?.state === "open";
    const params = { ip: trace.resolvedIp || "", port: trace.port };
    if (!controlOk) {
      // Even the control address doesn't open — it's the network breaking, not the server.
      return { kind: "localNetwork", severity: "err", action: null, params };
    }
    if (trace.tcp?.state === "refused") {
      // The other side answered with a refusal: the port is closed or the server isn't ours.
      return { kind: "serverPortSilent", severity: "err", action: "switchNode", params };
    }
    if (trace.icmpReached) {
      // Packets reach the server, but the connection to the port is silently swallowed.
      return { kind: "filterInPath", severity: "err", action: "dpi", params };
    }
    return { kind: "serverUnreachable", severity: "err", action: "switchNode", params };
  }

  // 3. The tunnel gets in the way of specific services (bank, government services, local services).
  const tunnelBroken = blockedTunnelRows(rows);
  const serviceRefused = refusedByServiceRows(rows);

  // 4. The network blocks part of the internet, and the tunnel opens it.
  const rescued = blockedDirectRows(rows);
  const rescuedShare = shareOf(rows, (row) => isBlockedState(row.direct?.state) && isOkState(row.tunnel?.state));

  if (rescued.length && rescuedShare >= BLOCK_SHARE) {
    return {
      kind: "networkBlocks",
      severity: "warn",
      action: tunnelBroken.length ? "ruleDirect" : null,
      params: { count: rescued.length, first: rescued[0]?.id || "" },
    };
  }

  if (tunnelBroken.length) {
    return {
      kind: "tunnelBlocksLocal",
      severity: "warn",
      action: "ruleDirect",
      params: { count: tunnelBroken.length, first: tunnelBroken[0]?.id || "" },
    };
  }

  if (serviceRefused.length) {
    return {
      kind: "serviceRefusesNode",
      severity: "warn",
      action: "switchNode",
      params: { count: serviceRefused.length, first: serviceRefused[0]?.id || "" },
    };
  }

  // 5. Privacy: we look only when connectivity is fine.
  if (leaks) {
    if (leaks.dnsInTunnel?.state === "err") {
      return { kind: "dnsBroken", severity: "warn", action: null, params: {} };
    }
    if (leaks.dnsAnswerMatch?.state === "warn") {
      return { kind: "dnsMismatch", severity: "warn", action: null, params: {} };
    }
    if (leaks.ipv6Open?.state === "warn") {
      return { kind: "ipv6Open", severity: "warn", action: null, params: {} };
    }
  }

  if (!rows.length && !trace && !leaks) {
    return { kind: "idle", severity: "info", action: "run", params: {} };
  }

  // The matrix didn't come together: the other checks may have passed, but there's nothing to declare
  // the network clean on.
  if (reachFailed) {
    return { kind: "partial", severity: "warn", action: "run", params: {} };
  }

  return {
    kind: connected ? "clean" : "cleanOffline",
    severity: "ok",
    action: null,
    params: {},
  };
}

/// A short summary of facts under the verdict (the "DNS / TCP / channel …" tile).
/// Returns an array of { key, state, value } — rendering and translation are on the UI side.
export function verdictFacts({ trace = null, leaks = null, reach = [] } = {}) {
  const facts = [];
  if (trace) {
    facts.push({
      key: "trace",
      state: trace.tcpOpen ? "ok" : "err",
      // We show the connection time to the port, not the RTT of the last hop: it's
      // what answers the question "did we get through or not".
      value: trace.tcpOpen && trace.tcp?.ms != null ? String(trace.tcp.ms) : "",
    });
  }
  if (leaks) {
    facts.push({ key: "dns", state: leaks.dnsInTunnel?.state || "skipped", value: "" });
    facts.push({ key: "ipv6", state: leaks.ipv6Open?.state === "ok" ? "ok" : "warn", value: "" });
    facts.push({ key: "ip", state: leaks.externalIp?.state || "skipped", value: leaks.externalIp?.detail || "" });
  }
  if (reach?.length) {
    const ok = reach.filter((row) => isOkState(row.tunnel?.state)).length;
    facts.push({ key: "reach", state: ok === reach.length ? "ok" : "warn", value: `${ok}/${reach.length}` });
  }
  return facts;
}

/// How many findings the run produced — a number for the hint in the menu. A finding is something
/// the person can fix: a service that opens only from one side,
/// a broken trace, a leak remark. Rows that work from both sides
/// don't count as findings.
export function countFindings({ reach = [], trace = null, leaks = null, forwarding = null, tunMode = false } = {}) {
  const rows = Array.isArray(reach) ? reach : [];
  let count = blockedTunnelRows(rows).length + refusedByServiceRows(rows).length;
  if (tunMode && forwardingProblem(forwarding)) count += 1;
  // One row can end up in both lists (403 through the tunnel with live
  // direct access) — we don't count it twice.
  const both = rows.filter(
    (row) => isOkState(row.direct?.state) && row.tunnel?.state === "http" && (row.tunnel?.httpStatus ?? 0) >= 400,
  ).length;
  count -= both;
  count += blockedDirectRows(rows).length;
  if (trace && !trace.tcpOpen) count += 1;
  for (const check of [leaks?.dnsInTunnel, leaks?.dnsAnswerMatch, leaks?.externalIp, leaks?.ipv6Open]) {
    if (check?.state === "warn" || check?.state === "err") count += 1;
  }
  return Math.max(0, count);
}

/// Whether the address goes direct by a routing rule — regional or
/// user-defined. Needed not for the decision but for the LABEL: with a regional
/// rule the "through Ninety" column measures a direct connection made by
/// the core itself, and without an explanation two identical "ok"s look strange.
///
/// Locally we check what we can: the country suffix and the user's domain
/// rules. geosite lists live in the core and can't be expanded here —
/// so the absence of a match doesn't mean "definitely goes into the tunnel".
export function matchesDirectRule({ host = "", region = "", customRules = [] } = {}) {
  const name = String(host).toLowerCase();
  if (!name) return false;

  const country = String(region).toLowerCase();
  if (country && country !== "other" && name.endsWith(`.${country}`)) return true;

  for (const rule of Array.isArray(customRules) ? customRules : []) {
    if (!rule || rule.enabled === false || rule.action !== "direct" || rule.type !== "domain") continue;
    for (const raw of rule.values || []) {
      const value = String(raw || "").toLowerCase();
      if (!value) continue;
      const hit = rule.match === "exact"
        ? name === value
        : rule.match === "keyword"
          ? name.includes(value)
          : value.startsWith(".")
            ? name.endsWith(value)
            : name === value || name.endsWith(`.${value}`);
      if (hit) return true;
    }
  }
  return false;
}
