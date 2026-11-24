// xray JSON subscriptions: servers that don't fit into a link (finalmask XMC,
// post-quantum VLESS encryption) travel as a ready outbound via the xray bridge, and
// the subscription itself switches to JSON only when it covers the link list and
// adds something.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (i) => Array.from(data.keys())[i] ?? null,
    getItem: (k) => data.has(k) ? data.get(k) : null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}

let invokeHandler = async () => { throw new Error("invoke handler is not configured"); };
globalThis.localStorage = makeStorage();
globalThis.window = {
  localStorage: globalThis.localStorage,
  __TAURI__: { core: { invoke: (...args) => invokeHandler(...args) } },
};

const { parseXrayConfig } = await import("/lib/xray-config-import.js");
const { buildConfig, needsXrayBridge } = await import("/lib/singbox.js");
const { nodeConfigIssue } = await import("/lib/node-validation.js");
const {
  XRAY_JSON_DECISION_VERSION,
  XRAY_JSON_FORMAT,
  XRAY_JSON_RECHECK_MS,
  addSubscriptionFromUrl,
  loadSubscriptions,
  preferXrayJson,
  refreshSubscription,
  saveSubscriptions,
} = await import("/lib/subscriptions.js");

const UUID = "89b3cbba-e6ac-485a-9481-976a0415eab9";
const PBK = "Q2nbIiYrQ0dNVWdlT1VJ0iIdSFdwY0xEb3dCVWRGQ3Q";

const xmcOutbound = (host = "de.mc.example") => ({
  tag: "proxy",
  protocol: "vless",
  mux: { enabled: true, concurrency: 24 },
  settings: { address: host, port: 25565, id: UUID, encryption: "mlkem768x25519plus.native.0rtt.key" },
  streamSettings: {
    network: "tcp",
    security: "none",
    finalmask: { tcp: [{ type: "xmc", settings: { hostname: host, password: "secret" } }] },
    sockopt: { dialerProxy: "fragment" },
  },
});

const realityOutbound = (host = "de.example") => ({
  tag: "proxy",
  protocol: "vless",
  settings: { address: host, port: 443, id: UUID, encryption: "none", flow: "xtls-rprx-vision" },
  streamSettings: {
    network: "tcp",
    security: "reality",
    realitySettings: { serverName: host, fingerprint: "firefox", publicKey: PBK, shortId: "abcd" },
  },
});

const hysteriaOutbound = (udp) => ({
  tag: "proxy",
  protocol: "hysteria",
  settings: { address: "hy.example", port: 27015, version: 2 },
  streamSettings: {
    network: "hysteria",
    security: "tls",
    tlsSettings: { serverName: "hy.example", alpn: ["h3"] },
    hysteriaSettings: { version: 2, auth: "pass" },
    finalmask: { udp },
  },
});

const config = (remarks, outbound) => ({
  remarks,
  outbounds: [outbound, { tag: "direct", protocol: "freedom" }, { tag: "fragment", protocol: "freedom", settings: { fragment: {} } }],
});

test("плоский outbound Xray 26 (address/port/id в settings) разбирается как обычная ссылка", () => {
  const { profiles, skipped } = parseXrayConfig([config("DE", realityOutbound())]);
  assert.equal(skipped, 0);
  assert.equal(profiles.length, 1);
  const [node] = profiles;
  assert.equal(node.proto, "vless");
  assert.equal(node.host, "de.example");
  assert.equal(node.port, 443);
  assert.equal(node.uuid, UUID);
  assert.equal(node.flow, "xtls-rprx-vision");
  assert.equal(node.name, "DE");
  assert.equal(needsXrayBridge(node), false);
});

test("XMC едет готовым outbound: метка, адрес и всё содержимое кроме служебных связей", () => {
  const { profiles } = parseXrayConfig([config("DE XMC", xmcOutbound())]);
  assert.equal(profiles.length, 1);
  const [node] = profiles;
  assert.equal(node.proto, "xray");
  assert.equal(node.label, "XMC");
  assert.equal(node.name, "DE XMC");
  assert.equal(node.host, "de.mc.example");
  assert.equal(node.port, 25565);
  assert.equal(node.outbound.tag, undefined, "tag назначает сборщик");
  assert.equal(node.outbound.streamSettings.sockopt, undefined, "dialerProxy ссылался на соседа по конфигу");
  assert.equal(node.outbound.streamSettings.finalmask.tcp[0].type, "xmc");
  assert.equal(node.outbound.settings.encryption, "mlkem768x25519plus.native.0rtt.key");
  assert.equal(node.outbound.mux.concurrency, 24);
  assert.equal(nodeConfigIssue(node), null);
  assert.equal(needsXrayBridge(node), true);
});

test("шифрование VLESS без маски — тоже готовый outbound, ядро его не умеет", () => {
  const outbound = realityOutbound();
  outbound.settings.encryption = "mlkem768x25519plus.native.0rtt.key";
  const { profiles } = parseXrayConfig([config("PQ", outbound)]);
  assert.equal(profiles[0].proto, "xray");
  assert.equal(profiles[0].label, "VLESS ML-KEM");
});

