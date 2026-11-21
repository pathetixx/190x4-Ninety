// Ninety · the recommendation engine — scoring a server by its own measurements.
// Moved out of proxies-view.js: this is pure math without DOM, clash API and
// storage, so it can be checked by tests directly.
//
// It counts ONLY measurements the app has already made: the latency history
// and the node's transport type. No external telemetry.

export const liveDelays = (hs) => hs.filter(d => d > 0 && d < 65000);

export function medianOf(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function stdevOf(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const TRANSPORT_W = { REALITY: 1, XHTTP: 0.95, TRUSTTUNNEL: 0.9, NAIVE: 0.85, WIREGUARD: 0.82, OPENVPN: 0.82, GRPC: 0.8, WS: 0.75 };

export function transportWeight(node) {
  const proto = String(node?.proto || "").toLowerCase();
  if (proto === "trusttunnel") return TRANSPORT_W.TRUSTTUNNEL;
  if (proto === "naive") return TRANSPORT_W.NAIVE;
  if (proto === "wireguard") return TRANSPORT_W.WIREGUARD;
  if (proto === "openvpn") return TRANSPORT_W.OPENVPN;
  const sec = String(node?.security || "").toLowerCase();
  if (sec === "reality") return TRANSPORT_W.REALITY;
  const type = String(node?.type || "").toLowerCase();
  if (type === "xhttp") return TRANSPORT_W.XHTTP;
  if (type === "grpc") return TRANSPORT_W.GRPC;
  if (type === "ws") return TRANSPORT_W.WS;
  return 0.8;
}

// The latency scale is logarithmic, by ratio, not by the difference in ms.
// A linear "25…300 ms" scale rated a difference the same at any speed: 2 ms
// were worth as much in a 26/28 pair as in a 260/262 pair. On a subscription where all
// live servers fit into 26–40 ms, the whole latency spread took 5% of the scale,
// and recommendations were effectively decided by jitter: a server with 33 ms and a steady channel
// beat the fastest one with 26 ms. Meanwhile the user sees the "Latency" column
// sorted by numbers — and the recommendations block looked random.
// On a logarithmic scale at 30 ms a millisecond of latency weighs about as much as
// a millisecond of jitter, and at 300 ms noticeably less, which is what's needed.
const LATENCY_FLOOR_MS = 20;
const LATENCY_CEIL_MS = 400;
const LATENCY_SPAN = Math.log(LATENCY_CEIL_MS / LATENCY_FLOOR_MS);
export function latencyScore(med) {
  if (!(med > 0)) return 0;
  return clamp01(1 - Math.log(Math.max(med, LATENCY_FLOOR_MS) / LATENCY_FLOOR_MS) / LATENCY_SPAN);
}

// Jitter stays on an absolute scale: 5 ms of jitter hurts equally on
// a fast and a slow channel.
const JITTER_SCALE_MS = 55;

export function scoreNode(node, history) {
  const hs = Array.isArray(history) ? history : [];
  const L = liveDelays(hs);
  // One successful measurement is enough: one "Measure all" run gives exactly one
  // measurement per server, and a threshold above that made recommendations unreachable.
  if (!L.length) return null;
  const med = medianOf(L);
  const jit = L.length >= 2 ? stdevOf(L) : null;
  const latency = latencyScore(med);

  // With two measurements, jitter and availability are extremely noisy estimates: one bad
  // sample zeroed stability, and the fastest server dropped out of the recommendations.
  // So the derived components gain weight as measurements accumulate, and
  // while evidence is scarce, the index relies on what's measured directly —
  // latency.
  const evidence = clamp01((hs.length - 1) / 4);
  const shrink = (v) => 0.5 + (v - 0.5) * evidence;
  const stability = jit == null ? 0.5 : shrink(clamp01(1 - jit / JITTER_SCALE_MS));
  const liveness = shrink(L.length / hs.length);
  const transport = transportWeight(node);
  return {
    total: 0.45 * latency + 0.30 * stability + 0.15 * liveness + 0.10 * transport,
    latency, stability, liveness, transport, med, jit, okN: L.length, allN: hs.length,
  };
}

export const REASON_KEYS = ["latency", "stability", "liveness", "transport"];

// The reason is chosen by what the node STANDS OUT from the field the most,
// not by the maximum component: otherwise everyone gets "12 of 12 measurements"
// — a truth that explains nothing. The two lines don't repeat.
//
// superlative says whether the latency can be called the lowest. Previously the line
// "lowest latency" was attached to any node whose latency happened to be
// its strongest side — and below it in the list there could well be a server with a smaller
// number. Only the minimum across the field deserves the superlative.
export function reasonKeys(top, field) {
  const med = {};
  REASON_KEYS.forEach(k => { med[k] = medianOf(field.map(x => Math.round(x.s[k] * 100))) / 100; });
  const bestMed = field.reduce((m, x) => Math.min(m, x.s.med), Infinity);
  const used = new Set();
  return top.map(({ s }) => {
    // Jitter isn't measured without a second measurement, availability with a single measurement
    // is trivially one — such reasons explain nothing.
    const usable = REASON_KEYS.filter(k =>
      !(k === "stability" && s.jit == null) && !(k === "liveness" && s.allN < 2));
    const pool = usable.length ? usable : REASON_KEYS.filter(k => k !== "stability" || s.jit != null);
    const order = [...pool].sort((a, b) => (s[b] - med[b]) - (s[a] - med[a]));
    const key = order.find(k => !used.has(k)) || order[0];
    used.add(key);
    return { key, superlative: key === "latency" && Math.round(s.med) <= Math.round(bestMed) };
  });
}
