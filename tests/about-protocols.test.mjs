// «О программе» — витрина того, что клиент умеет. Её список ни с чем не
// сверялся и отставал: anytls, Hysteria v1 и SOCKS уже собирались в outbound, а
// чипов было восемь — при том что абзац описания на том же экране перечислял
// все одиннадцать. Инвариант: каждая ветка buildOutbound представлена чипом.
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

// Имена чипов человекочитаемые, ветки — по значению node.proto.
const CHIP_BY_PROTO = {
  vless: "vless",
  vmess: "vmess",
  trojan: "trojan",
  shadowsocks: "shadowsocks",
  hysteria2: "hysteria2",
  hysteria: "hysteria",
  tuic: "tuic",
  anytls: "anytls",
  socks: "socks",
  naive: "naiveproxy",
  trusttunnel: "trusttunnel",
};

// WireGuard не проходит через buildOutbound: в sing-box 1.13 это endpoint, и
// билдер собирает его отдельной функцией. Инвариант тот же — витрина обязана
// показывать то, что клиент действительно поднимает.
const ENDPOINT_PROTOS = {
  wireguard: ["wireguard", "amneziawg"],
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
