// AmneziaWG 2.0: S3/S4 и диапазоны «от-до» в H1..H4. Профиль 2.0 обязан
// доехать до ядра целиком — потерянный S4 или диапазон, ставший нулём, дают
// тоннель, который говорит с пиром не на том протоколе и молча не поднимается.
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

const {
  awgHeaderRange,
  isAmneziaWg2,
  parseAwgHeader,
  parseWireguardConf,
  wireguardConfText,
} = await import("/lib/protocol-parsers.js");
const { nodeConfigIssue } = await import("/lib/node-validation.js");
const { buildConfig } = await import("/lib/singbox.js");
const { nodeSemanticFingerprint } = await import("/lib/runtime-identity.js");

const WG_PRIVATE = "nlhuTLXG3gAV8AJmw8jYngX3QkwdDoSPi2HxhGGSKrs=";
const WG_PUBLIC = "zjVMotkY/dyEZygQ7crKvCtV1ODNZkVx1xe/1Bvvo8A=";
const conf = (shaping) => `[Interface]
PrivateKey = ${WG_PRIVATE}
Address = 10.8.1.2/32
${shaping}

[Peer]
PublicKey = ${WG_PUBLIC}
Endpoint = 203.0.113.7:51820
AllowedIPs = 0.0.0.0/0`;

const AWG2 = `Jc = 4
Jmin = 10
Jmax = 50
S1 = 34
S2 = 79
S3 = 21
S4 = 9
H1 = 1838470129-1889212337
H2 = 2041375233-2110293281
H3 = 2117103522-2135921844
H4 = 2139853361-2141911022
I1 = <b 0xc0ffee><r 16>`;

function endpointOf(profile) {
  const { config } = buildConfig({ source: { kind: "single", profile }, mode: "vpn" });
  return config.endpoints.find((e) => e.type === "wireguard");
}

test("parseAwgHeader: число для 1.x, строка «от-до» для 2.0, мусор — null", () => {
  assert.equal(parseAwgHeader(""), 0);
  assert.equal(parseAwgHeader(undefined), 0);
  assert.equal(parseAwgHeader("1020983529"), 1020983529);
  assert.equal(parseAwgHeader(1020983529), 1020983529);
  assert.equal(parseAwgHeader("100-200"), "100-200");
  assert.equal(parseAwgHeader(" 100 - 200 "), "100-200");
  assert.equal(parseAwgHeader("300-300"), 300, "вырожденный диапазон — это одно значение");
  assert.equal(parseAwgHeader("200-100"), null);
  assert.equal(parseAwgHeader("4294967296"), null);
  assert.equal(parseAwgHeader("abc"), null);
  assert.equal(parseAwgHeader("1-2-3"), null);
  assert.deepEqual(awgHeaderRange("100-200"), { from: 100, to: 200 });
  assert.deepEqual(awgHeaderRange(7), { from: 7, to: 7 });
  assert.equal(awgHeaderRange(0), null);
});

test(".conf AmneziaWG 2.0 разбирается целиком, без «непереносимых» полей", () => {
  const p = parseWireguardConf(conf(AWG2), "AWG2");
  assert.equal(p.awg.s3, 21);
  assert.equal(p.awg.s4, 9);
  assert.deepEqual(
    [p.awg.h1, p.awg.h2, p.awg.h3, p.awg.h4],
    ["1838470129-1889212337", "2041375233-2110293281", "2117103522-2135921844", "2139853361-2141911022"],
  );
  assert.deepEqual(p.ignored, []);
  assert.equal(isAmneziaWg2(p.awg), true);
  assert.equal(nodeConfigIssue(p), null);
});

