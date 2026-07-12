import { test } from "node:test";
import assert from "node:assert/strict";

function storage() {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
}
globalThis.localStorage = storage();

const {
  bumpSourceRevision, createRuntimeIdentityController, sourceFingerprint, stableNodeId,
} = await import("/lib/runtime-identity.js");

const sub = (nodes) => ({ kind: "sub", subscription: { id: "s1" }, nodes });

test("rename/reorder не меняют stable identity и source fingerprint", () => {
  const a = { stableId: "n-a", name: "Москва", proto: "vless", host: "a", port: 443, uuid: "secret-a" };
  const b = { stableId: "n-b", name: "Рига", proto: "trojan", host: "b", port: 443, password: "secret-b" };
  assert.equal(stableNodeId(a, "sub:s1"), "sub:s1:n-a");
  assert.equal(sourceFingerprint(sub([a, b])), sourceFingerprint(sub([{ ...b, name: "Новое имя" }, { ...a, name: "A" }])));
});

test("runtime-relevant изменение меняет fingerprint", () => {
  const a = sub([{ stableId: "n", name: "A", proto: "vless", host: "one", port: 443, uuid: "x" }]);
  const b = sub([{ stableId: "n", name: "A", proto: "vless", host: "two", port: 443, uuid: "x" }]);
  assert.notEqual(sourceFingerprint(a), sourceFingerprint(b));
});

test("source revision инвалидирует захваченный runtime token", () => {
  const source = sub([{ stableId: "n", proto: "vless", host: "one", port: 443, uuid: "x" }]);
  const runtime = createRuntimeIdentityController({ getSource: () => source, getMode: () => "systemProxy", getClashPort: () => 9191 });
  const token = runtime.begin({ configJson: "{}" });
  assert.equal(token.clashPort, 9191);
  assert.equal(runtime.isCurrent(token), true);
  bumpSourceRevision("sub:s1");
  assert.equal(runtime.isCurrent(token), false);
  assert.throws(() => runtime.assertCurrent(token, "poll"), { code: "STALE_RUNTIME" });
});
