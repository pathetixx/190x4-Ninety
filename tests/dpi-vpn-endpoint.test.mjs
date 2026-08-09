// Исключение активной VPN-ноды из winws. Ошибка классификации здесь не видна
// нигде: команда падает в Rust, вызов проглатывается .catch(() => false), а в
// списках остаётся исключение предыдущей ноды — winws десинхрит зашифрованный
// трафик к текущему серверу, а UI показывает защиту включённой.
import test from "node:test";
import assert from "node:assert/strict";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.document = { getElementById: () => null };

const calls = [];
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args) => {
        if (command === "dpi_set_active_vpn_endpoint") calls.push(args);
      },
    },
  },
  dispatchEvent: () => {},
};

const { excludeVpnNode, clearVpnNodeExclusion } = await import("/lib/dpi-view.js");

async function endpointArgsFor(host) {
  calls.length = 0;
  await (host === null ? clearVpnNodeExclusion() : excludeVpnNode(host));
  assert.equal(calls.length, 1, `ожидался один вызов для ${host}`);
  return calls[0];
}

test("dpi exclude: IPv4/IPv6 уходят в ip, домены — в domain", async () => {
  assert.deepEqual(await endpointArgsFor("1.2.3.4"), { ip: "1.2.3.4", domain: null });
  assert.deepEqual(await endpointArgsFor("2001:db8::1"), { ip: "2001:db8::1", domain: null });
  assert.deepEqual(await endpointArgsFor("vpn.example.com"), { ip: null, domain: "vpn.example.com" });
  assert.deepEqual(await endpointArgsFor(null), { ip: null, domain: null });
});

// Домен из одних hex-букв и точек проходил прежнюю проверку как «IP-адрес».
test("dpi exclude: hex-домен не выдаёт себя за IP", async () => {
  for (const host of ["abc.def", "dead.cf", "cafe.ba", "de.ad", "face.ee"]) {
    assert.deepEqual(await endpointArgsFor(host), { ip: null, domain: host }, host);
  }
});

test("dpi exclude: битый адрес не уезжает в ip-список", async () => {
  assert.deepEqual(await endpointArgsFor("999.1.1.1"), { ip: null, domain: "999.1.1.1" });
  assert.deepEqual(await endpointArgsFor("1.2.3"), { ip: null, domain: "1.2.3" });
});
