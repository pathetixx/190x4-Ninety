// Ninety · BuildOptions — зеркало HiddifyOptions
// Все настройки пользователя в одном объекте, сохраняется в localStorage.

const OPTIONS_KEY = "ninety.options.v1";

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
    //   custom     — берёт значения из warp.customNoise (см. ниже)
    // Передаётся в endpoint.noise.fake_packet (см. hiddify/wireguard-go).
    noisePreset: "off",
    // Параметры custom-пресета (только если noisePreset === "custom")
    customNoise: {
      count: { from: 2, to: 5 },
      size:  { from: 20, to: 60 },
      delay: { from: 8, to: 20 },
    },
    // Расширенный пул подсетей в Endpoint Scanner.
    deepScan: false,
    // Periodic re-scan: следим за latency текущего WARP-endpoint через
    // clash-API, при росте выше порога — запускаем scan и применяем лучший.
    autoRescan: false,
    autoRescanIntervalMin: 30,    // как часто опрашивать (минуты)
    autoRescanThresholdMs: 300,   // если latency выше — пересканировать
  },
  log: { level: "info", disabled: false },
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
    // TUN + split-routing: Discord идёт мимо туннеля (direct), чтобы DPI-обход
    // (winws) десинхрил его на реальном интерфейсе — голос low-ping одновременно
    // с полным TUN. Opt-in: в полном TUN весь трафик в туннеле, обход не нужен.
    tunSplitDiscord: false,
  },
  inbound: {
    mixedPort: 7890,
    mtu: 9000,
    tunStack: "mixed",
    strictRoute: false,
    allowConnectionFromLan: false,
  },
  tlsTricks: {
    // hiddify-sing-box v1.13.0.h5 (upstream 1.12+): фрагментация и tls_tricks
    // переехали из experimental.tls_tricks в per-outbound tls{} и применяются
    // к прокси-outbound. fragmentMode: "record" (record_fragment, рекоменд.
    // upstream — производительнее, мягче к Reality) | "tcp" (fragment, TCP-
    // сегменты + fragment_fallback_delay). Поля взаимоисключающие.
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
    // Включён по умолчанию: используется для view Proxies (список нод + ping)
    // и для real-time RX/TX. Доступен только на 127.0.0.1.
    enableClashApi: true,
    clashApiPort: 9090,
  },
  // Движок качества связи — детект троттла/деградации (не только liveness) +
  // авто-лечение лесенкой. Проба тащит >16 КБ через туннель и меряет goodput:
  // latency этого не видит, т.к. ТСПУ режет отдачу ПОСЛЕ первых ~16 КБ.
  quality: {
    enabled: true,
    // aggressive=true: реконнект-ступени лесенки (R3+) применяются автоматом.
    // false (дефолт): перед реконнектом — мягкий промпт «оптимизировать?».
    aggressive: false,
    // lowDataMode: выключает фоновый idle-heartbeat (пробы только по подозрению
    // из пассивного трафика), экономит трафик на лимитных тарифах.
    lowDataMode: false,
    idleProbeSec: 300,        // как часто пробовать вхолостую (если не lowData)
    goodBps: 1_500_000,       // ≥ этого (бит/с, ~183 КиБ/с) = GOOD
    probeBytes: 262_144,      // выборка пробы (256 КиБ, > 16-КБ занавес)
    // Эндпоинт пробы (через туннель). Официальный speed-test CF — нашу инфру
    // НЕ светит (никаких своих доменов/IP в публичном клиенте). Если недоступен
    // с какого-то exit — проба = UNKNOWN, движок просто бездействует.
    endpoints: [
      "https://speed.cloudflare.com/__down?bytes=262144",
    ],
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
