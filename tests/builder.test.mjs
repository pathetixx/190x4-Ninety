// buildConfig: смоук всей сборки + two-core разводка мостов и TOML-экранирование.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConfig,
  bridgeNeeds,
  ENGINE_PROCESS_NAMES,
  nodeTag,
  parseVless,
  parseVmess,
  parseWireguardConf,
  validateConfigReferences,
} from "/lib/singbox.js";
import { DEFAULT_OPTIONS, REGIONS } from "/lib/options.js";
import { createStrictPrivacyPolicy } from "/lib/strict-privacy-policy.js";

// Строгий туннель включается ровно так же в бою: main.js готовит политику
// через prepareStrictPrivacyRuntime и отдаёт её builder'у как runtimePolicy.
const strictBuild = ({ selectedNodeTag = null, ...args }) =>
  buildConfig({ ...args, runtimePolicy: createStrictPrivacyPolicy({ selectedNodeTag }) });

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

test("process lookup: default route contains a non-routing sentinel", () => {
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  const sentinel = config.route.rules.find((rule) =>
    rule.process_name?.includes("\u0000ninety-force-process-lookup"));
  assert.deepEqual(sentinel, {
    process_name: ["\u0000ninety-force-process-lookup"],
    outbound: "direct",
  });
  assert.equal(config.route.final, "proxy");
});

test("process lookup: explicit false omits the sentinel rule", () => {
  const options = structuredClone(DEFAULT_OPTIONS);
  options.route.processLookup = false;
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "proxy",
    options,
  });
  assert.equal(
    config.route.rules.some((rule) => rule.process_name?.includes("\u0000ninety-force-process-lookup")),
    false,
  );
  assert.equal(config.route.final, "proxy");
});

// Перехватить выданный FakeIP может только TUN-инбаунд. В proxy/systemProxy тот
// же ответ уходит в direct-маршруты и соединение не встаёт, а выглядит это как
// «отдельные приложения не работают», не как проблема DNS.
test("FakeIP применяется только в TUN", () => {
  const options = structuredClone(DEFAULT_OPTIONS);
  options.dns.enableFakeDns = true;
  const source = { kind: "single", profile: vlessNode() };

  for (const mode of ["proxy", "systemProxy"]) {
    const { config } = buildConfig({ source, mode, options });
    assert.equal(
      config.dns.servers.some((server) => server.type === "fakeip"),
      false,
      `FakeIP не должен появляться в режиме ${mode}`,
    );
    assert.equal(config.dns.rules.some((rule) => rule.server === "dns-fake"), false);
  }

  const { config } = buildConfig({ source, mode: "tun", options });
  assert.ok(config.dns.servers.some((server) => server.type === "fakeip"));
  assert.ok(config.dns.rules.some((rule) => rule.server === "dns-fake"));
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
  assert.equal(byTag.proxy.default, "auto");
  // Balancer меряет сам: отдельного urltest-чекера рядом больше нет. Его
  // тикер всё равно не запускался — периодическую проверку urltest-группа
  // включает только когда трафик идёт через неё саму.
  assert.equal(byTag.lowest, undefined);
  assert.equal(byTag.auto.url, DEFAULT_OPTIONS.urlTest.connectionTestUrl);
  assert.equal(byTag.auto.interval, `${DEFAULT_OPTIONS.urlTest.intervalSec}s`);
  // Порог обязан быть заметно меньше типичного разброса задержек, иначе
  // balancer не переключится никогда.
  assert.ok(byTag.auto.tolerance > 0 && byTag.auto.tolerance <= 20,
    "tolerance должен быть меньше разброса между серверами");
  assert.ok(byTag.auto.failure_cooldown, "нода, через которую не дозвониться, обязана выбывать");
});

