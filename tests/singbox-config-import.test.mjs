// Импорт готового конфига sing-box. Панели раздают подписку двумя способами —
// списком ссылок и собранным конфигом ядра (BPB-Worker-Panel, Hiddify-панели), и
// второй способ до этого выглядел как «подписка не содержит конфигов».
//
// Проверяем то, что ломается молча: серверная часть должна доехать до конфига
// без потерь (пароль со спецсимволами, IPv6, reality, early data, reserved
// WireGuard), а всё, что не сервер, не должно попадать в счётчик пропущенных.
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

const { parseSingboxConfig, singboxOutboundToLink } =
  await import("/lib/singbox-config-import.js");
const { detectConfigFormat } = await import("/lib/config-format.js");
const { parseSubscriptionEntries, detectAddInput } = await import("/lib/subscriptions.js");
const { buildConfig } = await import("/lib/singbox.js");
const { nodeConfigIssue } = await import("/lib/node-validation.js");

const HOST = "panel.example";
const UUID = "89b3cbba-e6ac-485a-9481-976a0415eab9";
const WG_KEY = "iLFN8Z0ihE3hI6xUXFPtQaTPZKvhZlOMs0k7q1sVX3Y=";
const WG_PUB = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";

const wrap = (outbounds, extra = {}) => ({
  log: { level: "warn" },
  inbounds: [{ type: "tun", tag: "tun-in" }],
  outbounds,
  route: { final: "proxy" },
  ...extra,
});

const vlessWs = {
  tag: "💦 1. VL - Domain", type: "vless", server: HOST, server_port: 443, uuid: UUID,
  tls: {
    enabled: true, server_name: "PaNel.ExAmple", alpn: ["http/1.1"],
    utls: { enabled: true, fingerprint: "randomized" },
  },
  transport: {
    type: "ws", path: "/vl/abc", max_early_data: 2560,
    early_data_header_name: "Sec-WebSocket-Protocol", headers: { Host: HOST },
  },
};

// Собирает конфиг ядра из нод и возвращает outbound'ы самих серверов. Тег
// зависит от числа нод (одна нода собирается сразу под «proxy»), поэтому
// отбираем по типу, а не по имени.
const GROUP_TYPES = new Set(["selector", "urltest", "balancer", "direct", "block", "dns"]);
function outboundsOf(nodes) {
  const { config } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes },
    mode: "vpn",
  });
  return config.outbounds.filter((o) => !GROUP_TYPES.has(o.type));
}

// ── распознавание формата ──────────────────────────────────
test("конфиг sing-box распознаётся, а конфиг чужого движка называется по имени", () => {
  assert.equal(detectConfigFormat(JSON.stringify(wrap([vlessWs]))), "sing-box");
  assert.equal(detectConfigFormat(JSON.stringify({ outbounds: [{ protocol: "vless", settings: {} }] })), "xray");
  assert.equal(detectConfigFormat("proxies:\n  - name: a\n    type: vless\n"), "clash");
  assert.equal(detectConfigFormat("vless://uuid@host:443#a"), null);
  assert.equal(detectConfigFormat(""), null);
});

test("outbounds без type, но с protocol — это Xray, а не sing-box", () => {
  // Ключ `outbounds` есть у обоих движков; отличает их форма записи сервера.
  const xray = { outbounds: [{ protocol: "vless", tag: "proxy", settings: { vnext: [] } }] };
  assert.equal(detectConfigFormat(JSON.stringify(xray)), "xray");
  assert.equal(detectAddInput(JSON.stringify(xray)).kind, "client-config");
  assert.equal(detectAddInput(JSON.stringify(xray)).format, "xray");
});

// ── что берём и что пропускаем ─────────────────────────────
test("группы и системные outbound'ы не серверы и в пропущенные не попадают", () => {
  const { profiles, skipped } = parseSingboxConfig(wrap([
    { type: "selector", tag: "proxy", outbounds: ["auto"] },
    { type: "urltest", tag: "auto", outbounds: ["💦 1. VL - Domain"] },
    { type: "direct", tag: "direct" },
    { type: "block", tag: "block" },
    { type: "dns", tag: "dns-out" },
    vlessWs,
  ]));
  assert.equal(profiles.length, 1);
  assert.equal(skipped, 0);
});

