// Протоколы и транспорты, добавленные поверх исходного набора: разбор ссылок и
// то, что уезжает в конфиг. Поля и их имена сверены с исходниками ядра.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || {};
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const {
  buildConfig, bridgeNeeds, needsXrayBridge, parseLink, parseVless,
} = await import("/lib/singbox.js");
const { nodeConfigIssue } = await import("/lib/node-validation.js");
const { DEFAULT_OPTIONS } = await import("/lib/options.js");
const { detectAddInput } = await import("/lib/subscriptions.js");

const single = (profile, extra = {}) => buildConfig({
  source: { kind: "single", profile }, mode: "proxy", options: DEFAULT_OPTIONS, ...extra,
}).config.outbounds.find(o => o.tag === "proxy");

test("anytls: ссылка разбирается и собирается в outbound ядра", () => {
  const node = parseLink("anytls://p%40ss@a.example:8443?sni=cdn.example&insecure=1&alpn=h2#AT");
  assert.equal(node.proto, "anytls");
  assert.equal(node.password, "p@ss");
  assert.equal(node.name, "AT");
  assert.equal(nodeConfigIssue(node), null);

  const out = single(node);
  assert.equal(out.type, "anytls");
  assert.equal(out.password, "p@ss");
  assert.equal(out.tls.server_name, "cdn.example");
  assert.equal(out.tls.insecure, true);
  assert.deepEqual(out.tls.alpn, ["h2"]);
});

test("hysteria v1: auth/скорости/обфускация уезжают в поля, которые ждёт ядро", () => {
  const node = parseLink("hysteria://a.example:36712?auth=secret&peer=sni.example&upmbps=20&downmbps=100&obfs=xplus&insecure=1#HY1");
  assert.equal(node.proto, "hysteria");
  assert.equal(nodeConfigIssue(node), null);

  const out = single(node);
  assert.equal(out.type, "hysteria");
  assert.equal(out.auth_str, "secret");
  assert.equal(out.obfs, "xplus");
  assert.equal(out.up_mbps, 20);
  assert.equal(out.down_mbps, 100);
  assert.equal(out.tls.server_name, "sni.example");
});

test("hysteria v1 поверх faketcp ядру неизвестен — нода не берётся", () => {
  const node = parseLink("hysteria://a.example:36712?auth=x&protocol=faketcp#HY1");
  assert.deepEqual(nodeConfigIssue(node), { code: "hysteriaProtocol" });
});

test("socks: логин/пароль и версия", () => {
  const node = parseLink("socks5://user:p%40ss@127.0.0.1:1080#local");
  assert.equal(node.proto, "socks");
  const out = single(node);
  assert.equal(out.type, "socks");
  assert.equal(out.version, "5");
  assert.equal(out.username, "user");
  assert.equal(out.password, "p@ss");

  const anon = parseLink("socks://10.0.0.1:1080");
  assert.equal(single(anon).username, undefined);
  assert.equal(parseLink("socks4://10.0.0.1:1080").version, "4");
});

test("httpupgrade и quic собираются транспортом самого ядра", () => {
  const hu = parseVless("vless://uuid@a.example:443?security=tls&type=httpupgrade&path=%2Fup&host=cdn.example");
  const huOut = single(hu);
  assert.deepEqual(huOut.transport, { type: "httpupgrade", host: "cdn.example", path: "/up" });

  const quic = parseVless("vless://uuid@a.example:443?security=tls&type=quic");
  assert.deepEqual(single(quic).transport, { type: "quic" });
});

test("quic с шифрованием транспорта из Xray ядру не по силам — нода не берётся", () => {
  const node = parseVless("vless://uuid@a.example:443?security=tls&type=quic&quicSecurity=aes-128-gcm&key=k");
  assert.deepEqual(nodeConfigIssue(node), { code: "quicSecurity" });
});

test("mKCP уходит на мост xray с обфускацией из ссылки", () => {
  const node = parseVless("vless://uuid@a.example:443?type=kcp&headerType=srtp&seed=abc");
  assert.equal(nodeConfigIssue(node), null);
  assert.ok(needsXrayBridge(node));
  assert.equal(bridgeNeeds([node]).xray, 1);

  const { config, xray } = buildConfig({
    source: { kind: "single", profile: node },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
    xray: true,
  });
  const stream = xray.outbounds[0].streamSettings;
  assert.equal(stream.network, "kcp");
  assert.deepEqual(stream.kcpSettings, { header: { type: "srtp" }, seed: "abc" });
  // В sing-box остаётся только локальный socks-мост.
  const proxy = config.outbounds.find(o => o.tag === "proxy");
  assert.equal(proxy.type, "socks");
  assert.equal(proxy.server, "127.0.0.1");
});

test("неизвестный транспорт больше не собирается молча как обычный TCP", () => {
  const node = parseVless("vless://uuid@a.example:443?security=tls&type=mkcp2");
  assert.deepEqual(nodeConfigIssue(node), { code: "transport" });
});

test("новые схемы распознаются полем добавления", () => {
  assert.equal(detectAddInput("anytls://pass@a.example:443#x").kind, "config");
  assert.equal(detectAddInput("hysteria://a.example:443?auth=x").kind, "config");
  assert.equal(detectAddInput("socks5://127.0.0.1:1080").kind, "config");
  assert.equal(detectAddInput([
    "anytls://pass@a.example:443",
    "socks://127.0.0.1:1080",
  ].join("\n")).kind, "list");
  // http(s) в этом поле по-прежнему означает подписку, а не http-прокси.
  assert.equal(detectAddInput("https://panel.example/sub").kind, "url");
});

// Xray переименовал splithttp в xhttp; панели раздают ссылки со старым именем до
// сих пор. Раньше `raw` (бывший tcp) знали, а `splithttp` — нет, и такая нода
// молча выбрасывалась из подписки как «неизвестный транспорт».
test("splithttp — это xhttp: нода не выбрасывается и уходит на мост", () => {
  const legacy = parseVless("vless://uuid@a.example:443?security=tls&type=splithttp&path=%2Fx");
  assert.equal(legacy.type, "xhttp");
  assert.equal(nodeConfigIssue(legacy), null);
  assert.ok(needsXrayBridge(legacy));

  const modern = parseVless("vless://uuid@a.example:443?security=tls&type=xhttp&path=%2Fx");
  assert.deepEqual(nodeConfigIssue(legacy), nodeConfigIssue(modern));
});

// .conf вставляют в то же поле, что и ссылки: тип определяется сам. Ошибка
// распознавания здесь означает «файл не принят» с подписью «не похоже ни на что».
test("WireGuard .conf распознаётся полем добавления", () => {
  const conf = `[Interface]
Address = 172.16.0.2/32
PrivateKey = nlhuTLXG3gAV8AJmw8jYngX3QkwdDoSPi2HxhGGSKrs=

[Peer]
PublicKey = zjVMotkY/dyEZygQ7crKvCtV1ODNZkVx1xe/1Bvvo8A=
Endpoint = 162.159.192.1:2408
AllowedIPs = 0.0.0.0/0`;
  assert.equal(detectAddInput(conf).kind, "wg-conf");
  assert.equal(detectAddInput(`Jc = 4\n${conf}`).kind, "wg-conf");
  // Без PrivateKey это не профиль, а обрывок: пусть лучше скажет «не распознал».
  assert.equal(detectAddInput("[Interface]\nAddress = 172.16.0.2/32").kind, "unknown");
});
