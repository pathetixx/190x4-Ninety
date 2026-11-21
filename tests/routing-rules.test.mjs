import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidValue, normalizeIp, normalizeRuleName, normalizeTarget, normalizeValue, regionRules, sameRuleExceptName, sanitizeRule,
  buildRulesExport, parseRulesImport, mergeImportedRules, RULES_FILE_TYPE, RULES_FILE_VERSION, RULES_IMPORT_MAX,
} from "/lib/routing-rules.js";

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

// The former regex required a TLD of letters only and silently threw away all
// punycode: a rule for .рф disappeared from the list, while the UI showed only the counter
// of dropped values.
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

// domain_keyword in sing-box is a substring of the host name. The "full domain with
// a TLD" check made the "keyword" mode useless: youtube/google were dropped.
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
  // For suffix the path and port are stripped, for keyword they aren't: there they're part of what's searched.
  assert.equal(normalizeValue("domain", "https://x.com/ads", "suffix"), "x.com");
  assert.equal(normalizeValue("domain", "x.com/ads", "keyword"), "x.com/ads");
});

// The core doesn't accept leading zeros: "192.168.001.100" fails ip_cidr parsing, and
// the user's rule silently doesn't work (and in strict builds the whole config doesn't
// come up). Previously the validator let such an entry through and returned it unchanged.
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

// ── Multi-exit ───────────────────────────────────────────────────────────
test("routing rules: правило «через сервер» без цели деградирует в proxy", () => {
  const { rule } = sanitizeRule({
    id: "r1", enabled: true, type: "domain", match: "suffix",
    values: ["example.com"], action: "node",
  });
  // An empty tag would go into the core config as outbound:"" and bring down the start entirely.
  assert.equal(rule.action, "proxy");
  assert.equal(rule.target, undefined);
});

test("routing rules: цель правила нормализуется и переживает sanitize", () => {
  const { rule } = sanitizeRule({
    id: "r1", enabled: true, type: "domain", match: "suffix",
    values: ["example.com"], action: "node",
    target: { tag: "  node-abc123  ", name: "  DE-01  " },
  });
  assert.equal(rule.action, "node");
  assert.deepEqual(rule.target, { tag: "node-abc123", name: "DE-01" });
});

test("routing rules: action warp цели не требует", () => {
  const { rule } = sanitizeRule({
    id: "r1", enabled: true, type: "process",
    values: ["Discord.exe"], action: "warp",
  });
  assert.equal(rule.action, "warp");
  assert.equal(rule.target, undefined);
});

test("routing rules: нечитаемая цель — это отсутствие цели", () => {
  assert.equal(normalizeTarget(null), null);
  assert.equal(normalizeTarget({ tag: "   ", name: "" }), null);
  assert.deepEqual(normalizeTarget({ name: "Only name" }), { name: "Only name" });
});

test("routing rules: готовый список хранит только известные ссылки", () => {
  const { rule, dropped } = sanitizeRule({
    id: "s1",
    type: "set",
    values: ["geosite:YouTube", "geoip:ru", "geosite:no-such-list", "youtube", "geoip:ru"],
    action: "proxy",
  });
  assert.deepEqual(rule.values, ["geosite:youtube", "geoip:ru"]);
  assert.equal(rule.match, undefined);
  assert.equal(dropped, 2);
});

test("routing rules: зона целиком — только явно, с точкой, и только для «Поддомены»", () => {
  assert.equal(isValidValue("domain", ".ru", "suffix"), true);
  assert.equal(isValidValue("domain", ".xn--p1ai", "suffix"), true);
  assert.equal(normalizeValue("domain", ".RU", "suffix"), ".ru");
  assert.equal(isValidValue("domain", "ru", "suffix"), false);
  assert.equal(isValidValue("domain", ".ru", "exact"), false);
  assert.equal(isValidValue("domain", ".123", "suffix"), false);
  assert.equal(isValidValue("domain", ".", "suffix"), false);
});

