import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidValue, normalizeIp, normalizeValue, sanitizeRule } from "/lib/routing-rules.js";

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

// Прежняя регулярка требовала TLD из одних букв и молча выбрасывала весь
// punycode: правило для .рф исчезало из списка, а UI показывал только счётчик
// отброшенных значений.
test("routing rules: IDN и punycode-домены сохраняются в A-label", () => {
  const { rule, dropped } = sanitizeRule({
    type: "domain",
    match: "suffix",
    values: ["почта.рф", "site.xn--p1ai", "münchen.de", "abc.p2p"],
    action: "direct",
  });
  assert.equal(dropped, 0);
  assert.deepEqual(rule.values, [
    "xn--80a1acny.xn--p1ai",
    "site.xn--p1ai",
    "xn--mnchen-3ya.de",
    "abc.p2p",
  ]);
});

test("routing rules: домен обязан иметь метки и нечисловой TLD", () => {
  const { rule, dropped } = sanitizeRule({
    type: "domain",
    match: "suffix",
    values: ["gosuslugi.ru", "google", "1.2.3.4", "-bad.com", "bad-.com"],
    action: "proxy",
  });
  assert.deepEqual(rule.values, ["gosuslugi.ru"]);
  assert.equal(dropped, 4);
});

// domain_keyword в sing-box — подстрока имени хоста. Проверка «полный домен с
// TLD» делала режим «ключевое слово» нерабочим: youtube/google отбрасывались.
test("routing rules: keyword принимает подстроку и не режет её как URL", () => {
  const { rule, dropped } = sanitizeRule({
    type: "domain",
    match: "keyword",
    values: ["youtube", "google", "с пробелом"],
    action: "proxy",
  });
  assert.deepEqual(rule.values, ["youtube", "google"]);
  assert.equal(dropped, 1);
});

test("routing rules: keyword и suffix валидируются по-разному", () => {
  assert.equal(isValidValue("domain", "youtube", "keyword"), true);
  assert.equal(isValidValue("domain", "youtube", "suffix"), false);
  assert.equal(isValidValue("domain", "youtube.com", "suffix"), true);
  // Для suffix путь и порт срезаются, для keyword — нет: там это часть искомого.
  assert.equal(normalizeValue("domain", "https://x.com/ads", "suffix"), "x.com");
  assert.equal(normalizeValue("domain", "x.com/ads", "keyword"), "x.com/ads");
});

// Ведущие нули ядро не принимает: «192.168.001.100» валится на разборе ip_cidr, и
// правило пользователя молча не работает (а в строгих сборках не поднимается весь
// конфиг). Раньше валидатор такую запись пропускал и отдавал её без изменений.
test("routing rules: IPv4 с ведущими нулями канонизируется, а не уезжает как есть", () => {
  assert.equal(normalizeIp("192.168.001.100"), "192.168.1.100/32");
  assert.equal(normalizeIp("010.0.0.1"), "10.0.0.1/32");
  assert.equal(normalizeIp("01.02.03.04/8"), "1.2.3.4/8");
  assert.equal(normalizeIp("1.2.3.4"), "1.2.3.4/32");

  const { rule, dropped } = sanitizeRule({
    id: "zeros",
    enabled: true,
    type: "ip",
    values: ["192.168.001.100", "0300.1.1.1"],
    action: "direct",
  });
  assert.equal(dropped, 1, "восьмеричная запись 0300.* должна отбрасываться");
  assert.deepEqual(rule.values, ["192.168.1.100/32"]);
});
