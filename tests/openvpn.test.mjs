// .ovpn переносится в endpoint без потери ключей, remotes и настроек сеанса.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

globalThis.window = { __TAURI__: { core: { invoke: async () => "" } } };
const store = new Map();
globalThis.localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
};
globalThis.window.localStorage = globalThis.localStorage;

const { looksLikeOpenvpnConf, openvpnNeedsCredentials, parseOpenvpnConf, openvpnConfText } = await import("/lib/protocol-parsers.js");
const { openvpnIssue, nodeConfigIssue } = await import("/lib/node-validation.js");
const { buildConfig, parseVless, parseWireguardConf } = await import("/lib/singbox.js");
const { detectAddInput, parseSubscriptionEntries } = await import("/lib/subscriptions.js");
const { parseSingboxConfig } = await import("/lib/singbox-config-import.js");
const { parseAmneziaKey } = await import("/lib/amnezia-key.js");
const { createStrictPrivacyPolicy } = await import("/lib/strict-privacy-policy.js");

const CA = "-----BEGIN CERTIFICATE-----\ntrusted-ca\n-----END CERTIFICATE-----";
const CERT = "-----BEGIN CERTIFICATE-----\nclient-cert\n-----END CERTIFICATE-----";
const KEY = "-----BEGIN PRIVATE KEY-----\nclient-key\n-----END PRIVATE KEY-----";
const STATIC_KEY = "-----BEGIN OpenVPN Static key V1-----\n0123456789abcdef\n-----END OpenVPN Static key V1-----";
const block = (name, value) => `<${name}>\n${value}\n</${name}>`;
const conf = (extra = "", remote = "remote vpn.example.com 1194") => `client\ndev tun\nproto udp\n${remote}\n${extra}\n${block("ca", CA)}\n`;
const provider = conf(`nobind\npersist-key\npersist-tun\nauth SHA256\ncipher AES-256-CBC\ndata-ciphers AES-256-GCM:AES-128-GCM\nremote-cert-tls server\nverb 3\n${block("cert", CERT)}\n${block("key", KEY)}\n${block("tls-crypt", STATIC_KEY)}`);

test("OpenVPN: типичный профиль провайдера сохраняет TLS, ключи и исходный текст", () => {
  const profile = parseOpenvpnConf(provider, "Provider");
  assert.equal(looksLikeOpenvpnConf(provider), true);
  assert.equal(looksLikeOpenvpnConf("[Interface]\nPrivateKey=abc"), false);
  assert.equal(profile.raw, "ovpn://vpn.example.com:1194");
  assert.equal(profile.proto, "openvpn");
  assert.equal(profile.name, "Provider");
  assert.equal(profile.host, "vpn.example.com");
  assert.equal(profile.port, 1194);
  assert.equal(profile.network, "udp");
  assert.equal(profile.endpoint.mode, "tls");
  assert.deepEqual(profile.endpoint.servers, [{ server: "vpn.example.com", server_port: 1194, network: "udp" }]);
  assert.deepEqual(profile.endpoint.tls.certificate, CA.split("\n"));
  assert.deepEqual(profile.endpoint.tls.client_certificate, CERT.split("\n"));
  assert.deepEqual(profile.endpoint.tls.client_key, KEY.split("\n"));
  assert.deepEqual(profile.endpoint.tls.control_wrap, { type: "tls_crypt", key: STATIC_KEY.split("\n") });
  assert.deepEqual(profile.endpoint.data_ciphers, ["AES-256-GCM", "AES-128-GCM"]);
  assert.equal(profile.endpoint.data_ciphers_fallback, "AES-256-CBC");
  assert.equal(profile.endpoint.cipher, undefined, "cipher поддерживается ядром только в static_key");
  assert.equal(profile.endpoint.auth, "SHA256");
  assert.equal(profile.endpoint.tls.remote_certificate_tls, "server");
  assert.deepEqual(profile.ignored, []);
  assert.equal(openvpnConfText(profile), provider);
  assert.equal(nodeConfigIssue(profile), null);
});

