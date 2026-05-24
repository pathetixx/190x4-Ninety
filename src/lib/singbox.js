// Ninety · sing-box 1.13.x config builder
// Архитектура — зеркало Hiddify HiddifyOptions → builder.go.
// vless парсер + хранилище профилей здесь же.

import { DEFAULT_OPTIONS } from "/lib/options.js";

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

function safeAtob(s) {
  try {
    const cleaned = String(s).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!cleaned) return "";
    const padded = cleaned + "=".repeat((4 - cleaned.length % 4) % 4);
    return atob(padded);
  } catch { return ""; }
}

function splitHostPort(hostPort) {
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) throw new Error("Битый IPv6");
    return {
      host: hostPort.slice(1, close),
      port: parseInt(hostPort.slice(close + 2), 10),
    };
  }
  const colonIdx = hostPort.lastIndexOf(":");
  if (colonIdx < 0) throw new Error("Нет порта");
  return {
    host: hostPort.slice(0, colonIdx),
    port: parseInt(hostPort.slice(colonIdx + 1), 10),
  };
}

function splitTrailingHashName(url, fallback) {
  const hashIdx = url.indexOf("#");
  const name = hashIdx >= 0 ? safeDecode(url.slice(hashIdx + 1)) : fallback;
  const main = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  return { name, main };
}

function splitQuery(main) {
  const qIdx = main.indexOf("?");
  const head = qIdx >= 0 ? main.slice(0, qIdx) : main;
  const query = qIdx >= 0 ? main.slice(qIdx + 1) : "";
  return { head, query: new URLSearchParams(query) };
}

// ── vmess парсер (base64 JSON) ──────────────────────────────
export function parseVmess(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("vmess://")) throw new Error("Не vmess:// ссылка");
  const payload = url.slice("vmess://".length);
  const { name: hashName, main } = splitTrailingHashName(payload, null);
  const decoded = safeAtob(main);
  if (!decoded) throw new Error("vmess: не декодируется base64");
  let j;
  try { j = JSON.parse(decoded); } catch { throw new Error("vmess: не JSON"); }
  const port = parseInt(j.port, 10);
  if (!port) throw new Error("vmess: нет порта");
  return {
    raw: url,
    proto: "vmess",
    name: hashName || j.ps || j.remarks || "VMESS",
    host: j.add,
    port,
    uuid: j.id,
    alterId: parseInt(j.aid || j.alterId || "0", 10),
    security: j.scy || j.security || "auto",
    tlsMode: (j.tls || "") === "tls" || j.tls === "reality" ? j.tls : "none",
    sni: j.sni || j.host || j.add,
    fp: j.fp || "chrome",
    alpn: j.alpn || "",
    type: j.net || "tcp",
    path: j.path || "",
    host_header: j.host || "",
    serviceName: j.path || "",
    mode: j.type || "",
  };
}

// ── trojan парсер ───────────────────────────────────────────
export function parseTrojan(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("trojan://")) throw new Error("Не trojan:// ссылка");
  const rest = url.slice("trojan://".length);
  const { name, main } = splitTrailingHashName(rest, "TROJAN");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error("trojan: нет @host:port");
  const password = decodeURIComponent(head.slice(0, atIdx));
  const { host, port } = splitHostPort(head.slice(atIdx + 1));
  const get = (k, def = "") => query.get(k) ?? def;
  return {
    raw: url,
    proto: "trojan",
    name,
    host, port,
    password,
    security: get("security", "tls"),
    type: get("type", "tcp"),
    sni: get("sni") || host,
    fp: get("fp", "chrome"),
    alpn: get("alpn", ""),
    path: get("path", ""),
    host_header: get("host", ""),
    serviceName: get("serviceName", ""),
    mode: get("mode", ""),
  };
}

