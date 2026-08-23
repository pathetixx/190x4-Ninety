// Отбраковка нод, которые ядро не принимает: одна такая нода валит
// инициализацию всего конфига ("initialize outbound[N]: invalid public_key"),
// то есть целую подписку.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || {};
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const {
  nodeConfigIssue,
  normalizeRealityPublicKey,
  partitionNodes,
} = await import("/lib/node-validation.js");
const { parseVless } = await import("/lib/singbox.js");

const PBK = "0i4XeZ4CjhIRfQvvyPP6mQR5X5Ov1DKV0KRWFhvQF1s"; // 32 байта base64url

test("reality без public_key отбраковывается", () => {
  const node = parseVless("vless://uuid@1.2.3.4:443?security=reality&sni=a.example&sid=ab");
  assert.deepEqual(nodeConfigIssue(node), { code: "realityKey" });
});

test("reality с корректным ключом проходит", () => {
  const node = parseVless(`vless://uuid@1.2.3.4:443?security=reality&sni=a.example&pbk=${PBK}&sid=abcd`);
  assert.equal(nodeConfigIssue(node), null);
});

test("ключ в обычном base64 и с паддингом приводится к виду, который принимает ядро", () => {
  const std = PBK.replace(/-/g, "+").replace(/_/g, "/") + "=";
  assert.equal(normalizeRealityPublicKey(std), PBK);
  assert.equal(normalizeRealityPublicKey("короткий"), "");
  assert.equal(normalizeRealityPublicKey(""), "");
});

test("битый short_id отбраковывается, пустой — нет", () => {
  const bad = parseVless(`vless://uuid@1.2.3.4:443?security=reality&pbk=${PBK}&sid=zz`);
  assert.deepEqual(nodeConfigIssue(bad), { code: "realityShortId" });
  const odd = parseVless(`vless://uuid@1.2.3.4:443?security=reality&pbk=${PBK}&sid=abc`);
  assert.deepEqual(nodeConfigIssue(odd), { code: "realityShortId" });
  const empty = parseVless(`vless://uuid@1.2.3.4:443?security=reality&pbk=${PBK}`);
  assert.equal(nodeConfigIssue(empty), null);
});

test("обычный TLS без reality-полей валиден", () => {
  const node = parseVless("vless://uuid@1.2.3.4:443?security=tls&type=ws&path=/x");
  assert.equal(nodeConfigIssue(node), null);
});

test("нода без адреса или с невозможным портом отбраковывается", () => {
  assert.deepEqual(nodeConfigIssue({ proto: "vless", host: "", port: 443 }), { code: "endpoint" });
  assert.deepEqual(nodeConfigIssue({ proto: "vless", host: "a.example", port: 0 }), { code: "endpoint" });
});

test("sidecar-протоколы ядро не разбирает — их не отбраковываем", () => {
  assert.equal(nodeConfigIssue({ proto: "naive", host: "a.example", port: 443 }), null);
  assert.equal(nodeConfigIssue({ proto: "trusttunnel", host: "a.example", port: 443 }), null);
});

test("partitionNodes делит список и сохраняет порядок пригодных", () => {
  const good = parseVless(`vless://uuid@good.example:443?security=reality&pbk=${PBK}`);
  const bad = parseVless("vless://uuid@bad.example:443?security=reality");
  const { usable, skipped } = partitionNodes([good, bad, good]);
  assert.equal(usable.length, 2);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].issue.code, "realityKey");
  assert.equal(usable[0].host, "good.example");
});

// Значения, которые ядро проверяет строго (списки сняты с его исходников).
// Любое непринятое значение = FATAL на инициализации = мёртвая подписка целиком.
const { normalizeFlow, normalizeFingerprint } = await import("/lib/node-validation.js");

test("flow: xray-суффикс -udp443 снимается, всё чужое отбраковывается", () => {
  assert.equal(normalizeFlow("xtls-rprx-vision-udp443"), "xtls-rprx-vision");
  assert.equal(normalizeFlow("xtls-rprx-vision"), "xtls-rprx-vision");
  assert.equal(normalizeFlow(""), "");
  assert.equal(normalizeFlow("xtls-rprx-direct"), null);

  const node = parseVless("vless://uuid@1.2.3.4:443?security=tls&flow=xtls-rprx-vision-udp443");
  assert.equal(nodeConfigIssue(node), null, "нода с -udp443 чинится, а не выбрасывается");
  const alien = parseVless("vless://uuid@1.2.3.4:443?security=tls&flow=xtls-rprx-direct");
  assert.deepEqual(nodeConfigIssue(alien), { code: "flow" });
});

test("неизвестный отпечаток uTLS подменяется на chrome, известные не трогаются", () => {
  assert.equal(normalizeFingerprint("randomizednoalpn"), "chrome");
  assert.equal(normalizeFingerprint(""), "chrome");
  assert.equal(normalizeFingerprint("android"), "android");
  assert.equal(normalizeFingerprint("random"), "random");
});