test("строгая приватность: TUN без direct-исключений и одна закреплённая нода", () => {
  const nodes = [
    vlessNode({ name: "A", host: "a.example.com" }),
    vlessNode({ name: "B", host: "b.example.com" }),
  ];
  const opts = structuredClone(DEFAULT_OPTIONS);
  opts.region = "ru";
  opts.general.disableGeoLookup = false;
  opts.general.allowDirectSubscriptionFallback = true;
  opts.warp.enabled = true;
  opts.warp.autoRescan = true;
  opts.dns.remoteAddress = "https://dns.example/dns-query";
  // Заведомо НЕ дефолтный direct: иначе проверка ниже пройдёт и в случае, если
  // строгий режим вообще ничего не переопределил (дефолты remote и direct
  // совпадают), то есть перестанет что-либо доказывать.
  opts.dns.directAddress = "udp://192.0.2.53";
  opts.dns.enableFakeDns = true;
  opts.route.bypassLan = true;
  opts.route.resolveDestination = false;
  opts.route.ipv6Mode = "only";
  opts.route.tunSplitDiscord = true;
  opts.route.customRules = [
    {
      id: "direct",
      enabled: true,
      type: "domain",
      match: "suffix",
      values: ["direct.example"],
      action: "direct",
    },
    {
      id: "proxy",
      enabled: true,
      type: "domain",
      match: "suffix",
      values: ["protected.example"],
      action: "proxy",
    },
    {
      id: "block",
      enabled: true,
      type: "domain",
      match: "suffix",
      values: ["blocked.example"],
      action: "block",
    },
  ];
  opts.inbound.strictRoute = false;
  const selectedNodeTag = nodeTag(1, nodes[1]);

  const { config, runtime } = strictBuild({
    source: { kind: "sub", subscription: { name: "S" }, nodes },
    mode: "systemProxy",
    options: opts,
    selectedNodeTag,
    warpInfo: {
      private_key: "priv",
      peer_public_key: "peer",
      client_id: "AAAA",
      local_ipv4: "172.16.0.2",
    },
  });

  assert.equal(runtime.mode, "tun");
  assert.equal(runtime.strictPrivacy, true);
  assert.equal(runtime.pinnedNodeTag, selectedNodeTag);
  assert.equal(runtime.options.region, "other");
  assert.equal(runtime.options.general.disableGeoLookup, true);
  assert.equal(runtime.options.general.allowDirectSubscriptionFallback, false);
  assert.equal(runtime.options.warp.enabled, false);
  assert.equal(runtime.options.dns.remoteAddress, DEFAULT_OPTIONS.dns.remoteAddress);
  assert.equal(runtime.options.dns.directAddress, DEFAULT_OPTIONS.dns.remoteAddress);
  assert.equal(runtime.options.route.ipv6Mode, "disable");
  assert.equal(config.inbounds[0].type, "tun");
  assert.equal(config.inbounds[0].strict_route, true);
  assert.equal(config.route.default_domain_resolver.server, "dns-remote");
  assert.deepEqual(config.outbounds.map((outbound) => outbound.tag), ["proxy", "direct"]);
  assert.equal(config.outbounds[0].server, "b.example.com");
  assert.equal(config.outbounds[0].domain_resolver, "dns-direct");
  assert.equal(config.endpoints, undefined, "WARP не должен попасть в строгий runtime");

  const directRules = config.route.rules.filter((rule) =>
    rule.outbound === "direct"
      && !rule.process_name?.includes("\u0000ninety-force-process-lookup"));
  assert.equal(directRules.length, 1, "разрешён только обязательный loop-avoidance");
  assert.equal(
    directRules[0].process_name.includes("Ninety.exe"),
    false,
    "служебный трафик Ninety тоже должен идти через строгий туннель",
  );
  for (const exe of ENGINE_PROCESS_NAMES) {
    assert.ok(directRules[0].process_name.includes(exe), `нет loop-avoidance для ${exe}`);
  }
  assert.equal(
    config.route.rules.some((rule) => rule.domain_suffix?.includes("direct.example")),
    false,
  );
  assert.equal(
    config.route.rules.find((rule) => rule.domain_suffix?.includes("protected.example"))?.outbound,
    "proxy",
  );
  assert.equal(
    config.route.rules.find((rule) => rule.domain_suffix?.includes("blocked.example"))?.action,
    "reject",
  );
  assert.equal(config.route.rules.some((rule) => rule.ip_is_private), false);
  assert.equal(config.route.rules.some((rule) => rule.domain_suffix?.includes(".ru")), false);
  assert.equal(config.route.rule_set.some((ruleSet) => /-(?:ru|discord)$/.test(ruleSet.tag)), false);
  // Процессное правило split-Discord — тоже прямое исключение: в строгой сессии
  // его быть не должно, иначе весь трафик клиента Discord уходит мимо туннеля.
  assert.equal(
    config.route.rules.some((rule) => rule.process_name?.includes("Discord.exe")),
    false,
  );
  assert.equal(config.dns.rules.some((rule) => rule.domain_suffix?.includes(".ru")), false);
});

