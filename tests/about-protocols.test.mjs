// "About" is the showcase of what the client can do. Its list wasn't checked against
// anything and lagged behind: anytls, Hysteria v1 and SOCKS were already built into outbounds, while
// there were eight chips — even though the description paragraph on the same screen listed
// all eleven. Invariant: every buildOutbound branch is represented by a chip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const view = readFileSync("src/lib/settings-view.js", "utf8");
const builder = readFileSync("src/lib/singbox.js", "utf8");

const listed = (() => {
  const start = view.indexOf("const ABOUT_PROTOCOLS");
  const open = view.indexOf("[", start);
  const close = view.indexOf("]", open);
  return [...view.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
})();

// Chip names are human-readable, branches are by node.proto value.
const CHIP_BY_PROTO = {
  vless: "vless",
  vmess: "vmess",
  trojan: "trojan",
  shadowsocks: "shadowsocks",
  hysteria2: "hysteria2",
  hysteria: "hysteria",
  tuic: "tuic",
  anytls: "anytls",
  mieru: "mieru",
  socks: "socks",
  naive: "naiveproxy",
  trusttunnel: "trusttunnel",
};

// WireGuard and OpenVPN don't go through buildOutbound: they're endpoints, and
// the builder assembles them with separate functions. The invariant is the same — the showcase must
// show what the client actually brings up.
const ENDPOINT_PROTOS = {
  wireguard: ["wireguard", "amneziawg"],
  openvpn: ["openvpn"],
};

test("каждый собираемый протокол показан в «О программе»", () => {
  const branches = [...builder.matchAll(/^\s{4}case "([a-z0-9]+)":/gm)]
    .map((m) => m[1])
    .filter((proto) => proto in CHIP_BY_PROTO);
  assert.ok(branches.length >= 10, `ветки протоколов не распознаны: ${branches}`);

  const missing = [...new Set(branches)]
    .map((proto) => CHIP_BY_PROTO[proto])
    .filter((chip) => !listed.includes(chip));
  assert.deepEqual(missing, [], `нет чипа для: ${missing.join(", ")}`);
});

test("протоколы, собираемые как endpoint, тоже показаны в «О программе»", () => {
  for (const [proto, chips] of Object.entries(ENDPOINT_PROTOS)) {
    assert.ok(
      builder.includes(`profileProto(n) === "${proto}"`),
      `билдер больше не собирает ${proto} — проверку пора обновить`,
    );
    const missing = chips.filter((chip) => !listed.includes(chip));
    assert.deepEqual(missing, [], `нет чипа для: ${missing.join(", ")}`);
  }
});