test("routing rules: база региона переносится теми же правилами", () => {
  const ru = regionRules("ru");
  assert.deepEqual(ru.map(({ id, ...rest }) => rest), [
    { enabled: true, type: "domain", match: "suffix", values: [".ru"], action: "direct", origin: "region" },
    { enabled: true, type: "set", values: ["geosite:category-ru", "geoip:ru"], action: "direct", origin: "region" },
  ]);
  // For a country without its own geosite — addresses only.
  assert.deepEqual(regionRules("tr")[1].values, ["geoip:tr"]);
  assert.notEqual(ru[0].id, ru[1].id);
});

test("routing rules: метку происхождения нельзя подделать", () => {
  const { rule } = sanitizeRule({ id: "x", type: "domain", values: ["a.example"], action: "direct", origin: "evil" });
  assert.equal(rule.origin, undefined);
});

test("routing rules: подпись правила нормализуется и опускается, если пуста", () => {
  const base = { id: "n1", type: "ip", values: ["1.2.3.4"], action: "direct" };
  assert.equal(sanitizeRule({ ...base, name: "  Riot Games  " }).rule.name, "Riot Games");
  assert.equal("name" in sanitizeRule({ ...base, name: "   " }).rule, false);
  assert.equal("name" in sanitizeRule(base).rule, false);
  assert.equal("name" in sanitizeRule({ ...base, name: { toString: () => "x" } }).rule, false);
  assert.equal(normalizeRuleName(42), "");
  assert.equal(normalizeRuleName("a\nb\tc"), "a b c");
  assert.equal(normalizeRuleName("a\u202eb\u0007c\u2066d"), "abcd");
  // ZWNJ is needed for Persian text — we don't strip it
  assert.equal(normalizeRuleName("می\u200cخواهم"), "می\u200cخواهم");
  // HTML is stored as is, escaped on output
  assert.equal(normalizeRuleName("<img src=x onerror=1>"), "<img src=x onerror=1>");
});

test("routing rules: лимит подписи — 64 символа, emoji не режется пополам", () => {
  const long = "😀".repeat(70);
  const name = normalizeRuleName(long);
  assert.equal(Array.from(name).length, 64);
  assert.equal(name, "😀".repeat(64));
  assert.equal(normalizeRuleName("a".repeat(63) + "😀😀"), "a".repeat(63) + "😀");
  assert.equal(normalizeRuleName(normalizeRuleName(long)), name);
});

test("routing rules: переименование не считается сетевым изменением", () => {
  const a = sanitizeRule({ id: "n2", type: "domain", match: "suffix", values: ["example.com"], action: "node", target: { tag: "t1", name: "B" } }).rule;
  assert.equal(sameRuleExceptName(a, { ...a, name: "Работа" }), true);
  assert.equal(sameRuleExceptName({ ...a, name: "x" }, { ...a, name: "y" }), true);
  assert.equal(sameRuleExceptName(a, { ...a, enabled: false }), false);
  assert.equal(sameRuleExceptName(a, { ...a, values: ["example.org"] }), false);
  // target.name is a working field of the server choice, not a label
  assert.equal(sameRuleExceptName(a, { ...a, target: { tag: "t1", name: "C" } }), false);
  assert.equal(sameRuleExceptName(a, null), false);
});

// ── Rules file ──────────────────────────────────────────────────────

const sampleRules = () => [
  { id: "r-1", name: "Почта", enabled: true, type: "domain", match: "suffix", values: ["почта.рф"], action: "direct" },
  { id: "r-2", enabled: false, type: "process", values: ["Telegram"], action: "proxy" },
  { id: "r-3", enabled: true, type: "ip", values: ["10.0.0.0/8"], action: "node", target: { tag: "t1", name: "DE" } },
];