// ── shadowsocks (SIP002) ────────────────────────────────────
export function parseShadowsocks(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("ss://")) throw new Error("Не ss:// ссылка");
  const rest = url.slice("ss://".length);
  const { name, main } = splitTrailingHashName(rest, "SS");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) {
    // Legacy form: base64(method:password@host:port)
    const decoded = safeAtob(head);
    if (!decoded) throw new Error("ss: не декодируется legacy base64");
    const at2 = decoded.lastIndexOf("@");
    if (at2 < 0) throw new Error("ss: legacy без @host:port");
    const credsRaw = decoded.slice(0, at2);
    const [method, password] = credsRaw.split(":", 2);
    const { host, port } = splitHostPort(decoded.slice(at2 + 1));
    return { raw: url, proto: "shadowsocks", name, host, port, method, password };
  }
  const credsRaw = head.slice(0, atIdx);
  // SIP002: userinfo может быть как раз base64url(method:password)
  let method, password;
  if (credsRaw.includes(":")) {
    [method, password] = credsRaw.split(":", 2);
    password = decodeURIComponent(password);
  } else {
    const decoded = safeAtob(credsRaw);
    const sep = decoded.indexOf(":");
    if (sep < 0) throw new Error("ss: bad userinfo");
    method = decoded.slice(0, sep);
    password = decoded.slice(sep + 1);
  }
  const { host, port } = splitHostPort(head.slice(atIdx + 1));
  const plugin = query.get("plugin") || "";
  let pluginName = "", pluginOpts = "";
  if (plugin) {
    const semi = plugin.indexOf(";");
    pluginName = semi >= 0 ? plugin.slice(0, semi) : plugin;
    pluginOpts = semi >= 0 ? plugin.slice(semi + 1) : "";
  }
  return {
    raw: url, proto: "shadowsocks", name, host, port,
    method, password,
    plugin: pluginName, plugin_opts: pluginOpts,
  };
}

// ── hysteria2 ───────────────────────────────────────────────
export function parseHysteria2(raw) {
  const url = String(raw || "").trim();
  const scheme = url.startsWith("hysteria2://") ? "hysteria2://" : (url.startsWith("hy2://") ? "hy2://" : null);
  if (!scheme) throw new Error("Не hysteria2:// ссылка");
  const rest = url.slice(scheme.length);
  const { name, main } = splitTrailingHashName(rest, "HYSTERIA2");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error("hysteria2: нет @host:port");
  const password = decodeURIComponent(head.slice(0, atIdx));
  const { host, port } = splitHostPort(head.slice(atIdx + 1));
  const get = (k, def = "") => query.get(k) ?? def;
  return {
    raw: url, proto: "hysteria2", name,
    host, port, password,
    sni: get("sni") || host,
    obfs: get("obfs", ""),
    obfsPassword: get("obfs-password") || get("obfsPassword", ""),
    alpn: get("alpn", "h3"),
    insecure: get("insecure", "0") === "1",
    pinSHA256: get("pinSHA256", ""),
    upMbps: parseInt(get("up") || "0", 10) || undefined,
    downMbps: parseInt(get("down") || "0", 10) || undefined,
  };
}

// ── tuic v5 ────────────────────────────────────────────────
export function parseTuic(raw) {
  const url = String(raw || "").trim();
  if (!url.startsWith("tuic://")) throw new Error("Не tuic:// ссылка");
  const rest = url.slice("tuic://".length);
  const { name, main } = splitTrailingHashName(rest, "TUIC");
  const { head, query } = splitQuery(main);
  const atIdx = head.lastIndexOf("@");
  if (atIdx < 0) throw new Error("tuic: нет @host:port");
  const auth = head.slice(0, atIdx);
  const [uuid, passwordRaw] = auth.split(":", 2);
  const password = decodeURIComponent(passwordRaw || "");
  const { host, port } = splitHostPort(head.slice(atIdx + 1));
  const get = (k, def = "") => query.get(k) ?? def;
  return {
    raw: url, proto: "tuic", name,
    host, port, uuid, password,
    sni: get("sni") || host,
    alpn: get("alpn", "h3"),
    congestionControl: get("congestion_control") || get("congestionControl", "bbr"),
    udpRelayMode: get("udp_relay_mode") || get("udpRelayMode", "native"),
    zeroRttHandshake: get("zero_rtt_handshake", "false") === "true",
    disableSni: get("disable_sni", "false") === "true",
  };
}

// ── главный dispatcher ─────────────────────────────────────
// Возвращает профиль с .proto полем. Назад-совместимо со старыми vless-only
// профилями (у тех .proto не было; считаем "vless").
export function parseLink(raw) {
  const s = String(raw || "").trim();
  if (s.startsWith("vless://"))     return { ...parseVless(s), proto: "vless" };
  if (s.startsWith("vmess://"))     return parseVmess(s);
  if (s.startsWith("trojan://"))    return parseTrojan(s);
  if (s.startsWith("ss://"))        return parseShadowsocks(s);
  if (s.startsWith("hysteria2://") || s.startsWith("hy2://")) return parseHysteria2(s);
  if (s.startsWith("tuic://"))      return parseTuic(s);
  throw new Error(`Неподдерживаемый протокол: ${s.split("://")[0] || s.slice(0, 16)}://`);
}

export function profileProto(p) {
  return p?.proto || "vless";
}