test("нода за чужим detour и протокол без поддержки считаются пропущенными", () => {
  const { profiles, skipped, unsupported } = parseSingboxConfig(wrap([
    vlessWs,
    { tag: "chain", type: "vless", server: "c.example", server_port: 443, uuid: UUID, detour: "front" },
    { tag: "http", type: "http", server: "p.example", server_port: 8080 },
  ]));
  assert.equal(profiles.length, 1);
  assert.equal(skipped, 2);
  // Цепочку через чужой outbound Ninety не воспроизводит: без неё нода пошла бы
  // напрямую, то есть вела бы себя не так, как в конфиге, откуда пришла.
  assert.deepEqual(unsupported.sort(), ["http", "vless+detour"]);
});

// ── перенос без потерь ─────────────────────────────────────
test("vless ws+tls доезжает до конфига вместе с ранней передачей данных", () => {
  const { profiles } = parseSingboxConfig(wrap([vlessWs]));
  const [out] = outboundsOf(profiles);
  assert.equal(out.type, "vless");
  assert.equal(out.server, HOST);
  assert.equal(out.uuid, UUID);
  assert.equal(out.tls.server_name, "PaNel.ExAmple");
  assert.equal(out.tls.utls.fingerprint, "randomized");
  assert.deepEqual(out.tls.alpn, ["http/1.1"]);
  assert.deepEqual(out.transport, {
    type: "ws",
    path: "/vl/abc",
    headers: { Host: HOST },
    max_early_data: 2560,
    early_data_header_name: "Sec-WebSocket-Protocol",
  });
  assert.equal(profiles[0].name, "💦 1. VL - Domain");
});

test("IPv6-сервер уезжает в ядро без скобок, а в ссылке живёт со скобками", () => {
  const node = { ...vlessWs, tag: "v6", server: "2606:4700::6810:105", server_port: 2053 };
  const { link } = singboxOutboundToLink(node);
  assert.ok(link.includes("@[2606:4700::6810:105]:2053"), link);
  const { profiles } = parseSingboxConfig(wrap([node]));
  assert.equal(outboundsOf(profiles)[0].server, "2606:4700::6810:105");
});

test("пароль со спецсимволами не рвёт ссылку по пути в конфиг", () => {
  // `@` и `:` в пароле — обычное дело у панелей, а разбор ссылки режет по
  // последнему `@` и первому `:`: без экранирования сюда доезжает огрызок.
  const password = "S0me:Tr0j@n/Pa ss#1";
  const { profiles } = parseSingboxConfig(wrap([{
    tag: "tr", type: "trojan", server: HOST, server_port: 8443, password,
    tls: { enabled: true, server_name: HOST },
  }]));
  assert.equal(outboundsOf(profiles)[0].password, password);
});

test("shadowsocks переносит метод и пароль через base64-userinfo", () => {
  const password = "SbP+ZmJhY2VkZWFkYmVlZjAxMg==";
  const { profiles } = parseSingboxConfig(wrap([{
    tag: "ss", type: "shadowsocks", server: "5.6.7.8", server_port: 8388,
    method: "2022-blake3-aes-128-gcm", password,
  }]));
  const [out] = outboundsOf(profiles);
  assert.equal(out.method, "2022-blake3-aes-128-gcm");
  assert.equal(out.password, password);
});

test("reality переносит ключ и short_id", () => {
  const { profiles } = parseSingboxConfig(wrap([{
    tag: "r", type: "vless", server: "r.example", server_port: 443, uuid: UUID,
    flow: "xtls-rprx-vision",
    tls: {
      enabled: true, server_name: "www.microsoft.com",
      utls: { enabled: true, fingerprint: "chrome" },
      reality: {
        enabled: true,
        public_key: "OaJVGnPzGpDLDlN9GNCsCLYlIzCZlBRVzGSkKGxNIRs",
        short_id: "6ba85179e30d4fc2",
      },
    },
  }]));
  const [out] = outboundsOf(profiles);
  assert.equal(out.flow, "xtls-rprx-vision");
  assert.equal(out.tls.reality.public_key, "OaJVGnPzGpDLDlN9GNCsCLYlIzCZlBRVzGSkKGxNIRs");
  assert.equal(out.tls.reality.short_id, "6ba85179e30d4fc2");
});

