// Ninety · sing-box 1.13.x config builder
// Архитектура — зеркало Hiddify HiddifyOptions → builder.go.
// vless парсер + хранилище профилей здесь же.

import { DEFAULT_OPTIONS } from "/lib/options.js";

// Transports которые mainline sing-box 1.13 НЕ поддерживает.
// xhttp — расширение xray, ждёт форка sing-box-hiddify.
const UNSUPPORTED_TRANSPORTS = new Set(["xhttp"]);

const PROFILES_KEY = "ninety.profiles.v1";
const ACTIVE_KEY = "ninety.profiles.active";
const ACTIVE_KIND_KEY = "ninety.active.kind";   // "single" | "sub"
const ACTIVE_SUB_KEY = "ninety.subscriptions.active";
const MODE_KEY = "ninety.mode";

const HIDDIFY_GEO_BASE = "https://raw.githubusercontent.com/hiddify/hiddify-geo/rule-set";
const BLOCK_AD_SETS = [
  ["geosite-ads", `${HIDDIFY_GEO_BASE}/block/geosite-category-ads-all.srs`],
  ["geosite-malware", `${HIDDIFY_GEO_BASE}/block/geosite-malware.srs`],
  ["geosite-phishing", `${HIDDIFY_GEO_BASE}/block/geosite-phishing.srs`],
  ["geosite-cryptominers", `${HIDDIFY_GEO_BASE}/block/geosite-cryptominers.srs`],
  ["geoip-malware", `${HIDDIFY_GEO_BASE}/block/geoip-malware.srs`],
  ["geoip-phishing", `${HIDDIFY_GEO_BASE}/block/geoip-phishing.srs`],
];

const IPV6_STRATEGY_MAP = {
  disable: "ipv4_only",
  enable: "prefer_ipv4",
  prefer: "prefer_ipv6",
  only: "ipv6_only",
};