test("OpenVPN: tls-auth переносит числовое направление OpenVPN в client/server", () => {
  for (const [source, expected] of [
    [`tls-auth [inline] 1\n${block("tls-auth", STATIC_KEY)}`, "client"],
    [`key-direction 0\n${block("tls-auth", STATIC_KEY)}`, "server"],
    [`${block("tls-auth", STATIC_KEY)}\nkey-direction 1`, "client"],
  ]) {
    const profile = parseOpenvpnConf(conf(source));
    assert.deepEqual(profile.endpoint.tls.control_wrap, { type: "tls_auth", key: STATIC_KEY.split("\n"), direction: expected });
    assert.equal(openvpnIssue(profile), null);
  }
  assert.equal(parseOpenvpnConf(conf(block("tls-crypt-v2", STATIC_KEY))).endpoint.tls.control_wrap.type, "tls_crypt_v2");
});

test("OpenVPN: встроенные логин и пароль, запрос отсутствующих и внешние credentials", () => {
  const withAuth = conf(`auth-user-pass\n${block("auth-user-pass", "alice\np a;#ss")}`);
  const profile = parseOpenvpnConf(withAuth);
  assert.equal(profile.authUserPass, true);
  assert.equal(profile.endpoint.username, "alice");
  assert.equal(profile.endpoint.password, "p a;#ss");
  assert.equal(openvpnNeedsCredentials(withAuth), false);
  assert.equal(openvpnNeedsCredentials(conf()), false);
  for (const directive of ["auth-user-pass", "auth-user-pass credentials.txt", block("auth-user-pass", "alice")]) {
    const missing = conf(directive);
    assert.equal(openvpnNeedsCredentials(missing), true);
    assert.throws(() => parseOpenvpnConf(missing), error => error.code === "openvpn-credentials");
    assert.throws(() => parseOpenvpnConf(missing, "", { username: "alice" }), error => error.code === "openvpn-credentials");
    const supplied = parseOpenvpnConf(missing, "", { username: "bob", password: "secret" });
    assert.equal(supplied.endpoint.username, "bob");
    assert.equal(supplied.endpoint.password, "secret");
    assert.equal(openvpnIssue(supplied), null);
  }
  assert.deepEqual(parseOpenvpnConf(conf("auth-user-pass credentials.txt"), "", { username: "bob", password: "secret" }).ignored, ["auth-user-pass"]);
});

test("OpenVPN: несколько remote, общий port/proto, TCP и IPv6 нормализуются", () => {
  const profile = parseOpenvpnConf(conf("port 443\nproto tcp-client\nremote-random", "remote first.example.com\nremote [2001:db8::7] 1194 udp6\nremote third.example.com 8443 tcp4"));
  assert.equal(profile.host, "first.example.com");
  assert.equal(profile.port, 443);
  assert.equal(profile.network, "tcp");
  assert.equal(profile.endpoint.network, "tcp");
  assert.equal(profile.endpoint.remote_random, true);
  assert.deepEqual(profile.endpoint.servers, [
    { server: "first.example.com", server_port: 443, network: "tcp" },
    { server: "2001:db8::7", server_port: 1194, network: "udp" },
    { server: "third.example.com", server_port: 8443, network: "tcp" },
  ]);
  for (const [proto, expected] of [["udp", "udp"], ["udp4", "udp"], ["udp6", "udp"], ["tcp", "tcp"], ["tcp4", "tcp"], ["tcp6", "tcp"], ["tcp-client", "tcp"]]) {
    assert.equal(parseOpenvpnConf(conf(`proto ${proto}`)).network, expected);
  }
});

