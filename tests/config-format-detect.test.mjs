// Detecting the format of a foreign config. Both cases below were found not on made-up
// examples but on a live run of BPB-Worker-Panel v5.1.1: until the format is recognized,
// the user sees "no supported configs" and doesn't know what to do
// next — while exactly one specific action is needed.
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

const { detectConfigFormat } = await import("/lib/config-format.js");
const { unsupportedFormatMessage } = await import("/lib/config-import.js");
const { parseSubscriptionEntries, detectAddInput } = await import("/lib/subscriptions.js");

// The panel serves the clash subscription as JSON, not YAML: JSON is a subset of YAML, and
// Clash accepts it. A check only for "proxies:" at the start of a line didn't recognize
// such a body at all.
const CLASH_JSON = JSON.stringify({
  "mixed-port": 7890,
  "allow-lan": false,
  mode: "rule",
  proxies: [
    {
      name: "1 - VLESS - Domain", type: "vless", server: "panel.example",
      port: 443, uuid: "89b3cbba-e6ac-485a-9481-976a0415eab9", network: "ws", tls: true,
    },
  ],
  "proxy-groups": [{ name: "BPB", type: "select", proxies: ["1 - VLESS - Domain"] }],
  rules: ["MATCH,BPB"],
});

const CLASH_YAML = [
  "mixed-port: 7890",
  "proxies:",
  '  - name: "node"',
  "    type: vless",
  "    server: panel.example",
].join("\n");

// ZIP: the local header signature. The subscription body reaches the frontend as a string,
// but these four bytes are ASCII and control characters, lossy decoding doesn't spoil them.
const ZIP_BODY = "PK\u0003\u0004\u000a   "
  + "BPB-Warp-1.conf[Interface]\nPrivateKey = key\n";

test("clash в виде JSON распознаётся так же, как YAML", () => {
  assert.equal(detectConfigFormat(CLASH_JSON), "clash");
  assert.equal(detectConfigFormat(CLASH_YAML), "clash");
});

test("подписка с конфигом Clash называет формат и говорит, что взять вместо него", () => {
  const result = parseSubscriptionEntries(CLASH_JSON);
  assert.equal(result.format, "clash");
  assert.equal(result.profiles.length, 0);
  const message = unsupportedFormatMessage("clash");
  assert.match(message, /Clash/);
  assert.match(message, /sing-box/);
});

test("тело-архив опознаётся и объясняется, а не выглядит пустой подпиской", () => {
  // Inside the archive lies exactly what Ninety already reads, so the message is
  // not "format not supported" but "unpack it and add the file".
  assert.equal(detectConfigFormat(ZIP_BODY), "archive");
  const result = parseSubscriptionEntries(ZIP_BODY);
  assert.equal(result.format, "archive");
  assert.equal(result.profiles.length, 0);
  assert.match(unsupportedFormatMessage("archive"), /ZIP/);
  assert.equal(detectAddInput(ZIP_BODY).kind, "client-config");
});

test("читаемые форматы сообщения о непонятном формате не получают", () => {
  assert.equal(unsupportedFormatMessage("sing-box"), null);
  assert.equal(unsupportedFormatMessage("xray"), null);
  assert.equal(unsupportedFormatMessage(null), null);
});

test("обычный список ссылок и .conf форматом конфига не считаются", () => {
  assert.equal(detectConfigFormat("vless://uuid@h.example:443#a"), null);
  assert.equal(detectConfigFormat("[Interface]\nPrivateKey = x\n"), null);
  assert.equal(detectConfigFormat(""), null);
});
