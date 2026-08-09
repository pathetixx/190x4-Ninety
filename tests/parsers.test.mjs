// Парсеры ссылок singbox.js — чистые функции, главный источник «нода молча
// не поднялась» при регрессии. Гоняются node --test без сборки приложения.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVless,
  parseVmess,
  parseTrojan,
  parseShadowsocks,
  parseHysteria2,
  parseTuic,
  parseNaive,
  parseTrustTunnelDeepLink,
  parseTrustTunnelToml,
  parseLink,
  profileProto,
} from "/lib/singbox.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const b64urlBytes = (bytes) => Buffer.from(bytes)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

test("vless: reality + xhttp со всеми параметрами", () => {
  const p = parseVless(
    "vless://11111111-2222-3333-4444-555555555555@example.com:443" +
    "?security=reality&type=xhttp&flow=xtls-rprx-vision&sni=cdn.example.org" +
    "&fp=firefox&pbk=PUBKEY&sid=abcd&path=%2Fstream&host=front.example.org&mode=packet-up" +
    "#%D0%9C%D0%BE%D1%8F%20%D0%BD%D0%BE%D0%B4%D0%B0"
  );
  assert.equal(p.uuid, "11111111-2222-3333-4444-555555555555");
  assert.equal(p.host, "example.com");
  assert.equal(p.port, 443);
  assert.equal(p.security, "reality");
  assert.equal(p.type, "xhttp");
  assert.equal(p.flow, "xtls-rprx-vision");
  assert.equal(p.sni, "cdn.example.org");
  assert.equal(p.fp, "firefox");
  assert.equal(p.pbk, "PUBKEY");
  assert.equal(p.sid, "abcd");
  assert.equal(p.path, "/stream");
  assert.equal(p.host_header, "front.example.org");
  assert.equal(p.mode, "packet-up");
  assert.equal(p.name, "Моя нода");
});

test("vless: дефолты и sni-фолбэк на host", () => {
  const p = parseVless("vless://uuid@1.2.3.4:8443");
  assert.equal(p.security, "none");
  assert.equal(p.type, "tcp");
  assert.equal(p.sni, "1.2.3.4");
  assert.equal(p.fp, "chrome");
  assert.equal(p.name, "VLESS");
});

test("vless: IPv6-хост в скобках", () => {
  const p = parseVless("vless://uuid@[2001:db8::1]:443?security=tls");
  assert.equal(p.host, "2001:db8::1");
  assert.equal(p.port, 443);
});

// Панели экранируют userinfo целиком, а пустой UUID собрал бы конфиг, который
// падает уже в ядре на аутентификации — без внятного сообщения.
test("vless: UUID декодируется, пустой отвергается", () => {
  const p = parseVless("vless://uuid%2Dwith%2Ddash@example.com:443");
  assert.equal(p.uuid, "uuid-with-dash");
  assert.throws(() => parseVless("vless://@example.com:443"));
  assert.throws(() => parseVless("vless://%20@example.com:443"));
});

test("vless: битый порт кидает", () => {
  assert.throws(() => parseVless("vless://uuid@example.com:99999"));
  assert.throws(() => parseVless("vless://uuid@example.com:0"));
  assert.throws(() => parseVless("vless://uuid@example.com"));
});

test("vmess: base64 JSON", () => {
  const j = {
    add: "vm.example.com", port: "8080", id: "uuid-here", aid: "0",
    net: "ws", tls: "tls", sni: "sni.example.com", path: "/ws", host: "h.example.com",
    ps: "My VMess",
  };
  const p = parseVmess("vmess://" + b64(JSON.stringify(j)));
  assert.equal(p.proto, "vmess");
  assert.equal(p.host, "vm.example.com");
  assert.equal(p.port, 8080);
  assert.equal(p.uuid, "uuid-here");
  assert.equal(p.type, "ws");
  assert.equal(p.tlsMode, "tls");
  assert.equal(p.sni, "sni.example.com");
  assert.equal(p.path, "/ws");
  assert.equal(p.host_header, "h.example.com");
  assert.equal(p.name, "My VMess");
});

test("vmess: не-base64 кидает", () => {
  assert.throws(() => parseVmess("vmess://%%%"));
});