test("строгая приватность не допускает Auto или исчезнувшую ноду", () => {
  const nodes = [
    vlessNode({ name: "A", host: "a.example.com" }),
    vlessNode({ name: "B", host: "b.example.com" }),
  ];
  const build = (selectedNodeTag) => strictBuild({
    source: { kind: "sub", subscription: { name: "S" }, nodes },
    mode: "tun",
    options: DEFAULT_OPTIONS,
    selectedNodeTag,
  });

  assert.throws(build, (error) => error?.code === "STRICT_PRIVACY_NODE_REQUIRED");
  assert.throws(
    () => build("auto"),
    (error) => error?.code === "STRICT_PRIVACY_NODE_REQUIRED",
  );
  assert.throws(
    () => build("node-gone"),
    (error) => error?.code === "STRICT_PRIVACY_NODE_UNAVAILABLE",
  );
  assert.throws(
    () => strictBuild({
      source: { kind: "sub", subscription: { name: "S" }, nodes: [nodes[0]] },
      mode: "tun",
      options: DEFAULT_OPTIONS,
      selectedNodeTag: nodeTag(1, nodes[1]),
    }),
    (error) => error?.code === "STRICT_PRIVACY_NODE_UNAVAILABLE",
    "исчезновение pinned-ноды не должно молча переключать singleton",
  );
});

test("строгая приватность отклоняет hostname во внешнем bridge-клиенте", () => {
  const unsafeNodes = [
    vlessNode({ type: "xhttp", host: "xhttp.example.com" }),
    {
      proto: "naive",
      host: "naive.example.com",
      port: 443,
      username: "u",
      password: "p",
      scheme: "https",
    },
    {
      proto: "trusttunnel",
      host: "tt.example.com",
      hostname: "tt.example.com",
      addresses: ["edge.example.com:443"],
      username: "u",
      password: "p",
    },
  ];

  for (const profile of unsafeNodes) {
    assert.throws(
      () => strictBuild({
        source: { kind: "single", profile },
        mode: "tun",
        options: DEFAULT_OPTIONS,
      }),
      (error) => error?.code === "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
    );
  }
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

// Пиннинг приватного CA — единственное, что отличает рабочий endpoint от
// «Auth Required»: сертификат обязан доехать из профиля в конфиг моста.
test("TrustTunnel sidecar: PEM-сертификат уезжает в конфиг", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n";
  const { sidecars } = buildConfig({
    source: {
      kind: "single",
      profile: {
        proto: "trusttunnel",
        hostname: "tt.example.com",
        addresses: ["1.2.3.4:443"],
        username: "u",
        password: "p",
        certificate: pem,
      },
    },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  assert.ok(sidecars[0].config.includes(
    'certificate = "-----BEGIN CERTIFICATE-----\\nQUJD\\n-----END CERTIFICATE-----\\n"',
  ));
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
  // Оба семейства адресов: без IPv6-адреса auto_route не строит IPv6-маршрут и
  // трафик приложений с собственным резолвером утекает мимо туннеля.
  assert.deepEqual(config.inbounds[0].address, ["172.19.0.1/30", "fdfe:dcba:9876::1/126"]);
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
  for (const exe of ENGINE_PROCESS_NAMES) {
    assert.ok(rules[bypassIdx].process_name.includes(exe), `нет bypass для ${exe}`);
  }
});

test("split Discord: процессное правило уводит голосовой UDP мимо туннеля", () => {
  const opts = structuredClone(DEFAULT_OPTIONS);
  opts.route.tunSplitDiscord = true;
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "tun",
    options: opts,
  });
  const rules = config.route.rules;
  // Голос Discord — UDP на голый IP: домена в пакете нет, доменные правила по
  // нему не срабатывают, и без процессного правила он уходил в final: proxy.
  const byProcess = rules.find((r) => Array.isArray(r.process_name) && r.process_name.includes("Discord.exe"));
  assert.ok(byProcess, "нет процессного правила Discord — голос уйдёт в туннель");
  assert.equal(byProcess.outbound, "direct");
  // Доменные правила остаются: они покрывают Discord в браузере.
  assert.ok(rules.some((r) => Array.isArray(r.rule_set) && r.rule_set.includes("geosite-discord")));
  assert.ok(rules.some((r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes("discord.media")));
  // Выше bypass-правила Ninety.exe вставать нельзя — оно защищает от петли,
  // а ниже пользовательских правил split обязан остаться перекрываемым.
  const bypassIdx = rules.findIndex((r) => Array.isArray(r.process_name) && r.process_name.includes("Ninety.exe"));
  assert.ok(bypassIdx >= 0 && bypassIdx < rules.indexOf(byProcess));
});

test("split Discord выключен: ни процессного, ни доменных правил Discord", () => {
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "tun",
    options: DEFAULT_OPTIONS,
  });
  const rules = config.route.rules;
  assert.equal(rules.some((r) => Array.isArray(r.process_name) && r.process_name.includes("Discord.exe")), false);
  assert.equal(rules.some((r) => Array.isArray(r.rule_set) && r.rule_set.includes("geosite-discord")), false);
});

