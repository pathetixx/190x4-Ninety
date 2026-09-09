// Импорт готового конфига Xray. Подписка Xray у панелей — это МАССИВ целых
// конфигов (формат v2rayN), а не один конфиг: имя сервера лежит в `remarks`, а
// теги outbound'ов служебные. Плюс панель дублирует все серверы ещё раз в
// конфиге-балансировщике, поэтому одинаковые ноды обязаны схлопываться.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window.localStorage = globalThis.localStorage;

const { parseXrayConfig } = await import("/lib/xray-config-import.js");
const { detectConfigFormat } = await import("/lib/config-format.js");
const { parseClientConfig } = await import("/lib/config-import.js");
const { parseSubscriptionEntries, detectAddInput } = await import("/lib/subscriptions.js");
const { buildConfig } = await import("/lib/singbox.js");
const { nodeConfigIssue } = await import("/lib/node-validation.js");

const HOST = "panel.example";
const UUID = "89b3cbba-e6ac-485a-9481-976a0415eab9";
const WG_KEY = "iLFN8Z0ihE3hI6xUXFPtQaTPZKvhZlOMs0k7q1sVX3Y=";
const WG_PUB = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";

const GROUP_TYPES = new Set(["selector", "urltest", "balancer", "direct", "block", "dns"]);
function outboundsOf(nodes) {
  const { config } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes },
    mode: "vpn",
  });
  return config.outbounds.filter((o) => !GROUP_TYPES.has(o.type));
}

// Форма, которую отдаёт BPB-Worker-Panel: ws с путём «?ed=», host отдельным
// ключом wsSettings (не headers.Host), sockopt и rawSettings.
const vlessOutbound = (tag = "proxy", address = HOST, port = 443) => ({
  tag,
  protocol: "vless",
  settings: { vnext: [{ address, port, users: [{ id: UUID, encryption: "none" }] }] },
  streamSettings: {
    network: "ws",
    wsSettings: { host: HOST, path: "/vl/abc?ed=2560" },
    security: "tls",
    tlsSettings: { serverName: "PaNel.ExAmple", alpn: ["http/1.1"], fingerprint: "randomized" },
    sockopt: { tcpFastOpen: false, domainStrategy: "UseIP" },
  },
});

const freedom = { tag: "direct", protocol: "freedom", settings: {} };
const blackhole = { tag: "block", protocol: "blackhole", settings: {} };

const xrayConfig = (remarks, outbounds) => ({
  remarks,
  log: { loglevel: "warning" },
  dns: { servers: [] },
  inbounds: [{ protocol: "socks", port: 10808 }],
  outbounds,
  routing: { rules: [] },
});

// ── формат ─────────────────────────────────────────────────
test("массив конфигов Xray распознаётся форматом xray", () => {
  const sub = [xrayConfig("💦 1. VL - Domain", [vlessOutbound(), freedom, blackhole])];
  assert.equal(detectConfigFormat(JSON.stringify(sub)), "xray");
  const detected = detectAddInput(JSON.stringify(sub));
  assert.equal(detected.kind, "client-config");
  assert.equal(detected.format, "xray");
});

test("имя сервера берётся из remarks конфига, а не из служебного тега", () => {
  const sub = [
    xrayConfig("💦 1. VL - Domain", [vlessOutbound(), freedom]),
    xrayConfig("💦 2. VL - IPv4", [vlessOutbound("proxy", "104.16.1.5", 8443), freedom]),
  ];
  const { profiles } = parseXrayConfig(sub);
  assert.deepEqual(profiles.map((p) => p.name), ["💦 1. VL - Domain", "💦 2. VL - IPv4"]);
});

