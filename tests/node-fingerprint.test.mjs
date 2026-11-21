// A node's fingerprint is its identity: stableId (and therefore the server's tag
// in the config), the remembered manual choice and the quarantine rely on it. The fingerprint is computed
// over ALL profile fields, so a new field in the parser silently changes the identity
// of all nodes that have it: after an update the user's
// selected server gets reset.
//
// The test pins down the fingerprints of reference links. It doesn't forbid changing the parser — it
// requires doing so deliberately: if the values below diverged, the author of the change
// must understand that subscriptions will move to new tags, and update them here.
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

const { parseLink } = await import("/lib/protocol-parsers.js");
const { nodeSemanticFingerprint } = await import("/lib/runtime-identity.js");

const UUID = "89b3cbba-e6ac-485a-9481-976a0415eab9";

const REFERENCE = {
  "vless-reality":
    `vless://${UUID}@node.example:443?security=reality&type=tcp&sni=www.microsoft.com`
    + "&pbk=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaQ&sid=ab12&fp=chrome#RE",
  "vless-ws-early":
    `vless://${UUID}@cdn.example:443?security=tls&type=ws&sni=cdn.example&path=%2Fws`
    + "&host=cdn.example&ed=2560&eh=Sec-WebSocket-Protocol#WS",
  "vless-insecure":
    `vless://${UUID}@self.example:443?security=tls&type=tcp&sni=self.example&allowInsecure=1#SS`,
  "trojan-grpc":
    "trojan://pa%40ss@tj.example:443?security=tls&type=grpc&serviceName=GunService&sni=tj.example#TJ",
  "hysteria2":
    "hysteria2://pw@hy.example:443?sni=hy.example&alpn=h3&obfs=salamander&obfs-password=x#HY",
};

test("отпечатки эталонных нод не меняются молча", () => {
  const actual = Object.fromEntries(
    Object.entries(REFERENCE).map(([name, link]) => [name, nodeSemanticFingerprint(parseLink(link))]),
  );
  assert.deepEqual(actual, {
    "vless-reality": "1aogjrp1c0amvd",
    "vless-ws-early": "1o8i5yu19a7t7u",
    "vless-insecure": "1qwlm0z12v58of",
    "trojan-grpc": "lmgd6wqu3r6c",
    "hysteria2": "64dznm1gdjc1a",
  });
});

test("одна и та же ссылка даёт один отпечаток, разные ссылки — разные", () => {
  const fingerprints = Object.values(REFERENCE).map((link) => nodeSemanticFingerprint(parseLink(link)));
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  for (const link of Object.values(REFERENCE)) {
    assert.equal(nodeSemanticFingerprint(parseLink(link)), nodeSemanticFingerprint(parseLink(link)));
  }
});

test("имя ноды на identity не влияет, а параметр соединения влияет", () => {
  const base = `vless://${UUID}@node.example:443?security=tls&type=tcp&sni=node.example`;
  assert.equal(
    nodeSemanticFingerprint(parseLink(`${base}#Первое имя`)),
    nodeSemanticFingerprint(parseLink(`${base}#Другое имя`)),
  );
  assert.notEqual(
    nodeSemanticFingerprint(parseLink(`${base}#N`)),
    nodeSemanticFingerprint(parseLink(`${base}&allowInsecure=1#N`)),
  );
});
