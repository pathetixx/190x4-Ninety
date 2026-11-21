// Ninety · BuildOptions — user settings from which the core config is built.
// All user settings in one object, saved to localStorage.

import { perfObserver } from "/lib/performance-observer.js";
import { STARTUP_CONNECT_MODES } from "/lib/startup-runtime-policy.js";

const OPTIONS_KEY = "ninety.options.v1";
// Flag of the one-time log.level info→warn migration (see loadOptions).
const LOG_WARN_MIGRATED_KEY = OPTIONS_KEY + ".logWarnMigrated";
export const OPTIONS_SCHEMA_VERSION = 2;

export const REGIONS = ["other", "ru", "cn", "ir", "tr", "by"];
export const IPV6_MODES = ["disable", "enable", "prefer", "only"];
export const TUN_STACKS = ["mixed", "gvisor", "system"];
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"];
export const MUX_PROTOCOLS = ["h2mux", "smux", "yamux"];

export const DEFAULT_OPTIONS = {
  schemaVersion: OPTIONS_SCHEMA_VERSION,
  region: "ru",
  blockAds: false,
  general: {
    autostart: false,
    startMinimized: false,
    // Connecting on a regular launch: off | restore | always. Autostart at
    // Windows sign-in always connects, regardless of this setting.
    startupConnect: "off",
    // Register Ninety as the handler of top-level VPN links:
    // vless://, vmess://, ss://, trojan://, hysteria2://, hy2://, tuic://,
    // sub://, tt://, naive+https://, naive+quic://.
    linkHandlers: false,
    // III.3: auto-enabling TUN when connecting to an OPEN (unencrypted) Wi-Fi.
    autoProtectWifi: false,
    // I.2 (EXPERIMENTAL): WFP kill switch.
    killSwitch: false,
    // Privacy: don't contact external geo/ASN services.
    disableGeoLookup: false,
    // Don't retry a failed subscription refresh directly.
    allowDirectSubscriptionFallback: false,
  },
  privacy: {
    strictTunnel: false,
    protectedBrowserAutoLaunch: false,
  },
  warp: {
    enabled: false,
    mode: "direct",
    endpoint: "engage.cloudflareclient.com:2408",
    mtu: 1280,
    noisePreset: "off",
    customNoise: {
      count: { from: 2, to: 5 },
      size:  { from: 20, to: 60 },
      delay: { from: 8, to: 20 },
    },
    deepScan: false,
    autoRescan: false,
    autoRescanIntervalMin: 30,
    autoRescanThresholdMs: 300,
  },
  // Default warn, not info: info writes the domain history to singbox.log.
  log: { level: "warn", disabled: false },
  urlTest: {
    connectionTestUrl: "http://cp.cloudflare.com/generate_204",
    intervalSec: 600,
  },
  dns: {
    // Google DoH on both sides. Open UDP can't be the default: from Russia
    // it returns a forged NXDOMAIN for filtered domains (see dns-presets.js).
    // The former direct default (Yandex) distorted urltest — some live nodes
    // showed up as unreachable, see the comment on FALLBACKS in dns-guard.js.
    remoteAddress: "https://8.8.8.8/dns-query",
    directAddress: "https://8.8.8.8/dns-query",
    enableFakeDns: false,
  },
  route: {
    bypassLan: true,
    resolveDestination: false,
    ipv6Mode: "disable",
    tunSplitDiscord: false,
    // Process lookup is on by default: socket→PID→exe is needed by the connection
    // monitor to show each process's executable.
    processLookup: true,
    customRules: [],
    // The region base was moved into customRules ("Make them mine"): the region itself
    // stays selected, but no longer emits its own rules.
    regionDetached: false,
  },
  inbound: {
    mixedPort: 7890,
    mtu: 9000,
    tunStack: "mixed",
    strictRoute: false,
    allowConnectionFromLan: false,
    // Password for network neighbors. It can't be put on mixedPort: the same
    // port is used by the PC's own system proxy, and Windows apps can't
    // respond to a proxy password prompt. So password-protected neighbors go
    // to a separate lanPort, and mixedPort stays for this PC only. The
    // login and password themselves don't live here: localStorage sits on disk in plain
    // text, so the backend stores them and substitutes them into the config (lan_auth.rs).
    lanAuth: false,
    lanPort: 7891,
  },
  tlsTricks: {
    enableFragment: false,
    fragmentMode: "record",
    fragmentFallbackDelay: "500ms",
    mixedSniCase: false,
    enablePadding: false,
    paddingSize: { from: 100, to: 900 },
  },
  mux: {
    enable: false,
    protocol: "h2mux",
    maxStreams: 8,
    padding: false,
  },
  experimental: {
    // enableClashApi is no longer here: the controller is mandatory for the runtime
    // (node selection, pings, traffic), and a disabled flag simply broke the start.
    clashApiPort: 9090,
  },
  quality: {
    enabled: true,
    aggressive: false,
    lowDataMode: false,
    idleProbeSec: 300,
    goodBps: 1_500_000,
    probeBytes: 262_144,
    endpoints: [
      "https://speed.cloudflare.com/__down?bytes=262144",
    ],
  },
  // The "Diagnostics" screen. regionPack is the local services pack for the reachability
  // matrix; it is NOT the same as the region setting: that one controls routing and
  // is limited to the core's geosite/geoip sets, while diagnostics has
  // many more country packs. An empty string = global targets only.
  diagnose: {
    // "auto" means "not chosen yet", the pack is guessed by region/language. An empty
    // string here means a deliberate "global set only".
    regionPack: "auto",
    // Addresses pinned by the user ([{ id, name, url }]) — checked
    // on every run along with the others.
    pinned: [],
  },
};