test("OpenVPN: пути не читаются, TAP отклоняется, неизвестные директивы перечисляются", () => {
  assert.throws(() => parseOpenvpnConf("client\ndev tun\nremote vpn.example.com 1194\nca ca.crt"), /single-file|единый файл/i);
  const paths = parseOpenvpnConf(conf(`ca ca.crt\ncert client.crt\nkey client.key\ntls-auth ta.key\nunknown-option yes\nunknown-option again\n${block("cert", CERT)}\n${block("key", KEY)}\n${block("tls-auth", STATIC_KEY)}`));
  assert.deepEqual(paths.ignored, ["ca", "cert", "key", "tls-auth", "unknown-option"]);
  assert.equal(paths.endpoint.tls.certificate_path, undefined);
  assert.equal(paths.endpoint.tls.client_certificate_path, undefined);
  assert.equal(paths.endpoint.tls.control_wrap.type, "tls_auth");
  for (const unavailable of ["cert client.crt", "key client.key", "cert client.crt\nkey client.key", "tls-auth ta.key 1", "tls-crypt tls.key", "tls-crypt-v2 [inline]"]) {
    assert.throws(() => parseOpenvpnConf(conf(unavailable)), /single-file|единый файл/i, unavailable);
  }
  assert.throws(() => parseOpenvpnConf(conf("dev tap")), /TAP/);
  assert.throws(() => parseOpenvpnConf(conf("dev-type tap")), /TAP/);
  assert.throws(() => parseOpenvpnConf(conf(block("cert", CERT))), /single-file|единый файл/i);
  assert.deepEqual(parseOpenvpnConf(conf("<unsupported>\nanything\n</unsupported>")).ignored, ["unsupported"]);
});

test("OpenVPN: служебные директивы не становятся предупреждениями", () => {
  const harmless = ["nobind", "persist-key", "persist-tun", "resolv-retry infinite", "verb 3", "mute 20", "mute-replay-warnings", "setenv opt value", "script-security 2", "up script.sh", "down script.sh", "dhcp-option DNS 1.1.1.1", "block-outside-dns", "route-method exe", "route-delay 2", "pull", "tls-client", "float", "sndbuf 0", "rcvbuf 0", "push-peer-info", "auth-nocache", "register-dns", "connect-retry 2", "connect-retry-max 3", "server-poll-timeout 10"];
  assert.deepEqual(parseOpenvpnConf(conf(harmless.join("\n"))).ignored, []);
});

test("OpenVPN: TLS-проверки и полное отображение имен полей по справочнику ядра", () => {
  const endpoint = parseOpenvpnConf(conf(`verify-x509-name "VPN Server" name-prefix\ntls-version-min 1.0 or-highest\ntls-version-max 1.3\ntls-cipher ECDHE-RSA-AES256-GCM-SHA384:AES256-SHA\ntls-groups X25519:SECP256R1\nns-cert-type server\nremote-cert-ku a0 88\nremote-cert-eku "TLS Web Server Authentication"\ntls-cert-profile preferred\nncp-ciphers AES-128-GCM:AES-256-GCM\ndata-ciphers-fallback AES-128-CBC\ncipher AES-256-CBC\nauth SHA512`)).endpoint;
  assert.deepEqual(endpoint.tls, {
    certificate: CA.split("\n"), server_name: "VPN Server", server_name_type: "name-prefix",
    version_min: "1.0", version_max: "1.3", cipher: "ECDHE-RSA-AES256-GCM-SHA384:AES256-SHA",
    groups: "X25519:SECP256R1", ns_certificate_type: "server", remote_certificate_ku: ["a0", "88"],
    remote_certificate_eku: "TLS Web Server Authentication", certificate_profile: "preferred",
  });
  assert.deepEqual(endpoint.data_ciphers, ["AES-128-GCM", "AES-256-GCM"]);
  assert.equal(endpoint.data_ciphers_fallback, "AES-128-CBC");
  assert.equal(endpoint.auth, "SHA512");
  assert.equal(parseOpenvpnConf(conf('verify-x509-name "CN=VPN Server"')).endpoint.tls.server_name_type, "subject");
});

