// Отчёт диагностики уезжает в чат поддержки, поэтому маскировка адресов — это
// обещание приватности, а не косметика. Проверяем то, что легко потерять:
// IPv6 (прежняя реализация знала только IPv4) и текст, который лишь похож на
// адрес.
import { test } from "node:test";
import assert from "node:assert/strict";

const { maskAddresses, maskIp } = await import("/lib/address-mask.js");

test("IPv4 теряет середину", () => {
  assert.equal(maskAddresses("  3. 203.0.113.7 · icmp=expired"), "  3. 203.***.***.7 · icmp=expired");
});

test("IPv6 не остаётся в отчёте целиком", () => {
  assert.equal(maskAddresses("2001:db8:85a3::8a2e:370:7334"), "2001:db8:·:·");
  assert.equal(maskAddresses("fe80::1"), "fe80::·:·");
  assert.equal(maskAddresses("resolvedIp 2606:4700:4700::1111"), "resolvedIp 2606:4700:·:·");
});

test("IPv4 внутри IPv6-адреса не остаётся открытым", () => {
  const masked = maskAddresses("::ffff:203.0.113.7");
  assert.ok(!masked.includes("203.0.113.7"), masked);
  assert.ok(!masked.includes("0.113.7"), masked);
});

test("несколько адресов в одной строке маскируются все", () => {
  assert.equal(
    maskAddresses("провайдер: 2a00:1450:4010:c0f::8b · туннель: 104.21.5.9"),
    "провайдер: 2a00:1450:·:· · туннель: 104.***.***.9",
  );
});

test("время и прочие не-адреса не портятся", () => {
  assert.equal(maskAddresses("12:34:56 ERROR dial failed"), "12:34:56 ERROR dial failed");
  assert.equal(maskAddresses("* * *"), "* * *");
  assert.equal(maskAddresses(""), "—");
});

test("maskIp прячет хвост собственного адреса", () => {
  assert.equal(maskIp("203.0.113.7"), "203.0.*.*");
  assert.equal(maskIp("2001:db8:85a3::1"), "2001:db8:·:·");
  assert.equal(maskIp(null), "—");
});
