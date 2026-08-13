// Ядро само называет виновника отказа: «initialize outbound[N]: причина».
// Нода по индексу должна находиться точно и больше в конфиг не попадать.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}
globalThis.localStorage = makeStorage();
globalThis.window = globalThis.window || {};

const {
  matchCoreOutboundRejection,
  quarantineNode,
  isNodeQuarantined,
  quarantineReason,
  clearNodeQuarantine,
} = await import("/lib/node-quarantine.js");
const { buildConfig, parseVless } = await import("/lib/singbox.js");
const { DEFAULT_OPTIONS } = await import("/lib/options.js");

const PBK = "0i4XeZ4CjhIRfQvvyPP6mQR5X5Ov1DKV0KRWFhvQF1s";
const node = (host) => parseVless(`vless://uuid@${host}:443?security=reality&sni=a.example&pbk=${PBK}`);

test("индекс outbound'а из ошибки ядра указывает на ту самую ноду", () => {
  clearNodeQuarantine();
  const nodes = [node("a.example"), node("b.example"), node("c.example")];
  const { config, outboundNodes } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  // selector/auto/lowest идут первыми — вторая нода это outbound[4].
  assert.equal(config.outbounds[4].server, "b.example");
  const hit = matchCoreOutboundRejection(
    "sing-box died. Last errors:\nFATAL[0000] create service: initialize outbound[4]: unsupported flow: xtls-rprx-direct",
    outboundNodes,
  );
  assert.equal(hit.node.host, "b.example");
  assert.equal(hit.reason, "unsupported flow: xtls-rprx-direct");
});

test("отказ без индекса или по служебному outbound'у никого не выключает", () => {
  const { outboundNodes } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes: [node("a.example"), node("b.example")] },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  assert.equal(matchCoreOutboundRejection("start failed: port in use", outboundNodes), null);
  assert.equal(matchCoreOutboundRejection("initialize outbound[0]: bad selector", outboundNodes), null);
  assert.equal(matchCoreOutboundRejection("initialize outbound[99]: x", outboundNodes), null);
});

test("нода в карантине не попадает в конфиг, остальные остаются", () => {
  clearNodeQuarantine();
  const nodes = [node("a.example"), node("b.example"), node("c.example")];
  quarantineNode(nodes[1], "unsupported flow: xtls-rprx-direct");

  assert.ok(isNodeQuarantined(nodes[1]));
  assert.ok(!isNodeQuarantined(nodes[0]));
  assert.equal(quarantineReason(nodes[1]), "unsupported flow: xtls-rprx-direct");

  const { config } = buildConfig({
    source: { kind: "sub", subscription: { id: "s1" }, nodes },
    mode: "proxy",
    options: DEFAULT_OPTIONS,
  });
  const servers = config.outbounds.filter((o) => o.type === "vless").map((o) => o.server);
  assert.deepEqual(servers, ["a.example", "c.example"]);
});

test("карантин привязан к параметрам ноды: починенный сервер снова используется", () => {
  clearNodeQuarantine();
  const broken = parseVless("vless://uuid@fix.example:443?security=tls&sni=a.example&fp=chrome");
  quarantineNode(broken, "reason");
  const fixed = parseVless("vless://uuid@fix.example:8443?security=tls&sni=a.example&fp=chrome");
  assert.ok(isNodeQuarantined(broken));
  assert.ok(!isNodeQuarantined(fixed));
});
