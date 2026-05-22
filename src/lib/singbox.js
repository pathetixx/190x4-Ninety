// Ninety · sing-box config builder + vless:// парсер + хранилище профилей
// Совместимо с sing-box 1.10.x (CI скачивает 1.10.5)

const PROFILES_KEY = "ninety.profiles.v1";
const ACTIVE_KEY = "ninety.profiles.active";
const MODE_KEY = "ninety.mode";

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

function buildOutbound(p) {
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

  return out;
}

export function buildConfig({ profile, mode }) {
  const outbound = buildOutbound(profile);
  const inbound = mode === "tun" ? {
    type: "tun",
    tag: "tun-in",
    interface_name: "ninety-tun",
    address: ["172.19.0.1/30"],
    mtu: 9000,
    auto_route: true,
    strict_route: false,
    sniff: true,
  } : {
    type: "mixed",
    tag: "mixed-in",
    listen: "127.0.0.1",
    listen_port: 7890,
    sniff: true,
  };

  return {
    log: { level: "warn", timestamp: true },
    dns: {
      servers: [
        { tag: "remote", address: "https://1.1.1.1/dns-query", detour: "proxy" },
        { tag: "local", address: "local", detour: "direct" },
      ],
      rules: [{ outbound: "any", server: "local" }],
      strategy: "prefer_ipv4",
    },
    inbounds: [inbound],
    outbounds: [
      outbound,
      { type: "direct", tag: "direct" },
      { type: "dns", tag: "dns-out" },
    ],
    route: {
      rules: [{ protocol: "dns", outbound: "dns-out" }],
      final: "proxy",
      auto_detect_interface: true,
    },
  };
}

// ── Storage ─────────────────────────────────────────────
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
  if (!getActiveProfileId()) setActiveProfileId(id);
  return { id, profile: parsed };
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
