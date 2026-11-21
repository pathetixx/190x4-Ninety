// Mieru goes one way from a share link or a ready config to an outbound:
// the transport choice, port ranges and optional fields must not get lost.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
globalThis.window.localStorage = globalThis.localStorage;

const { parseLink, parseMieru } = await import("/lib/protocol-parsers.js");
const { buildConfig, needsXrayBridge } = await import("/lib/singbox.js");
const { nodeConfigIssue } = await import("/lib/node-validation.js");
const { parseSingboxConfig, singboxOutboundToLink } = await import("/lib/singbox-config-import.js");
const { detectAddInput, parseSubscriptionEntries } = await import("/lib/subscriptions.js");

const HOST = "mieru.example";
const SIMPLE = `mierus://user:password@${HOST}?port=6666&protocol=TCP`;
const TRAFFIC_PATTERN = "AA+/bWllcnU=";
const MULTIPLEXING = [
  "MULTIPLEXING_DEFAULT", "MULTIPLEXING_OFF", "MULTIPLEXING_LOW",
  "MULTIPLEXING_MIDDLE", "MULTIPLEXING_HIGH",
];
const HANDSHAKE_MODES = ["HANDSHAKE_DEFAULT", "HANDSHAKE_STANDARD", "HANDSHAKE_NO_WAIT"];

function build(node) {
  const result = buildConfig({ source: { kind: "single", profile: node }, mode: "proxy" });
  const outbound = result.config.outbounds.find((item) => item.type === "mieru");
  assert.ok(outbound, "Mieru должен собираться собственным outbound'ом");
  return { ...result, outbound };
}

const validNode = (extra = {}) => ({
  proto: "mieru", name: "Mieru", host: HOST, port: 6666,
  transport: "TCP", username: "user", password: "password", ...extra,
});

test("mierus: одиночный порт разбирается без пустых необязательных полей", () => {
  const expected = {
    raw: SIMPLE, proto: "mieru", name: HOST, host: HOST, port: 6666,
    transport: "TCP", username: "user", password: "password",
  };
  assert.deepEqual(parseMieru(SIMPLE), expected);
  assert.deepEqual(parseLink(SIMPLE), expected);
});

test("mierus: имя берётся из фрагмента, затем profile, затем адреса", () => {
  const profile = `${SIMPLE}&profile=${encodeURIComponent("Профиль Mieru")}`;
  assert.equal(parseLink(profile).name, "Профиль Mieru");
  assert.equal(parseLink(`${profile}#${encodeURIComponent("Сервер № 1")}`).name, "Сервер № 1");
  assert.equal(parseLink(SIMPLE).name, HOST);
});

test("mierus: IPv6 и кодированные логин с паролем сохраняются", () => {
  const username = "имя@сервера";
  const password = "p:a@ss/word ?#%+";
  const raw = `mierus://${encodeURIComponent(username)}:${encodeURIComponent(password)}@[2001:db8::42]?port=6666&protocol=UDP`;
  const node = parseLink(raw);
  assert.equal(node.raw, raw);
  assert.equal(node.host, "2001:db8::42");
  assert.equal(node.username, username);
  assert.equal(node.password, password);
  assert.equal(node.transport, "UDP");
});

test("mierus: повторяющиеся port/protocol сопоставляются по позиции, TCP имеет приоритет", () => {
  const raw = `mierus://user:password@${HOST}?port=6489&port=9998-9999&port=6666&port=7000&protocol=UDP&protocol=TCP&protocol=TCP&protocol=UDP`;
  const node = parseLink(raw);
  assert.equal(node.transport, "TCP");
  assert.equal(node.port, 6666, "для пинга нужен первый одиночный TCP-порт");
  assert.deepEqual(node.ports, ["9998-9999"]);
  assert.deepEqual(build(node).outbound, {
    type: "mieru", tag: "proxy", server: HOST,
    server_port: 6666, server_ports: ["9998-9999"],
    transport: "TCP", username: "user", password: "password",
  });
});

test("mierus: без TCP сохраняются все UDP-привязки", () => {
  const node = parseLink(`mierus://user:password@${HOST}?port=9000-9002&protocol=UDP&port=6489&protocol=UDP`);
  assert.equal(node.transport, "UDP");
  assert.equal(node.port, 6489);
  assert.deepEqual(node.ports, ["9000-9002"]);
  const { outbound } = build(node);
  assert.equal(outbound.server_port, 6489);
  assert.deepEqual(outbound.server_ports, ["9000-9002"]);
});

test("mierus: диапазоны без одиночного порта дают порт для пинга, но только server_ports для ядра", () => {
  const node = parseLink(`mierus://user:password@${HOST}?port=9998-9999&protocol=TCP&port=20000-20002&protocol=TCP`);
  assert.equal(node.port, 9998);
  assert.deepEqual(node.ports, ["9998-9999", "20000-20002"]);
  assert.equal(nodeConfigIssue(node), null);
  const { outbound } = build(node);
  assert.equal(Object.hasOwn(outbound, "server_port"), false);
  assert.deepEqual(outbound.server_ports, ["9998-9999", "20000-20002"]);
});