// Arrays are NOT merged: a saved array wins over the default one entirely.
function deepMerge(target, source) {
  if (typeof source !== "object" || source === null) return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const k of Object.keys(source)) {
    if (k === "__proto__" || k === "prototype" || k === "constructor") continue;
    if (source[k] && typeof source[k] === "object" && !Array.isArray(source[k]) && typeof target[k] === "object") {
      out[k] = deepMerge(target[k], source[k]);
    } else {
      out[k] = source[k];
    }
  }
  return out;
}

const ENUM_PATHS = {
  region: REGIONS,
  "route.ipv6Mode": IPV6_MODES,
  "inbound.tunStack": TUN_STACKS,
  "log.level": LOG_LEVELS,
  "mux.protocol": MUX_PROTOCOLS,
  "warp.mode": ["direct", "chain"],
  "warp.noisePreset": ["off", "default", "aggressive", "custom"],
  "tlsTricks.fragmentMode": ["record", "tcp"],
  "general.startupConnect": STARTUP_CONNECT_MODES,
};

const NUMBER_PATHS = {
  "urlTest.intervalSec": [30, 3600],
  "inbound.mixedPort": [1024, 65535],
  "inbound.lanPort": [1024, 65535],
  "inbound.mtu": [576, 9000],
  "experimental.clashApiPort": [1024, 65535],
  "quality.idleProbeSec": [60, 900],
  "quality.goodBps": [10_000, 1_000_000_000],
  "quality.probeBytes": [16_384, 4_194_304],
  "warp.mtu": [576, 1500],
  "warp.autoRescanIntervalMin": [5, 360],
  "warp.autoRescanThresholdMs": [100, 5000],
  "mux.maxStreams": [1, 1024],
  "tlsTricks.paddingSize.from": [0, 4096],
  "tlsTricks.paddingSize.to": [0, 4096],
  "warp.customNoise.count.from": [1, 64],
  "warp.customNoise.count.to": [1, 64],
  "warp.customNoise.size.from": [1, 1500],
  "warp.customNoise.size.to": [1, 1500],
  "warp.customNoise.delay.from": [0, 10_000],
  "warp.customNoise.delay.to": [0, 10_000],
};

const BOOLEAN_PATHS = [
  "blockAds", "general.autostart", "general.startMinimized", "general.linkHandlers",
  "general.autoProtectWifi", "general.killSwitch", "general.disableGeoLookup",
  "general.allowDirectSubscriptionFallback", "warp.enabled", "warp.deepScan",
  "privacy.strictTunnel", "privacy.protectedBrowserAutoLaunch",
  "warp.autoRescan", "log.disabled", "dns.enableFakeDns",
  "route.bypassLan", "route.resolveDestination", "route.tunSplitDiscord",
  "route.processLookup", "route.regionDetached", "inbound.strictRoute", "inbound.allowConnectionFromLan",
  "inbound.lanAuth", "tlsTricks.enableFragment", "tlsTricks.mixedSniCase", "tlsTricks.enablePadding",
  "mux.enable", "mux.padding", "quality.enabled",
  "quality.aggressive", "quality.lowDataMode",
];

