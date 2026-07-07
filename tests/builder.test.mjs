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

test("tun-режим: tun-inbound + probe-in, правило пробы выше bypass", () => {
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "tun",
    options: DEFAULT_OPTIONS,
  });
  assert.equal(config.inbounds.length, 2);
  assert.equal(config.inbounds[0].type, "tun");
  const probe = config.inbounds[1];
  assert.equal(probe.tag, "probe-in");
  assert.equal(probe.type, "mixed");
  assert.equal(probe.listen, "127.0.0.1");
  // Правило probe-in → proxy обязано стоять ВЫШЕ bypass-правила Ninety.exe,
  // иначе проба качества уходит в direct и меряет голый канал вместо туннеля.
  const rules = config.route.rules;
  const probeIdx = rules.findIndex((r) => Array.isArray(r.inbound) && r.inbound.includes("probe-in"));
  const bypassIdx = rules.findIndex((r) => Array.isArray(r.process_name) && r.process_name.includes("Ninety.exe"));
  assert.ok(probeIdx >= 0, "нет правила probe-in");
  assert.ok(bypassIdx >= 0, "нет bypass-правила Ninety.exe");
  assert.ok(probeIdx < bypassIdx, "probe-in ниже bypass — проба пойдёт в direct");
  assert.equal(rules[probeIdx].outbound, "proxy");
  // Bypass обязан покрывать ВСЕ движки, дозванивающиеся наружу (= ENGINES в
  // killswitch.rs): пропущенный sidecar петлял бы через TUN сам в себя.
  for (const exe of ["sing-box.exe", "xray.exe", "naive.exe", "trusttunnel_client.exe"]) {
    assert.ok(rules[bypassIdx].process_name.includes(exe), `нет bypass для ${exe}`);
  }
});

test("proxy-режим: единственный inbound — mixed (без probe-in)", () => {
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  assert.equal(config.inbounds.length, 1);
  assert.equal(config.inbounds[0].type, "mixed");
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

test("WARP direct: custom action proxy идёт в warp, а не мимо него", () => {
  const opts = structuredClone(DEFAULT_OPTIONS);
  opts.warp.enabled = true;
  opts.warp.mode = "direct";
  opts.route.customRules = [{
    id: "r1",
    enabled: true,
    type: "domain",
    match: "suffix",
    values: ["example.com"],
    action: "proxy",
  }];
  const warpInfo = {
    private_key: "priv",
    peer_public_key: "peer",
    client_id: "AAAA",
    local_ipv4: "172.16.0.2",
  };
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "proxy",
    options: opts,
    warpInfo,
  });
  assert.equal(config.route.final, "warp");
  const rule = config.route.rules.find((r) => r.domain_suffix?.includes("example.com"));
  assert.equal(rule.outbound, "warp");
  assert.ok(config.route.rule_set.every((rs) => rs.download_detour === "warp"));
});

test("WARP direct может собраться без активного профиля или подписки", () => {
  const opts = structuredClone(DEFAULT_OPTIONS);
  opts.warp.enabled = true;
  opts.warp.mode = "direct";
  const warpInfo = {
    private_key: "priv",
    peer_public_key: "peer",
    client_id: "AAAA",
    local_ipv4: "172.16.0.2",
  };
  const { config, xray, sidecars } = buildConfig({
    source: null,
    mode: "proxy",
    options: opts,
    warpInfo,
  });
  assert.equal(xray, null);
  assert.deepEqual(sidecars, []);
  assert.equal(config.route.final, "warp");
  assert.deepEqual(config.endpoints.map((e) => e.tag), ["warp"]);
  assert.deepEqual(config.outbounds.map((o) => o.tag), ["direct"]);
  assert.ok(config.route.rule_set.every((rs) => rs.download_detour === "warp"));
});