test("dns parser: IPv4, bracket IPv6, ambiguous IPv6 и DoH", () => {
  const dnsDirect = (address) => {
    const opts = structuredClone(DEFAULT_OPTIONS);
    opts.dns.directAddress = address;
    const { config } = buildConfig({
      source: { kind: "single", profile: vlessNode() },
      mode: "proxy",
      options: opts,
    });
    return config.dns.servers.find((s) => s.tag === "dns-direct");
  };

  assert.deepEqual(dnsDirect("udp://1.1.1.1"), { tag: "dns-direct", type: "udp", server: "1.1.1.1" });
  assert.deepEqual(dnsDirect("udp://1.1.1.1:53"), { tag: "dns-direct", type: "udp", server: "1.1.1.1", server_port: 53 });
  assert.deepEqual(dnsDirect("udp://[2001:4860:4860::8888]:53"), { tag: "dns-direct", type: "udp", server: "2001:4860:4860::8888", server_port: 53 });
  assert.deepEqual(dnsDirect("udp://[2001:4860:4860::8888]"), { tag: "dns-direct", type: "udp", server: "2001:4860:4860::8888" });
  assert.deepEqual(dnsDirect("udp://2001:4860:4860::8888"), { tag: "dns-direct", type: "udp", server: "2001:4860:4860::8888" });
  assert.deepEqual(dnsDirect("https://cloudflare-dns.com/dns-query"), { tag: "dns-direct", type: "https", server: "cloudflare-dns.com", path: "/dns-query" });
  assert.deepEqual(dnsDirect("tls://dns.example.com:853"), { tag: "dns-direct", type: "tls", server: "dns.example.com", server_port: 853 });
  assert.throws(() => dnsDirect("ftp://dns.example.com"), /unsupported DNS scheme/);
  assert.throws(() => dnsDirect("https://[broken"), /invalid DoH URL/);
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

// Контроллер обязателен: без external_controller Rust отказывается стартовать
// («Clash control endpoint is not configured»), поэтому выключить его нечем —
// ни опцией, ни пустым/битым experimental из старого бэкапа.
test("clash-api есть всегда, порт берётся из настроек", () => {
  const withoutExperimental = { ...DEFAULT_OPTIONS, experimental: undefined };
  for (const opts of [DEFAULT_OPTIONS, withoutExperimental]) {
    const { config } = buildConfig({
      source: { kind: "single", profile: vlessNode() },
      mode: "proxy",
      options: opts,
    });
    assert.equal(config.experimental.clash_api.external_controller, "127.0.0.1:9090");
  }

  const custom = { ...DEFAULT_OPTIONS, experimental: { clashApiPort: 9191 } };
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "proxy",
    options: custom,
  });
  assert.equal(config.experimental.clash_api.external_controller, "127.0.0.1:9191");
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
  const rule = config.route.rules.find((r) => r.domain_suffix?.some((suffix) => suffix === "example.com"));
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
  assert.equal(config.dns.servers.find((s) => s.tag === "dns-remote")?.detour, "warp");
  assert.equal(validateConfigReferences(config), true);
  assert.ok(config.route.rule_set.every((rs) => rs.download_detour === "warp"));
});

test("semantic validator отклоняет ссылки на отсутствующие outbound tags", () => {
  const broken = {
    outbounds: [{ tag: "direct", type: "direct" }],
    route: { final: "missing", rules: [] },
    dns: { servers: [{ tag: "dns", type: "local" }], final: "dns", rules: [] },
  };
  assert.throws(() => validateConfigReferences(broken), /route\.final -> missing/);
});

