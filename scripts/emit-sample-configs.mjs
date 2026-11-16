#!/usr/bin/env node
// Пишет представительный набор конфигов в каталог из argv[2], чтобы CI прогнал
// их через `sing-box check` настоящим ядром. Ядро строго относится к неизвестным
// полям: любое лишнее роняет ВЕСЬ конфиг, а узнать об этом на машине юзера — уже
// поздно. Набор покрывает все три режима, блокировки, регион, WARP и все
// протоколы, которые несёт только наш форк ядра (AmneziaWG 2/3, Mieru, OpenVPN).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig } from "/lib/singbox.js";
import { DEFAULT_OPTIONS } from "/lib/options.js";
import { createStrictPrivacyPolicy } from "/lib/strict-privacy-policy.js";
import { parseLink, parseVless, parseWireguardConf, nodeTag } from "/lib/singbox.js";
import { parseOpenvpnConf } from "/lib/openvpn.js";
import { parseXrayConfig } from "/lib/xray-config-import.js";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: emit-sample-configs.mjs <out-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const node = (host) => parseVless(`vless://uuid@${host}:443?security=tls&sni=${host}`);
const nodes = [node("a.example.com"), node("b.example.com")];
const sub = { kind: "sub", subscription: { name: "S" }, nodes };

// WireGuard живёт в config.endpoints, а не в outbounds, и шейпинг AmneziaWG
// принимает только наше ядро — оба места стоит проверять настоящим `check`.
const WG_CONF = `[Interface]
Address = 172.16.0.2/32, 2606:4700:110:8edc:ef5d:17ec:2624:4a72/128
MTU = 1280
Jc = 4
Jmin = 8
Jmax = 80
H1 = 1
H2 = 2
H3 = 3
H4 = 4
I1 = <b 0xc0ffee>
PrivateKey = nlhuTLXG3gAV8AJmw8jYngX3QkwdDoSPi2HxhGGSKrs=

[Peer]
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 162.159.192.1:2408
PersistentKeepalive = 15
PublicKey = zjVMotkY/dyEZygQ7crKvCtV1ODNZkVx1xe/1Bvvo8A=
`;
const AWG_CONF = WG_CONF
  .replace("H1 = 1", "H1 = 1020983529")
  .replace("H2 = 2", "H2 = 1449520552")
  .replace("H3 = 3", "H3 = 1120404579")
  .replace("H4 = 4", "H4 = 1741401686")
  .replace("MTU = 1280", "MTU = 1280\nS1 = 15\nS2 = 20");
const wgNode = parseWireguardConf(WG_CONF, "WG");
const awgNode = parseWireguardConf(AWG_CONF, "AWG");

// AmneziaWG 2.0 (S3/S4, диапазоны H) и 3 (защита заголовков, padding,
// хвосты): эти поля понимает только ядро с нашим ninety-wireguard-go.
const AWG2_CONF = WG_CONF
  .replace("H1 = 1", "H1 = 110000000-110020000")
  .replace("H2 = 2", "H2 = 1210000000-1210020000")
  .replace("H3 = 3", "H3 = 1510000000-1510020000")
  .replace("H4 = 4", "H4 = 1910000000-1910020000")
  .replace("MTU = 1280", "MTU = 1280\nS1 = 24\nS2 = 18\nS3 = 21\nS4 = 14");
const AWG3_CONF = AWG2_CONF
  .replace("I1 = <b 0xc0ffee>", "I1 = <b 0xc0ffee><rc 12><t><r 100>\n"
    + "HeaderProtectionKey = AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=\n"
    + "ContentPaddingAddition = 16-64\nRandomTrailers = on");
const awg2Node = parseWireguardConf(AWG2_CONF, "AWG2");
const awg3Node = parseWireguardConf(AWG3_CONF, "AWG3");

// Mieru: TCP с одиночным портом и всеми параметрами из официального примера,
// UDP только с диапазонами (тогда server_port в конфиг не идёт).
const mieruTcp = parseLink("mierus://user:pass@mieru1.example.net?handshake-mode=HANDSHAKE_NO_WAIT"
  + "&mtu=1400&multiplexing=MULTIPLEXING_HIGH&port=6666&port=9998-9999&profile=default"
  + "&protocol=TCP&protocol=TCP&traffic-pattern=CCoQARoECAEQCiIYCAMQASoIMDAwMTAyMDMqCDA0MDUwNjA3");