test("несколько пользователей в одном vnext дают различимые имена", () => {
  // Панель кладёт в outbound два доступа к одному серверу. Профиля получается
  // два, и общее имя конфига делало их в списке неразличимыми.
  const outbound = vlessOutbound();
  outbound.settings.vnext[0].users.push({ id: "aaaabbbb-cccc-dddd-eeee-ffff00001111", encryption: "none" });
  const { profiles } = parseXrayConfig([xrayConfig("Panel EU", [outbound, freedom])]);
  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles.map((p) => p.name), ["Panel EU · 1", "Panel EU · 2"]);
});

test("конфиг-балансировщик перечисляет те же серверы — дубликаты схлопываются", () => {
  // Панель кладёт каждый сервер отдельным конфигом, а потом ещё раз все сразу
  // в конфиге «Best Ping». Без склейки пользователь получил бы всё дважды.
  const one = vlessOutbound("proxy", HOST, 443);
  const two = vlessOutbound("proxy", "104.16.1.5", 8443);
  const sub = [
    xrayConfig("💦 1. VL - Domain", [one, freedom]),
    xrayConfig("💦 2. VL - IPv4", [two, freedom]),
    xrayConfig("💦 Best Ping 💥", [
      { ...one, tag: "proxy-1" }, { ...two, tag: "proxy-2" }, freedom,
    ]),
  ];
  const { profiles } = parseClientConfig(JSON.stringify(sub));
  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles.map((p) => p.name), ["💦 1. VL - Domain", "💦 2. VL - IPv4"]);
});

test("freedom, blackhole и dns не серверы и в пропущенные не попадают", () => {
  const { profiles, skipped } = parseXrayConfig([xrayConfig("x", [
    vlessOutbound(), freedom, blackhole,
    { tag: "dns-out", protocol: "dns", settings: {} },
  ])]);
  assert.equal(profiles.length, 1);
  assert.equal(skipped, 0);
});

// ── перенос без потерь ─────────────────────────────────────
test("vless ws+tls доезжает до конфига, путь с «?ed=» остаётся как есть", () => {
  // Форму Xray в max_early_data не переводим: ядро отправляет такой путь
  // вместе с query, это работает, и поведение нод менять незачем.
  const { profiles } = parseXrayConfig([xrayConfig("n", [vlessOutbound(), freedom])]);
  const [out] = outboundsOf(profiles);
  assert.equal(out.type, "vless");
  assert.equal(out.server, HOST);
  assert.equal(out.uuid, UUID);
  assert.equal(out.tls.server_name, "PaNel.ExAmple");
  assert.equal(out.tls.utls.fingerprint, "randomized");
  assert.deepEqual(out.tls.alpn, ["http/1.1"]);
  assert.deepEqual(out.transport, {
    type: "ws", path: "/vl/abc?ed=2560", headers: { Host: HOST },
  });
});

test("reality переносит ключ, short_id и flow", () => {
  const { profiles } = parseXrayConfig([xrayConfig("r", [{
    tag: "proxy", protocol: "vless",
    settings: { vnext: [{ address: "r.example", port: 443,
      users: [{ id: UUID, encryption: "none", flow: "xtls-rprx-vision" }] }] },
    streamSettings: {
      network: "tcp", security: "reality",
      realitySettings: {
        serverName: "www.microsoft.com", fingerprint: "chrome",
        publicKey: "OaJVGnPzGpDLDlN9GNCsCLYlIzCZlBRVzGSkKGxNIRs",
        shortId: "6ba85179e30d4fc2", spiderX: "/",
      },
    },
  }])]);
  const [out] = outboundsOf(profiles);
  assert.equal(out.flow, "xtls-rprx-vision");
  assert.equal(out.tls.reality.public_key, "OaJVGnPzGpDLDlN9GNCsCLYlIzCZlBRVzGSkKGxNIRs");
  assert.equal(out.tls.reality.short_id, "6ba85179e30d4fc2");
});