// Страновой geosite есть не для каждого региона (см. COUNTRY_GEOSITE). Правило,
// ссылающееся на невыпущенный rule-set, ядро не примет, поэтому проверяем
// целостность ссылок для каждого региона, который можно выбрать в настройках.
test("rule-set ссылки целы для всех регионов", () => {
  for (const region of REGIONS) {
    const { config } = buildConfig({
      source: { kind: "single", profile: vlessNode() },
      mode: "proxy",
      options: { ...DEFAULT_OPTIONS, region, blockAds: true },
    });
    const declared = new Set((config.route.rule_set || []).map((set) => set.tag));
    const referenced = [
      ...(config.dns?.rules || []),
      ...(config.route?.rules || []),
    ].flatMap((rule) => rule.rule_set || []);
    for (const tag of referenced) {
      assert.ok(declared.has(tag), `${region}: правило ссылается на ${tag}, которого нет в route.rule_set`);
    }
  }
});

// Страновые списки берём у первоисточников. Зеркало, которое здесь стояло
// раньше, для tr отдавало файл с доменами госсайтов РФ, а для by — 404.
test("страновые rule-set'ы ведут на канонические источники", () => {
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "proxy",
    options: { ...DEFAULT_OPTIONS, region: "tr" },
  });
  const sets = config.route.rule_set || [];
  assert.equal(sets.some((set) => set.tag === "geosite-tr"), false);
  const geoip = sets.find((set) => set.tag === "geoip-tr");
  assert.ok(geoip, "geoip-tr должен выпускаться");
  assert.match(geoip.url, /SagerNet\/sing-geoip/);
});

// Мост брал в xray любую ноду с type=xhttp, а собирал из неё vless-outbound:
// vmess-нода получала чужой протокол с собственным uuid. Конфиг при этом
// валиден, оба ядра стартуют, и нода просто не работает — молча.
test("two-core: vmess+xhttp собирается как vmess, а не как vless", () => {
  const vmess = parseVmess("vmess://" + Buffer.from(JSON.stringify({
    add: "vm.example.com", port: "443", id: "vmess-uuid", net: "xhttp",
    tls: "tls", sni: "s.example.com", path: "/x", ps: "VM",
  }), "utf8").toString("base64"));
  const { config, xray } = buildConfig({
    source: { kind: "single", profile: vmess },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
    xray: true,
  });
  assert.ok(xray, "xray-конфиг должен собраться");
  assert.equal(xray.outbounds[0].protocol, "vmess");
  assert.equal(xray.outbounds[0].settings.vnext[0].address, "vm.example.com");
  assert.equal(xray.outbounds[0].settings.vnext[0].users[0].id, "vmess-uuid");
  assert.equal(xray.outbounds[0].streamSettings.network, "xhttp");
  assert.equal(bridgeNeeds([vmess]).xray, 1);
  const bridge = config.outbounds.find((o) => o.tag === "proxy");
  assert.equal(bridge.type, "socks");
  assert.equal(bridge.server_port, 31100);
});

// Счётчик портов и сборка обязаны решать одинаково: разойдись они — мост занял
// бы порт, которого никто не планировал.
test("two-core: xhttp у неподдерживаемого протокола не идёт в мост", () => {
  const ss = {
    proto: "shadowsocks", host: "ss.example.com", port: 8388,
    method: "aes-256-gcm", password: "pw", type: "xhttp",
  };
  assert.equal(bridgeNeeds([ss]).xray, 0);
  const { config, xray } = buildConfig({
    source: { kind: "single", profile: ss },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
    xray: true,
  });
  assert.equal(xray, null);
  const proxy = config.outbounds.find((o) => o.tag === "proxy");
  assert.equal(proxy.type, "shadowsocks");
});

// rule_set и endpoints раньше валидатор не смотрел вовсе: правило, ссылающееся
// на невыпущенный набор, и WARP-chain с опечаткой в detour доходили до ядра.
test("semantic validator ловит rule_set и endpoints[].detour", () => {
  const base = {
    outbounds: [{ tag: "direct", type: "direct" }],
    dns: { servers: [{ tag: "dns", type: "local" }], final: "dns", rules: [] },
  };
  assert.throws(() => validateConfigReferences({
    ...base,
    route: { final: "direct", rules: [{ rule_set: ["geosite-nope"], outbound: "direct" }], rule_set: [] },
  }), /route\.rules\[0\]\.rule_set\[0\] -> geosite-nope/);

  assert.throws(() => validateConfigReferences({
    ...base,
    dns: { ...base.dns, rules: [{ rule_set: ["geosite-nope"], server: "dns" }] },
    route: { final: "direct", rules: [], rule_set: [] },
  }), /dns\.rules\[0\]\.rule_set\[0\] -> geosite-nope/);

  assert.throws(() => validateConfigReferences({
    ...base,
    endpoints: [{ tag: "warp", type: "wireguard", detour: "proxy" }],
    route: { final: "warp", rules: [], rule_set: [] },
  }), /endpoints\[0\]\.detour -> proxy/);
});