// ── общие части (TLS, transport) ───────────────────────────
function buildTls(p) {
  // Для vless reality/tls; vmess/trojan/tuic — обычный TLS
  const tlsMode = p.tlsMode || p.security; // vmess использует tlsMode, остальные security
  if (tlsMode !== "tls" && tlsMode !== "reality") return null;
  const tls = {
    enabled: true,
    server_name: p.sni,
    utls: { enabled: true, fingerprint: p.fp || "chrome" },
  };
  if (p.alpn) tls.alpn = String(p.alpn).split(",").map(s => s.trim()).filter(Boolean);
  if (tlsMode === "reality") {
    tls.reality = { enabled: true, public_key: p.pbk, short_id: p.sid };
  }
  return tls;
}

function buildTransport(p) {
  switch (p.type) {
    case "ws": {
      const t = { type: "ws" };
      if (p.path) t.path = p.path;
      if (p.host_header) t.headers = { Host: p.host_header };
      return t;
    }
    case "grpc": {
      const t = { type: "grpc" };
      if (p.serviceName) t.service_name = p.serviceName;
      return t;
    }
    case "http":
    case "h2": {
      const t = { type: "http" };
      if (p.path) t.path = p.path;
      if (p.host_header) t.host = p.host_header.split(",").map(s => s.trim());
      return t;
    }
    case "xhttp": {
      const t = { type: "xhttp" };
      if (p.path) t.path = p.path;
      if (p.host_header) t.host = p.host_header;
      if (p.mode) t.mode = p.mode;
      return t;
    }
    default:
      return null;
  }
}

function applyMux(out, options) {
  if (!options?.mux?.enable) return;
  out.multiplex = {
    enabled: true,
    protocol: options.mux.protocol || "h2mux",
    max_streams: options.mux.maxStreams || 8,
    padding: !!options.mux.padding,
  };
}