test("OpenVPN: MTU, маршруты, сжатие, таймеры и аутентификация не теряются", () => {
  const endpoint = parseOpenvpnConf(conf(`compress lz4-v2\ncomp-lzo no\nallow-compression asym\nmssfix 1360 mtu\nfragment 1300\ntun-mtu 1420\nroute-nopull\npull-filter ignore "route "\npull-filter accept "dhcp-option DNS"\nredirect-gateway def1 ipv6\nblock-ipv6\nping 10\nping-restart 60\nreneg-sec 3600\nreneg-bytes 1000000\nreneg-pkts 10000\ntls-timeout 2\nhand-window 60\nexplicit-exit-notify 2\nauth-retry nointeract\nstatic-challenge "One-time password" 0`)).endpoint;
  for (const [key, expected] of Object.entries({ compression: "lz4-v2", compression_lzo: "no", allow_compression: "asym", mss_fix: 1360, mss_fix_mode: "mtu", fragment: 1300, mtu: 1420, route_no_pull: true, redirect_gateway: true, block_ipv6: true, ping_interval: "10s", ping_restart: "60s", renegotiate_interval: "3600s", renegotiate_bytes: 1000000, renegotiate_packets: 10000, tls_timeout: "2s", handshake_window: "60s", explicit_exit_notify: 2, auth_retry: "nointeract", static_challenge: "One-time password", static_challenge_echo: false })) assert.deepEqual(endpoint[key], expected, key);
  assert.deepEqual(endpoint.pull_filters, [{ action: "ignore", text: "route " }, { action: "accept", text: "dhcp-option DNS" }]);
  assert.deepEqual(endpoint.redirect_gateway_flags, ["def1", "ipv6"]);
});

test("OpenVPN: нулевые таймеры выключают defaults ядра, необязательные значения сохраняют смысл", () => {
  const disabled = parseOpenvpnConf(conf("mssfix 0\nping-restart 0\nreneg-sec 0\nexplicit-exit-notify")).endpoint;
  assert.equal(disabled.mss_fix_disabled, true);
  assert.equal(disabled.mss_fix, undefined);
  assert.equal(disabled.ping_restart_disabled, true);
  assert.equal(disabled.ping_restart, undefined);
  assert.equal(disabled.renegotiate_disabled, true);
  assert.equal(disabled.renegotiate_interval, undefined);
  assert.equal(disabled.explicit_exit_notify, 1);
  assert.equal(parseOpenvpnConf(conf("compress")).endpoint.compression, "stub");
  assert.equal(parseOpenvpnConf(conf("comp-lzo")).endpoint.compression_lzo, "adaptive");
  assert.equal(parseOpenvpnConf(conf("comp-lzo")).endpoint.allow_compression, "asym");
  assert.equal(parseOpenvpnConf(conf("mssfix")).endpoint.mss_fix, undefined);
});

test("OpenVPN: static key и ifconfig работают без TLS и CA", () => {
  const profile = parseOpenvpnConf(`dev tun\nremote 203.0.113.5 1194\nsecret [inline] 1\nifconfig 10.8.0.2 10.8.0.1\ncipher AES-256-CBC\nauth SHA256\n${block("secret", STATIC_KEY)}`);
  assert.equal(profile.endpoint.mode, "static_key");
  assert.equal(profile.endpoint.tls, undefined);
  assert.equal(profile.endpoint.cipher, "AES-256-CBC");
  assert.equal(profile.endpoint.key_direction, "client");
  assert.deepEqual(profile.endpoint.static_key, STATIC_KEY.split("\n"));
  assert.deepEqual(profile.endpoint.address, ["10.8.0.2/32"]);
  assert.equal(profile.endpoint.peer_address, "10.8.0.1");
  assert.equal(nodeConfigIssue(profile), null);
  assert.throws(() => parseOpenvpnConf("dev tun\nremote 203.0.113.5 1194\nsecret secret.key\nifconfig 10.8.0.2 10.8.0.1"));
  assert.throws(() => parseOpenvpnConf(`dev tun\nremote 203.0.113.5\n${block("secret", STATIC_KEY)}`));
  for (const options of ["topology subnet\nifconfig 10.8.0.2 255.255.255.0", "ifconfig 10.8.0.2 255.255.255.0\ntopology subnet"]) {
    assert.throws(() => parseOpenvpnConf(`dev tun\nremote 203.0.113.5\n${options}\n${block("secret", STATIC_KEY)}`));
    const tlsProfile = parseOpenvpnConf(conf(options));
    assert.deepEqual(tlsProfile.endpoint.address, ["10.8.0.2/24"]);
    assert.equal(tlsProfile.endpoint.peer_address, undefined);
  }
  assert.throws(() => parseOpenvpnConf(conf("topology subnet\nifconfig 10.8.0.2 255.255.1.0")));
});

