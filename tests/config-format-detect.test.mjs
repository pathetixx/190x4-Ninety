// Распознавание формата чужого конфига. Оба случая ниже нашлись не на выдуманных
// примерах, а на живом прогоне BPB-Worker-Panel v5.1.1: пока формат не опознан,
// пользователь видит «нет поддерживаемых конфигов» и не знает, что делать
// дальше, — а сделать надо ровно одно конкретное действие.
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

// Панель отдаёт clash-подписку JSON'ом, а не YAML: JSON — подмножество YAML, и
// Clash его принимает. Проверка только по «proxies:» в начале строки такое тело
// не узнавала вовсе.
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

// ZIP: сигнатура локального заголовка. Тело подписки доезжает до фронта строкой,
// но эти четыре байта — ASCII и управляющие, лоссовое декодирование их не портит.
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
  // Внутри архива лежит ровно то, что Ninety уже читает, поэтому сообщение —
  // не «формат не поддержан», а «распакуйте и добавьте файл».
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