test("trojan и shadowsocks читаются из settings.servers", () => {
  const { profiles, skipped } = parseXrayConfig([xrayConfig("s", [
    { tag: "t", protocol: "trojan",
      settings: { servers: [{ address: HOST, port: 8443, password: "p@ss:word/1" }] },
      streamSettings: { network: "ws", security: "tls",
        wsSettings: { host: HOST, path: "/tr" }, tlsSettings: { serverName: HOST } } },
    { tag: "ss", protocol: "shadowsocks",
      settings: { servers: [{ address: "5.6.7.8", port: 8388,
        method: "chacha20-ietf-poly1305", password: "p+w/d=" }] } },
  ])]);
  assert.equal(skipped, 0);
  const outs = outboundsOf(profiles);
  assert.equal(outs[0].password, "p@ss:word/1");
  assert.equal(outs[1].method, "chacha20-ietf-poly1305");
  assert.equal(outs[1].password, "p+w/d=");
});

test("vmess переносит alterId, шифр и grpc", () => {
  const { profiles } = parseXrayConfig([xrayConfig("v", [{
    tag: "vm", protocol: "vmess",
    settings: { vnext: [{ address: "1.2.3.4", port: 443,
      users: [{ id: UUID, alterId: 0, security: "aes-128-gcm" }] }] },
    streamSettings: {
      network: "grpc", security: "tls",
      grpcSettings: { serviceName: "GunService" },
      tlsSettings: { serverName: "a.example", fingerprint: "chrome" },
    },
  }])]);
  const [out] = outboundsOf(profiles);
  assert.equal(out.type, "vmess");
  assert.equal(out.uuid, UUID);
  assert.equal(out.security, "aes-128-gcm");
  assert.deepEqual(out.transport, { type: "grpc", service_name: "GunService" });
});

test("socks берёт логин и пароль из users", () => {
  const { profiles } = parseXrayConfig([xrayConfig("s", [{
    tag: "sk", protocol: "socks",
    settings: { servers: [{ address: "9.9.9.9", port: 1080, users: [{ user: "u", pass: "p@ss" }] }] },
  }])]);
  const [out] = outboundsOf(profiles);
  assert.equal(out.type, "socks");
  assert.equal(out.username, "u");
  assert.equal(out.password, "p@ss");
});

test("mKCP и QUIC переносят маскировку, seed и режим шифрования транспорта", () => {
  const { profiles } = parseXrayConfig([xrayConfig("k", [
    { tag: "kcp", protocol: "vless",
      settings: { vnext: [{ address: "k.example", port: 443, users: [{ id: UUID }] }] },
      streamSettings: { network: "kcp", security: "none",
        kcpSettings: { header: { type: "wechat-video" }, seed: "s3cr3t" } } },
    { tag: "quic", protocol: "vless",
      settings: { vnext: [{ address: "q.example", port: 443, users: [{ id: UUID }] }] },
      streamSettings: { network: "quic", security: "tls",
        quicSettings: { security: "none", header: { type: "none" } },
        tlsSettings: { serverName: "q.example" } } },
  ])]);
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].type, "kcp");
  assert.equal(profiles[0].seed, "s3cr3t");
  assert.equal(profiles[0].headerType, "wechat-video");
  assert.equal(profiles[1].type, "quic");
  assert.equal(nodeConfigIssue(profiles[1]), null);
});

test("xhttp кладёт подопции в extra — без них сервер рвёт handshake", () => {
  const xhttpSettings = {
    path: "/xh", host: "x.example", mode: "packet-up",
    xPaddingBytes: "100-1000", noGRPCHeader: false,
    downloadSettings: { address: "dl.example", port: 443, security: "tls",
      tlsSettings: { serverName: "dl.example" }, xhttpSettings: { path: "/xh" } },
  };
  const { profiles } = parseXrayConfig([xrayConfig("x", [{
    tag: "xh", protocol: "vless",
    settings: { vnext: [{ address: "x.example", port: 443, users: [{ id: UUID }] }] },
    streamSettings: { network: "xhttp", security: "tls", xhttpSettings,
      tlsSettings: { serverName: "x.example" } },
  }])]);
  const [out] = outboundsOf(profiles);
  assert.equal(out.transport.type, "xhttp");
  assert.equal(out.transport.mode, "packet-up");
  assert.equal(out.transport.xPaddingBytes, "100-1000");
  assert.equal(out.transport.downloadSettings.server, "dl.example");
});