test("mierus: одиночный порт, совпадающий с началом диапазона, не теряется", () => {
  const node = parseLink(`mierus://user:password@${HOST}?port=9998&protocol=TCP&port=9998-9999&protocol=TCP`);
  assert.equal(node.port, 9998);
  const { outbound } = build(node);
  assert.equal(outbound.server_port, 9998);
  assert.deepEqual(outbound.server_ports, ["9998-9999"]);
});

test("mierus: дополнительные одиночные порты сохраняются как вырожденные диапазоны", () => {
  const node = parseLink(`${SIMPLE}&port=7777&protocol=TCP&port=8888&protocol=TCP`);
  assert.equal(node.port, 6666);
  const { outbound } = build(node);
  assert.equal(outbound.server_port, 6666);
  assert.deepEqual(outbound.server_ports, ["7777-7777", "8888-8888"]);
});

test("mierus: необязательные параметры и base64 traffic-pattern переносятся без изменений", () => {
  const raw = `${SIMPLE}&mtu=1400&multiplexing=MULTIPLEXING_HIGH&handshake-mode=HANDSHAKE_NO_WAIT&traffic-pattern=${encodeURIComponent(TRAFFIC_PATTERN)}`;
  const node = parseLink(raw);
  assert.equal(node.mtu, 1400);
  assert.equal(node.multiplexing, "MULTIPLEXING_HIGH");
  assert.equal(node.handshakeMode, "HANDSHAKE_NO_WAIT");
  assert.equal(node.trafficPattern, TRAFFIC_PATTERN);
  assert.equal(parseLink(`${SIMPLE}&traffic-pattern=${TRAFFIC_PATTERN}`).trafficPattern, TRAFFIC_PATTERN);
  assert.equal(nodeConfigIssue(node), null);
  assert.deepEqual(build(node).outbound, {
    type: "mieru", tag: "proxy", server: HOST, server_port: 6666,
    transport: "TCP", username: "user", password: "password",
    mtu: 1400, multiplexing: "MULTIPLEXING_HIGH",
    handshake_mode: "HANDSHAKE_NO_WAIT", traffic_pattern: TRAFFIC_PATTERN,
  });
});

test("mierus: отсутствие логина или пароля отвергается при разборе", () => {
  for (const userinfo of ["", "user", ":password", "user:"]) {
    assert.throws(() => parseLink(`mierus://${userinfo ? `${userinfo}@` : ""}${HOST}?port=6666&protocol=TCP`), userinfo);
  }
});

test("mierus: неверные порты и несогласованные привязки отвергаются при разборе", () => {
  for (const query of [
    "", "port=6666", "protocol=TCP", "port=6666&protocol=TCP&port=7777",
    "port=0&protocol=TCP", "port=65536&protocol=TCP", "port=9-8&protocol=TCP",
    "port=1-65536&protocol=TCP", "port=6666&protocol=QUIC", "port=6666&protocol=tcp",
  ]) {
    assert.throws(() => parseMieru(`mierus://user:password@${HOST}?${query}`), query);
  }
});

test("Mieru собирается без TLS, sidecar и xray-моста", () => {
  const node = parseLink(SIMPLE);
  const { outbound, xray, sidecars } = build(node);
  assert.deepEqual(outbound, {
    type: "mieru", tag: "proxy", server: HOST, server_port: 6666,
    transport: "TCP", username: "user", password: "password",
  });
  assert.equal(Object.hasOwn(outbound, "tls"), false);
  assert.equal(Object.hasOwn(outbound, "server_ports"), false);
  assert.equal(needsXrayBridge(node), false);
  assert.equal(xray, null);
  assert.deepEqual(sidecars, []);
});

test("Mieru: валидатор требует обе части учётных данных", () => {
  for (const extra of [{ username: "" }, { password: "" }, { username: undefined }, { password: undefined }]) {
    assert.deepEqual(nodeConfigIssue(validNode(extra)), { code: "credentials" });
  }
});

test("Mieru: валидатор принимает только TCP и UDP", () => {
  for (const transport of ["TCP", "UDP"]) assert.equal(nodeConfigIssue(validNode({ transport })), null);
  for (const transport of ["tcp", "quic", "", undefined]) {
    assert.deepEqual(nodeConfigIssue(validNode({ transport })), { code: "mieruTransport" });
  }
});

test("Mieru: валидатор проверяет перечисления multiplexing и handshakeMode", () => {
  for (const multiplexing of MULTIPLEXING) assert.equal(nodeConfigIssue(validNode({ multiplexing })), null);
  for (const handshakeMode of HANDSHAKE_MODES) assert.equal(nodeConfigIssue(validNode({ handshakeMode })), null);
  for (const extra of [{ multiplexing: "HIGH" }, { handshakeMode: "NO_WAIT" }]) {
    assert.deepEqual(nodeConfigIssue(validNode(extra)), { code: "mieruOption" });
  }
});

