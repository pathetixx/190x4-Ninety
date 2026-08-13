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