test("OpenVPN: кавычки, комментарии, CRLF, BOM и inline-блоки разбираются отдельно", () => {
  const source = `\uFEFF# profile\r\nclient ; comment\r\ndev tun\r\nremote "vpn.example.com" 1194 # note\r\nverify-x509-name 'VPN #1; test' name\r\n<ca>${CA}</ca>\r\n`;
  const profile = parseOpenvpnConf(source);
  assert.equal(profile.endpoint.tls.server_name, "VPN #1; test");
  assert.deepEqual(profile.endpoint.tls.certificate, CA.split("\n"));
  assert.equal(profile.ovpn, source);
  assert.throws(() => parseOpenvpnConf(conf('verify-x509-name "unterminated')), /syntax|синтаксис/);
  assert.throws(() => parseOpenvpnConf(conf("<key>\nmissing closing tag")), /syntax|синтаксис/);
});

test("OpenVPN: неверные параметры отклоняются до создания мёртвого профиля", () => {
  for (const option of ["proto tcp-server", "remote-cert-tls bogus", "verify-x509-name server bogus", "tls-version-min 1.4", "tls-version-min 1.3\ntls-version-max 1.2", "tls-version-max 1.1", "ns-cert-type anything", "remote-cert-ku xyz", "remote-cert-tls server\nremote-cert-eku server", "compress invalid", "comp-lzo invalid", "allow-compression invalid", "compress lz4\nallow-compression no", "fragment 67", "proto tcp\nfragment 1400", "mssfix 1300 invalid", "tun-mtu 0", "ping -1", "auth-retry bogus", "static-challenge question 2", "pull-filter bogus route", "key-direction 3"]) {
    assert.throws(() => parseOpenvpnConf(conf(option)), undefined, option);
  }
  assert.throws(() => parseOpenvpnConf(conf("", "remote vpn.example.com 65536")));
  assert.throws(() => parseOpenvpnConf(conf("", "remote vpn.example.com 0")));
  assert.throws(() => parseOpenvpnConf(conf("redirect-gateway block-local")));
  assert.throws(() => parseOpenvpnConf(conf(`${block("tls-auth", STATIC_KEY)}\n${block("tls-crypt", STATIC_KEY)}`)));
  assert.throws(() => openvpnConfText({ proto: "openvpn", endpoint: {} }));
});

test("OpenVPN validation: обязательные поля и enums имеют отдельные коды", () => {
  const valid = parseOpenvpnConf(conf());
  const issue = patch => openvpnIssue({ ...valid, endpoint: { ...valid.endpoint, ...patch } });
  assert.deepEqual(openvpnIssue({ ...valid, endpoint: undefined }), { code: "ovpnEndpoint" });
  assert.deepEqual(issue({ servers: [] }), { code: "ovpnEndpoint" });
  assert.deepEqual(issue({ servers: [{ server: "vpn.example.com", server_port: 0 }] }), { code: "ovpnEndpoint" });
  assert.deepEqual(issue({ server: "vpn.example.com", server_port: 1194 }), { code: "ovpnEndpoint" });
  assert.deepEqual(issue({ tls: {} }), { code: "ovpnCa" });
  assert.deepEqual(issue({ tls: { certificate_path: "ca.crt" } }), { code: "ovpnCa" });
  assert.deepEqual(openvpnIssue({ ...valid, authUserPass: true }), { code: "ovpnCredentials" });
  assert.deepEqual(issue({ username: "alice" }), { code: "ovpnCredentials" });
  assert.equal(issue({ username: "", password: "" }), null);
  assert.equal(issue({ compression: "", compression_lzo: "", ping_interval: "" }), null);
  assert.deepEqual(issue({ dev: "tap" }), { code: "ovpnTun" });
  assert.deepEqual(openvpnIssue({ ...valid, dev: "tap" }), { code: "ovpnTun" });
  assert.deepEqual(issue({ network: "quic" }), { code: "ovpnNetwork" });
  assert.deepEqual(openvpnIssue({ ...valid, network: "udp4" }), { code: "ovpnNetwork" });
  assert.deepEqual(issue({ servers: [{ server: "vpn.example.com", server_port: 1194, network: "udp6" }] }), { code: "ovpnNetwork" });
  assert.deepEqual(issue({ compression: "invalid" }), { code: "ovpnCompression" });
  assert.deepEqual(issue({ compression_lzo: "invalid" }), { code: "ovpnCompression" });
  assert.deepEqual(issue({ allow_compression: "invalid" }), { code: "ovpnCompression" });
  assert.deepEqual(issue({ mode: "invalid" }), { code: "ovpnOption" });
  assert.deepEqual(issue({ mode: "static_key" }), { code: "ovpnStatic" });
  assert.deepEqual(issue({ redirect_gateway_flags: ["block-local"] }), { code: "ovpnOption" });
  assert.equal(nodeConfigIssue(valid), null);
});

