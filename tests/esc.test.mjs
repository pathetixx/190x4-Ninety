// Единый HTML-эскейп untrusted-данных (имена нод/подписок, хосты, процессы).
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, escapeAttr } from "/lib/esc.js";

test("экранирует все 5 спецсимволов", () => {
  assert.equal(
    escapeHtml(`<img src="x" onerror='alert(1)'>&`),
    "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;"
  );
});

test("null/undefined → пустая строка, числа → строка", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
});

test("escapeAttr — тот же эскейп (обе кавычки покрыты)", () => {
  assert.equal(escapeAttr, escapeHtml);
});
