// Ninety · BuildOptions — зеркало HiddifyOptions
// Все настройки пользователя в одном объекте, сохраняется в localStorage.

import { perfObserver } from "/lib/performance-observer.js";

const OPTIONS_KEY = "ninety.options.v1";
// Флаг разовой миграции log.level info→warn (см. loadOptions).
const LOG_WARN_MIGRATED_KEY = OPTIONS_KEY + ".logWarnMigrated";

export const REGIONS = ["other", "ru", "cn", "ir", "tr", "by"];
export const IPV6_MODES = ["disable", "enable", "prefer", "only"];
export const TUN_STACKS = ["mixed", "gvisor", "system"];
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"];
export const MUX_PROTOCOLS = ["h2mux", "smux", "yamux"];

export const DEFAULT_OPTIONS = {
  region: "ru",
  blockAds: false,
  general: {
    autostart: false,
    startMinimized: false,
    // Регистрировать Ninety как обработчик VPN-ссылок верхнего уровня:
    // vless://, vmess://, ss://, trojan://, hysteria2://, hy2://, tuic://,
    // sub://, tt://, naive+https://, naive+quic://.
    linkHandlers: false,
    // III.3: авто-включение TUN при подключении к ОТКРЫТОЙ (нешифрованной) Wi-Fi.
    autoProtectWifi: false,
    // I.2 (ЭКСПЕРИМЕНТАЛЬНО): WFP kill switch.
    killSwitch: false,
    // Приватность: не обращаться к внешним geo/ASN-сервисам.
    disableGeoLookup: false,
    // Не повторять неудачный subscription refresh напрямую.
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
  // Дефолт warn, не info: info пишет историю доменов в singbox.log.
  log: { level: "warn", disabled: false },
  urlTest: {
    connectionTestUrl: "http://cp.cloudflare.com/generate_204",
    intervalSec: 600,
  },
  dns: {
    remoteAddress: "https://1.1.1.1/dns-query",
    directAddress: "udp://77.88.8.8",
    independentCache: true,
    enableFakeDns: false,
  },
  route: {
    bypassLan: true,
    resolveDestination: false,
    ipv6Mode: "disable",
    tunSplitDiscord: false,
    // Process lookup opt-in: socket→PID→exe lookup имеет цену на каждом connect.
    processLookup: false,
    customRules: [],
  },
  inbound: {
    mixedPort: 7890,
    mtu: 9000,
    tunStack: "mixed",
    strictRoute: false,
    allowConnectionFromLan: false,
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
    enableClashApi: true,
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
};

// Массивы НЕ мёржатся: сохранённый массив целиком побеждает дефолтный.
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
};

const NUMBER_PATHS = {
  "urlTest.intervalSec": [30, 3600],
  "inbound.mixedPort": [1024, 65535],
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
  "warp.autoRescan", "log.disabled", "dns.independentCache", "dns.enableFakeDns",
  "route.bypassLan", "route.resolveDestination", "route.tunSplitDiscord",
  "route.processLookup", "inbound.strictRoute", "inbound.allowConnectionFromLan",
  "tlsTricks.enableFragment", "tlsTricks.mixedSniCase", "tlsTricks.enablePadding",
  "mux.enable", "mux.padding", "experimental.enableClashApi", "quality.enabled",
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
    ? out.quality.endpoints.filter((url) => typeof url === "string" && isHttpUrl(url)).slice(0, 4)
    : [];
  if (!out.quality.endpoints.length) out.quality.endpoints = [...DEFAULT_OPTIONS.quality.endpoints];
  if (!Array.isArray(out.route.customRules)) out.route.customRules = [];
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
  cachedOptions = deepFreeze(normalized);
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
  const opts = normalizeOptions(parsed);
  if (!localStorage.getItem(LOG_WARN_MIGRATED_KEY)) {
    localStorage.setItem(LOG_WARN_MIGRATED_KEY, "1");
    if (opts.log?.level === "info") {
      opts.log.level = "warn";
      const migratedRaw = JSON.stringify(opts);
      localStorage.setItem(OPTIONS_KEY, migratedRaw);
      commitCache(migratedRaw, opts);
      return cachedOptions;
    }
  }
  commitCache(raw, opts);
  return cachedOptions;
}

// Совместимый API: callers получают независимый mutable clone, поэтому старый
// паттерн `const o=loadOptions(); o.x=...; saveOptions(o)` остаётся безопасным.
export function loadOptions() {
  try {
    return cloneOptions(loadNormalizedSnapshot());
  } catch {
    invalidateOptionsCache();
    return structuredClone(DEFAULT_OPTIONS);
  }
}

// Read-only shared snapshot для горячих путей, которым не нужна локальная мутация.
export function getOptionsSnapshot() {
  try { return loadNormalizedSnapshot(); }
  catch {
    invalidateOptionsCache();
    return deepFreeze(normalizeOptions(DEFAULT_OPTIONS));
  }
}

export function saveOptions(opts) {
  const normalized = normalizeOptions(opts);
  const raw = JSON.stringify(normalized);
  localStorage.setItem(OPTIONS_KEY, raw);
  commitCache(raw, normalized);
  return cloneOptions(cachedOptions);
}

export function updateOption(path, value) {
  const opts = loadOptions();
  const keys = path.split(".");
  for (const key of keys) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError("Unsafe option path");
    }
  }
  let cur = opts;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
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