test("OpenVPN validation: взаимозависимые параметры и TLS enums проверяются при JSON import", () => {
  const valid = parseOpenvpnConf(conf());
  const endpointIssue = patch => openvpnIssue({ ...valid, endpoint: { ...valid.endpoint, ...patch } });
  const tlsIssue = patch => endpointIssue({ tls: { ...valid.endpoint.tls, ...patch } });
  for (const key of ["server_name_type", "remote_certificate_tls", "ns_certificate_type", "certificate_profile", "version_min", "version_max"]) assert.deepEqual(tlsIssue({ [key]: "invalid" }), { code: "ovpnOption" }, key);
  assert.deepEqual(tlsIssue({ client_key: KEY }), { code: "ovpnOption" });
  assert.deepEqual(tlsIssue({ client_certificate_path: "cert.pem", client_key_path: "key.pem" }), { code: "ovpnOption" });
  assert.deepEqual(tlsIssue({ certificate_path: "ca.pem" }), { code: "ovpnOption" });
  assert.deepEqual(tlsIssue({ remote_certificate_tls: "server", remote_certificate_eku: "server" }), { code: "ovpnOption" });
  assert.deepEqual(tlsIssue({ control_wrap: { type: "invalid", key: STATIC_KEY } }), { code: "ovpnOption" });
  assert.deepEqual(tlsIssue({ control_wrap: { type: "tls_auth" } }), { code: "ovpnOption" });
  assert.deepEqual(tlsIssue({ control_wrap: { type: "tls_crypt", key: STATIC_KEY, direction: "client" } }), { code: "ovpnOption" });
  assert.equal(tlsIssue({ control_wrap: {} }), null);
  assert.equal(tlsIssue({ control_wrap: { type: "", key: [], key_path: "", direction: "" } }), null);
  for (const patch of [{ cipher: "AES-256-CBC" }, { mss_fix_disabled: true, mss_fix: 1400 }, { mss_fix_mode: "mtu" }, { fragment: 67 }, { ping_restart_disabled: true, ping_restart: "60s" }, { renegotiate_disabled: true, renegotiate_interval: "3600s" }, { auth_retry: "invalid" }, { topology: "invalid" }, { pull_filters: [{ action: "invalid", text: "route " }] }, { mtu: -1 }, { ping_interval: "0.5s" }]) assert.deepEqual(endpointIssue(patch), { code: "ovpnOption" });
  for (const value of ["1m30s", "1h0m0s", "1000ms", "0"]) assert.equal(endpointIssue({ ping_interval: value, ping_restart: value }), null, value);
  assert.equal(endpointIssue({ tls_timeout: "500ms", handshake_window: "1m30.5s", renegotiate_interval: "1h0m0.5s" }), null);
  for (const value of ["1m30ms", "1sbroken", "-1s", "1", 1000]) assert.deepEqual(endpointIssue({ ping_restart: value }), { code: "ovpnOption" }, String(value));
});

test("OpenVPN: распознавание и тело подписки сохраняют оригинал plain/base64", () => {
  const original = `\n# provider export\n${provider}\n`;
  for (const source of [original, Buffer.from(original).toString("base64")]) {
    assert.deepEqual(detectAddInput(source), { kind: "ovpn-conf", content: original });
    const { profiles, skipped } = parseSubscriptionEntries(source);
    assert.equal(skipped, 0);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].ovpn, original);
    assert.equal(profiles[0].proto, "openvpn");
  }
  // Ссылка в комментарии не превращает файл в список отдельных серверов.
  assert.equal(detectAddInput(`# vless://uuid@comment.example:443\n${provider}`).kind, "ovpn-conf");
});

