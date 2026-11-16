// Экспорт «sing-box JSON» отдаёт самодостаточный конфиг. Узлы, которые в
// приложении живут за локальным socks-мостом (xhttp/kcp через xray, naive и
// TrustTunnel через свои sidecar-клиенты), воспроизвести в одиночном конфиге
// нечем: там окажется socks на 127.0.0.1, то есть у получателя — его же
// localhost. Такие узлы обязаны отсеиваться, а не уезжать заглушкой.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || {};
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};
let copied = "";
// navigator в Node — getter-only, поэтому подменяем свойство, а не объект.
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (text) => { copied = text; } },
});
globalThis.document = globalThis.document || {
  addEventListener() {}, removeEventListener() {},
};

const { copyOpenvpnConf, exportSingboxJson } = await import("/lib/share.js");
const { parseVless } = await import("/lib/singbox.js");

const vless = parseVless("vless://uuid@ok.example:443?security=tls&sni=ok.example");
const naive = {
  proto: "naive", host: "n.example", port: 443,
  username: "u", password: "p", scheme: "https",
};
const trusttunnel = {
  proto: "trusttunnel", hostname: "tt.example",
  addresses: ["1.2.3.4:443"], username: "u", password: "p",
};

const collect = async (source) => {
  const toasts = [];
  copied = "";
  await exportSingboxJson(source, (msg, kind) => toasts.push({ msg, kind }));
  return { toasts, copied };
};

test("подписка: sidecar-ноды не попадают в экспорт", async () => {
  const { toasts, copied: json } = await collect({
    kind: "sub",
    subscription: { name: "S" },
    nodes: [vless, naive, trusttunnel],
  });
  assert.equal(toasts.at(-1)?.kind, "success");
  const config = JSON.parse(json);
  const servers = config.outbounds.map((o) => o.server).filter(Boolean);
  assert.ok(servers.includes("ok.example"));
  for (const local of servers) {
    assert.notEqual(local, "127.0.0.1", `в экспорт уехал локальный мост: ${json.slice(0, 200)}`);
  }
});

test("одиночный naive-профиль экспортировать нечего — ошибка, а не заглушка", async () => {
  const { toasts, copied: json } = await collect({ kind: "single", profile: naive });
  assert.equal(json, "", "конфиг не должен уходить в буфер");
  assert.equal(toasts.at(-1)?.kind, "error");
});

test("одиночный TrustTunnel-профиль тоже отсеивается", async () => {
  const { toasts, copied: json } = await collect({ kind: "single", profile: trusttunnel });
  assert.equal(json, "");
  assert.equal(toasts.at(-1)?.kind, "error");
});

test("copy .ovpn копирует исходный текст без потери комментариев провайдера", async () => {
  const original = "# Provider VPN\r\nclient\r\nremote vpn.example 1194\r\n";
  const toasts = [];
  copied = "";
  await copyOpenvpnConf({ proto: "openvpn", ovpn: original }, (msg, kind) => toasts.push({ msg, kind }));
  assert.equal(copied, original);
  assert.equal(toasts.at(-1)?.kind, "success");
});

test("copy .ovpn не выдаёт чужой протокол за OpenVPN", async () => {
  const toasts = [];
  copied = "";
  await copyOpenvpnConf(vless, (msg, kind) => toasts.push({ msg, kind }));
  assert.equal(copied, "");
  assert.equal(toasts.at(-1)?.kind, "error");
});