test("insecure из конфига доезжает до ядра, а не теряется по дороге", () => {
  const { profiles } = parseSingboxConfig(wrap([{
    ...vlessWs, tls: { ...vlessWs.tls, insecure: true },
  }]));
  assert.equal(outboundsOf(profiles)[0].tls.insecure, true);
});

test("vmess собирается через свою base64-ссылку, включая grpc", () => {
  const { profiles } = parseSingboxConfig(wrap([{
    tag: "vm", type: "vmess", server: "1.2.3.4", server_port: 443, uuid: UUID,
    alter_id: 0, security: "auto",
    tls: { enabled: true, server_name: "a.example" },
    transport: { type: "grpc", service_name: "GunService" },
  }]));
  const [out] = outboundsOf(profiles);
  assert.equal(out.type, "vmess");
  assert.equal(out.uuid, UUID);
  assert.deepEqual(out.transport, { type: "grpc", service_name: "GunService" });
});

test("vmess ws переносит раннюю передачу и insecure, которых нет в формате v2rayN", () => {
  // Формат ссылки vmess — это JSON v2rayN, и полей ed/eh/allowInsecure в нём
  // нет. Дописываем свои: чужие клиенты неизвестные ключи игнорируют, а наш
  // конфиг из ссылки возвращается таким же, каким в неё вошёл.
  const { profiles } = parseSingboxConfig(wrap([{
    tag: "vm", type: "vmess", server: "1.2.3.4", server_port: 443, uuid: UUID,
    alter_id: 0, security: "auto",
    tls: { enabled: true, server_name: "a.example", insecure: true },
    transport: {
      type: "ws", path: "/vm", max_early_data: 2048,
      early_data_header_name: "Sec-WebSocket-Protocol", headers: { Host: "a.example" },
    },
  }]));
  const [out] = outboundsOf(profiles);
  assert.equal(out.tls.insecure, true);
  assert.equal(out.transport.max_early_data, 2048);
  assert.equal(out.transport.early_data_header_name, "Sec-WebSocket-Protocol");
  assert.equal(out.transport.path, "/vm");
});

test("hysteria2, hysteria v1, tuic, anytls и socks переносятся целиком", () => {
  const { profiles, skipped } = parseSingboxConfig(wrap([
    { tag: "hy2", type: "hysteria2", server: "h2.example", server_port: 443, password: "pw",
      up_mbps: 100, down_mbps: 200, obfs: { type: "salamander", password: "obf" },
      tls: { enabled: true, server_name: "h2.example", insecure: true, alpn: ["h3"] } },
    { tag: "hy1", type: "hysteria", server: "h1.example", server_port: 443, auth_str: "secret",
      up_mbps: 50, down_mbps: 100, obfs: "xplus",
      tls: { enabled: true, server_name: "h1.example" } },
    { tag: "tuic", type: "tuic", server: "t.example", server_port: 443, uuid: UUID,
      password: "pw", congestion_control: "bbr", udp_relay_mode: "native",
      zero_rtt_handshake: true, tls: { enabled: true, server_name: "t.example" } },
    { tag: "at", type: "anytls", server: "a.example", server_port: 8443, password: "pw2",
      tls: { enabled: true, server_name: "a.example" } },
    { tag: "sk", type: "socks", server: "9.9.9.9", server_port: 1080, version: "5",
      username: "u", password: "p@ss" },
  ]));
  assert.equal(skipped, 0);
  const outs = outboundsOf(profiles);
  assert.deepEqual(outs.map((o) => o.type), ["hysteria2", "hysteria", "tuic", "anytls", "socks"]);
  assert.deepEqual(outs[0].obfs, { type: "salamander", password: "obf" });
  assert.equal(outs[0].up_mbps, 100);
  assert.equal(outs[1].auth_str, "secret");
  assert.equal(outs[1].obfs, "xplus");
  assert.equal(outs[2].congestion_control, "bbr");
  assert.equal(outs[3].password, "pw2");
  assert.equal(outs[4].password, "p@ss");
});