test("trojan: пароль с url-encoding", () => {
  const p = parseTrojan("trojan://p%40ss@tj.example.com:443?sni=x.example.com#TJ");
  assert.equal(p.password, "p@ss");
  assert.equal(p.host, "tj.example.com");
  assert.equal(p.port, 443);
  assert.equal(p.sni, "x.example.com");
  assert.equal(p.name, "TJ");
});

test("ss: SIP002 с base64url-userinfo", () => {
  const userinfo = Buffer.from("chacha20-ietf-poly1305:secret", "utf8")
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const p = parseShadowsocks(`ss://${userinfo}@ss.example.com:8388#SS`);
  assert.equal(p.method, "chacha20-ietf-poly1305");
  assert.equal(p.password, "secret");
  assert.equal(p.host, "ss.example.com");
  assert.equal(p.port, 8388);
});

test("ss: legacy full-base64", () => {
  const p = parseShadowsocks("ss://" + b64("aes-256-gcm:pw@legacy.example.com:8389") + "#Legacy");
  assert.equal(p.method, "aes-256-gcm");
  assert.equal(p.password, "pw");
  assert.equal(p.host, "legacy.example.com");
  assert.equal(p.port, 8389);
});

test("hysteria2: hy2-алиас, obfs и insecure", () => {
  const p = parseHysteria2("hy2://pass@h2.example.com:443?obfs=salamander&obfs-password=op&insecure=1&sni=s.example.com#H2");
  assert.equal(p.proto, "hysteria2");
  assert.equal(p.password, "pass");
  assert.equal(p.obfs, "salamander");
  assert.equal(p.obfsPassword, "op");
  assert.equal(p.insecure, true);
  assert.equal(p.sni, "s.example.com");
});

test("tuic: uuid:password и congestion_control", () => {
  const p = parseTuic("tuic://uuid-1:pw%21@t.example.com:443?congestion_control=cubic&alpn=h3#T");
  assert.equal(p.uuid, "uuid-1");
  assert.equal(p.password, "pw!");
  assert.equal(p.congestionControl, "cubic");
  assert.equal(p.alpn, "h3");
});

// base64-пейлоады несут UTF-8. Декод через atob отдавал latin1-строку, и любое
// не-ASCII (имя ноды из RU/CN-панели, пароль) приезжало побайтово перевранным:
// имя — мохибаке в UI, пароль — отказ аутентификации без единого сообщения.
test("vmess: UTF-8 в имени и host_header переживает base64", () => {
  const j = {
    add: "vm.example.com", port: "443", id: "uuid-here",
    ps: "Москва · 🇷🇺", host: "фронт.example.com",
  };
  const p = parseVmess("vmess://" + b64(JSON.stringify(j)));
  assert.equal(p.name, "Москва · 🇷🇺");
  assert.equal(p.host_header, "фронт.example.com");
});

test("ss: UTF-8 пароль переживает base64 (SIP002 и legacy)", () => {
  const userinfo = Buffer.from("aes-256-gcm:пароль", "utf8")
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sip002 = parseShadowsocks(`ss://${userinfo}@ss.example.com:8388`);
  assert.equal(sip002.method, "aes-256-gcm");
  assert.equal(sip002.password, "пароль");

  const legacy = parseShadowsocks("ss://" + b64("aes-256-gcm:пароль@legacy.example.com:8389"));
  assert.equal(legacy.password, "пароль");
  assert.equal(legacy.host, "legacy.example.com");
});

test("ss: percent-encoded метод и битый escape не роняют импорт", () => {
  const p = parseShadowsocks("ss://aes-256-gcm:p%40ss@ss.example.com:8388");
  assert.equal(p.method, "aes-256-gcm");
  assert.equal(p.password, "p@ss");
  // Битый %-escape раньше кидал из decodeURIComponent и убивал всю ссылку.
  const broken = parseShadowsocks("ss://aes-256-gcm:100%pw@ss.example.com:8388");
  assert.equal(broken.password, "100%pw");
});

// buildOutbound читает p.insecure для tls.insecure. Парсер это поле не выставлял
// вовсе, поэтому TUIC-нода с самоподписанным сертификатом молча не поднималась.
test("tuic: insecure и allow_insecure доезжают до профиля", () => {
  assert.equal(parseTuic("tuic://u:p@t.example.com:443?insecure=1").insecure, true);
  assert.equal(parseTuic("tuic://u:p@t.example.com:443?allow_insecure=true").insecure, true);
  assert.equal(parseTuic("tuic://u:p@t.example.com:443?insecure=0").insecure, false);
  assert.equal(parseTuic("tuic://u:p@t.example.com:443").insecure, false);
});