test("hysteria Xray с salamander становится hysteria2 ядра, с udphop — готовым outbound", () => {
  const plain = parseXrayConfig([config("HY", hysteriaOutbound([{ type: "salamander", settings: { password: "obfs" } }]))]);
  assert.equal(plain.profiles.length, 1);
  assert.equal(plain.profiles[0].proto, "hysteria2");
  assert.equal(plain.profiles[0].password, "pass");
  assert.equal(plain.profiles[0].obfs, "salamander");
  assert.equal(plain.profiles[0].obfsPassword, "obfs");
  assert.equal(plain.profiles[0].sni, "hy.example");

  const hop = parseXrayConfig([config("HOP", hysteriaOutbound([
    { type: "salamander", settings: { password: "obfs" } },
    { type: "udphop", settings: { ports: "20000-30000" } },
  ]))]);
  assert.equal(hop.profiles[0].proto, "xray");
  assert.equal(hop.profiles[0].label, "UDPHOP");
});

test("готовый outbound в конфиге: sing-box получает socks-мост, xray — outbound как есть", () => {
  const { profiles } = parseXrayConfig([config("XMC", xmcOutbound()), config("DE", realityOutbound())]);
  const { config: sb, xray } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes: profiles },
    mode: "proxy",
    xray: true,
  });
  const bridge = sb.outbounds.find((o) => o.type === "socks");
  assert.ok(bridge, "в sing-box мост вместо сервера");
  assert.equal(bridge.server, "127.0.0.1");
  assert.equal(xray.outbounds.length, 1);
  const out = xray.outbounds[0];
  assert.equal(out.protocol, "vless");
  assert.equal(out.settings.address, "de.mc.example");
  assert.equal(out.streamSettings.finalmask.tcp[0].type, "xmc");
  assert.equal(xray.inbounds[0].port, bridge.server_port);
  assert.equal(xray.routing.rules[0].outboundTag, out.tag);
  assert.equal(profiles[0].outbound.tag, undefined, "сборка не трогает объект ноды");
});

test("нода xray без годного outbound отбраковывается", () => {
  assert.deepEqual(nodeConfigIssue({ proto: "xray", host: "a.example", port: 1, outbound: null }), { code: "malformed" });
  assert.deepEqual(
    nodeConfigIssue({ proto: "xray", host: "a.example", port: 1, outbound: { protocol: "freedom" } }),
    { code: "malformed" },
  );
});

test("preferXrayJson: только надмножество списка ссылок, и только если есть что добавить", () => {
  const vless = { proto: "vless", host: "a.example", port: 443, type: "tcp" };
  const tuic = { proto: "tuic", host: "b.example", port: 443 };
  const xmc = { proto: "xray", host: "c.example", port: 25565 };
  assert.equal(preferXrayJson([vless], [{ ...vless, name: "другое имя" }, xmc]), true);
  assert.equal(preferXrayJson([vless], [{ ...vless }]), false, "ничего нового");
  assert.equal(preferXrayJson([vless, tuic], [vless, xmc]), false, "JSON потерял бы TUIC");
  assert.equal(preferXrayJson([vless], []), false);
});

test("preferXrayJson: готовый outbound покрывает ссылку на тот же сервер", () => {
  // The panel lists a masked ML-KEM server as a plain link without the mask;
  // only the JSON outbound can actually reach it.
  const pqLink = { proto: "vless", host: "mq.example", port: 1883, type: "tcp" };
  const pqRaw = {
    proto: "xray",
    host: "mq.example",
    port: 1883,
    outbound: {
      protocol: "vless",
      settings: { address: "mq.example", port: 1883, encryption: "mlkem768x25519plus.native.0rtt.key" },
      streamSettings: { network: "raw", finalmask: { tcp: [{ type: "header-custom" }] } },
    },
  };
  const hyLink = { proto: "hysteria2", host: "hy.example", port: 27015 };
  const hyRaw = { proto: "xray", host: "hy.example", port: 27015, outbound: hysteriaOutbound([{ type: "udphop" }]) };
  const xmc = { proto: "xray", host: "c.example", port: 25565, outbound: xmcOutbound("c.example") };

  assert.equal(preferXrayJson([pqLink, hyLink], [pqRaw, hyRaw, xmc]), true);
  assert.equal(
    preferXrayJson([{ ...pqLink, type: "xhttp" }], [pqRaw, xmc]),
    false,
    "другой транспорт — другой сервер",
  );
});

