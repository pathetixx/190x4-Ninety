// Ninety · BuildOptions — зеркало HiddifyOptions
// Все настройки пользователя в одном объекте, сохраняется в localStorage.

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
    // Защищённые сети (дом/офис) не трогаются. Доверенные открытые сети — в
    // localStorage ninety.wifi.trusted.
    autoProtectWifi: false,
    // I.2 (ЭКСПЕРИМЕНТАЛЬНО): WFP kill switch. В режимах proxy/systemProxy блокирует
    // весь исходящий, кроме loopback и sing-box.exe → при падении ядра трафик не
    // утекает мимо туннеля. В TUN утечки держит strict_route, kill switch не нужен.
    killSwitch: false,
    // Приватность: не обращаться к внешним geo/ASN-сервисам. localAsn (обучение
    // движка качества ISP×час) ходит НАПРЯМУЮ, мимо туннеля — раскрывает реальный
    // IP третьим сторонам. true → localAsn=unknown, IP-плитка на главной гаснет.
    disableGeoLookup: false,
    // Приватность подписок: если обновление через локальный туннель не удалось,
    // не повторять запрос напрямую. Иначе можно раскрыть реальный IP и URL панели.
    allowDirectSubscriptionFallback: false,
  },
  privacy: {
    // Высокоуровневая runtime-политика: не перезаписывает ручные настройки
    // маршрутизации, а на время соединения форсирует TUN без direct-исключений,
    // WARP, авто-ротации и обходных DNS-маршрутов.
    strictTunnel: false,
    // После первого успешного подключения в пользовательской сессии открыть
    // бесплатный Mullvad Browser. Повторные авто-реконнекты новых окон не плодят.
    protectedBrowserAutoLaunch: false,
  },
  warp: {
    // Включает выбор WARP в селекторе outbound (UI). Сама регистрация делается
    // отдельной кнопкой, ключи лежат в writable config dir/warp.json (Rust-сторона).
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
  // Дефолт warn, не info: на info sing-box пишет в singbox.log домен каждого
  // соединения — история браузинга на диске между сессиями (конфиги с кредами
  // при этом целенаправленно стираются после сессии, см. purge_* в vpn.rs).
  // info — осознанный выбор в настройках на время отладки.
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
    // TUN + split-routing: Discord идёт мимо туннеля (direct), чтобы DPI-обход
    // (winws) десинхрил его на реальном интерфейсе — голос low-ping одновременно
    // с полным TUN. Opt-in: в полном TUN весь трафик в туннеле, обход не нужен.
    tunSplitDiscord: false,
    // Форс process-lookup: sing-box резолвит сокет→PID→exe у КАЖДОГО соединения,
    // чтобы монитор соединений показывал имя приложения (см. buildRoute). Цена —
    // один lookup на коннект всю сессию. false по умолчанию убирает этот налог;
    // пользователь включает lookup, когда действительно нужен монитор с
    // именами процессов. Сохранённое true у существующих профилей не меняем.
    processLookup: false,
    // Пользовательские правила маршрутизации (гибкие, как в Throne). Каждое:
    //   { id, enabled, type:"domain"|"ip"|"process", match:"suffix"|"exact"|"keyword",
    //     values:[…], action:"proxy"|"direct"|"block" }
    // Применяются в buildRoute ПОСЛЕ служебных правил и ВЫШЕ региона/рекламы
    // (кастом приоритетнее региональной базы — точечная настройка поверх).
    // deepMerge берёт массив целиком → миграция у существующих юзеров без потерь.
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

// Массивы НЕ мёржатся: сохранённый массив целиком побеждает дефолтный.
// Изменение массива в DEFAULT_OPTIONS (напр. quality.endpoints) не доедет до
// существующих установок — нужна разовая миграция по образцу LOG_WARN_MIGRATED_KEY.
function deepMerge(target, source) {
  if (typeof source !== "object" || source === null) return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const k of Object.keys(source)) {
    // localStorage может быть изменён извне/в devtools. Не позволяем ключам
    // JSON менять prototype объектов, которые затем уходят в config builder.
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

export function loadOptions() {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) {
      // Свежий профиль: мигрировать нечего, но флаг ставим сразу — если юзер
      // потом осознанно выберет info, миграция ниже его уже не перетрёт.
      localStorage.setItem(LOG_WARN_MIGRATED_KEY, "1");
      return structuredClone(DEFAULT_OPTIONS);
    }
    const parsed = JSON.parse(raw);
    const opts = normalizeOptions(parsed);
    // Разовая миграция: прежний дефолт log.level="info" писал домены всех
    // соединений в singbox.log. Сохранённый info — почти наверняка старый
    // дефолт (saveOptions хранит объект целиком), а не выбор юзера → один раз
    // переводим на warn; вернуть можно в настройках, повторно не трогаем.
    if (!localStorage.getItem(LOG_WARN_MIGRATED_KEY)) {
      localStorage.setItem(LOG_WARN_MIGRATED_KEY, "1");
      if (opts.log?.level === "info") {
        opts.log.level = "warn";
        saveOptions(opts);
      }
    }
    return opts;
  } catch {
    return structuredClone(DEFAULT_OPTIONS);
  }
}

export function saveOptions(opts) {
  const normalized = normalizeOptions(opts);
  localStorage.setItem(OPTIONS_KEY, JSON.stringify(normalized));
  return normalized;
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
  const normalized = saveOptions(opts);
  // Одна опция может быть представлена несколькими контролами в разных местах
  // UI (warp.enabled: поповер «Режим» + Настройки → WARP). Контролы не
  // перерисовываются при чужой записи — подписка на это событие обязана
  // обновлять DOM всех дублей. Только DOM: запись опций из слушателя = цикл.
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
