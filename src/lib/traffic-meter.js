// Ninety · tracking actually measured traffic per source (subscription/profile).
//
// Why: the home screen tile showed traffic from the subscription header
// (subscription-userinfo) — the provider often sends 0/total=0 or rarely updates it,
// and single profiles (hysteria/naive/tt) have no header at all. The real
// traffic is counted by sing-box (everything goes through it) — clash API /connections returns
// cumulative uploadTotal/downloadTotal. But they reset on every
// core restart (any reconnect), so we accumulate deltas ourselves in localStorage
// per source — "used over N days" survives reconnects and
// app restarts.

import { getTrafficTotal } from "/lib/clash-api.js";
import { TRAFFIC_PREFIX } from "/lib/storage-policy.js";

const KEY_PREFIX = TRAFFIC_PREFIX;

function load(sourceKey) {
  try {
    const o = JSON.parse(localStorage.getItem(KEY_PREFIX + sourceKey) || "");
    return { up: Number(o.up) || 0, down: Number(o.down) || 0 };
  } catch { return { up: 0, down: 0 }; }
}
function save(sourceKey, v) {
  try { localStorage.setItem(KEY_PREFIX + sourceKey, JSON.stringify({ up: v.up, down: v.down })); } catch {}
}

// Accumulated measured traffic of a source. { up, down, total } in bytes.
export function getMeasured(sourceKey) {
  if (!sourceKey) return { up: 0, down: 0, total: 0 };
  const v = load(sourceKey);
  return { up: v.up, down: v.down, total: v.up + v.down };
}

export function resetMeasured(sourceKey) {
  if (!sourceKey) return;
  try { localStorage.removeItem(KEY_PREFIX + sourceKey); } catch {}
}

// Source key for a getActiveSource() object.
// The key must either be specific or absent. Previously a source without an id
// produced the string "sub:undefined", and the traffic of all such sources piled into one
// shared counter, and "Reset" cleared it for all of them at once.
export function sourceKeyOf(src) {
  if (!src) return null;
  if (src.kind === "sub") return src.subscription?.id ? `sub:${src.subscription.id}` : null;
  if (src.kind === "single") return src.profile?.id ? `profile:${src.profile.id}` : null;
  if (src.kind === "warp") return "warp";
  return null;
}

let timer = null;
let curKey = null;
let lastUp = 0, lastDown = 0;   // the last snapshot of the core's cumulative totals
let haveBaseline = false;       // whether we got the first snapshot (the baseline for deltas)
let onUpdate = null;
let meterRunId = 0;
let runtimeToken = null;
let runtimeProvider = null;
let clashPort = 9090;

export function configureTrafficRuntime(provider) {
  runtimeProvider = provider || null;
}

async function poll() {
  const runId = meterRunId;
  const key = curKey;
  const token = runtimeToken;
  if (!key) return;
  if (token && runtimeProvider?.isCurrent && !runtimeProvider.isCurrent(token)) return;
  let t;
  try { t = await getTrafficTotal(clashPort, { token }); }
  catch { return; } // the core hasn't brought up the clash API yet / already died — skip the tick
  if (runId !== meterRunId || key !== curKey || token !== runtimeToken) return;
  if (token && runtimeProvider?.isCurrent && !runtimeProvider.isCurrent(token)) return;
  const up = Number(t?.up) || 0, down = Number(t?.down) || 0;
  // The first snapshot after the core starts is only a baseline, we don't write a delta.
  if (!haveBaseline) { lastUp = up; lastDown = down; haveBaseline = true; return; }
  // Delta since the last tick. If the total dropped, the core restarted, and the current
  // value is the "new" traffic since the restart.
  let dU = up - lastUp, dD = down - lastDown;
  if (dU < 0) dU = up;
  if (dD < 0) dD = down;
  lastUp = up; lastDown = down;
  if (dU > 0 || dD > 0) {
    const acc = load(key);
    acc.up += dU; acc.down += dD;
    save(key, acc);
    try { onUpdate?.(); } catch {}
  }
}

// Start polling for the active source. Called on the transition to connected.
export function startMeter({ sourceKey, intervalMs = 3000, onUpdate: cb, token, port } = {}) {
  stopMeter();
  curKey = sourceKey || null;
  onUpdate = cb || null;
  runtimeToken = token || runtimeProvider?.capture?.() || null;
  clashPort = Number(port ?? runtimeToken?.clashPort) || 9090;
  haveBaseline = false; lastUp = 0; lastDown = 0;
  if (!curKey) return;
  poll();
  timer = setInterval(poll, intervalMs);
}

export function stopMeter() {
  meterRunId++;
  if (timer) { clearInterval(timer); timer = null; }
  curKey = null; haveBaseline = false; onUpdate = null; runtimeToken = null;
}