// ── WireGuard ──────────────────────────────────────────────
const warpEndpoint = {
  type: "wireguard", tag: "💦 WARP",
  address: ["172.16.0.2/32", "2606:4700:110:859d::/128"],
  private_key: WG_KEY, mtu: 1280,
  peers: [{
    address: "engage.cloudflareclient.com", port: 2408, public_key: WG_PUB,
    reserved: [12, 34, 56], allowed_ips: ["0.0.0.0/0", "::/0"],
    persistent_keepalive_interval: 5,
  }],
};

test("WireGuard берётся из endpoints вместе с reserved-байтами", () => {
  // Через .conf этот путь не проходит: reserved в ini-формате wg-quick не
  // выражается, поэтому endpoint кладётся в модель профиля напрямую.
  const { profiles, skipped } = parseSingboxConfig(wrap([{ type: "direct", tag: "direct" }], {
    endpoints: [warpEndpoint],
  }));
  assert.equal(skipped, 0);
  assert.equal(profiles.length, 1);
  assert.equal(nodeConfigIssue(profiles[0]), null);

  const { config } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes: profiles },
    mode: "vpn",
  });
  const [endpoint] = config.endpoints;
  assert.equal(endpoint.type, "wireguard");
  assert.equal(endpoint.private_key, WG_KEY);
  assert.deepEqual(endpoint.peers[0].reserved, [12, 34, 56]);
  assert.equal(endpoint.peers[0].persistent_keepalive_interval, 5);
  assert.equal(endpoint.mtu, 1280);
});

test("конфиг постарше держит WireGuard среди outbounds — берём и оттуда", () => {
  const { profiles } = parseSingboxConfig(wrap([warpEndpoint]));
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].proto, "wireguard");
});

test("битые reserved-байты отбраковывают ноду, а не весь конфиг", () => {
  const bad = {
    ...warpEndpoint,
    peers: [{ ...warpEndpoint.peers[0], reserved: [12, 34, 999] }],
  };
  const { profiles } = parseSingboxConfig(wrap([], { endpoints: [bad] }));
  assert.deepEqual(nodeConfigIssue(profiles[0]), { code: "wgReserved" });
});

test("reserved вместе с шейпингом AmneziaWG ядро не примет — нода отбраковывается", () => {
  const clash = {
    ...warpEndpoint,
    noise: { amnezia: { jc: 4, jmin: 40, jmax: 70 } },
  };
  const { profiles } = parseSingboxConfig(wrap([], { endpoints: [clash] }));
  assert.deepEqual(nodeConfigIssue(profiles[0]), { code: "wgReservedNoise" });
});

// ── тело подписки ──────────────────────────────────────────
test("подписка отдала конфиг вместо списка ссылок — серверы всё равно импортируются", () => {
  const body = JSON.stringify(wrap([vlessWs, { type: "direct", tag: "direct" }]));
  const plain = parseSubscriptionEntries(body);
  assert.equal(plain.format, "sing-box");
  assert.equal(plain.profiles.length, 1);

  // Часть панелей заворачивает то же тело в base64 — это по-прежнему конфиг.
  const encoded = Buffer.from(body, "utf8").toString("base64");
  const wrapped = parseSubscriptionEntries(encoded);
  assert.equal(wrapped.format, "sing-box");
  assert.equal(wrapped.profiles.length, 1);
  assert.equal(detectAddInput(encoded).kind, "client-config");
});

test("подписка с нечитаемым конфигом называет формат, а не молчит про пустоту", () => {
  const result = parseSubscriptionEntries("proxies:\n  - name: a\n    type: vless\n");
  assert.equal(result.format, "clash");
  assert.equal(result.profiles.length, 0);
});

test("обычный список ссылок разбирается по-прежнему и форматом не считается", () => {
  const list = `vless://${UUID}@${HOST}:443?type=ws&security=tls&path=%2Fa#one`;
  const result = parseSubscriptionEntries(Buffer.from(list, "utf8").toString("base64"));
  assert.equal(result.format, null);
  assert.equal(result.profiles.length, 1);
});