test("ядро получает S3/S4 и диапазоны как есть", () => {
  const ep = endpointOf(parseWireguardConf(conf(AWG2), "AWG2"));
  const amnezia = ep.noise.amnezia;
  assert.equal(amnezia.s1, 34);
  assert.equal(amnezia.s3, 21);
  assert.equal(amnezia.s4, 9);
  assert.equal(amnezia.h1, "1838470129-1889212337");
  assert.equal(amnezia.h4, "2139853361-2141911022");
  assert.equal(amnezia.i1, "<b 0xc0ffee><r 16>");
});

test("профиль 1.x не меняется: ни новых полей, ни нового отпечатка", () => {
  const shaping = "Jc = 4\nJmin = 8\nJmax = 80\nS1 = 15\nS2 = 20\nH1 = 1020983529\nH2 = 1449520552\nH3 = 1120404579\nH4 = 1741401686";
  const p = parseWireguardConf(conf(shaping), "AWG1");
  assert.equal("s3" in p.awg, false);
  assert.equal("s4" in p.awg, false);
  assert.equal(p.awg.h1, 1020983529);
  assert.equal(isAmneziaWg2(p.awg), false);
  // Отпечаток профиля, сохранённого до 2.0, совпадает со свежим разбором.
  const legacy = { ...p, awg: { ...p.awg } };
  assert.equal(nodeSemanticFingerprint(legacy), nodeSemanticFingerprint(parseWireguardConf(conf(shaping), "AWG1")));
  const amnezia = endpointOf(p).noise.amnezia;
  assert.equal(amnezia.h1, 1020983529);
  assert.equal("s4" in amnezia, false);
});

test("S4 без остального — тоже шейпинг 2.0, заголовки остаются типами WireGuard", () => {
  const p = parseWireguardConf(conf("S4 = 16"), "S4");
  assert.equal(isAmneziaWg2(p.awg), true);
  const amnezia = endpointOf(p).noise.amnezia;
  assert.equal(amnezia.s4, 16);
  assert.equal("h1" in amnezia, false);
});

test("пересекающиеся диапазоны и запредельные S3/S4 отбраковываются", () => {
  const bad = (shaping) => nodeConfigIssue(parseWireguardConf(conf(shaping), "bad"));
  assert.deepEqual(bad("H1 = 100-200\nH2 = 150-250\nH3 = 300\nH4 = 400"), { code: "wgMagicHeaders" });
  assert.deepEqual(bad("H1 = 100-500\nH2 = 250\nH3 = 600\nH4 = 700"), { code: "wgMagicHeaders" });
  // Незаданный H дополняется типом WireGuard — и тоже не должен попасть в чужой диапазон.
  assert.deepEqual(bad("H1 = 1-100\nH2 = 200\nH3 = 300\nH4 = 400"), null);
  assert.deepEqual(bad("H2 = 1-100\nH3 = 300\nH4 = 400"), { code: "wgMagicHeaders" });
  assert.deepEqual(bad("S3 = 5000"), { code: "wgHandshakeJunk" });
  assert.deepEqual(bad("S4 = 1000"), { code: "wgTransportJunk" });
  assert.equal(bad("H1 = 100-200\nH2 = 201-300\nH3 = 301-400\nH4 = 401-500"), null);
});

test("нечитаемый H называется среди непереносимых, а не становится нулём молча", () => {
  const p = parseWireguardConf(conf("H1 = 200-100\nH2 = 2\nH3 = 3\nH4 = 4"), "x");
  assert.ok(p.ignored.includes("H1"));
  assert.equal(p.awg.h1, 0);
});

test("экспорт .conf возвращает S3/S4 и диапазоны в исходном виде", () => {
  const text = wireguardConfText(parseWireguardConf(conf(AWG2), "AWG2"));
  assert.match(text, /^S3 = 21$/m);
  assert.match(text, /^S4 = 9$/m);
  assert.match(text, /^H1 = 1838470129-1889212337$/m);
  const again = parseWireguardConf(text, "AWG2");
  assert.deepEqual(again.awg, parseWireguardConf(conf(AWG2), "AWG2").awg);
});
