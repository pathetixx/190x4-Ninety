// Ninety · BuildOptions — зеркало HiddifyOptions
// Все настройки пользователя в одном объекте, сохраняется в localStorage.

const OPTIONS_KEY = "ninety.options.v1";

export const REGIONS = ["other", "ru", "cn", "ir", "tr", "by"];
export const IPV6_MODES = ["disable", "enable", "prefer", "only"];
export const TUN_STACKS = ["mixed", "gvisor", "system"];
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"];
export const MUX_PROTOCOLS = ["h2mux", "smux", "yamux"];
export const BALANCER_STRATEGIES = ["round-robin", "consistent-hashing", "sticky-sessions"];

export const URL_HANDLER_SCHEMES = ["vless", "vmess", "ss", "trojan", "hysteria2", "hy2", "tuic", "sub"];

export const DEFAULT_OPTIONS = {
  region: "ru",
  blockAds: false,
  general: {
    autostart: false,
    startMinimized: false,
    // Какие схемы зарегистрированы как handler Ninety в HKCU. Используется UI'ем
    // для отображения чек-боксов; реальный source-of-truth — реестр Windows,
    // синхронизируется через is_url_handler_registered на старте.
    urlSchemes: [],
  },
  warp: {
    // Включает выбор WARP в селекторе outbound (UI). Сама регистрация делается
    // отдельной кнопкой, ключи лежат в app_config_dir/warp.json (Rust-сторона).
    enabled: false,
    // "direct" — WARP как единственный outbound (без прокси)
    // "chain"  — WARP как detour поверх активной ноды (proxy → WARP → internet)
    mode: "direct",
    // Endpoint policy: "auto4" / "auto6" / "auto" / конкретный IP:port.
    // CF возвращает peer.endpoint, мы по умолчанию используем engage.cloudflareclient.com.
    endpoint: "engage.cloudflareclient.com:2408",
    mtu: 1280,
    // AmneziaWG fake-packet обфускация. Пресеты:
    //   off        — никаких junk-пакетов, обычный WG
    //   default    — лёгкая обфускация (1-3 пакета, 10-30 байт, 10-30мс задержка)
    //   aggressive — больше шума (3-8 пакетов, 30-90 байт, 5-15мс задержка)
    // Передаётся в endpoint.noise.fake_packet (см. hiddify/wireguard-go).
    noisePreset: "off",
  },
  log: { level: "info", timestamp: true, disabled: false },
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
    balancerStrategy: "round-robin",
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
    fragmentSize: { from: 10, to: 30 },
    fragmentSleep: { from: 2, to: 8 },
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
    // Включён по умолчанию: используется для view Proxies (список нод + ping)
    // и для real-time RX/TX. Доступен только на 127.0.0.1.
    enableClashApi: true,
    clashApiPort: 9090,
  },
};

function deepMerge(target, source) {
  if (typeof source !== "object" || source === null) return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const k of Object.keys(source)) {
    if (source[k] && typeof source[k] === "object" && !Array.isArray(source[k]) && typeof target[k] === "object") {
      out[k] = deepMerge(target[k], source[k]);
    } else {
      out[k] = source[k];
    }
  }
  return out;
}

export function loadOptions() {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) return structuredClone(DEFAULT_OPTIONS);
    const parsed = JSON.parse(raw);
    return deepMerge(DEFAULT_OPTIONS, parsed);
  } catch {
    return structuredClone(DEFAULT_OPTIONS);
  }
}

export function saveOptions(opts) {
  localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
}

export function updateOption(path, value) {
  const opts = loadOptions();
  const keys = path.split(".");
  let cur = opts;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  saveOptions(opts);
  return opts;
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