const mieruUdp = parseLink("mierus://user:pass@mieru2.example.net?port=2000-2010&protocol=UDP&profile=u");

// OpenVPN: TLS-профиль провайдера (tls-crypt, auth-user-pass, несколько
// remote) и static key. Ключи в файлах — самоподписанные, только для CI.
const profilesDir = join(dirname(fileURLToPath(import.meta.url)), "sample-profiles");
const ovpnTls = parseOpenvpnConf(readFileSync(join(profilesDir, "openvpn-tls.ovpn"), "utf8"), "OVPN",
  { username: "user", password: "pass" });
const ovpnStatic = parseOpenvpnConf(readFileSync(join(profilesDir, "openvpn-static.ovpn"), "utf8"), "OVPN static");

// XMC (finalmask Minecraft) — готовый outbound Xray: в sing-box от него
// остаётся socks-мост, а сам он уходит в конфиг xray.
const [xmcNode] = parseXrayConfig([{
  remarks: "XMC",
  outbounds: [{
    protocol: "vless",
    settings: { address: "mc.example.net", port: 25565, id: "89b3cbba-e6ac-485a-9481-976a0415eab9", encryption: "mlkem768x25519plus.native.0rtt.key" },
    streamSettings: { network: "tcp", security: "none", finalmask: { tcp: [{ type: "xmc", settings: { hostname: "mc.example.net" } }] } },
  }],
}]).profiles;
const opts = (over = {}) => ({ ...structuredClone(DEFAULT_OPTIONS), ...over });

const cases = [
  ["proxy", { source: sub, mode: "proxy", options: opts(), xray: true }],
  ["system-proxy", { source: sub, mode: "systemProxy", options: opts(), xray: true }],
  ["tun", { source: sub, mode: "tun", options: opts(), xray: true }],
  ["block-ads", { source: sub, mode: "tun", options: opts({ blockAds: true }), xray: true }],
  ["region-ru", { source: sub, mode: "tun", options: opts({ region: "ru" }), xray: true }],
  ["region-tr", { source: sub, mode: "tun", options: opts({ region: "tr" }), xray: true }],
  ["tls-tricks", {
    source: sub,
    mode: "tun",
    options: opts({
      tlsTricks: {
        ...DEFAULT_OPTIONS.tlsTricks,
        enableFragment: true,
        mixedSniCase: true,
        enablePadding: true,
      },
    }),
    xray: true,
  }],
  ["warp", {
    source: sub,
    mode: "tun",
    options: opts({ warp: { ...DEFAULT_OPTIONS.warp, enabled: true, noisePreset: "default" } }),
    warpInfo: {
      private_key: "aG9sZGVyLXByaXZhdGUta2V5LWJhc2U2NC1zdHJpbmc9",
      peer_public_key: "aG9sZGVyLXB1YmxpYy1rZXktYmFzZTY0LXN0cmluZz0=",
      client_id: "AAAA",
      local_ipv4: "172.16.0.2",
      local_ipv6: "2606:4700:110:8949:fed6:1c3f:79b3:e2d8",
    },
    xray: true,
  }],
  ["wireguard-single", { profile: wgNode, mode: "tun", options: opts() }],
  ["wireguard-mixed", {
    source: { kind: "sub", subscription: { name: "S" }, nodes: [...nodes, awgNode] },
    mode: "tun",
    options: opts(),
    xray: true,
  }],
  ["amneziawg2-single", { profile: awg2Node, mode: "tun", options: opts() }],
  ["amneziawg3-single", { profile: awg3Node, mode: "tun", options: opts() }],
  ["mieru-single", { profile: mieruTcp, mode: "tun", options: opts() }],
  ["openvpn-single", { profile: ovpnTls, mode: "tun", options: opts() }],
  ["openvpn-static", { profile: ovpnStatic, mode: "proxy", options: opts() }],
  ["new-protocols-mixed", {
    source: { kind: "sub", subscription: { name: "S" }, nodes: [...nodes, awg2Node, awg3Node, mieruTcp, mieruUdp, ovpnTls, xmcNode] },
    mode: "tun",
    options: opts(),
    xray: true,
  }],
  ["strict-privacy", {
    source: sub,
    mode: "tun",
    options: opts(),
    runtimePolicy: createStrictPrivacyPolicy({ selectedNodeTag: nodeTag(0, nodes[0]) }),
    xray: true,
  }],
];

for (const [name, args] of cases) {
  const { config } = buildConfig(args);
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(config, null, 2));
  console.log(`wrote ${name}.json`);
}