function valueAt(obj, path) {
  return path.split(".").reduce((cur, key) => cur?.[key], obj);
}

function setAt(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (const key of keys.slice(0, -1)) cur = cur[key];
  cur[keys.at(-1)] = value;
}

function isHttpUrl(value) {
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}

// The list of hosts the Rust quality probe accepts (quality.rs,
// ALLOWED_QUALITY_HOSTS). We keep the same gate here: the backend rejects an address outside the list
// entirely, the quality engine goes into a permanent UNKNOWN and silently stops
// measuring anything — while the setting looks applied.
const QUALITY_ENDPOINT_HOSTS = new Set(["speed.cloudflare.com"]);

function isQualityEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && QUALITY_ENDPOINT_HOSTS.has(url.hostname.toLowerCase());
  } catch { return false; }
}

// Version 0.8.0 kept the neighbors' login and password in these settings. We
// take them before the first normalize (which throws these fields away) and hand them to the backend —
// see takeLegacyLanCredentials.
let legacyLanCredentials = (() => {
  try {
    const inbound = JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}")?.inbound;
    const username = typeof inbound?.lanUsername === "string" ? inbound.lanUsername : "";
    const password = typeof inbound?.lanPassword === "string" ? inbound.lanPassword : "";
    return username || password ? { username, password } : null;
  } catch { return null; }
})();

/** Login and password left in settings from 0.8.0; handed out once. */
export function takeLegacyLanCredentials() {
  const found = legacyLanCredentials;
  legacyLanCredentials = null;
  return found;
}