test("подписка с маскированными ML-KEM серверами переходит на JSON", async () => {
  globalThis.localStorage = makeStorage();
  const pqLink = `vless://${UUID}@mq.example:1883?security=none&type=tcp&encryption=mlkem768x25519plus.native.0rtt.key&flow=xtls-rprx-vision#PQ`;
  const pqOutbound = {
    tag: "proxy",
    protocol: "vless",
    settings: { address: "mq.example", port: 1883, id: UUID, flow: "xtls-rprx-vision", encryption: "mlkem768x25519plus.native.0rtt.key" },
    streamSettings: {
      network: "tcp",
      security: "none",
      finalmask: { tcp: [{ type: "header-custom", settings: { clients: [[{ type: "hex", packet: "1018" }]] } }] },
    },
  };
  const calls = [];
  invokeHandler = async (cmd, args) => {
    calls.push(args.format || "links");
    if (args.format === XRAY_JSON_FORMAT) {
      return { status: 200, body: JSON.stringify([config("PQ", pqOutbound), config("XMC", xmcOutbound())]) };
    }
    return { status: 200, body: Buffer.from(pqLink).toString("base64") };
  };
  const sub = await addSubscriptionFromUrl("https://panel.example/sub/pq");
  assert.deepEqual(calls, ["links", XRAY_JSON_FORMAT]);
  assert.equal(sub.xrayJson.use, true);
  assert.deepEqual(sub.profiles.map((p) => p.label), ["HEADER-CUSTOM", "XMC"]);
});

test("отказ от JSON, принятый старым правилом, перепроверяется сразу", async () => {
  globalThis.localStorage = makeStorage();
  const calls = panel({ json: JSON.stringify([config("DE", realityOutbound())]) });
  const sub = await addSubscriptionFromUrl("https://panel.example/sub/old");
  assert.equal(sub.xrayJson.use, false);
  assert.equal(sub.xrayJson.v, XRAY_JSON_DECISION_VERSION);

  // A decision saved before the rule had a version: fresh by date, but not trusted.
  const list = loadSubscriptions();
  delete list[0].xrayJson.v;
  saveSubscriptions(list);
  calls.length = 0;
  const refreshed = await refreshSubscription(sub.id);
  assert.deepEqual(calls, ["links", XRAY_JSON_FORMAT]);
  assert.equal(refreshed.xrayJson.v, XRAY_JSON_DECISION_VERSION);
});

const LINKS = `vless://${UUID}@de.example:443?security=reality&type=tcp&pbk=${PBK}&sid=abcd&sni=de.example&flow=xtls-rprx-vision#DE`;
const JSON_BODY = JSON.stringify([config("DE", realityOutbound()), config("DE XMC", xmcOutbound())]);

function panel({ json = JSON_BODY } = {}) {
  const calls = [];
  invokeHandler = async (cmd, args) => {
    assert.equal(cmd, "fetch_subscription");
    calls.push(args.format || "links");
    if (args.format === XRAY_JSON_FORMAT) return { status: 200, body: json };
    return { status: 200, body: Buffer.from(LINKS).toString("base64") };
  };
  return calls;
}

test("подписка переходит на xray-JSON, когда там всё то же и сверх того", async () => {
  globalThis.localStorage = makeStorage();
  const calls = panel();
  const sub = await addSubscriptionFromUrl("https://panel.example/sub/a");
  assert.deepEqual(calls, ["links", XRAY_JSON_FORMAT]);
  assert.equal(sub.xrayJson.use, true);
  assert.deepEqual(sub.profiles.map((p) => p.proto), ["vless", "xray"]);

  // While the decision is fresh, the update goes straight for JSON, with a single request.
  calls.length = 0;
  const refreshed = await refreshSubscription(sub.id);
  assert.deepEqual(calls, [XRAY_JSON_FORMAT]);
  assert.equal(refreshed.profiles.length, 2);
});

test("JSON без новых серверов не заменяет ссылки, и неделю его не перепроверяем", async () => {
  globalThis.localStorage = makeStorage();
  const calls = panel({ json: JSON.stringify([config("DE", realityOutbound())]) });
  const sub = await addSubscriptionFromUrl("https://panel.example/sub/b");
  assert.equal(sub.xrayJson.use, false);
  assert.deepEqual(sub.profiles.map((p) => p.proto), ["vless"]);

  calls.length = 0;
  await refreshSubscription(sub.id);
  assert.deepEqual(calls, ["links"]);

  // The decision is stale — we check again.
  const list = loadSubscriptions();
  list[0].xrayJson.checkedAt = Date.now() - XRAY_JSON_RECHECK_MS - 1;
  saveSubscriptions(list);
  calls.length = 0;
  await refreshSubscription(sub.id);
  assert.deepEqual(calls, ["links", XRAY_JSON_FORMAT]);
});

test("панель перестала отдавать JSON — обновление возвращается к ссылкам", async () => {
  globalThis.localStorage = makeStorage();
  const calls = panel();
  const sub = await addSubscriptionFromUrl("https://panel.example/sub/c");
  assert.equal(sub.xrayJson.use, true);

  panel({ json: "" });
  const refreshed = await refreshSubscription(sub.id);
  assert.equal(refreshed.xrayJson.use, false);
  assert.deepEqual(refreshed.profiles.map((p) => p.proto), ["vless"]);
  assert.ok(calls.length >= 2);
});
