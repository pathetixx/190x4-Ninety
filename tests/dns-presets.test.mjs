// DNS-пресеты: подписи пунктов, распознавание сохранённого адреса и проверка
// ручного ввода. Валидатор обязан совпадать с парсером сборки конфига —
// иначе UI примет адрес, на котором ядро упадёт при старте.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  DNS_PRESETS, DNS_SEPARATOR,
  dnsPresetLabel, findDnsPreset, isSystemDns, validateDnsAddress,
} = await import("/lib/dns-presets.js");

const { DEFAULT_OPTIONS } = await import("/lib/options.js");

test("дефолтные адреса присутствуют в своих списках", () => {
  assert.ok(findDnsPreset("remote", DEFAULT_OPTIONS.dns.remoteAddress));
  assert.ok(findDnsPreset("direct", DEFAULT_OPTIONS.dns.directAddress));
});

test("резервы dns-guard видны в списке direct как готовые пункты", () => {
  for (const dns of [
    "https://149.112.112.112/dns-query",
    "https://77.88.8.8/dns-query",
    "udp://149.112.112.112",
    "udp://77.88.8.8",
  ]) {
    assert.ok(findDnsPreset("direct", dns), dns);
  }
});

test("неизвестный адрес пресетом не считается", () => {
  assert.equal(findDnsPreset("direct", "udp://192.168.1.1"), null);
});

test("подпись пункта собирается из бренда и типа", () => {
  const doh = DNS_PRESETS.remote.find(p => p.value === "https://8.8.8.8/dns-query");
  assert.equal(dnsPresetLabel(doh), "Google · DoH");
  const dot = DNS_PRESETS.remote.find(p => p.value === "tls://1.1.1.1");
  assert.equal(dnsPresetLabel(dot), "Cloudflare · DoT");
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