// Незакодированное двоеточие в пароле встречается в ссылках руками собранных
// панелей. Обрезка хвоста тут не даёт ошибки нигде: конфиг валиден, ядро
// стартует, нода отваливается на аутентификации.
test("ss: пароль с двоеточием не теряет хвост (SIP002 и legacy base64)", () => {
  const sip002 = parseShadowsocks("ss://aes-256-gcm:pa:ss@ss.example.com:8388#SS");
  assert.equal(sip002.method, "aes-256-gcm");
  assert.equal(sip002.password, "pa:ss");

  const legacy = parseShadowsocks(`ss://${b64("aes-256-gcm:pa:ss@legacy.example.com:8389")}`);
  assert.equal(legacy.method, "aes-256-gcm");
  assert.equal(legacy.password, "pa:ss");
  assert.equal(legacy.host, "legacy.example.com");
});

test("tuic: пароль с двоеточием сохраняется целиком", () => {
  const p = parseTuic("tuic://uuid-1:pa:ss@t.example.com:443#T");
  assert.equal(p.uuid, "uuid-1");
  assert.equal(p.password, "pa:ss");
});

test("булевы параметры ссылок принимают и 1, и true", () => {
  const base = "hy2://pass@h2.example.com:443";
  assert.equal(parseHysteria2(`${base}?insecure=true`).insecure, true);
  assert.equal(parseHysteria2(`${base}?insecure=1`).insecure, true);
  assert.equal(parseHysteria2(`${base}?insecure=false`).insecure, false);
  assert.equal(parseHysteria2(`${base}?insecure=0`).insecure, false);
  assert.equal(parseHysteria2(base).insecure, false);

  const tuic = parseTuic("tuic://uuid:pw@t.example.com:443?zero_rtt_handshake=1&disable_sni=true");
  assert.equal(tuic.zeroRttHandshake, true);
  assert.equal(tuic.disableSni, true);
  const tuicOff = parseTuic("tuic://uuid:pw@t.example.com:443");
  assert.equal(tuicOff.zeroRttHandshake, false);
  assert.equal(tuicOff.disableSni, false);
});

test("naive: https-схема и креды", () => {
  const p = parseNaive("naive+https://user:p%40ss@n.example.com:443#NV");
  assert.equal(p.proto, "naive");
  assert.equal(p.scheme, "https");
  assert.equal(p.username, "user");
  assert.equal(p.password, "p@ss");
  assert.equal(p.host, "n.example.com");
  assert.equal(p.port, 443);
});

test("naive: quic-схема; чужая схема кидает", () => {
  assert.equal(parseNaive("naive+quic://u:p@h.example.com:443").scheme, "quic");
  assert.throws(() => parseNaive("naive+socks://u:p@h.example.com:443"));
});

test("trusttunnel deeplink: malformed TLV даёт нормальную ошибку, не TypeError", () => {
  const malformed = `tt://?${b64urlBytes([0x01, 0x05, 0x41])}`; // type=1, len=5, value shorter
  assert.throws(
    () => parseTrustTunnelDeepLink(malformed),
    (err) => err instanceof Error && err.name !== "TypeError" && /ttTlvOOB|TLV|границ/i.test(err.message)
  );
});