// WARP chain — рабочая конфигурация, а не ошибка: detour ведёт в реальный selector.
test("semantic validator пропускает WARP chain поверх selector", () => {
  const { config } = buildConfig({
    source: { kind: "sub", nodes: [vlessNode(), vlessNode({ host: "b.example.com" })] },
    mode: "proxy",
    options: { ...DEFAULT_OPTIONS, warp: { ...DEFAULT_OPTIONS.warp, enabled: true, mode: "chain" } },
    warpInfo: {
      private_key: "priv", peer_public_key: "peer", client_id: "AAAA",
      local_ipv4: "172.16.0.2", local_ipv6: "2606:4700:110::1",
    },
  });
  assert.equal(config.endpoints[0].detour, "proxy");
  assert.equal(config.route.final, "warp");
  assert.equal(validateConfigReferences(config), true);
});

// extra.downloadSettings.address уезжает в конфиг xray как есть, а xray в
// строгом режиме ходит мимо туннеля: доменное имя оттуда резолвилось системным
// DNS, хотя сам node.host был IP и проверку проходил.
test("строгая приватность отклоняет домен в download-канале xhttp", () => {
  const node = vlessNode({
    host: "203.0.113.7",
    type: "xhttp",
    extra: JSON.stringify({ downloadSettings: { address: "leak.example", port: 443 } }),
  });
  assert.throws(
    () => strictBuild({
      source: { kind: "single", profile: node },
      mode: "tun",
      options: DEFAULT_OPTIONS,
    }),
    (error) => error?.code === "STRICT_PRIVACY_BOOTSTRAP_UNSAFE",
  );

  // Оба адреса IP — нода остаётся допустимой.
  const safe = vlessNode({
    host: "203.0.113.7",
    type: "xhttp",
    extra: JSON.stringify({ downloadSettings: { address: "203.0.113.8", port: 443 } }),
  });
  const { config } = strictBuild({
    source: { kind: "single", profile: safe },
    mode: "tun",
    options: DEFAULT_OPTIONS,
  });
  assert.ok(config.outbounds.some((o) => o.tag === "proxy"));
});

// Ядро инициализирует конфиг целиком: нода, чьи параметры оно не принимает,
// роняла старт всей подписки ("initialize outbound[72]: invalid public_key").
const REALITY_PBK = "0i4XeZ4CjhIRfQvvyPP6mQR5X5Ov1DKV0KRWFhvQF1s";

test("подписка: нода с непринимаемыми параметрами не попадает в конфиг", () => {
  const ok1 = parseVless(`vless://uuid@ok1.example:443?security=reality&pbk=${REALITY_PBK}&sni=a.example`);
  const broken = parseVless("vless://uuid@broken.example:443?security=reality&sni=a.example");
  const ok2 = parseVless(`vless://uuid@ok2.example:443?security=reality&pbk=${REALITY_PBK}&sni=a.example`);

  const { config } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes: [ok1, broken, ok2] },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });

  const servers = config.outbounds.filter((o) => o.type === "vless").map((o) => o.server);
  assert.deepEqual(servers, ["ok1.example", "ok2.example"]);
  // Селектор и balancer ссылаются только на существующие теги.
  validateConfigReferences(config);
  const selector = config.outbounds.find((o) => o.tag === "proxy");
  assert.deepEqual(selector.outbounds, ["auto", nodeTag(0, ok1), nodeTag(1, ok2)]);
});

test("подписка целиком из непригодных нод падает понятной ошибкой, а не FATAL ядра", () => {
  const broken = parseVless("vless://uuid@broken.example:443?security=reality&sni=a.example");
  assert.throws(
    () => buildConfig({
      source: { kind: "sub", subscription: { id: "s1" }, nodes: [broken] },
      mode: "proxy",
      options: DEFAULT_OPTIONS,
    }),
    /reality|прин|core|rejec/i,
  );
});

