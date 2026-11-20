// Адреса VPN-серверов и их сборка в конфиг: резолв адреса сервера не должен
// зависеть от этого же подключения, шифрование VLESS не должно теряться, а
// строгий режим — пропускать клиенты, которые резолвят домен сами.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfig, parseLink } from "/lib/singbox.js";
import { DEFAULT_OPTIONS } from "/lib/options.js";
import { createStrictPrivacyPolicy } from "/lib/strict-privacy-policy.js";
import { nodeConfigIssue } from "/lib/node-validation.js";

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k), clear: () => store.clear(),
};

const UUID = "11111111-2222-3333-4444-555555555555";
const PBK = "Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw";

test("«адреса сайтов внутри туннеля»: адрес сервера резолвится прямым DNS, а не через сам сервер", () => {
  const opts = structuredClone(DEFAULT_OPTIONS);
  opts.route.resolveDestination = true;
  const nodes = [
    parseLink(`vless://${UUID}@a.example.com:443?security=tls&sni=a.example.com#A`),
    parseLink("trojan://pw@b.example.com:443?security=tls#B"),
    parseLink(`vless://${UUID}@203.0.113.7:443?security=tls#IP`),
  ].map((n, i) => ({ ...n, stableId: `s${i}` }));
  for (const mode of ["proxy", "systemProxy", "tun"]) {
    const { config } = buildConfig({ source: { kind: "sub", subscription: { id: "x" }, nodes }, mode, options: opts });
    assert.equal(config.route.default_domain_resolver.server, "dns-remote");
    const servers = config.outbounds.filter((o) => o.server && o.server !== "127.0.0.1");
    for (const o of servers) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(o.server)) assert.equal(o.domain_resolver, undefined);
      else assert.equal(o.domain_resolver, "dns-direct", `${mode}: ${o.server}`);
    }
  }
});

test("«адреса сайтов внутри туннеля»: доменный пир WARP резолвится прямым DNS", () => {
  const opts = structuredClone(DEFAULT_OPTIONS);
  opts.route.resolveDestination = true;
  opts.warp.enabled = true;
  opts.warp.mode = "direct";
  const { config } = buildConfig({
    source: null, mode: "proxy", options: opts,
    warpInfo: { private_key: "k", peer_public_key: "p", client_id: "AAAA", local_ipv4: "172.16.0.2" },
  });
  const warp = config.endpoints.find((e) => e.tag === "warp");
  assert.equal(warp.domain_resolver, "dns-direct");
});

test("VLESS с шифрованием на обычном TCP идёт через xray и сохраняет шифрование", () => {
  const p = parseLink(`vless://${UUID}@srv.example.com:443?encryption=mlkem768x25519plus.native.0rtt.AAAA`
    + `&security=reality&pbk=${PBK}&sid=ab&sni=www.example.com&flow=xtls-rprx-vision&type=tcp#ML`);
  assert.equal(nodeConfigIssue(p), null);
  const { config, xray } = buildConfig({ source: { kind: "single", profile: p }, mode: "proxy", options: DEFAULT_OPTIONS, xray: true });
  const ob = config.outbounds.find((o) => o.tag === "proxy");
  assert.equal(ob.type, "socks", "в sing-box остаётся локальный мост");
  const xo = xray.outbounds[0];
  assert.equal(xo.protocol, "vless");
  assert.equal(xo.settings.vnext[0].users[0].encryption, "mlkem768x25519plus.native.0rtt.AAAA");
  assert.equal(xo.streamSettings.network, "raw");
  assert.equal(xo.streamSettings.security, "reality");
});

test("VLESS с шифрованием на неподдержанном мостом транспорте отсеивается с причиной", () => {
  const p = parseLink(`vless://${UUID}@srv.example.com:443?encryption=mlkem768x25519plus.native.0rtt.AAAA&type=ws&security=tls#WS`);
  assert.deepEqual(nodeConfigIssue(p), { code: "encryption" });
});

test("строгий режим отвергает mKCP-ноду с доменом: xray резолвит его сам", () => {
  const p = parseLink(`vless://${UUID}@kcp.example.com:443?type=kcp&headerType=none&security=none#K`);
  assert.throws(() => buildConfig({
    source: { kind: "single", profile: p }, mode: "tun", options: DEFAULT_OPTIONS, xray: true,
    runtimePolicy: createStrictPrivacyPolicy({ selectedNodeTag: null }),
  }), (err) => err?.code === "STRICT_PRIVACY_BOOTSTRAP_UNSAFE");
});

test("TUIC и SS с целиком закодированным логином импортируются", () => {
  const tuic = parseLink(`tuic://${UUID}%3Apw@h.example:443#T`);
  assert.equal(tuic.uuid, UUID);
  assert.equal(tuic.password, "pw");
  const ss = parseLink("ss://aes-256-gcm%3Asecret@s.example:8388#S");
  assert.equal(ss.method, "aes-256-gcm");
  assert.equal(ss.password, "secret");
});

test("закодированный разделитель раньше буквального двоеточия в пароле", () => {
  const ss = parseLink("ss://aes-256-gcm%3Apa:ss@s.example:8388#S");
  assert.equal(ss.method, "aes-256-gcm");
  assert.equal(ss.password, "pa:ss");
  const tuic = parseLink(`tuic://${UUID}%3Ap:w@h.example:443#T`);
  assert.equal(tuic.uuid, UUID);
  assert.equal(tuic.password, "p:w");
  const plain = parseLink(`tuic://${UUID}:p%3Aw@h.example:443#T`);
  assert.equal(plain.password, "p:w");
});

test("xray-мост получает прямой DoH, а UDP и IPv6-скобки не ломают конфиг", () => {
  const p = parseLink(`vless://${UUID}@x.example.com:443?type=xhttp&security=tls&sni=x.example.com#X`);
  const build = (directAddress) => {
    const opts = structuredClone(DEFAULT_OPTIONS);
    opts.dns.directAddress = directAddress;
    return buildConfig({ source: { kind: "single", profile: p }, mode: "proxy", options: opts, xray: true }).xray;
  };
  const doh = build("https://8.8.8.8/dns-query");
  assert.deepEqual(doh.dns, { servers: ["https+local://8.8.8.8/dns-query"] });
  assert.equal(doh.outbounds[0].streamSettings.sockopt.domainStrategy, "UseIP");
  assert.deepEqual(build("https://[2001:4860:4860::8888]/dns-query").dns,
    { servers: ["https+local://[2001:4860:4860::8888]/dns-query"] });
  const udp = build("77.88.8.8");
  assert.equal(udp.dns, undefined, "обычный UDP ушёл бы через прокси-outbound");
  assert.equal(udp.outbounds[0].streamSettings.sockopt, undefined);
});

test("VLESS с неизвестным форматом шифрования отсеивается, а не роняет мост", () => {
  const p = parseLink(`vless://${UUID}@srv.example.com:443?encryption=aes-128-gcm&type=tcp&security=tls#BAD`);
  assert.deepEqual(nodeConfigIssue(p), { code: "encryption" });
});