// ── outbound dispatcher по протоколу ───────────────────────
function buildOutbound(p, options) {
  const proto = profileProto(p);
  const base = { tag: "proxy", server: p.host, server_port: p.port };
  let out;
  switch (proto) {
    case "vmess": {
      out = {
        ...base,
        type: "vmess",
        uuid: p.uuid,
        security: p.security || "auto",
        alter_id: p.alterId || 0,
        packet_encoding: "xudp",
      };
      break;
    }
    case "trojan": {
      out = { ...base, type: "trojan", password: p.password };
      break;
    }
    case "shadowsocks": {
      out = { ...base, type: "shadowsocks", method: p.method, password: p.password };
      if (p.plugin) {
        out.plugin = p.plugin;
        if (p.plugin_opts) out.plugin_opts = p.plugin_opts;
      }
      break;
    }
    case "hysteria2": {
      out = {
        ...base,
        type: "hysteria2",
        password: p.password,
      };
      if (p.upMbps) out.up_mbps = p.upMbps;
      if (p.downMbps) out.down_mbps = p.downMbps;
      if (p.obfs) {
        out.obfs = { type: p.obfs };
        if (p.obfsPassword) out.obfs.password = p.obfsPassword;
      }
      // hysteria2 всегда поверх QUIC/TLS — TLS обязателен
      out.tls = {
        enabled: true,
        server_name: p.sni || p.host,
        insecure: !!p.insecure,
        alpn: (p.alpn || "h3").split(",").map(s => s.trim()).filter(Boolean),
      };
      if (p.pinSHA256) out.tls.certificate_public_key_sha256 = p.pinSHA256;
      return out;
    }
    case "tuic": {
      out = {
        ...base,
        type: "tuic",
        uuid: p.uuid,
        password: p.password,
        congestion_control: p.congestionControl || "bbr",
        udp_relay_mode: p.udpRelayMode || "native",
        zero_rtt_handshake: !!p.zeroRttHandshake,
      };
      out.tls = {
        enabled: true,
        server_name: p.sni || p.host,
        insecure: !!p.insecure,
        disable_sni: !!p.disableSni,
        alpn: (p.alpn || "h3").split(",").map(s => s.trim()).filter(Boolean),
      };
      return out;
    }
    case "vless":
    default: {
      out = {
        ...base,
        type: "vless",
        uuid: p.uuid,
        packet_encoding: "xudp",
      };
      if (p.flow) out.flow = p.flow;
      break;
    }
  }

  const tls = buildTls(p);
  if (tls) out.tls = tls;
  const transport = buildTransport(p);
  if (transport) out.transport = transport;
  applyMux(out, options);
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
function buildRoute(options, mode) {
  const rules = [
    { action: "sniff" },
    { protocol: "dns", action: "hijack-dns" },
  ];

  // ProcessName bypass — критично для TUN-режима. Без него собственный трафик
  // Ninety (Tauri webview HTTP-запросы к ipwho.is и т.п.), tunnel-сервиса и
  // самого sing-box петлял бы обратно в TUN-интерфейс. Аналог Hiddify
  // tunnel_service.go:80-95 — bypass Hiddify.exe/HiddifyCli.exe.
  // В proxy-режиме process_name не применим (трафик идёт через mixed inbound,
  // sing-box не знает о клиентских процессах) — правило безвредно, но добавляем
  // только в TUN чтобы не плодить лишнее.
  if (mode === "tun") {
    rules.push({
      process_name: ["Ninety.exe", "ninety-tunnel-svc.exe", "sing-box.exe"],
      outbound: "direct",
    });
  }

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

// ── WARP endpoint (Cloudflare WireGuard) ───────────────────
// Принимает WarpInfo из Tauri-команды warp_status (см. src-tauri/src/warp.rs)
// и собирает sing-box endpoint type=wireguard. Возвращает [endpoint, finalTag]
// или null если WARP не сконфигурирован.
//
//   mode "direct": WARP — единственный outbound, route.final = "warp",
//                  proxy selector в outbounds для UI/clash-API остаётся.
//   mode "chain":  WARP поверх proxy (endpoint.detour = "proxy"), route.final = "warp".
function buildWarpEndpoint(warpOpts, warpInfo) {
  if (!warpOpts?.enabled || !warpInfo?.private_key || !warpInfo?.peer_public_key) {
    return null;
  }
  const endpointStr = warpOpts.endpoint || "engage.cloudflareclient.com:2408";
  // hostPort: либо host:port, либо auto4/auto6/auto → host = строка, port = 2408
  let host = endpointStr, port = 2408;
  if (/^auto[46]?$/.test(endpointStr)) {
    host = endpointStr;
  } else {
    try {
      const { host: h, port: p } = splitHostPort(endpointStr);
      host = h;
      if (p) port = p;
    } catch {
      // fallback: оставляем endpointStr как host
    }
  }

  // client_id base64 → 3 байта reserved (CF проверяет первые 3)
  const clientIdRaw = safeAtob(warpInfo.client_id || "");
  const reserved = [];
  for (let i = 0; i < 3; i++) reserved.push(clientIdRaw.charCodeAt(i) || 0);

  const address = [];
  if (warpInfo.local_ipv4) address.push(`${warpInfo.local_ipv4}/32`);
  if (warpInfo.local_ipv6) address.push(`${warpInfo.local_ipv6}/128`);
  if (!address.length) return null;

  const endpoint = {
    type: "wireguard",
    tag: "warp",
    address,
    private_key: warpInfo.private_key,
    mtu: warpOpts.mtu || 1280,
    peers: [
      {
        address: host,
        port,
        public_key: warpInfo.peer_public_key,
        allowed_ips: ["0.0.0.0/0", "::/0"],
        reserved,
      },
    ],
  };
  if (warpOpts.mode === "chain") {
    // detour: WG-пакеты WARP отправляются через активный selector "proxy"
    endpoint.detour = "proxy";
  }
  return endpoint;
}

// ── главный builder ────────────────────────────────────────
// Поддерживает оба вызова:
//   buildConfig({ profile, mode, options }) — одиночный vless (legacy)
//   buildConfig({ source, mode, options })  — { kind, profile|nodes }
// Если nodes.length >= 2 → собирает urltest group: outbound "auto" с
// дочерними vless'ами; route.final → auto.
//
// warpInfo: опциональный объект WarpInfo от warp_status команды.
//   Если options.warp.enabled === true и warpInfo передан с валидными ключами —
//   добавляется WireGuard endpoint и route.final переключается на "warp".
export function buildConfig({ profile, source, mode, options, warpInfo }) {
  const opts = options || DEFAULT_OPTIONS;
  const src = source ?? (profile ? { kind: "single", profile } : null);
  if (!src) throw new Error("buildConfig: нет источника");

  const nodes = src.kind === "sub" ? src.nodes : [src.profile];
  if (!nodes?.length) throw new Error("buildConfig: пустой список нод");

  const route = buildRoute(opts, mode);
  const useUrltest = nodes.length >= 2;
  const vlessOutbounds = nodes.map((n, i) => {
    const ob = buildOutbound(n, opts);
    ob.tag = useUrltest ? nodeTag(i, n) : "proxy";
    return ob;
  });

  let outbounds;
  if (useUrltest) {
    // Hiddify-схема (builder.go:269-301): "Auto" — это НЕ URLTest, а Balancer
    // со strategy=lowest-delay. Balancer на каждом новом connection выбирает
    // outbound с минимальным delay из monitoring + interrupt_exist_connections
    // обрывает старые соединения когда лидер меняется → реальное "live"
    // переключение. URLTest рядом нужен ТОЛЬКО для health-чека: он сам тестит
    // каждые N минут и наполняет monitoring, который читает Balancer.
    // Без URLTest balancer не знает delay'ев и фолбэчится к первой ноде.
    const utCfg = opts.urlTest || {};
    const nodeTags = vlessOutbounds.map(o => o.tag);

    // Health-checker (скрыт из proxies UI, юзер про него не знает).
    const urlTest = {
      type: "urltest",
      tag: "lowest",
      outbounds: nodeTags,
      url: utCfg.url || "https://www.gstatic.com/generate_204",
      interval: utCfg.interval || "3m",
      tolerance: utCfg.tolerance || 50,
      // false — URLTest сам не должен обрывать TCP. Прерывание — задача
      // Balancer, иначе sing-box будет дважды дёргать interrupt при rotation.
      interrupt_exist_connections: false,
    };
    // "Авто" в UI — Balancer, lowest-delay per-connection.
    const auto = {
      type: "balancer",
      tag: "auto",
      outbounds: nodeTags,
      strategy: "lowest-delay",
      delay_acceptable_ratio: 2,
      interrupt_exist_connections: true,
    };
    const selector = {
      type: "selector",
      tag: "proxy",
      outbounds: ["auto", "lowest", ...nodeTags],
      default: "auto",
      // Главный фикс hot-switch: с false старые соединения держатся
      // на прошлом outbound — браузер качает страницу через старый сервер
      // даже после переключения. Hiddify ставит true для всех селекторов.
      interrupt_exist_connections: true,
    };
    outbounds = [
      selector,
      auto,
      urlTest,
      ...vlessOutbounds,
      { type: "direct", tag: "direct" },
    ];
  } else {
    outbounds = [
      vlessOutbounds[0],
      { type: "direct", tag: "direct" },
    ];
  }

  // WARP endpoint (опционально): подмешиваем wireguard endpoint и
  // переключаем route.final на "warp".
  const warpEndpoint = buildWarpEndpoint(opts.warp, warpInfo);
  if (warpEndpoint) {
    route.final = "warp";
  }

  const config = {
    log: {
      level: opts.log?.level || "info",
      timestamp: opts.log?.timestamp !== false,
      ...(opts.log?.disabled ? { disabled: true } : {}),
    },
    dns: buildDns(opts),
    inbounds: [buildInbound(mode, opts)],
    outbounds,
    route,
    experimental: {
      cache_file: { enabled: true, store_rdrc: true },
    },
  };
  if (warpEndpoint) {
    config.endpoints = [warpEndpoint];
  }

  if (opts.experimental?.enableClashApi) {
    config.experimental.clash_api = {
      external_controller: `127.0.0.1:${opts.experimental.clashApiPort || 9090}`,
    };
  }

  // TLS-tricks форка hiddify-sing-box: глобально в experimental.tls_tricks.
  // Применяется ко всем TLS-handshake outbound'ов на стороне ядра.
  const t = opts.tlsTricks || {};
  const tricks = {};
  if (t.enableFragment) {
    const fs = t.fragmentSize || { from: 10, to: 30 };
    const fsl = t.fragmentSleep || { from: 2, to: 8 };
    tricks.fragment_size = `${fs.from}-${fs.to}`;
    tricks.fragment_sleep = `${fsl.from}-${fsl.to}`;
  }
  if (t.enablePadding) {
    const ps = t.paddingSize || { from: 100, to: 900 };
    tricks.padding_size = `${ps.from}-${ps.to}`;
  }
  if (t.mixedSniCase) {
    tricks.mixedcase_sni = true;
  }
  if (Object.keys(tricks).length) {
    config.experimental.tls_tricks = tricks;
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
  return addProfileFromLink(raw);
}

// Универсальный добавитель — работает для любого supported протокола.
export function addProfileFromLink(raw) {
  const parsed = parseLink(raw);
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

// Точечное обновление полей одиночного профиля (rename и т.п.).
export function updateProfile(id, patch) {
  const list = loadProfiles();
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  saveProfiles(list);
  return list[idx];
}

export function getMode() {
  const m = localStorage.getItem(MODE_KEY);
  return m === "tun" ? "tun" : "proxy";
}

export function setMode(m) {
  localStorage.setItem(MODE_KEY, m === "tun" ? "tun" : "proxy");
}