// Сертификат в deep-link едет сырым DER, а trusttunnel_client принимает только
// PEM: без конверсии узел из tt:// уходил в мост без своего CA (тот же endpoint
// из .toml при этом работал), а Uint8Array ещё и сохранялся в JSON как {"0":..}.
test("trusttunnel deeplink: DER-сертификат превращается в PEM", () => {
  const tlv = (type, value) => {
    const len = value.length;
    return [type, ...(len < 64 ? [len] : [0x40 | (len >> 8), len & 0xff]), ...value];
  };
  const utf8 = (s) => [...Buffer.from(s, "utf8")];
  const der = Array.from({ length: 70 }, (_, i) => (i * 7) & 0xff); // > 64 байт base64 → перенос строки
  const payload = [
    ...tlv(0x01, utf8("tt.example.com")),
    ...tlv(0x02, utf8("1.2.3.4:443")),
    ...tlv(0x05, utf8("user")),
    ...tlv(0x06, utf8("pass")),
    ...tlv(0x08, der),
  ];

  const p = parseTrustTunnelDeepLink(`tt://?${b64urlBytes(payload)}`);
  const lines = p.certificate.trimEnd().split("\n");
  assert.equal(lines[0], "-----BEGIN CERTIFICATE-----");
  assert.equal(lines.at(-1), "-----END CERTIFICATE-----");
  assert.ok(lines.slice(1, -1).every((l) => l.length <= 64), "PEM переносится по 64 символа");
  assert.deepEqual([...Buffer.from(lines.slice(1, -1).join(""), "base64")], der);
  // Сырой DER в профиль не уезжает — его некому прочитать, а JSON он портит.
  assert.equal("certificateDer" in p, false);
});

test("trusttunnel deeplink: без сертификата поле пустое, а не мусорное", () => {
  const bytes = [
    0x01, 14, ...Buffer.from("tt.example.com", "utf8"),
    0x02, 11, ...Buffer.from("1.2.3.4:443", "utf8"),
    0x05, 4, ...Buffer.from("user", "utf8"),
    0x06, 4, ...Buffer.from("pass", "utf8"),
  ];
  assert.equal(parseTrustTunnelDeepLink(`tt://?${b64urlBytes(bytes)}`).certificate, "");
});

test("trusttunnel toml: happy path + certificate + массив с запятой внутри строки", () => {
  const p = parseTrustTunnelToml(`
hostname = "tt.example.com"
addresses = ["1.2.3.4:443", "5.6.7.8:443"]
username = "user"
password = "pa\\"ss"
skip_verification = true
upstream_protocol = "http3"
certificate = "-----BEGIN CERT-----\\nabc\\n-----END CERT-----"
dns_upstreams = ["https://dns.example/dns-query,with-comma", "1.1.1.1"]
`, "TT import");

  assert.equal(p.proto, "trusttunnel");
  assert.equal(p.hostname, "tt.example.com");
  assert.deepEqual(p.addresses, ["1.2.3.4:443", "5.6.7.8:443"]);
  assert.equal(p.password, 'pa"ss');
  assert.equal(p.skipVerification, true);
  assert.equal(p.upstreamProtocol, "http3");
  assert.equal(p.certificate, "-----BEGIN CERT-----\nabc\n-----END CERT-----");
  assert.deepEqual(p.dnsUpstreams, ["https://dns.example/dns-query,with-comma", "1.1.1.1"]);
});

test("parseLink: dispatcher по схеме и unsupported", () => {
  assert.equal(parseLink("vless://uuid@h.example.com:443").proto ?? "vless", "vless");
  assert.equal(parseLink("trojan://pw@h.example.com:443").proto, "trojan");
  assert.throws(() => parseLink("gopher://whatever"));
});

test("profileProto: legacy-профиль без proto = vless", () => {
  assert.equal(profileProto({ host: "x", port: 1 }), "vless");
  assert.equal(profileProto({ proto: "naive" }), "naive");
});

test("парсеры: порт обязан быть 1..65535 и числом", () => {
  const cases = [
    ["vless", (port) => parseVless(`vless://uuid@example.com:${port}`)],
    ["vmess", (port) => parseVmess("vmess://" + b64(JSON.stringify({ add: "vm.example.com", port, id: "uuid" })))],
    ["trojan", (port) => parseTrojan(`trojan://pw@tj.example.com:${port}`)],
    ["shadowsocks", (port) => parseShadowsocks(`ss://${b64("aes-256-gcm:secret")}@ss.example.com:${port}`)],
    ["hysteria2", (port) => parseHysteria2(`hy2://pass@h2.example.com:${port}`)],
    ["tuic", (port) => parseTuic(`tuic://uuid:pw@t.example.com:${port}`)],
    ["naive", (port) => parseNaive(`naive+https://user:pw@n.example.com:${port}`)],
  ];
  for (const [name, parse] of cases) {
    assert.equal(parse("443").port, 443, `${name}: 443 должен проходить`);
    for (const bad of ["0", "65536", "abc", ""]) {
      assert.throws(() => parse(bad), undefined, `${name}: ${bad || "empty"} должен падать`);
    }
  }
});
