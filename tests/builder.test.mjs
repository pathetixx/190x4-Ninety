// buildConfig: смоук всей сборки + two-core разводка мостов и TOML-экранирование.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfig, bridgeNeeds, parseVless } from "/lib/singbox.js";
import { DEFAULT_OPTIONS } from "/lib/options.js";

const vlessNode = (over = {}) => ({
  ...parseVless("vless://uuid@srv.example.com:443?security=tls&sni=s.example.com"),
  ...over,
});

test("одиночный профиль: outbound proxy + direct, mixed-inbound", () => {
  const { config, xray, sidecars } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  assert.equal(xray, null);
  assert.deepEqual(sidecars, []);
  const tags = config.outbounds.map((o) => o.tag);
  assert.ok(tags.includes("proxy"));
  assert.ok(tags.includes("direct"));
  assert.equal(config.inbounds.length, 1);
  assert.equal(config.inbounds[0].type, "mixed");
});

test("подписка из 2+ нод: selector/balancer/urltest", () => {
  const nodes = [vlessNode({ name: "A" }), vlessNode({ name: "B" })];
  const { config } = buildConfig({
    source: { kind: "sub", subscription: { name: "S" }, nodes },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  const byTag = Object.fromEntries(config.outbounds.map((o) => [o.tag, o]));
  assert.equal(byTag.proxy.type, "selector");
  assert.equal(byTag.auto.type, "balancer");
  assert.equal(byTag.lowest.type, "urltest");
  assert.equal(byTag.proxy.default, "auto");
});

test("two-core: xhttp-нода уходит в xray, в sing-box — socks-мост", () => {
  const xhttp = vlessNode({ type: "xhttp", path: "/x", mode: "auto" });
  const { config, xray } = buildConfig({
    source: { kind: "single", profile: xhttp },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
    xray: true,
  });
  assert.ok(xray, "xray-конфиг должен собраться");
  assert.equal(xray.inbounds[0].port, 31100); // дефолтная база
  assert.equal(xray.inbounds[0].listen, "127.0.0.1");
  assert.equal(xray.outbounds[0].protocol, "vless");
  const bridge = config.outbounds.find((o) => o.tag === "proxy");
  assert.equal(bridge.type, "socks");
  assert.equal(bridge.server_port, 31100);
});

test("bridgePorts: план портов подменяет дефолтные базы", () => {
  const xhttp = vlessNode({ type: "xhttp" });
  const { config, xray } = buildConfig({
    source: { kind: "single", profile: xhttp },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
    xray: true,
    bridgePorts: { xray: 40000, naive: 40100, trusttunnel: 40200 },
  });
  assert.equal(xray.inbounds[0].port, 40000);
  const bridge = config.outbounds.find((o) => o.tag === "proxy");
  assert.equal(bridge.server_port, 40000);
});

test("bridgeNeeds: счётчики мостов по типам нод", () => {
  const nodes = [
    vlessNode(),
    vlessNode({ type: "xhttp" }),
    { proto: "naive", host: "n", port: 1, username: "u", password: "p", scheme: "https" },
    { proto: "trusttunnel", hostname: "t", addresses: ["1.2.3.4"], username: "u", password: "p" },
  ];
  assert.deepEqual(bridgeNeeds(nodes), { xray: 1, naive: 1, trusttunnel: 1 });
  assert.deepEqual(bridgeNeeds([]), { xray: 0, naive: 0, trusttunnel: 0 });
});

test("TrustTunnel sidecar: TOML-экранирование управляющих символов", () => {
  const tt = {
    proto: "trusttunnel",
    hostname: "tt.example.com",
    addresses: ["1.2.3.4"],
    username: 'user"quote',
    password: "line1\nline2\ttab\\slash",
  };
  const { sidecars } = buildConfig({
    source: { kind: "single", profile: tt },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  assert.equal(sidecars.length, 1);
  const toml = sidecars[0].config;
  // Ни одной сырой многострочной строки: \n внутри значений экранированы.
  for (const line of toml.split("\n")) {
    const quotes = (line.match(/(?<!\\)"/g) || []).length;
    assert.equal(quotes % 2, 0, `непарная кавычка (сырой перенос?): ${line}`);
  }
  assert.ok(toml.includes('password = "line1\\nline2\\ttab\\\\slash"'));
  assert.ok(toml.includes('username = "user\\"quote"'));
  assert.ok(toml.includes(`address = "127.0.0.1:${sidecars[0].port}"`));
});

test("naive sidecar: креды url-энкодятся в proxy-URL", () => {
  const nv = { proto: "naive", host: "n.example.com", port: 443, username: "u@x", password: "p:w", scheme: "https" };
  const { sidecars } = buildConfig({
    source: { kind: "single", profile: nv },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  const cfg = JSON.parse(sidecars[0].config);
  assert.equal(cfg.proxy, "https://u%40x:p%3Aw@n.example.com:443");
  assert.equal(cfg.listen, `socks://127.0.0.1:${sidecars[0].port}`);
});

test("tun-режим: единственный inbound — tun", () => {
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "tun",
    options: DEFAULT_OPTIONS,
  });
  assert.equal(config.inbounds.length, 1);
  assert.equal(config.inbounds[0].type, "tun");
});

test("clash-api включается опцией experimental.enableClashApi", () => {
  const opts = { ...DEFAULT_OPTIONS, experimental: { ...DEFAULT_OPTIONS.experimental, enableClashApi: true } };
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "proxy",
    options: opts,
  });
  assert.ok(config.experimental.clash_api.external_controller.startsWith("127.0.0.1:"));
});