test("OpenVPN builder: одиночный профиль становится endpoint proxy без изменения модели", () => {
  const profile = parseOpenvpnConf(provider, "Provider");
  const before = structuredClone(profile);
  const { config, endpointNodes, outboundNodes } = buildConfig({ source: { kind: "single", profile }, mode: "vpn" });
  assert.deepEqual(config.endpoints, [{ ...profile.endpoint, type: "openvpn-client", tag: "proxy" }]);
  assert.deepEqual(config.outbounds.map(outbound => outbound.type), ["direct"]);
  assert.equal(config.route.final, "proxy");
  assert.equal(config.dns.servers.find(server => server.tag === "dns-remote").detour, "proxy");
  assert.deepEqual(endpointNodes, [profile]);
  assert.deepEqual(outboundNodes, [null]);
  assert.deepEqual(profile, before);
});

test("OpenVPN builder: selector и balancer ссылаются на endpoint и outbound", () => {
  const openvpn = parseOpenvpnConf(provider, "OpenVPN");
  const wireguard = parseWireguardConf(`[Interface]\nAddress = 10.0.0.2/32\nPrivateKey = nlhuTLXG3gAV8AJmw8jYngX3QkwdDoSPi2HxhGGSKrs=\n[Peer]\nPublicKey = zjVMotkY/dyEZygQ7crKvCtV1ODNZkVx1xe/1Bvvo8A=\nEndpoint = 203.0.113.2:51820\nAllowedIPs = 0.0.0.0/0, ::/0`, "WireGuard");
  const vless = parseVless("vless://uuid@other.example:443?security=tls#Other");
  const { config, endpointNodes } = buildConfig({
    source: { kind: "sub", subscription: { id: "mixed" }, nodes: [openvpn, vless, wireguard] }, mode: "vpn",
  });
  assert.deepEqual(config.endpoints.map(endpoint => endpoint.type), ["openvpn-client", "wireguard"]);
  const selector = config.outbounds.find(outbound => outbound.type === "selector");
  const auto = config.outbounds.find(outbound => outbound.type === "balancer");
  for (const tag of config.endpoints.map(endpoint => endpoint.tag)) {
    assert.ok(selector.outbounds.includes(tag));
    assert.ok(auto.outbounds.includes(tag));
    assert.ok(!config.outbounds.some(outbound => outbound.tag === tag));
  }
  assert.ok(auto.outbounds.includes(config.outbounds.find(outbound => outbound.type === "vless").tag));
  assert.equal(auto.outbounds.length, 3);
  assert.deepEqual(endpointNodes, [openvpn, wireguard]);
});

test("OpenVPN builder: строгая приватность проверяет каждый remote", () => {
  const buildStrict = profile => buildConfig({
    source: { kind: "single", profile }, mode: "proxy", runtimePolicy: createStrictPrivacyPolicy(),
  });
  for (const remote of ["remote vpn.example.com 1194", "remote 203.0.113.5 1194\nremote fallback.example.com 443 tcp"]) {
    assert.throws(() => buildStrict(parseOpenvpnConf(conf("", remote))), error => error.code === "STRICT_PRIVACY_BOOTSTRAP_UNSAFE");
  }
  const profile = parseOpenvpnConf(conf("", "remote 203.0.113.5 1194\nremote 2001:db8::5 443 tcp"));
  const { config, runtime } = buildStrict(profile);
  assert.equal(runtime.strictPrivacy, true);
  assert.equal(runtime.mode, "tun");
  assert.equal(config.endpoints[0].tag, "proxy");
  assert.equal(config.endpoints[0].domain_resolver, undefined);
  assert.deepEqual(config.endpoints[0].servers, profile.endpoint.servers);
});