// ── vless парсер ────────────────────────────────────────────
export function parseVless(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("vless://")) throw new Error("Не vless:// ссылка");
  const rest = url.slice("vless://".length);
  const hashIdx = rest.indexOf("#");
  const name = hashIdx >= 0 ? safeDecode(rest.slice(hashIdx + 1)) : "VLESS";
  const main = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const qIdx = main.indexOf("?");
  const head = qIdx >= 0 ? main.slice(0, qIdx) : main;
  const query = qIdx >= 0 ? main.slice(qIdx + 1) : "";

  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error("Нет @host:port");
  const uuid = head.slice(0, atIdx);
  const hostPort = head.slice(atIdx + 1);

  let host, port;
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) throw new Error("Битый IPv6");
    host = hostPort.slice(1, close);
    port = parseInt(hostPort.slice(close + 2), 10);
  } else {
    const colonIdx = hostPort.lastIndexOf(":");
    if (colonIdx < 0) throw new Error("Нет порта");
    host = hostPort.slice(0, colonIdx);
    port = parseInt(hostPort.slice(colonIdx + 1), 10);
  }
  if (!port || port < 1 || port > 65535) throw new Error("Некорректный порт");

  const params = new URLSearchParams(query);
  const get = (k, def = "") => params.get(k) ?? def;

  return {
    raw: url,
    name,
    uuid,
    host,
    port,
    security: get("security", "none"),
    encryption: get("encryption", "none"),
    type: get("type", "tcp"),
    flow: get("flow", ""),
    sni: get("sni") || host,
    fp: get("fp", "chrome"),
    pbk: get("pbk", ""),
    sid: get("sid", ""),
    alpn: get("alpn", ""),
    path: get("path", ""),
    host_header: get("host", ""),
    serviceName: get("serviceName", ""),
    mode: get("mode", ""),
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ── outbound из профиля + mux ───────────────────────────────
function buildOutbound(p, options) {
  const out = {
    type: "vless",
    tag: "proxy",
    server: p.host,
    server_port: p.port,
    uuid: p.uuid,
    packet_encoding: "xudp",
  };
  if (p.flow) out.flow = p.flow;

  if (p.security === "tls" || p.security === "reality") {
    out.tls = {
      enabled: true,
      server_name: p.sni,
      utls: { enabled: true, fingerprint: p.fp || "chrome" },
    };
    if (p.alpn) out.tls.alpn = p.alpn.split(",").map(s => s.trim()).filter(Boolean);
    if (p.security === "reality") {
      out.tls.reality = { enabled: true, public_key: p.pbk, short_id: p.sid };
    }
  }

  switch (p.type) {
    case "ws":
      out.transport = { type: "ws" };
      if (p.path) out.transport.path = p.path;
      if (p.host_header) out.transport.headers = { Host: p.host_header };
      break;
    case "grpc":
      out.transport = { type: "grpc" };
      if (p.serviceName) out.transport.service_name = p.serviceName;
      break;
    case "http":
    case "h2":
      out.transport = { type: "http" };
      if (p.path) out.transport.path = p.path;
      if (p.host_header) out.transport.host = p.host_header.split(",").map(s => s.trim());
      break;
    case "xhttp":
      out.transport = { type: "xhttp" };
      if (p.path) out.transport.path = p.path;
      if (p.host_header) out.transport.host = p.host_header;
      if (p.mode) out.transport.mode = p.mode;
      break;
    case "tcp":
    default:
      break;
  }

  if (options?.mux?.enable) {
    out.multiplex = {
      enabled: true,
      protocol: options.mux.protocol || "h2mux",
      max_streams: options.mux.maxStreams || 8,
      padding: !!options.mux.padding,
    };
  }

  return out;
}

// ── rule_sets для региона + block_ads ───────────────────────
function buildRuleSets(options) {
  const sets = [];
  const region = options.region;
  if (region && region !== "other") {
    sets.push({
      type: "remote", tag: `geoip-${region}`, format: "binary",
      url: `${HIDDIFY_GEO_BASE}/country/geoip-${region}.srs`,
      update_interval: "120h", download_detour: "proxy",
    });
    sets.push({
      type: "remote", tag: `geosite-${region}`, format: "binary",
      url: `${HIDDIFY_GEO_BASE}/country/geosite-${region}.srs`,
      update_interval: "120h", download_detour: "proxy",
    });
  }
  if (options.blockAds) {
    for (const [tag, url] of BLOCK_AD_SETS) {
      sets.push({
        type: "remote", tag, format: "binary",
        url, update_interval: "120h", download_detour: "proxy",
      });
    }
  }
  return sets;
}

// ── DNS server: парсер строки в новый формат sing-box 1.12+ ─
// Поддерживаемые входы:
//   https://host/path   → {type: "https", server, path?}
//   tls://host[:port]   → {type: "tls",   server, server_port?}
//   tcp://host[:port]   → {type: "tcp",   server, server_port?}
//   udp://host[:port]   → {type: "udp",   server, server_port?}
//   quic://host[:port]  → {type: "quic",  server, server_port?}
//   1.2.3.4 / host      → {type: "udp",   server} (дефолт)
//   local | system      → {type: "local"}
function parseDnsAddress(raw) {
  const s = String(raw || "").trim();
  if (!s || s === "local" || s === "system") return { type: "local" };
  const m = s.match(/^([a-z]+):\/\/(.+)$/i);
  if (!m) return { type: "udp", server: s };
  const scheme = m[1].toLowerCase();
  const rest = m[2];
  if (scheme === "https") {
    const u = (() => { try { return new URL(s); } catch { return null; } })();
    const o = { type: "https", server: u ? u.hostname : rest };
    if (u && u.port) o.server_port = parseInt(u.port, 10);
    if (u && u.pathname && u.pathname !== "/") o.path = u.pathname;
    return o;
  }
  if (["tls", "tcp", "udp", "quic"].includes(scheme)) {
    const o = { type: scheme };
    const idx = rest.lastIndexOf(":");
    if (idx > 0 && !rest.includes("/")) {
      o.server = rest.slice(0, idx);
      o.server_port = parseInt(rest.slice(idx + 1), 10);
    } else {
      o.server = rest;
    }
    return o;
  }
  return { type: "udp", server: s };
}

function buildDns(options) {
  const ipv6Strategy = IPV6_STRATEGY_MAP[options.route.ipv6Mode] || "prefer_ipv4";

  const remoteSrv = {
    tag: "dns-remote",
    ...parseDnsAddress(options.dns.remoteAddress),
    domain_resolver: "dns-direct",
    detour: "proxy",
  };

  // detour "direct" в sing-box 1.13 не задаём — direct outbound у нас пустой
  // (без bind_interface), а 1.13 на пустой direct outbound выдаёт
  // "detour to an empty direct outbound makes no sense" и падает на старте.
  const directSrv = {
    tag: "dns-direct",
    ...parseDnsAddress(options.dns.directAddress),
  };

  const dns = {
    servers: [remoteSrv, directSrv],
    rules: [],
    independent_cache: !!options.dns.independentCache,
    strategy: ipv6Strategy,
    final: "dns-remote",
  };

  if (options.region && options.region !== "other") {
    dns.rules.push({
      domain_suffix: [`.${options.region}`],
      server: "dns-direct",
      rewrite_ttl: 86400,
    });
    dns.rules.push({
      rule_set: [`geosite-${options.region}`],
      server: "dns-direct",
      rewrite_ttl: 86400,
    });
  }

  if (options.dns.enableFakeDns) {
    dns.servers.push({
      tag: "dns-fake",
      type: "fakeip",
      inet4_range: "198.18.0.0/15",
      inet6_range: "fc00::/18",
    });
    dns.rules.push({ query_type: ["A", "AAAA"], server: "dns-fake" });
  }

  return dns;
}

// ── route ──────────────────────────────────────────────────
function buildRoute(options) {
  const rules = [
    { action: "sniff" },
    { protocol: "dns", action: "hijack-dns" },
  ];

  if (options.route.bypassLan) {
    rules.push({ ip_is_private: true, outbound: "direct" });
  }

  if (options.region && options.region !== "other") {
    rules.push({ domain_suffix: [`.${options.region}`], outbound: "direct" });
    rules.push({
      rule_set: [`geosite-${options.region}`, `geoip-${options.region}`],
      outbound: "direct",
    });
  }

  if (options.blockAds) {
    rules.push({
      rule_set: ["geosite-ads", "geosite-malware", "geosite-phishing", "geosite-cryptominers", "geoip-malware", "geoip-phishing"],
      action: "reject",
    });
  }

  const route = {
    rules,
    rule_set: buildRuleSets(options),
    final: "proxy",
    auto_detect_interface: true,
    default_domain_resolver: {
      server: options.route.resolveDestination ? "dns-remote" : "dns-direct",
    },
  };

  return route;
}

// ── inbound (sing-box 1.13: sniff/tun.address — через route rules / inet4_address) ─
function buildInbound(mode, options) {
  if (mode === "tun") {
    return {
      type: "tun",
      tag: "tun-in",
      interface_name: "ninety-tun",
      address: ["172.19.0.1/30"],
      mtu: options.inbound.mtu || 9000,
      auto_route: true,
      strict_route: !!options.inbound.strictRoute,
      stack: options.inbound.tunStack || "mixed",
    };
  }
  return {
    type: "mixed",
    tag: "mixed-in",
    listen: options.inbound.allowConnectionFromLan ? "0.0.0.0" : "127.0.0.1",
    listen_port: options.inbound.mixedPort || 7890,
  };
}

// ── главный builder ────────────────────────────────────────
// Поддерживает оба вызова:
//   buildConfig({ profile, mode, options }) — одиночный vless (legacy)
//   buildConfig({ source, mode, options })  — { kind, profile|nodes }
// Если nodes.length >= 2 → собирает urltest group: outbound "auto" с
// дочерними vless'ами; route.final → auto.
export function buildConfig({ profile, source, mode, options }) {
  const opts = options || DEFAULT_OPTIONS;
  const src = source ?? (profile ? { kind: "single", profile } : null);
  if (!src) throw new Error("buildConfig: нет источника");

  const allNodes = src.kind === "sub" ? src.nodes : [src.profile];
  if (!allNodes?.length) throw new Error("buildConfig: пустой список нод");

  // Mainline sing-box 1.13 не знает xhttp transport (это xray-форка фича).
  // Фильтруем такие ноды; считаем сколько отбросили — UI покажет в toast.
  const nodes = allNodes.filter(n => !UNSUPPORTED_TRANSPORTS.has((n.type || "tcp").toLowerCase()));
  if (!nodes.length) {
    throw new Error(`Все ${allNodes.length} нод используют xhttp transport — нужен форк sing-box. Выберите другую ноду или подписку.`);
  }

  const route = buildRoute(opts);
  const useUrltest = nodes.length >= 2;
  const vlessOutbounds = nodes.map((n, i) => {
    const ob = buildOutbound(n, opts);
    ob.tag = useUrltest ? nodeTag(i, n) : "proxy";
    return ob;
  });

  let outbounds;
  if (useUrltest) {
    // Hiddify-схема: внешний Selector "proxy" + внутренний URLTest "auto".
    // Selector принимает PUT /proxies/proxy (ручной выбор юзера), URLTest сам выбирает min-delay.
    // Юзер ткнул ноду → Selector.now = node-tag. Юзер ткнул "Auto" → Selector.now = "auto".
    const utCfg = opts.urlTest || {};
    const auto = {
      type: "urltest",
      tag: "auto",
      outbounds: vlessOutbounds.map(o => o.tag),
      url: utCfg.url || "https://www.gstatic.com/generate_204",
      interval: utCfg.interval || "3m",
      tolerance: utCfg.tolerance || 50,
    };
    const selector = {
      type: "selector",
      tag: "proxy",
      outbounds: ["auto", ...vlessOutbounds.map(o => o.tag)],
      default: "auto",
      interrupt_exist_connections: false,
    };
    outbounds = [
      selector,
      auto,
      ...vlessOutbounds,
      { type: "direct", tag: "direct" },
    ];
  } else {
    outbounds = [
      vlessOutbounds[0],
      { type: "direct", tag: "direct" },
    ];
  }

  const config = {
    log: { level: opts.log.level || "warn", timestamp: true },
    dns: buildDns(opts),
    inbounds: [buildInbound(mode, opts)],
    outbounds,
    route,
    experimental: {
      cache_file: { enabled: true, store_rdrc: true },
    },
  };

  if (opts.experimental?.enableClashApi) {
    config.experimental.clash_api = {
      external_controller: `127.0.0.1:${opts.experimental.clashApiPort || 9090}`,
    };
  }

  return config;
}

function sanitizeTag(s) {
  return String(s || "").replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 24);
}

