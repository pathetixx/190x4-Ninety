// Тело подписки — не всегда список ссылок. Панель может раздать ссылкой и файл
// профиля: WARP у BPB-Worker-Panel это .conf WireGuard, а не список. Вставку
// такого файла текстом окно добавления понимало и раньше, а тело подписки — нет,
// и подписка выглядела пустой без единого слова почему.
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

const { parseSubscriptionEntries } = await import("/lib/subscriptions.js");
const { buildConfig } = await import("/lib/singbox.js");

const WG_CONF = `[Interface]
PrivateKey = iLFN8Z0ihE3hI6xUXFPtQaTPZKvhZlOMs0k7q1sVX3Y=
Address = 172.16.0.2/32, 2606:4700:110:859d::/128
MTU = 1280

[Peer]
PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = engage.cloudflareclient.com:2408
PersistentKeepalive = 5
`;

// Шейпинг живёт в [Interface]: в [Peer] эти же ключи ничего не значат.
const AWG_CONF = WG_CONF.replace("MTU = 1280", "MTU = 1280\nJc = 4\nJmin = 40\nJmax = 70");

const TT_TOML = `hostname = "tt.example"
addresses = ["203.0.113.7:443"]
username = "user"
password = "secret"
upstream_protocol = "http2"
name = "TrustTunnel NL"
`;

test("подписка отдала .conf WireGuard — профиль импортируется", () => {
  const { profiles, skipped, format } = parseSubscriptionEntries(WG_CONF);
  assert.equal(format, null);
  assert.equal(skipped, 0);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].proto, "wireguard");
  assert.equal(profiles[0].host, "engage.cloudflareclient.com");

  const { config } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes: profiles },
    mode: "vpn",
  });
  assert.equal(config.endpoints[0].type, "wireguard");
  assert.equal(config.endpoints[0].mtu, 1280);
});

test("шейпинг AmneziaWG из тела подписки доезжает до ядра", () => {
  const { profiles } = parseSubscriptionEntries(AWG_CONF);
  const { config } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes: profiles },
    mode: "vpn",
  });
  assert.deepEqual(config.endpoints[0].noise.amnezia, { jc: 4, jmin: 40, jmax: 70 });
});

test("подписка отдала endpoint TrustTunnel — профиль импортируется", () => {
  const { profiles, skipped } = parseSubscriptionEntries(TT_TOML);
  assert.equal(skipped, 0);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].proto, "trusttunnel");
  assert.equal(profiles[0].hostname, "tt.example");
});

test("тот же файл в base64 — это по-прежнему файл", () => {
  const encoded = Buffer.from(WG_CONF, "utf8").toString("base64");
  const { profiles } = parseSubscriptionEntries(encoded);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].proto, "wireguard");
});

test("битый .conf не выдаёт себя за пустую подписку молча", () => {
  // Ключ не 32-байтный: парсер бросает, тело остаётся неразобранным. Важно,
  // что это не падение импорта, а обычный «нет конфигов» — его вызывающий и
  // покажет пользователю.
  const broken = WG_CONF.replace(/PrivateKey = \S+/, "PrivateKey = short");
  const { profiles, skipped } = parseSubscriptionEntries(broken);
  assert.equal(profiles.length, 0);
  assert.equal(skipped, 0);
});

test("список ссылок по-прежнему разбирается списком, а не файлом", () => {
  const list = "vless://89b3cbba-e6ac-485a-9481-976a0415eab9@h.example:443?type=ws#a";
  const { profiles, format } = parseSubscriptionEntries(list);
  assert.equal(format, null);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].proto, "vless");
});