test("OpenVPN Amnezia: сжатый контейнер использует тот же parser и требует credentials", async () => {
  const makeKey = config => {
    const body = Buffer.from(JSON.stringify({ description: "Amnezia OpenVPN", containers: [{
      container: "amnezia-openvpn", openvpn: { last_config: JSON.stringify({ config }) },
    }] }));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    return `vpn://${Buffer.concat([size, deflateSync(body)]).toString("base64url")}`;
  };
  const { profiles, ignored, unsupported } = await parseAmneziaKey(makeKey(provider));
  assert.deepEqual(profiles, [parseOpenvpnConf(provider, "Amnezia OpenVPN")]);
  assert.deepEqual(ignored, []);
  assert.deepEqual(unsupported, []);
  const authenticated = makeKey(conf("auth-user-pass"));
  await assert.rejects(parseAmneziaKey(authenticated), error => error.code === "openvpn-credentials");
  const supplied = await parseAmneziaKey(authenticated, "Override", { username: "alice", password: "secret" });
  assert.equal(supplied.profiles[0].endpoint.username, "alice");
  assert.equal(supplied.profiles[0].endpoint.password, "secret");
  assert.equal(supplied.profiles[0].name, "Override");
});

test("OpenVPN sing-box import: endpoint проходит export/import без потери опций", () => {
  const profile = parseOpenvpnConf(conf(`remote-random\nauth-user-pass\n${block("auth-user-pass", "alice\nsecret")}\n${block("tls-crypt", STATIC_KEY)}\nroute-nopull\npull-filter ignore "route "`, "remote vpn.example.com 1194\nremote backup.example.com 443 tcp"));
  const exported = buildConfig({ source: { kind: "single", profile }, mode: "proxy" }).config;
  const imported = parseSingboxConfig(exported);
  assert.equal(imported.skipped, 0);
  assert.deepEqual(imported.unsupported, []);
  assert.equal(imported.profiles.length, 1);
  const [roundTrip] = imported.profiles;
  for (const field of ["proto", "raw", "host", "port", "network", "endpoint"]) assert.deepEqual(roundTrip[field], profile[field], field);
  assert.equal(nodeConfigIssue(roundTrip), null);
  assert.ok(!("type" in roundTrip.endpoint));
  assert.ok(!("tag" in roundTrip.endpoint));
  const rebuilt = buildConfig({ source: { kind: "single", profile: roundTrip }, mode: "proxy" }).config;
  assert.deepEqual(rebuilt.endpoints, exported.endpoints);
});

test("OpenVPN sing-box import: одиночный server, проверки enum и detour", () => {
  const endpoint = {
    type: "openvpn-client", tag: "Provider TCP", server: "203.0.113.7", server_port: 443,
    network: "tcp", tls: { certificate: CA }, compression: "stub-v2", allow_compression: "no",
  };
  const { profiles, skipped } = parseSingboxConfig({ endpoints: [endpoint] });
  assert.equal(skipped, 0);
  assert.equal(profiles[0].name, endpoint.tag);
  assert.equal(profiles[0].host, endpoint.server);
  assert.equal(profiles[0].network, "tcp");
  assert.equal(nodeConfigIssue(profiles[0]), null);
  assert.deepEqual(buildConfig({ source: { kind: "single", profile: profiles[0] }, mode: "proxy" }).config.endpoints,
    [{ ...endpoint, tag: "proxy" }]);
  assert.deepEqual(parseSingboxConfig({ endpoints: [{ ...endpoint, detour: "other" }] }), {
    profiles: [], skipped: 1, unsupported: ["openvpn-client+detour"],
  });
  const invalid = parseSingboxConfig({ endpoints: [{ ...endpoint, compression: "invalid" }] }).profiles[0];
  assert.deepEqual(nodeConfigIssue(invalid), { code: "ovpnCompression" });
  assert.equal(parseSubscriptionEntries(JSON.stringify({ endpoints: [{ ...endpoint, compression: "invalid" }] })).profiles.length, 0);
  // Внешний DNS-тег исчезает вместе с DNS исходного конфига.
  const foreignDns = parseSingboxConfig({
    dns: { servers: [{ tag: "provider-dns", type: "udp", server: "1.1.1.1" }] },
    endpoints: [{ ...endpoint, domain_resolver: "provider-dns" }],
  }).profiles[0];
  assert.equal(foreignDns.endpoint.domain_resolver, undefined);
  assert.doesNotThrow(() => buildConfig({ source: { kind: "single", profile: foreignDns }, mode: "proxy" }));
});
