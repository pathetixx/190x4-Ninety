// DNS presets: item labels, recognizing a saved address and validating
// manual input. The validator must match the config builder's parser —
// otherwise the UI accepts an address on which the core fails at startup.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  DNS_PRESETS, DNS_SEPARATOR,
  dnsPresetLabel, dnsHostLabel, findDnsPreset, isSystemDns, validateDnsAddress,
} = await import("/lib/dns-presets.js");

const { DEFAULT_OPTIONS } = await import("/lib/options.js");

// dns-guard reads Tauri invoke at the top level; to import the constant
// a stub is enough, as in tests/health-watchdog.test.mjs.
globalThis.window = globalThis.window
  ?? { __TAURI__: { core: { invoke: async () => ({}) } } };
const { FALLBACKS } = await import("/lib/dns-guard.js");

test("дефолтные адреса присутствуют в своих списках", () => {
  assert.ok(findDnsPreset("remote", DEFAULT_OPTIONS.dns.remoteAddress));
  assert.ok(findDnsPreset("direct", DEFAULT_OPTIONS.dns.directAddress));
});

// We compare with the watchdog's array itself, not with a copy of it: if they diverged, the copy
// would let through a fallback that isn't in the list — and auto-switching would move
// the select to "Custom address" instead of a clear name.
test("резервы dns-guard видны в списке direct как готовые пункты", () => {
  assert.ok(FALLBACKS.length >= 4);
  for (const dns of FALLBACKS) {
    assert.ok(findDnsPreset("direct", dns), dns);
  }
});

// The default must be in the chain: the watchdog goes through it from the top, and an address that
// isn't in it will never come back after the very first switch.
test("дефолтный direct-адрес присутствует в цепочке резервов", () => {
  assert.ok(FALLBACKS.includes(DEFAULT_OPTIONS.dns.directAddress));
  assert.notEqual(FALLBACKS[0], DEFAULT_OPTIONS.dns.directAddress);
});

test("неизвестный адрес пресетом не считается", () => {
  assert.equal(findDnsPreset("direct", "udp://192.168.1.1"), null);
});

test("подпись пункта — бренд, адрес и тип", () => {
  const label = (kind, value) =>
    dnsPresetLabel(DNS_PRESETS[kind].find(p => p.value === value));
  assert.equal(label("remote", "https://8.8.8.8/dns-query"), "Google · 8.8.8.8 · DoH");
  assert.equal(label("remote", "tls://1.1.1.1"), "Cloudflare · 1.1.1.1 · DoT");
  // An unencrypted resolver is labeled with the protocol, not a translatable word:
  // UDP/DoT/DoH are protocol names and are the same in all languages.
  assert.equal(label("direct", "udp://77.88.8.8"), "Yandex · 77.88.8.8 · UDP");
});

test("адрес в подписи без схемы и без пути, но с портом", () => {
  assert.equal(dnsHostLabel("https://1.1.1.1/dns-query"), "1.1.1.1");
  assert.equal(dnsHostLabel("tls://9.9.9.9"), "9.9.9.9");
  assert.equal(dnsHostLabel("udp://77.88.8.8"), "77.88.8.8");
  assert.equal(dnsHostLabel("udp://1.1.1.1:5353"), "1.1.1.1:5353");
  assert.equal(dnsHostLabel("https://example.test:8443/dns-query"), "example.test:8443");
  assert.equal(dnsHostLabel("77.88.8.8"), "77.88.8.8");
  assert.equal(dnsHostLabel(""), "");
});

// The main reason the type stays in the label: Cloudflare DoH and DoT have the same
// host, Yandex in direct has plain and DoH on 77.88.8.8. Remove the type, and the items
// become indistinguishable from each other right in the list.
test("подписи внутри одного списка не повторяются", () => {
  for (const kind of ["remote", "direct"]) {
    const labels = DNS_PRESETS[kind]
      .filter(p => p.value !== DNS_SEPARATOR)
      .map(dnsPresetLabel);
    assert.equal(new Set(labels).size, labels.length, kind);
  }
});

// An asymmetry in the list reads as unfinished work: one brand has both lines, the
// neighboring one only DoH. The 8.8.8.8 and 94.140.14.14 certificates contain an IP SAN,
// so DoT by a bare IP passes the check for them the same way as for Cloudflare.
test("у каждого remote-бренда есть и DoH, и DoT", () => {
  const byBrand = new Map();
  for (const p of DNS_PRESETS.remote) {
    if (p.value === DNS_SEPARATOR) continue;
    byBrand.set(p.brand, (byBrand.get(p.brand) || new Set()).add(p.type));
  }
  assert.ok(byBrand.size >= 4);
  for (const [brand, types] of byBrand) {
    assert.ok(types.has("doh"), `${brand}: нет DoH`);
    assert.ok(types.has("dot"), `${brand}: нет DoT`);
  }
});

test("разделители не участвуют в поиске пресета", () => {
  assert.equal(findDnsPreset("direct", DNS_SEPARATOR), null);
});

test("isSystemDns ловит оба написания системного резолвера", () => {
  assert.ok(isSystemDns("local"));
  assert.ok(isSystemDns(" system "));
  assert.ok(!isSystemDns("udp://1.1.1.1"));
});

test("путь в plain-адресе отклоняется адресным сообщением", () => {
  const r = validateDnsAddress("udp://8.8.8.8/dns-query");
  assert.equal(r.ok, false);
  assert.equal(r.messageKey, "settings.dns.errPath");
});

test("неизвестная схема отклоняется", () => {
  assert.equal(validateDnsAddress("dot://8.8.8.8").messageKey, "settings.dns.errScheme");
});

test("битый адрес без схемы отклоняется общим сообщением", () => {
  assert.equal(validateDnsAddress("1.1.1.1 8.8.8.8").messageKey, "settings.dns.errGeneric");
});

test("валидные формы принимаются", () => {
  for (const dns of [
    "https://1.1.1.1/dns-query",
    "tls://9.9.9.9",
    "udp://77.88.8.8",
    "udp://1.1.1.1:5353",
    "local",
    "77.88.8.8",
    "",
  ]) {
    assert.ok(validateDnsAddress(dns).ok, dns);
  }
});

test("каждый пресет проходит собственный валидатор", () => {
  for (const kind of ["remote", "direct"]) {
    for (const p of DNS_PRESETS[kind]) {
      if (p.value === DNS_SEPARATOR) continue;
      assert.ok(validateDnsAddress(p.value).ok, `${kind}: ${p.value}`);
    }
  }
});

test("системный резолвер не предлагается для remote, но остаётся для direct", () => {
  assert.equal(DNS_PRESETS.remote.some(p => isSystemDns(p.value)), false);
  assert.ok(DNS_PRESETS.direct.some(p => isSystemDns(p.value)));
});
