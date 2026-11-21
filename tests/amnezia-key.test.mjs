// AmneziaVPN key (vpn://) and AmneziaWG 3. The keys here are synthetic: the format
// is built the same way AmneziaVPN writes it (qCompress → base64url).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window.localStorage = globalThis.localStorage;

const { looksLikeAmneziaKey, parseAmneziaKey } = await import("/lib/amnezia-key.js");
const { detectAddInput } = await import("/lib/subscriptions.js");
const { isAmneziaWg3, parseWireguardConf, wireguardConfText } = await import("/lib/protocol-parsers.js");
const { nodeConfigIssue } = await import("/lib/node-validation.js");
const { buildConfig } = await import("/lib/singbox.js");

const WG_PRIVATE = "nlhuTLXG3gAV8AJmw8jYngX3QkwdDoSPi2HxhGGSKrs=";
const WG_PUBLIC = "zjVMotkY/dyEZygQ7crKvCtV1ODNZkVx1xe/1Bvvo8A=";
const HEADER_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString("base64");

const AWG3 = `Jc = 5
Jmin = 64
Jmax = 556
S1 = 24
S2 = 18
S3 = 21
S4 = 14
H1 = 110000000-110020000
H2 = 1210000000-1210020000
H3 = 1510000000-1510020000
H4 = 1910000000-1910020000
I1 = <b 0xc0ffee><rc 12><t><r 100>
HeaderProtectionKey = ${HEADER_KEY}
ContentPaddingAddition = 16-64
RandomTrailers = on`;

const conf = (shaping) => `[Interface]
Address = 10.77.0.20/32
DNS = $PRIMARY_DNS, $SECONDARY_DNS
PrivateKey = ${WG_PRIVATE}
${shaping}

[Peer]
PublicKey = ${WG_PUBLIC}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = vpn.example.net:20507
PersistentKeepalive = 25`;

// qCompress: 4 length bytes big endian + zlib; then base64url without "=".
function amneziaKey(json, { compressed = true } = {}) {
  const text = Buffer.from(JSON.stringify(json));
  let payload = text;
  if (compressed) {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(text.length);
    payload = Buffer.concat([size, deflateSync(text)]);
  }
  return `vpn://${payload.toString("base64url")}`;
}

const awgContainer = (shaping = AWG3) => ({
  container: "amnezia-awg2",
  awg: {
    last_config: JSON.stringify({ config: conf(shaping), mtu: "1280" }),
    port: "20507",
    transport_proto: "udp",
  },
});

test("ключ vpn:// узнаётся в окне добавления", () => {
  const key = amneziaKey({ containers: [awgContainer()], defaultContainer: "amnezia-awg2", description: "Poland" });
  assert.equal(looksLikeAmneziaKey(key), true);
  assert.deepEqual(detectAddInput(key), { kind: "amnezia-key", content: key });
  assert.equal(looksLikeAmneziaKey("vpn://"), false);
  assert.equal(looksLikeAmneziaKey("https://example.com"), false);
});

test("ключ с AmneziaWG 3 даёт рабочий профиль с именем из описания", async () => {
  const key = amneziaKey({ containers: [awgContainer()], defaultContainer: "amnezia-awg2", description: "Poland AWG3" });
  const { profiles, ignored, unsupported, name } = await parseAmneziaKey(key);
  assert.equal(name, "Poland AWG3");
  assert.equal(profiles.length, 1);
  const [profile] = profiles;
  assert.equal(profile.name, "Poland AWG3");
  assert.equal(profile.host, "vpn.example.net");
  assert.equal(profile.port, 20507);
  assert.equal(profile.awg.headerProtectionKey, HEADER_KEY);
  assert.equal(profile.awg.contentPaddingAddition, "16-64");
  assert.equal(profile.awg.randomTrailers, true);
  assert.equal(profile.awg.s4, 14);
  assert.equal(isAmneziaWg3(profile.awg), true);
  assert.equal(nodeConfigIssue(profile), null);
  // DNS from the key is an Amnezia placeholder; DNS is handled by Ninety's own settings section.
  assert.deepEqual(ignored, ["DNS"]);
  assert.deepEqual(unsupported, []);
});

test("ядро получает защиту заголовков, padding содержимого и хвосты", async () => {
  const key = amneziaKey({ containers: [awgContainer()], defaultContainer: "amnezia-awg2", description: "PL" });
  const [profile] = (await parseAmneziaKey(key)).profiles;
  const { config } = buildConfig({ source: { kind: "single", profile }, mode: "vpn" });
  const amnezia = config.endpoints.find((e) => e.type === "wireguard").noise.amnezia;
  assert.equal(amnezia.header_protection_key, HEADER_KEY);
  assert.equal(amnezia.content_padding_addition, "16-64");
  assert.equal(amnezia.random_trailers, true);
  assert.equal(amnezia.h1, "110000000-110020000");
  assert.equal(amnezia.s1, 24);
});

