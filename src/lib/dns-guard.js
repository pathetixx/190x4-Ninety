// Ninety · DNS watchdog for the direct resolver.
//
// The problem: sing-box resolves the node's server name via dns-direct BEFORE the
// tunnel comes up. A dead direct DNS (in Russia, Google/Cloudflare DoH went down this way) brings down
// the whole start — "i/o timeout" without a clear cause. This module actively probes
// the current direct DNS (Rust: dns_probe) and on failure switches to a working fallback.
//
// Two points: (1) BEFORE connecting, ensureWorkingDirectDns fixes "VPN won't start";
// (2) a periodic check while connected catches the resolver going down mid-session.
//
// The fallback order is NOT random: Quad9 DoH first — it holds up in Russia and, unlike
// Yandex, doesn't distort the node urltest check (Yandex resolves some servers to
// addresses the test falsely marks as unreachable). Yandex DoH is the last resort:
// maximally resilient, but with the same caveat about false failures.
//
// DoH must be followed by plain-DNS steps. TSPU cuts DoH as a CLASS, not
// one address at a time: on 06.08.2026 :443 of Quad9, Yandex, Google and Cloudflare went down at once
// while UDP:53 and regular TCP:443 were alive. A chain of DoH alone on such a day
// degenerates — all candidates are dead, the guard goes into all-dead and DOESN'T fix anything, although
// a working resolver is right at hand. Plain DNS is weaker (an open query, spoofing
// by the ISP), so it ranks below DoH, but it's the last step at which
// the tunnel comes up at all.

import { getOptionsSnapshot, updateOption } from "/lib/options.js";
import { dnsHostLabel } from "/lib/dns-presets.js";
import { t } from "/lib/i18n/index.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// A neutral control domain (IANA, permanent) — we check the very fact of resolution
// without tying it to a specific node/infrastructure.
const CONTROL_HOST = "example.com";

// Fallback chain: DoH (Quad9 → Google → Yandex), then plain DNS. The default
// direct DNS (Google DoH) isn't placed at the top — if it's the one that went down, Quad9
// is more reliable; but it must be lower down, otherwise switching away from it is irreversible: the watchdog
// goes through the list from the top, and it will never return an address that isn't in it.
//
// Google is taken ONLY in DoH form. The open udp://8.8.8.8 doesn't fit the chain:
// from Russia it returns a forged NXDOMAIN for filtered domains, and the probe below
// uses the neutral example.com and doesn't see the spoofing — such a resolver would pass
// the health check and stay selected. Over DoH the answer is encrypted and can't be
// spoofed, so Google is safe there (more in dns-presets.js).
export const FALLBACKS = [
  "https://149.112.112.112/dns-query", // Quad9 secondary DoH
  "https://8.8.8.8/dns-query",         // Google DoH — the default, we must be able to return to it
  "https://77.88.8.8/dns-query",       // Yandex DoH (last-resort DoH fallback)
  "udp://149.112.112.112",             // Quad9 plain — when DoH is cut as a class
  "udp://77.88.8.8",                   // Yandex plain — the most resilient in Russia
];

const PROBE_TIMEOUT_MS = 4000;
// All fallbacks are down = most likely there's no network at all. We don't spam: a toast no more than
// once every 30 min, and after that the watchdog backs off for 15 min.
const ALL_DEAD_TOAST_GAP_MS = 30 * 60_000;
const ALL_DEAD_BACKOFF_MS = 15 * 60_000;
let lastAllDeadToastAt = 0;
let allDeadBackoffUntil = 0;

async function probe(dns) {
  try {
    const r = await invoke("dns_probe", { dns, host: CONTROL_HOST, timeoutMs: PROBE_TIMEOUT_MS });
    // The cause of death goes to the console: without it "why dead" can't be figured out (this way we
    // would have caught the 505 from the HTTP/1.1 probe right away, not from a complaint about toasts).
    if (r?.status === "dead") console.warn("[dns-guard] проба dead:", dns, r?.detail || "");
    return r?.status || "skip";
  } catch (e) {
    console.warn("[dns-guard] dns_probe invoke failed:", e?.message || e);
    return "skip";
  }
}

// Checks the current direct DNS; if it's "dead", finds the first working fallback,
// saves it in settings and returns the new address (otherwise null — nothing to touch).
// toast is injected from main.js. onlyIf is a "still relevant" predicate (don't switch
// if the user disconnected/changed the source during the probe).
export async function ensureWorkingDirectDns({ toast, onlyIf } = {}) {
  const cur = getOptionsSnapshot().dns?.directAddress || "";
  const st = await probe(cur);
  if (st !== "dead") return null; // ok / skip — don't intervene
  // Recheck: we don't switch on a single failure (the network blinked, a packet
  // got lost) — dead is accepted only after two failures in a row.
  if ((await probe(cur)) !== "dead") return null;
  if (onlyIf && !onlyIf()) return null;

  for (const cand of FALLBACKS) {
    if (cand === cur) continue;
    if ((await probe(cand)) !== "ok") continue;
    if (onlyIf && !onlyIf()) return null;
    // Probes take seconds, and during that time the user may have set the DNS themselves.
    // onlyIf guards the relevance of the operation, but not the setting value: without this
    // comparison the watchdog silently put its fallback back over a fresh manual choice.
    if ((getOptionsSnapshot().dns?.directAddress || "") !== cur) return null;
    updateOption("dns.directAddress", cand);
    toast?.(t("dns.switched", { dns: dnsHostLabel(cand) }), "warn", 6000, {
      desc: t("dns.switchedDesc"),
    });
    return cand;
  }
  // All fallbacks are down too — we don't touch the setting; we report it with restraint
  // (time gate), the watchdog backs off — otherwise the toast would hammer every tick.
  allDeadBackoffUntil = Date.now() + ALL_DEAD_BACKOFF_MS;
  if (Date.now() - lastAllDeadToastAt >= ALL_DEAD_TOAST_GAP_MS) {
    lastAllDeadToastAt = Date.now();
    toast?.(t("dns.allDead"), "error", 7000, { desc: t("dns.allDeadDesc") });
  }
  return null;
}

// Periodic watchdog while connected. onDnsSwitched(newDns) is called when
// the resolver was changed (main.js reconnects so that sing-box rereads the DNS).
let timer = null;
let inFlight = false;

export function startDnsGuard({ toast, isConnected, onDnsSwitched, intervalMs = 150_000 } = {}) {
  stopDnsGuard();
  timer = setInterval(async () => {
    if (inFlight || !isConnected?.()) return;
    if (Date.now() < allDeadBackoffUntil) return; // after all-dead — back off
    inFlight = true;
    try {
      // ensureWorkingDirectDns itself exits fast on the first ok probe and
      // double-checks before switching — a separate pre-probe isn't needed.
      const next = await ensureWorkingDirectDns({ toast, onlyIf: isConnected });
      if (next) onDnsSwitched?.(next);
    } catch { /* a background task — we don't escalate errors */ }
    finally { inFlight = false; }
  }, intervalMs);
}

export function stopDnsGuard() {
  if (timer) { clearInterval(timer); timer = null; }
}