test("rules file: export drops local ids and round-trips through import", () => {
  const now = new Date("2026-11-17T10:00:00Z");
  const payload = buildRulesExport(sampleRules(), { regionDetached: true, now });
  assert.equal(payload.type, RULES_FILE_TYPE);
  assert.equal(payload.version, RULES_FILE_VERSION);
  assert.equal(payload.exportedAt, "2026-11-17T10:00:00.000Z");
  assert.equal(payload.regionDetached, true);
  assert.ok(payload.rules.every((r) => !("id" in r)));
  assert.deepEqual(payload.rules[0].values, ["xn--80a1acny.xn--p1ai"]);
  assert.equal(payload.rules[1].values[0], "Telegram.exe");

  const parsed = parseRulesImport(JSON.stringify(payload));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.rules.length, 3);
  assert.equal(parsed.regionDetached, true);
  assert.equal(parsed.skipped, 0);
  assert.ok(parsed.rules.every((r) => typeof r.id === "string" && r.id && !["r-1", "r-2", "r-3"].includes(r.id)));
  const strip = ({ id: _ignored, ...rest }) => rest;
  assert.deepEqual(parsed.rules.map(strip), payload.rules);
});

test("rules file: import accepts BOM and a bare array, infers region state", () => {
  const regional = [{ type: "set", values: ["geoip:ru"], action: "direct", origin: "region" }];
  const parsed = parseRulesImport("\uFEFF" + JSON.stringify(regional));
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0].origin, "region");
  assert.equal(parsed.regionDetached, true);
  assert.equal(parseRulesImport(JSON.stringify(sampleRules())).regionDetached, false);
});

test("rules file: import skips unknown types/actions instead of guessing", () => {
  const parsed = parseRulesImport(JSON.stringify([
    { type: "domain", values: ["example.com"], action: "block" },
    { type: "domain", values: ["example.org"], action: "teleport" },
    { type: "geo", values: ["x"], action: "proxy" },
    { type: "domain", values: ["not a domain"], action: "proxy" },
    "garbage",
    null,
  ]));
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0].action, "block");
  assert.equal(parsed.skipped, 5);
  assert.equal(parsed.dropped, 1);
});

test("rules file: import reports broken, foreign, newer and oversized files", () => {
  assert.deepEqual(parseRulesImport("{not json"), { error: "parse" });
  assert.deepEqual(parseRulesImport(JSON.stringify({ rules: [] })), { error: "format" });
  assert.deepEqual(parseRulesImport(JSON.stringify({ type: RULES_FILE_TYPE, version: 1 })), { error: "format" });
  assert.deepEqual(parseRulesImport(JSON.stringify({ type: RULES_FILE_TYPE, version: RULES_FILE_VERSION + 1, rules: [] })), { error: "newer" });
  assert.deepEqual(parseRulesImport(JSON.stringify([])), { error: "empty" });
  const many = Array.from({ length: RULES_IMPORT_MAX + 1 }, () => ({ type: "domain", values: ["a.com"], action: "proxy" }));
  assert.deepEqual(parseRulesImport(JSON.stringify(many)), { error: "tooMany" });
});

test("rules file: append skips rules already present, replace takes the file as is", () => {
  const current = [
    { id: "a", enabled: false, type: "domain", match: "suffix", values: ["example.com"], action: "direct" },
  ];
  const incoming = [
    { id: "n1", name: "Другая подпись", enabled: true, type: "domain", match: "suffix", values: ["example.com"], action: "direct" },
    { id: "n2", enabled: true, type: "set", values: ["geoip:ru"], action: "direct", origin: "region" },
  ];
  const appended = mergeImportedRules(current, incoming, "append");
  assert.equal(appended.added, 1);
  assert.equal(appended.duplicates, 1);
  assert.equal(appended.rules.length, 2);
  assert.equal(appended.rules[0], current[0]);
  assert.equal("origin" in appended.rules[1], false);

  const replaced = mergeImportedRules(current, incoming, "replace");
  assert.equal(replaced.added, 2);
  assert.equal(replaced.rules.length, 2);
  assert.equal(replaced.rules[1].origin, "region");
  assert.notEqual(replaced.rules[0], incoming[0]);
});