// ── цепочки ────────────────────────────────────────────────
test("dialerProxy на freedom — это фрагментация, нода берётся; на прокси — цепочка, не берётся", () => {
  // Фрагментация у Xray живёт отдельным freedom-outbound'ом: путь до сервера
  // она не меняет, и у Ninety своя настройка фрагментации. А dialerProxy на
  // настоящий прокси — это цепочка: без неё нода пошла бы напрямую.
  const withFragment = vlessOutbound();
  withFragment.streamSettings = {
    ...withFragment.streamSettings,
    sockopt: { dialerProxy: "fragment" },
  };
  const fragmentOutbound = {
    tag: "fragment", protocol: "freedom",
    settings: { fragment: { packets: "tlshello", length: "10-20", interval: "10-20" } },
  };
  const fragOk = parseXrayConfig([xrayConfig("f", [withFragment, fragmentOutbound])]);
  assert.equal(fragOk.profiles.length, 1);
  assert.equal(fragOk.skipped, 0);

  const chained = vlessOutbound();
  chained.streamSettings = { ...chained.streamSettings, sockopt: { dialerProxy: "front" } };
  const front = { tag: "front", protocol: "socks",
    settings: { servers: [{ address: "1.1.1.1", port: 1080 }] } };
  const chainSkipped = parseXrayConfig([xrayConfig("c", [chained, front])]);
  assert.equal(chainSkipped.profiles.length, 1); // остался только сам front
  assert.deepEqual(chainSkipped.unsupported, ["vless+chain"]);
});

// ── WireGuard ──────────────────────────────────────────────
test("WARP из конфига Xray приезжает вместе с reserved", () => {
  // У Xray WireGuard — обычный outbound со своими именами полей
  // (secretKey/publicKey/endpoint), а reserved лежит на уровне settings.
  const { profiles, skipped } = parseXrayConfig([xrayConfig("💦 WARP", [{
    tag: "proxy", protocol: "wireguard",
    settings: {
      address: ["172.16.0.2/32", "2606:4700:110:859d::/128"],
      mtu: 1280, secretKey: WG_KEY, reserved: [12, 34, 56],
      peers: [{ endpoint: "engage.cloudflareclient.com:2408", publicKey: WG_PUB, keepAlive: 5 }],
    },
  }, freedom])]);
  assert.equal(skipped, 0);
  assert.equal(profiles[0].name, "💦 WARP");
  assert.equal(nodeConfigIssue(profiles[0]), null);

  const { config } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes: profiles },
    mode: "vpn",
  });
  const [endpoint] = config.endpoints;
  assert.equal(endpoint.private_key, WG_KEY);
  assert.deepEqual(endpoint.peers[0].reserved, [12, 34, 56]);
  assert.deepEqual(endpoint.peers[0].allowed_ips, ["0.0.0.0/0", "::/0"]);
  assert.equal(endpoint.peers[0].persistent_keepalive_interval, 5);
});

// ── тело подписки ──────────────────────────────────────────
test("подписка отдала массив конфигов Xray — серверы импортируются", () => {
  const sub = JSON.stringify([
    xrayConfig("💦 1. VL - Domain", [vlessOutbound(), freedom]),
    xrayConfig("💦 2. VL - IPv4", [vlessOutbound("proxy", "104.16.1.5", 8443), freedom]),
  ]);
  const result = parseSubscriptionEntries(sub);
  assert.equal(result.format, "xray");
  assert.equal(result.profiles.length, 2);

  const encoded = Buffer.from(sub, "utf8").toString("base64");
  assert.equal(parseSubscriptionEntries(encoded).profiles.length, 2);
});