test("несжатый ключ старого формата тоже читается", async () => {
  const key = amneziaKey({ containers: [awgContainer()], description: "Old" }, { compressed: false });
  const { profiles } = await parseAmneziaKey(key);
  assert.equal(profiles.length, 1);
});

const OPENVPN = "client\ndev tun\nremote vpn.example.net 1194 udp\n<ca>\nTEST CA\n</ca>";
const openvpnContainer = () => ({
  container: "amnezia-openvpn",
  openvpn: { last_config: JSON.stringify({ config: OPENVPN }) },
});

test("в ключе с OpenVPN и AWG импортируются оба контейнера", async () => {
  const key = amneziaKey({
    containers: [openvpnContainer(), awgContainer()],
    defaultContainer: "amnezia-awg2",
    description: "Mixed",
  });
  const { profiles, unsupported } = await parseAmneziaKey(key);
  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles.map((profile) => profile.proto), ["wireguard", "openvpn"]);
  assert.deepEqual(profiles.map((profile) => profile.name), ["Mixed · AmneziaWG", "Mixed · OpenVPN"]);
  assert.deepEqual(unsupported, []);
});

test("OpenVPN импортируется, Cloak остаётся неподдерживаемым, без конфигурации — ошибка", async () => {
  const { profiles, unsupported } = await parseAmneziaKey(amneziaKey({ containers: [openvpnContainer()] }));
  assert.equal(profiles[0].proto, "openvpn");
  assert.equal(profiles[0].ovpn, OPENVPN);
  assert.deepEqual(unsupported, []);
  assert.equal(nodeConfigIssue(profiles[0]), null);
  await assert.rejects(
    parseAmneziaKey(amneziaKey({ containers: [{ container: "amnezia-openvpn-cloak" }] })),
    /Cloak/,
  );
  await assert.rejects(
    parseAmneziaKey(amneziaKey({ containers: [{ container: "amnezia-openvpn", openvpn: { last_config: "{}" } }] })),
    /Amnezia/,
  );
  // An Amnezia service key: API access instead of a server.
  await assert.rejects(
    parseAmneziaKey(amneziaKey({ api_config: { service: "x" }, auth_data: { token: "t" } })),
    /Amnezia/,
  );
  await assert.rejects(parseAmneziaKey("vpn://bm90LWpzb24"), /Amnezia/);
});

test("AmneziaWG 3: защита заголовков требует S1..S4 не меньше 12 и 32-байтный ключ", () => {
  const issue = (shaping) => nodeConfigIssue(parseWireguardConf(conf(shaping), "x"));
  assert.equal(issue(AWG3), null);
  assert.deepEqual(issue(AWG3.replace("S4 = 14", "S4 = 8")), { code: "wgHeaderKey" });
  assert.deepEqual(issue(AWG3.replace(HEADER_KEY, "c2hvcnQ=")), { code: "wgHeaderKey" });
  const hexKey = Buffer.from(HEADER_KEY, "base64").toString("hex");
  assert.equal(issue(AWG3.replace(HEADER_KEY, hexKey)), null);
  assert.deepEqual(issue(AWG3.replace("ContentPaddingAddition = 16-64", "ContentPaddingAddition = 16-9000")), { code: "wgContentPadding" });
});

test("RandomTrailers = off и мусор: off не включает, мусор называется", () => {
  const off = parseWireguardConf(conf("RandomTrailers = off"), "x");
  assert.equal("randomTrailers" in off.awg, false);
  assert.equal(isAmneziaWg3(off.awg), false);
  const junk = parseWireguardConf(conf("RandomTrailers = maybe"), "x");
  assert.ok(junk.ignored.includes("RandomTrailers"));
});

test("экспорт .conf сохраняет поля AmneziaWG 3", () => {
  const profile = parseWireguardConf(conf(AWG3), "x");
  const text = wireguardConfText(profile);
  assert.match(text, /^HeaderProtectionKey = /m);
  assert.match(text, /^ContentPaddingAddition = 16-64$/m);
  assert.match(text, /^RandomTrailers = on$/m);
  assert.deepEqual(parseWireguardConf(text, "x").awg, profile.awg);
});

test("профиль без полей v3 не получает новых ключей", () => {
  const plain = parseWireguardConf(conf("Jc = 4\nJmin = 8\nJmax = 80"), "x");
  for (const key of ["headerProtectionKey", "contentPaddingAddition", "randomTrailers"]) {
    assert.equal(key in plain.awg, false);
  }
});