test("vmess: ядро знает конечный список шифров", () => {
  const base = { proto: "vmess", host: "a.example", port: 443, uuid: "u" };
  assert.equal(nodeConfigIssue({ ...base, security: "AES-128-GCM" }), null);
  assert.equal(nodeConfigIssue({ ...base, security: "auto" }), null);
  assert.deepEqual(nodeConfigIssue({ ...base, security: "aes-256-gcm" }), { code: "vmessSecurity" });
});

test("shadowsocks: метод обязателен и должен быть из списка ядра", () => {
  const base = { proto: "shadowsocks", host: "a.example", port: 443, password: "p" };
  assert.equal(nodeConfigIssue({ ...base, method: "2022-blake3-aes-128-gcm" }), null);
  assert.deepEqual(nodeConfigIssue({ ...base, method: "" }), { code: "ssMethod" });
  assert.deepEqual(nodeConfigIssue({ ...base, method: "aes-256-gcm-siv" }), { code: "ssMethod" });
});

test("hysteria2: obfs только salamander и только с паролем", () => {
  const base = { proto: "hysteria2", host: "a.example", port: 443, password: "p" };
  assert.equal(nodeConfigIssue({ ...base }), null);
  assert.equal(nodeConfigIssue({ ...base, obfs: "salamander", obfsPassword: "x" }), null);
  assert.deepEqual(nodeConfigIssue({ ...base, obfs: "salamander" }), { code: "obfs" });
  assert.deepEqual(nodeConfigIssue({ ...base, obfs: "other", obfsPassword: "x" }), { code: "obfs" });
});

test("tuic: неизвестный алгоритм контроля перегрузки отбраковывается", () => {
  const base = { proto: "tuic", host: "a.example", port: 443, uuid: "u", password: "p" };
  assert.equal(nodeConfigIssue({ ...base, congestionControl: "bbr" }), null);
  assert.equal(nodeConfigIssue({ ...base, congestionControl: "" }), null);
  assert.deepEqual(nodeConfigIssue({ ...base, congestionControl: "reno" }), { code: "congestion" });
});

// ── WireGuard ──────────────────────────────────────────────
// Endpoint инициализируется тем же проходом, что и outbound'ы: битый ключ или
// невозможный шейпинг роняют весь конфиг, а не одну ноду. Инварианты шейпинга
// повторяют те, что проверяет ядро (noise/amnezia.go).
const { parseWireguardConf } = await import("/lib/singbox.js");

const WG_PRIVATE = "nlhuTLXG3gAV8AJmw8jYngX3QkwdDoSPi2HxhGGSKrs=";
const WG_PUBLIC = "zjVMotkY/dyEZygQ7crKvCtV1ODNZkVx1xe/1Bvvo8A=";
const wgNode = (extra = "") => parseWireguardConf(`[Interface]
Address = 172.16.0.2/32
PrivateKey = ${WG_PRIVATE}
${extra}
[Peer]
AllowedIPs = 0.0.0.0/0
Endpoint = 162.159.192.1:2408
PublicKey = ${WG_PUBLIC}`, "WG");

test("wireguard: корректный профиль проходит, битые ключи и адреса — нет", () => {
  assert.equal(nodeConfigIssue(wgNode()), null);
  assert.deepEqual(nodeConfigIssue({ ...wgNode(), privateKey: "короткий" }), { code: "wgPrivateKey" });
  assert.deepEqual(nodeConfigIssue({ ...wgNode(), addresses: [] }), { code: "wgAddress" });
  assert.deepEqual(nodeConfigIssue({ ...wgNode(), addresses: ["172.16.0.2"] }), { code: "wgAddress" });
  assert.deepEqual(nodeConfigIssue({ ...wgNode(), peers: [] }), { code: "wgPeer" });
  const node = wgNode();
  assert.deepEqual(
    nodeConfigIssue({ ...node, peers: [{ ...node.peers[0], publicKey: "короткий" }] }),
    { code: "wgPublicKey" },
  );
});

test("wireguard: невозможный шейпинг AmneziaWG отбраковывается", () => {
  assert.equal(nodeConfigIssue(wgNode("Jc = 4\nJmin = 8\nJmax = 80")), null);
  assert.deepEqual(nodeConfigIssue(wgNode("Jc = 4\nJmin = 80\nJmax = 8")), { code: "wgJunkSize" });
  assert.deepEqual(nodeConfigIssue(wgNode("Jc = 4")), { code: "wgJunkSize" });
  assert.deepEqual(nodeConfigIssue(wgNode("Jc = 500\nJmin = 8\nJmax = 80")), { code: "wgJunkCount" });
  // S1 + 148 == S2 + 92: init и response станут одной длины, и получатель
  // перестанет их различать.
  assert.deepEqual(nodeConfigIssue(wgNode("S1 = 0\nS2 = 56")), { code: "wgHandshakeJunk" });
  assert.equal(nodeConfigIssue(wgNode("S1 = 15\nS2 = 20")), null);
  assert.deepEqual(
    nodeConfigIssue(wgNode("H1 = 555\nH2 = 555\nH3 = 777\nH4 = 888")),
    { code: "wgMagicHeaders" },
  );
  assert.equal(nodeConfigIssue(wgNode("H1 = 1\nH2 = 2\nH3 = 3\nH4 = 4")), null);
});
