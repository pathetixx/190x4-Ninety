#!/usr/bin/env node
// Пишет представительный набор конфигов в каталог из argv[2], чтобы CI прогнал
// их через `sing-box check` настоящим ядром. Ядро строго относится к неизвестным
// полям: любое лишнее роняет ВЕСЬ конфиг, а узнать об этом на машине юзера — уже
// поздно. Набор покрывает все три режима, блокировки, регион и WARP.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildConfig } from "/lib/singbox.js";
import { DEFAULT_OPTIONS } from "/lib/options.js";
import { createStrictPrivacyPolicy } from "/lib/strict-privacy-policy.js";
import { parseVless, nodeTag } from "/lib/singbox.js";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: emit-sample-configs.mjs <out-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const node = (host) => parseVless(`vless://uuid@${host}:443?security=tls&sni=${host}`);
const nodes = [node("a.example.com"), node("b.example.com")];
const sub = { kind: "sub", subscription: { name: "S" }, nodes };
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