test("одиночный профиль с непринимаемыми параметрами не доходит до ядра", () => {
  const broken = parseVless("vless://uuid@broken.example:443?security=reality&sni=a.example");
  assert.throws(
    () => buildConfig({ source: { kind: "single", profile: broken }, mode: "proxy", options: DEFAULT_OPTIONS }),
    /broken\.example|прин|rejec/i,
  );
});

test("reality-ключ в обычном base64 нормализуется для ядра", () => {
  const std = REALITY_PBK.replace(/-/g, "+").replace(/_/g, "/") + "=";
  const node = parseVless(`vless://uuid@ok.example:443?security=reality&sni=a.example&pbk=${encodeURIComponent(std)}`);
  const { config } = buildConfig({
    source: { kind: "single", profile: node },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  const proxy = config.outbounds.find((o) => o.tag === "proxy");
  assert.equal(proxy.tls.reality.public_key, REALITY_PBK);
});

test("flow из xray-ссылки уезжает в конфиг в том виде, который принимает ядро", () => {
  const node = parseVless(`vless://uuid@ok.example:443?security=reality&sni=a.example&pbk=${REALITY_PBK}&flow=xtls-rprx-vision-udp443`);
  const { config } = buildConfig({
    source: { kind: "single", profile: node },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  assert.equal(config.outbounds.find((o) => o.tag === "proxy").flow, "xtls-rprx-vision");
});

test("незнакомый ядру отпечаток uTLS не доходит до конфига", () => {
  const node = parseVless("vless://uuid@ok.example:443?security=tls&sni=a.example&fp=randomizednoalpn");
  const { config } = buildConfig({
    source: { kind: "single", profile: node },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  assert.equal(config.outbounds.find((o) => o.tag === "proxy").tls.utls.fingerprint, "chrome");
});

// Явное правило пользователя обязано перекрывать split-Discord: раньше блок
// split стоял выше кастома, и правило «discord.com → через VPN» молча не
// работало — совпадение находилось раньше и уводило трафик в direct.
test("split Discord не перекрывает пользовательское правило на тот же домен", () => {
  const opts = structuredClone(DEFAULT_OPTIONS);
  opts.route.tunSplitDiscord = true;
  opts.route.customRules = [{
    id: "keep-discord-in-tunnel",
    enabled: true,
    type: "domain",
    match: "suffix",
    values: ["discord.com"],
    action: "proxy",
  }];
  const { config } = buildConfig({
    source: { kind: "single", profile: vlessNode() },
    mode: "tun",
    options: opts,
  });
  const rules = config.route.rules;
  // Точное сравнение элементов, а не поиск подстроки: domain_suffix — массив
  // доменов, и `includes` здесь читается (в том числе статическим анализом) как
  // проверка URL по подстроке, которой «evil-discord.com.attacker.net» тоже
  // удовлетворяет.
  const userIdx = rules.findIndex(
    (r) => r.domain_suffix?.some((suffix) => suffix === "discord.com") && r.outbound === "proxy",
  );
  const splitIdx = rules.findIndex((r) => Array.isArray(r.rule_set) && r.rule_set.includes("geosite-discord"));
  assert.ok(userIdx >= 0, "пользовательское правило не собралось");
  assert.ok(splitIdx >= 0, "split-Discord не собрался");
  assert.ok(userIdx < splitIdx, "правило пользователя обязано стоять выше split-Discord");

  // Bypass-правило Ninety.exe по-прежнему выше обоих: защита от петли важнее.
  const bypassIdx = rules.findIndex((r) => Array.isArray(r.process_name) && r.process_name.includes("Ninety.exe"));
  assert.ok(bypassIdx >= 0 && bypassIdx < userIdx);
});

// ── WireGuard: endpoints, а не outbounds ───────────────────
// В sing-box 1.13 wireguard-outbound удалён. Нода уезжает в config.endpoints,
// но тег остаётся обычным: группы ссылаются на него как на любой outbound,
// потому что менеджер ядра при промахе ищет тег среди endpoint'ов. Если это
// разъедется, конфиг соберётся и упадёт уже в ядре ссылкой на несуществующий тег.
const WG_PRIVATE = "nlhuTLXG3gAV8AJmw8jYngX3QkwdDoSPi2HxhGGSKrs=";
const WG_PUBLIC = "zjVMotkY/dyEZygQ7crKvCtV1ODNZkVx1xe/1Bvvo8A=";
const wgConf = (extra = "") => `[Interface]
Address = 172.16.0.2/32
MTU = 1280
PrivateKey = ${WG_PRIVATE}
${extra}
[Peer]
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 162.159.192.1:2408
PersistentKeepalive = 15
PublicKey = ${WG_PUBLIC}`;

test("wireguard: одиночный профиль становится endpoint с тегом proxy", () => {
  const profile = parseWireguardConf(wgConf(), "WG");
  const { config } = buildConfig({ profile, mode: "tun", options: DEFAULT_OPTIONS });
  assert.deepEqual(config.outbounds.map(o => o.tag), ["direct"]);
  assert.equal(config.endpoints.length, 1);
  const endpoint = config.endpoints[0];
  assert.equal(endpoint.type, "wireguard");
  assert.equal(endpoint.tag, "proxy");
  assert.equal(endpoint.private_key, WG_PRIVATE);
  assert.equal(endpoint.peers[0].public_key, WG_PUBLIC);
  assert.equal(endpoint.peers[0].persistent_keepalive_interval, 15);
  assert.equal(config.route.final, "proxy");
  validateConfigReferences(config);
});

test("wireguard: в подписке нода попадает в группы наравне с outbound'ами", () => {
  const nodes = [
    parseVless("vless://uuid@a.example.com:443?security=tls"),
    parseWireguardConf(wgConf(), "WG"),
  ];
  const { config } = buildConfig({
    source: { kind: "sub", subscription: { name: "S" }, nodes },
    mode: "tun",
    options: DEFAULT_OPTIONS,
  });
  const wgTag = nodeTag(1, nodes[1]);
  assert.equal(config.endpoints.length, 1);
  assert.equal(config.endpoints[0].tag, wgTag);
  assert.equal(config.outbounds.some(o => o.tag === wgTag), false);
  for (const groupTag of ["proxy", "auto"]) {
    const group = config.outbounds.find(o => o.tag === groupTag);
    assert.ok(group.outbounds.includes(wgTag), `${groupTag} не видит wireguard-ноду`);
  }
  validateConfigReferences(config);
});

test("wireguard: шейпинг AmneziaWG уходит в ядро, дефолтные H1..H4 — нет", () => {
  const plain = parseWireguardConf(wgConf("Jc = 4\nJmin = 8\nJmax = 80\nH1 = 1\nH2 = 2\nH3 = 3\nH4 = 4\nI1 = <b 0xc0ffee>"), "WG");
  const { config: plainConfig } = buildConfig({ profile: plain, mode: "tun", options: DEFAULT_OPTIONS });
  assert.deepEqual(plainConfig.endpoints[0].noise, {
    amnezia: { jc: 4, jmin: 8, jmax: 80, i1: "<b 0xc0ffee>" },
  });

  const shaped = parseWireguardConf(wgConf("S1 = 15\nS2 = 20\nH1 = 1020983529\nH2 = 1449520552\nH3 = 1120404579\nH4 = 1741401686"), "AWG");
  const { config: shapedConfig } = buildConfig({ profile: shaped, mode: "tun", options: DEFAULT_OPTIONS });
  assert.deepEqual(shapedConfig.endpoints[0].noise, {
    amnezia: {
      s1: 15, s2: 20,
      h1: 1020983529, h2: 1449520552, h3: 1120404579, h4: 1741401686,
    },
  });

  // Обычный WireGuard шума не получает вовсе: пустой блок ядро бы отвергло.
  const bare = parseWireguardConf(wgConf(), "WG");
  const { config: bareConfig } = buildConfig({ profile: bare, mode: "tun", options: DEFAULT_OPTIONS });
  assert.equal("noise" in bareConfig.endpoints[0], false);
});

test("wireguard: WARP поверх wireguard-ноды не теряет ни один endpoint", () => {
  const profile = parseWireguardConf(wgConf(), "WG");
  const { config } = buildConfig({
    profile,
    mode: "tun",
    options: { ...structuredClone(DEFAULT_OPTIONS), warp: { ...DEFAULT_OPTIONS.warp, enabled: true, mode: "chain" } },
    warpInfo: {
      private_key: WG_PRIVATE,
      peer_public_key: WG_PUBLIC,
      client_id: "AAAA",
      local_ipv4: "172.16.0.2",
      local_ipv6: "",
    },
  });
  assert.deepEqual(config.endpoints.map(e => e.tag), ["proxy", "warp"]);
  assert.equal(config.route.final, "warp");
  validateConfigReferences(config);
});