// ── обратная совместимость ─────────────────────────────────
test("форма Xray «path=/x?ed=2560» поведение уже добавленных нод не меняет", () => {
  // Путь с query ядро отправляет как есть, и это работает. Ранняя передача
  // включается только явными параметрами ссылки — иначе апдейт молча
  // переписал бы транспорт всем, у кого подписка в формате Xray.
  const inPath = parseSubscriptionEntries(
    `vless://${UUID}@${HOST}:443?type=ws&security=tls&path=%2Fvl%2Fx%3Fed%3D2560`,
  );
  const [built] = outboundsOf(inPath.profiles);
  assert.equal(built.transport.path, "/vl/x?ed=2560");
  assert.equal(built.transport.max_early_data, undefined);

  const explicit = parseSubscriptionEntries(
    `vless://${UUID}@${HOST}:443?type=ws&security=tls&path=%2Fvl%2Fx&ed=2560&eh=Sec-WebSocket-Protocol`,
  );
  const [withEarly] = outboundsOf(explicit.profiles);
  assert.equal(withEarly.transport.path, "/vl/x");
  assert.equal(withEarly.transport.max_early_data, 2560);
});

test("ссылка без ранней передачи не заводит полей — отпечаток ноды не меняется", () => {
  // Отпечаток считается по содержимому ноды: постоянное `earlyData: 0` сменило
  // бы identity всем существующим нодам вместе с запомненным выбором сервера.
  const [node] = parseSubscriptionEntries(`vless://${UUID}@${HOST}:443?type=ws#a`).profiles;
  assert.equal("earlyData" in node, false);
  assert.equal("insecure" in node, false);
});

// ── круг: экспорт → импорт ─────────────────────────────────
test("собственный экспорт конфига импортируется обратно без потерь", () => {
  // Самая строгая проверка переноса: то, что Ninety отдаёт кнопкой «экспорт в
  // sing-box», обязано вернуться теми же outbound'ами. Разница здесь — это
  // ровно то поле, которое теряется при импорте чужого конфига.
  const source = wrap([
    vlessWs,
    { tag: "v6", type: "vless", server: "2606:4700::6810:105", server_port: 2053, uuid: UUID,
      flow: "xtls-rprx-vision",
      tls: { enabled: true, server_name: "www.microsoft.com",
             utls: { enabled: true, fingerprint: "chrome" },
             reality: { enabled: true,
                        public_key: "OaJVGnPzGpDLDlN9GNCsCLYlIzCZlBRVzGSkKGxNIRs",
                        short_id: "6ba85179e30d4fc2" } } },
    { tag: "tr", type: "trojan", server: HOST, server_port: 8443, password: "p@ss:word/1",
      tls: { enabled: true, server_name: HOST, insecure: true },
      transport: { type: "httpupgrade", host: HOST, path: "/hu" } },
    { tag: "ss", type: "shadowsocks", server: "5.6.7.8", server_port: 8388,
      method: "chacha20-ietf-poly1305", password: "p+w/d=" },
    { tag: "hy2", type: "hysteria2", server: "h2.example", server_port: 443, password: "pw",
      up_mbps: 100, down_mbps: 200, obfs: { type: "salamander", password: "obf" },
      tls: { enabled: true, server_name: "h2.example", alpn: ["h3"] } },
    { tag: "at", type: "anytls", server: "a.example", server_port: 8443, password: "pw2",
      tls: { enabled: true, server_name: "a.example", utls: { enabled: true, fingerprint: "safari" } } },
  ], { endpoints: [warpEndpoint] });

  const first = parseSingboxConfig(source);
  const exported = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes: first.profiles },
    mode: "vpn",
  }).config;

  const second = parseSingboxConfig(exported);
  assert.equal(second.skipped, 0);
  assert.equal(second.profiles.length, first.profiles.length);
  const reExported = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes: second.profiles },
    mode: "vpn",
  }).config;

  const strip = (config) => [
    ...config.outbounds.filter((o) => !GROUP_TYPES.has(o.type)),
    ...(config.endpoints || []),
  ].map(({ tag, ...rest }) => rest);
  assert.deepEqual(strip(reExported), strip(exported));
});