// Единая логика тэга outbound'а для multi-node подписки.
// Должна совпадать между builder'ом и proxies-view, иначе селектор будет бить мимо.
export function nodeTag(i, node) {
  return `node-${i}-${sanitizeTag(node.name) || node.host}`;
}

// ── профили (storage) ──────────────────────────────────────
export function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveProfiles(list) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(list));
}

export function getActiveProfileId() {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveProfileId(id) {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

export function getActiveProfile() {
  const id = getActiveProfileId();
  if (!id) return null;
  return loadProfiles().find(p => p.id === id) || null;
}

export function addProfileFromVless(raw) {
  const parsed = parseVless(raw);
  const id = "p_" + Math.random().toString(36).slice(2, 10);
  const list = loadProfiles();
  list.push({ ...parsed, id });
  saveProfiles(list);
  if (!getActiveProfileId() && getActiveKind() !== "sub") {
    setActiveProfileId(id);
    setActiveKind("single");
  }
  return { id, profile: parsed };
}

// ── unified active source (profile | subscription) ─────────
export function getActiveKind() {
  return localStorage.getItem(ACTIVE_KIND_KEY) || "single";
}

export function setActiveKind(kind) {
  localStorage.setItem(ACTIVE_KIND_KEY, kind === "sub" ? "sub" : "single");
}

function loadSubsRaw() {
  try { return JSON.parse(localStorage.getItem("ninety.subscriptions.v1")) || []; }
  catch { return []; }
}

/**
 * Возвращает текущий активный источник для коннекта.
 * { kind: "single", profile } — одиночный vless
 * { kind: "sub", subscription, nodes } — подписка (>=1 нод)
 * null — ничего не активно
 */
export function getActiveSource() {
  const kind = getActiveKind();
  if (kind === "sub") {
    const subId = localStorage.getItem(ACTIVE_SUB_KEY);
    if (!subId) return null;
    const sub = loadSubsRaw().find(s => s.id === subId);
    if (!sub || !sub.profiles?.length) return null;
    return { kind: "sub", subscription: sub, nodes: sub.profiles };
  }
  const p = getActiveProfile();
  return p ? { kind: "single", profile: p } : null;
}

export function removeProfile(id) {
  const list = loadProfiles().filter(p => p.id !== id);
  saveProfiles(list);
  if (getActiveProfileId() === id) {
    setActiveProfileId(list[0]?.id ?? null);
  }
}

export function getMode() {
  const m = localStorage.getItem(MODE_KEY);
  return m === "tun" ? "tun" : "proxy";
}

export function setMode(m) {
  localStorage.setItem(MODE_KEY, m === "tun" ? "tun" : "proxy");
}