export function normalizeOptions(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = deepMerge(structuredClone(DEFAULT_OPTIONS), source);
  for (const [path, allowed] of Object.entries(ENUM_PATHS)) {
    if (!allowed.includes(valueAt(out, path))) setAt(out, path, valueAt(DEFAULT_OPTIONS, path));
  }
  for (const [path, [min, max]] of Object.entries(NUMBER_PATHS)) {
    const value = Number(valueAt(out, path));
    const fallback = valueAt(DEFAULT_OPTIONS, path);
    setAt(out, path, Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
  }
  for (const path of BOOLEAN_PATHS) {
    if (typeof valueAt(out, path) !== "boolean") setAt(out, path, valueAt(DEFAULT_OPTIONS, path));
  }
  if (!isHttpUrl(out.urlTest.connectionTestUrl)) out.urlTest.connectionTestUrl = DEFAULT_OPTIONS.urlTest.connectionTestUrl;
  out.quality.endpoints = Array.isArray(out.quality.endpoints)
    ? out.quality.endpoints.filter((url) => typeof url === "string" && isQualityEndpoint(url)).slice(0, 4)
    : [];
  if (!out.quality.endpoints.length) out.quality.endpoints = [...DEFAULT_OPTIONS.quality.endpoints];
  if (!Array.isArray(out.route.customRules)) out.route.customRules = [];
  // The local inbound and the clash API listen on the same loopback. Matching
  // ports (both are set manually and share ranges) caused a bind
  // refusal inside the core — on screen this is "failed to connect" without
  // a single hint at the cause. The clash API yields: the user picks the mixed port
  // deliberately (the browser and apps go to it), the control panel port — not.
  if (out.experimental.clashApiPort === out.inbound.mixedPort) {
    out.experimental.clashApiPort = DEFAULT_OPTIONS.experimental.clashApiPort;
    if (out.experimental.clashApiPort === out.inbound.mixedPort) {
      out.inbound.mixedPort = DEFAULT_OPTIONS.inbound.mixedPort;
    }
  }
  // The neighbors' port is also listened on by this same core: a match with mixed or
  // the clash API would bring down the start on bind. It yields — it's picked least often.
  const takenPorts = new Set([out.inbound.mixedPort, out.experimental.clashApiPort]);
  if (takenPorts.has(out.inbound.lanPort)) {
    let port = DEFAULT_OPTIONS.inbound.lanPort;
    while (takenPorts.has(port)) port++;
    out.inbound.lanPort = port;
  }
  // The neighbors' login and password are kept by the backend, they have no place in settings.
  delete out.inbound.lanUsername;
  delete out.inbound.lanPassword;
  for (const pair of [
    out.tlsTricks.paddingSize,
    out.warp.customNoise.count,
    out.warp.customNoise.size,
    out.warp.customNoise.delay,
  ]) {
    if (pair.from > pair.to) [pair.from, pair.to] = [pair.to, pair.from];
  }
  for (const path of ["dns.remoteAddress", "dns.directAddress", "warp.endpoint"]) {
    if (typeof valueAt(out, path) !== "string" || !valueAt(out, path).trim()) {
      setAt(out, path, valueAt(DEFAULT_OPTIONS, path));
    } else {
      setAt(out, path, valueAt(out, path).trim());
    }
  }
  if (typeof out.tlsTricks.fragmentFallbackDelay !== "string"
      || !/^\d+(?:\.\d+)?(?:ms|s)$/.test(out.tlsTricks.fragmentFallbackDelay.trim())) {
    out.tlsTricks.fragmentFallbackDelay = DEFAULT_OPTIONS.tlsTricks.fragmentFallbackDelay;
  }
  out.schemaVersion = OPTIONS_SCHEMA_VERSION;
  return out;
}

let cacheInitialized = false;
let cachedRaw = null;
let cachedOptions = null;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function cloneOptions(value) {
  return structuredClone(value || DEFAULT_OPTIONS);
}

function commitCache(raw, normalized) {
  cachedRaw = raw;
  // We freeze ONLY our own copy. normalized holds references to the caller's
  // structures: deepMerge puts source arrays and objects in as is, so
  // updateOption("route.customRules", rules) handed the rules screen's live array
  // here — deepFreeze made it immutable, and the next mutation (pushing
  // a second rule, replacing an edited one, toggle, drag-reorder) failed with
  // a TypeError in strict mode: the "Save" button stopped responding.
  cachedOptions = deepFreeze(cloneOptions(normalized));
  cacheInitialized = true;
}

export function invalidateOptionsCache() {
  cacheInitialized = false;
  cachedRaw = null;
  cachedOptions = null;
}

function loadNormalizedSnapshot() {
  const raw = localStorage.getItem(OPTIONS_KEY);
  if (cacheInitialized && raw === cachedRaw && cachedOptions) {
    perfObserver.increment("options.cache.hits");
    return cachedOptions;
  }
  perfObserver.increment("options.cache.misses");

  if (!raw) {
    localStorage.setItem(LOG_WARN_MIGRATED_KEY, "1");
    const defaults = normalizeOptions(DEFAULT_OPTIONS);
    commitCache(null, defaults);
    return cachedOptions;
  }

  const parsed = JSON.parse(raw);
  const rawSchemaVersion = Number(parsed?.schemaVersion);
  const isLegacySchema = !Number.isInteger(rawSchemaVersion)
    || rawSchemaVersion < OPTIONS_SCHEMA_VERSION;
  const opts = normalizeOptions(parsed);
  // v0.2.47+ storage was written after the process-lookup default regressed to
  // false. Without a marker that value is indistinguishable from an opt-out,
  // so migrate only unversioned/older snapshots once and mark the result. A
  // false value written with the current schema is an intentional opt-out.
  if (isLegacySchema && parsed?.route?.processLookup === false) {
    opts.route.processLookup = true;
  }
  let migrated = isLegacySchema;
  if (!localStorage.getItem(LOG_WARN_MIGRATED_KEY)) {
    localStorage.setItem(LOG_WARN_MIGRATED_KEY, "1");
    if (opts.log?.level === "info") {
      opts.log.level = "warn";
      migrated = true;
    }
  }
  if (migrated) {
    const migratedRaw = JSON.stringify(opts);
    localStorage.setItem(OPTIONS_KEY, migratedRaw);
    commitCache(migratedRaw, opts);
    return cachedOptions;
  }
  commitCache(raw, opts);
  return cachedOptions;
}

// Compatible API: callers get an independent mutable clone, so the old
// pattern `const o=loadOptions(); o.x=...; saveOptions(o)` stays safe.
export function loadOptions() {
  try {
    return cloneOptions(loadNormalizedSnapshot());
  } catch {
    invalidateOptionsCache();
    return structuredClone(DEFAULT_OPTIONS);
  }
}

// A read-only shared snapshot for hot paths that don't need local mutation.
export function getOptionsSnapshot() {
  try { return loadNormalizedSnapshot(); }
  catch {
    invalidateOptionsCache();
    // Also through a clone: normalizeOptions returns out with references to the arrays of
    // DEFAULT_OPTIONS (route.customRules, diagnose.pinned) — without a copy this
    // fallback would freeze the module default itself.
    return deepFreeze(cloneOptions(normalizeOptions(DEFAULT_OPTIONS)));
  }
}

export function saveOptions(opts) {
  const normalized = normalizeOptions(opts);
  const raw = JSON.stringify(normalized);
  localStorage.setItem(OPTIONS_KEY, raw);
  commitCache(raw, normalized);
  return cloneOptions(cachedOptions);
}

// Keep option writes explicit.  A generic deep setter would turn a caller-
// controlled path into a prototype-pollution primitive even when it filters a
// few well-known property names.
const OPTION_SETTERS = new Map([
  // Another region — another base: the migrated rules of the previous region stay
  // with the user, and the new region works with its own base again.
  ["region", (opts, value) => {
    if (opts.region !== value) opts.route.regionDetached = false;
    opts.region = value;
  }],
  ["blockAds", (opts, value) => { opts.blockAds = value; }],
  ["general.autostart", (opts, value) => { opts.general.autostart = value; }],
  ["general.startMinimized", (opts, value) => { opts.general.startMinimized = value; }],
  ["general.startupConnect", (opts, value) => { opts.general.startupConnect = value; }],
  ["general.linkHandlers", (opts, value) => { opts.general.linkHandlers = value; }],
  ["general.autoProtectWifi", (opts, value) => { opts.general.autoProtectWifi = value; }],
  ["general.killSwitch", (opts, value) => { opts.general.killSwitch = value; }],
  ["general.disableGeoLookup", (opts, value) => { opts.general.disableGeoLookup = value; }],
  ["general.allowDirectSubscriptionFallback", (opts, value) => { opts.general.allowDirectSubscriptionFallback = value; }],
  ["privacy.strictTunnel", (opts, value) => { opts.privacy.strictTunnel = value; }],
  ["privacy.protectedBrowserAutoLaunch", (opts, value) => { opts.privacy.protectedBrowserAutoLaunch = value; }],
  ["warp.enabled", (opts, value) => { opts.warp.enabled = value; }],
  ["warp.mode", (opts, value) => { opts.warp.mode = value; }],
  ["warp.endpoint", (opts, value) => { opts.warp.endpoint = value; }],
  ["warp.mtu", (opts, value) => { opts.warp.mtu = value; }],
  ["warp.noisePreset", (opts, value) => { opts.warp.noisePreset = value; }],
  ["warp.customNoise.count.from", (opts, value) => { opts.warp.customNoise.count.from = value; }],
  ["warp.customNoise.count.to", (opts, value) => { opts.warp.customNoise.count.to = value; }],
  ["warp.customNoise.size.from", (opts, value) => { opts.warp.customNoise.size.from = value; }],
  ["warp.customNoise.size.to", (opts, value) => { opts.warp.customNoise.size.to = value; }],
  ["warp.customNoise.delay.from", (opts, value) => { opts.warp.customNoise.delay.from = value; }],
  ["warp.customNoise.delay.to", (opts, value) => { opts.warp.customNoise.delay.to = value; }],
  ["warp.deepScan", (opts, value) => { opts.warp.deepScan = value; }],
  ["warp.autoRescan", (opts, value) => { opts.warp.autoRescan = value; }],
  ["warp.autoRescanIntervalMin", (opts, value) => { opts.warp.autoRescanIntervalMin = value; }],
  ["warp.autoRescanThresholdMs", (opts, value) => { opts.warp.autoRescanThresholdMs = value; }],
  ["log.level", (opts, value) => { opts.log.level = value; }],
  ["log.disabled", (opts, value) => { opts.log.disabled = value; }],
  ["urlTest.connectionTestUrl", (opts, value) => { opts.urlTest.connectionTestUrl = value; }],
  ["urlTest.intervalSec", (opts, value) => { opts.urlTest.intervalSec = value; }],
  ["dns.remoteAddress", (opts, value) => { opts.dns.remoteAddress = value; }],
  ["dns.directAddress", (opts, value) => { opts.dns.directAddress = value; }],
  ["dns.enableFakeDns", (opts, value) => { opts.dns.enableFakeDns = value; }],
  ["route.bypassLan", (opts, value) => { opts.route.bypassLan = value; }],
  ["route.resolveDestination", (opts, value) => { opts.route.resolveDestination = value; }],
  ["route.ipv6Mode", (opts, value) => { opts.route.ipv6Mode = value; }],
  ["route.tunSplitDiscord", (opts, value) => { opts.route.tunSplitDiscord = value; }],
  ["route.processLookup", (opts, value) => { opts.route.processLookup = value; }],
  ["route.customRules", (opts, value) => { opts.route.customRules = value; }],
  ["route.regionDetached", (opts, value) => { opts.route.regionDetached = value; }],
  ["inbound.mixedPort", (opts, value) => { opts.inbound.mixedPort = value; }],
  ["inbound.mtu", (opts, value) => { opts.inbound.mtu = value; }],
  ["inbound.tunStack", (opts, value) => { opts.inbound.tunStack = value; }],
  ["inbound.strictRoute", (opts, value) => { opts.inbound.strictRoute = value; }],
  ["inbound.allowConnectionFromLan", (opts, value) => { opts.inbound.allowConnectionFromLan = value; }],
  ["inbound.lanAuth", (opts, value) => { opts.inbound.lanAuth = value; }],
  ["inbound.lanPort", (opts, value) => { opts.inbound.lanPort = value; }],
  ["tlsTricks.enableFragment", (opts, value) => { opts.tlsTricks.enableFragment = value; }],
  ["tlsTricks.fragmentMode", (opts, value) => { opts.tlsTricks.fragmentMode = value; }],
  ["tlsTricks.fragmentFallbackDelay", (opts, value) => { opts.tlsTricks.fragmentFallbackDelay = value; }],
  ["tlsTricks.mixedSniCase", (opts, value) => { opts.tlsTricks.mixedSniCase = value; }],
  ["tlsTricks.enablePadding", (opts, value) => { opts.tlsTricks.enablePadding = value; }],
  ["tlsTricks.paddingSize.from", (opts, value) => { opts.tlsTricks.paddingSize.from = value; }],
  ["tlsTricks.paddingSize.to", (opts, value) => { opts.tlsTricks.paddingSize.to = value; }],
  ["mux.enable", (opts, value) => { opts.mux.enable = value; }],
  ["mux.protocol", (opts, value) => { opts.mux.protocol = value; }],
  ["mux.maxStreams", (opts, value) => { opts.mux.maxStreams = value; }],
  ["mux.padding", (opts, value) => { opts.mux.padding = value; }],
  ["experimental.clashApiPort", (opts, value) => { opts.experimental.clashApiPort = value; }],
  ["quality.enabled", (opts, value) => { opts.quality.enabled = value; }],
  ["quality.aggressive", (opts, value) => { opts.quality.aggressive = value; }],
  ["quality.lowDataMode", (opts, value) => { opts.quality.lowDataMode = value; }],
  ["quality.idleProbeSec", (opts, value) => { opts.quality.idleProbeSec = value; }],
  ["quality.goodBps", (opts, value) => { opts.quality.goodBps = value; }],
  ["quality.probeBytes", (opts, value) => { opts.quality.probeBytes = value; }],
  ["quality.endpoints", (opts, value) => { opts.quality.endpoints = value; }],
  ["diagnose.regionPack", (opts, value) => { opts.diagnose.regionPack = value; }],
  ["diagnose.pinned", (opts, value) => { opts.diagnose.pinned = value; }],
]);

export function updateOption(path, value) {
  const setter = OPTION_SETTERS.get(path);
  if (!setter) throw new TypeError("Unsafe option path");
  const opts = loadOptions();
  setter(opts, value);
  const normalized = saveOptions(opts);
  try {
    window.dispatchEvent(new CustomEvent("ninety:option-changed", {
      detail: { path, value: valueAt(normalized, path) },
    }));
  } catch {}
  return normalized;
}

export function getOption(opts, path, fallback) {
  const keys = path.split(".");
  let cur = opts;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return fallback;
    cur = cur[k];
  }
  return cur ?? fallback;
}

export function resetOptions() {
  saveOptions(structuredClone(DEFAULT_OPTIONS));
}

globalThis.window?.addEventListener?.("storage", (event) => {
  if (event?.key === OPTIONS_KEY) invalidateOptionsCache();
});
