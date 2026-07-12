import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || {};

const { snapshotMatchesSource, snapshotCanSelectTag } = await import("/lib/proxies-view.js");

const nodesB = [
  { clashTag: "node-0-b" },
  { clashTag: "node-1-b" },
];

function snapshot(tags) {
  const all = ["auto", "lowest", ...tags];
  return {
    proxies: Object.fromEntries([
      ["proxy", { type: "Selector", all, now: "auto" }],
      ["auto", { type: "Balancer", now: tags[0] }],
      ["lowest", { type: "URLTest", now: tags[0] }],
      ...tags.map(tag => [tag, { type: "VLESS", history: [] }]),
    ]),
  };
}

test("stale snapshot A не готов для источника B и запрещает PUT", () => {
  const stale = snapshot(["node-0-a", "node-1-a"]);
  assert.equal(snapshotMatchesSource(stale, nodesB), false);
  assert.equal(snapshotCanSelectTag(stale, nodesB, "node-0-b"), false);
});

test("snapshot B готов только с Selector, служебными outbound и всеми node tags", () => {
  const ready = snapshot(nodesB.map(n => n.clashTag));
  assert.equal(snapshotMatchesSource(ready, nodesB), true);
  assert.equal(snapshotCanSelectTag(ready, nodesB, "node-1-b"), true);

  delete ready.proxies.lowest;
  assert.equal(snapshotMatchesSource(ready, nodesB), false);
});

test("single-node outbound готов без Selector, но ручной Selector update запрещён", () => {
  const nodes = [{ clashTag: "proxy" }];
  const data = { proxies: { proxy: { type: "VLESS", history: [] } } };
  assert.equal(snapshotMatchesSource(data, nodes), true);
  assert.equal(snapshotCanSelectTag(data, nodes, "proxy"), false);
});
