// Разбор deep-link (/lib/deeplink.js) — форматы из README + top-level схемы.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeepLink, safeAtobUrl } from "/lib/deeplink.js";

const b64url = (s) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("ninety://import/<encoded-url>", () => {
  const url = "https://panel.example.com/sub?token=abc&x=1";
  const r = parseDeepLink("ninety://import/" + encodeURIComponent(url));
  assert.deepEqual(r, { url, name: "" });
});

test("ninety://import?url=...&name=...", () => {
  const url = "https://panel.example.com/sub";
  const r = parseDeepLink(`ninety://import?url=${encodeURIComponent(url)}&name=Home`);
  assert.deepEqual(r, { url, name: "Home" });
});

test("ninety://config/<encoded-link>", () => {
  const link = "vless://uuid@h.example.com:443?security=tls#N";
  const r = parseDeepLink("ninety://config/" + encodeURIComponent(link));
  assert.equal(r.url, link);
});

test("ninety://add/<base64-url> (Happ-style)", () => {
  const url = "https://sub.example.com/list";
  const r = parseDeepLink("ninety://add/" + b64url(url));
  assert.deepEqual(r, { url, name: "" });
});

test("ninety://add с не-base64 падает в сырой URL", () => {
  // «не base64» здесь = не декодируется вообще (invalid chars даже после чистки)
  const r = parseDeepLink("ninety://add/%%%%");
  assert.equal(r.url, "%%%%");
});

test("sub://<base64-url> раскрывается", () => {
  const url = "https://sub.example.com/abc";
  const r = parseDeepLink("sub://" + b64url(url));
  assert.deepEqual(r, { url, name: "" });
});

test("top-level схемы отдаются как есть", () => {
  for (const raw of [
    "vless://uuid@h.example.com:443",
    "trojan://pw@h.example.com:443",
    "hy2://pw@h.example.com:443",
    "tt://?abc",
    "naive+https://u:p@h.example.com:443#n",
    "naive+quic://u:p@h.example.com:443#n",
  ]) {
    assert.deepEqual(parseDeepLink(raw), { url: raw, name: "" });
  }
});

test("чужие схемы и мусор → null", () => {
  assert.equal(parseDeepLink("http://example.com"), null);
  assert.equal(parseDeepLink("ninety://"), null);
  assert.equal(parseDeepLink("ninety://import/"), null);
  assert.equal(parseDeepLink(""), null);
  assert.equal(parseDeepLink(null), null);
  assert.equal(parseDeepLink("garbage"), null);
});

test("неизвестный action отклоняется до декодирования payload", () => {
  assert.equal(parseDeepLink("ninety://evil/https%3A%2F%2Fexample.com%2Fsub"), null);
  assert.equal(parseDeepLink("ninety://ImPoRt/https%3A%2F%2Fexample.com%2Fsub").url, "https://example.com/sub");
});

test("deep-link payload с control chars отклоняется, malformed encoding не вызывает exception", () => {
  assert.equal(parseDeepLink("ninety://import/https%3A%2F%2Fexample.com%2F%00"), null);
  assert.deepEqual(parseDeepLink("ninety://import/%E0%A4%A"), { url: "%E0%A4%A", name: "" });
});

test("safeAtobUrl: url-алфавит и паддинг", () => {
  assert.equal(safeAtobUrl(b64url("hello?x=1&y=2")), "hello?x=1&y=2");
  assert.equal(safeAtobUrl("%%%"), "");
});
