import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIp, sanitizeRule } from "/lib/routing-rules.js";

test("routing rules: IPv6 validation accepts real addresses only", () => {
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8::1/128");
  assert.equal(normalizeIp("2001:db8::/32"), "2001:db8::/32");
  assert.equal(normalizeIp("::1"), "::1/128");
  assert.equal(normalizeIp(":"), "");
  assert.equal(normalizeIp(":::"), "");
  assert.equal(normalizeIp("fe80::1%12"), "");
});

test("routing rules: sanitizeRule drops invalid IP values", () => {
  const { rule, dropped } = sanitizeRule({
    id: "r1",
    enabled: true,
    type: "ip",
    values: ["1.2.3.4", ":::", "2001:db8::1/128", "999.1.1.1"],
    action: "direct",
  });
  assert.equal(dropped, 2);
  assert.deepEqual(rule.values, ["1.2.3.4/32", "2001:db8::1/128"]);
});