test("Mieru: MTU допускается только целым числом от 1280 до 1500", () => {
  for (const mtu of [1280, 1400, 1500]) assert.equal(nodeConfigIssue(validNode({ mtu })), null);
  for (const mtu of [0, 1279, 1501, 1400.5, NaN, "1400", null, true]) {
    assert.deepEqual(nodeConfigIssue(validNode({ mtu })), { code: "mieruOption" });
  }
});

test("Mieru: диапазоны проверяются в форме a-b и в границах допустимых портов", () => {
  assert.equal(nodeConfigIssue(validNode({ ports: ["1-1", "65535-65535", "1-65535"] })), null);
  for (const ports of [["0-10"], ["10-9"], ["1-65536"], ["9998:9999"], ["6666"], ["a-b"], "1-2"]) {
    assert.deepEqual(nodeConfigIssue(validNode({ ports })), { code: "endpoint" }, JSON.stringify(ports));
  }
  assert.deepEqual(nodeConfigIssue(validNode({ port: 0 })), { code: "endpoint" });
  assert.deepEqual(nodeConfigIssue(validNode({ host: "" })), { code: "endpoint" });
});

test("Mieru: импорт sing-box сохраняет все поля outbound'а при обратной сборке", () => {
  const original = {
    type: "mieru", tag: "Сервер Mieru", server: "2001:db8::42",
    server_port: 6666, server_ports: ["9998-9999"], transport: "UDP",
    username: "имя@сервера", password: "p:a@ss/?#%+",
    multiplexing: "MULTIPLEXING_MIDDLE", handshake_mode: "HANDSHAKE_STANDARD",
    mtu: 1280, traffic_pattern: TRAFFIC_PATTERN,
  };
  const { link } = singboxOutboundToLink(original);
  assert.ok(link.startsWith("mierus://"), link);
  assert.ok(link.includes("@[2001:db8::42]?"), link);
  const { profiles, skipped, unsupported } = parseSingboxConfig({ outbounds: [original] });
  assert.equal(skipped, 0);
  assert.deepEqual(unsupported, []);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, original.tag);
  assert.equal(nodeConfigIssue(profiles[0]), null);
  assert.deepEqual(build(profiles[0]).outbound, { ...original, tag: "proxy" });
});

test("Mieru: импорт диапазонов без server_port не выдумывает одиночный порт", () => {
  const original = {
    type: "mieru", tag: "Диапазоны", server: HOST,
    server_ports: ["9998-9999", "20000-20002"], transport: "TCP",
    username: "user", password: "password",
  };
  const { profiles, skipped } = parseSingboxConfig({ outbounds: [original] });
  assert.equal(skipped, 0);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].port, 9998);
  assert.deepEqual(build(profiles[0]).outbound, { ...original, tag: "proxy" });
});

test("Mieru: импорт сохраняет явно заданный пустой traffic_pattern и не скрывает пустое перечисление", () => {
  const original = {
    type: "mieru", server: HOST, server_port: 6666, transport: "TCP",
    username: "user", password: "password", traffic_pattern: "",
  };
  const { profiles } = parseSingboxConfig({ outbounds: [original] });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].trafficPattern, "");
  assert.equal(build(profiles[0]).outbound.traffic_pattern, "");
  const invalid = parseSingboxConfig({ outbounds: [{ ...original, multiplexing: "" }] }).profiles[0];
  assert.deepEqual(nodeConfigIssue(invalid), { code: "mieruOption" });
});

test("mierus попадает в тело подписки и из plain, и из base64", () => {
  const body = `${SIMPLE}\n${SIMPLE}&profile=UDP&port=7777&protocol=TCP`;
  for (const input of [body, Buffer.from(body, "utf8").toString("base64")]) {
    const parsed = parseSubscriptionEntries(input);
    assert.equal(parsed.format, null);
    assert.equal(parsed.skipped, 0);
    assert.equal(parsed.profiles.length, 2);
    assert.deepEqual(parsed.profiles.map((node) => node.proto), ["mieru", "mieru"]);
  }
  assert.deepEqual(detectAddInput(SIMPLE), { kind: "config", content: SIMPLE });
  assert.deepEqual(detectAddInput(body), { kind: "list", content: body });
});

test("полная protobuf-ссылка mieru не разбирается как mierus и не ломает вставку", () => {
  const raw = "mieru://CgdkZWZhdWx0EAE=";
  assert.throws(() => parseLink(raw));
  assert.deepEqual(detectAddInput(raw), { kind: "unknown", raw });
  assert.deepEqual(parseSubscriptionEntries(raw), { profiles: [], skipped: 0, format: null });
});
