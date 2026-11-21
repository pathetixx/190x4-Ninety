// Excluding VPN nodes from winws. A classification error here isn't visible
// anywhere: the command fails in Rust, the call is swallowed by .catch(() => false), and
// the lists keep the previous node's exclusion — winws desyncs encrypted
// traffic to the current server, while the UI shows protection enabled.
import test from "node:test";
import assert from "node:assert/strict";

const storage = new Map([
  ["ninety.dpi.enabled", "false"],
  ["ninety.options.v1", JSON.stringify({ privacy: { strictTunnel: false }, route: { tunSplitDiscord: false } })],
]);
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.document = { getElementById: () => null, addEventListener: () => {} };

const calls = [];
const commands = [];
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args) => {
        commands.push(command);
        if (command === "dpi_set_active_vpn_endpoint") calls.push(args);
        if (command === "dpi_start") return 1;
        if (command === "dpi_strategies") return JSON.stringify([{ id: "alt11", name: "ALT11", args: [] }]);
        if (command === "dpi_running") return false;
        return null;
      },
    },
  },
  dispatchEvent: () => {},
};

const { excludeVpnNode, clearVpnNodeExclusion, setVpnNodesProvider, refreshVpnNodeExclusion, toggleDpi, mountDpiView } =
  await import("/lib/dpi-view.js");
await mountDpiView({ ensureElevated: async () => true, onToast: () => {}, switchView: () => {} });

async function endpointArgsFor(host) {
  calls.length = 0;
  await (host === null ? clearVpnNodeExclusion() : excludeVpnNode(host));
  assert.equal(calls.length, 1, `ожидался один вызов для ${host}`);
  return calls[0];
}

test("dpi exclude: IPv4/IPv6 уходят в ips, домены — в domains", async () => {
  assert.deepEqual(await endpointArgsFor("1.2.3.4"), { ips: ["1.2.3.4"], domains: [], resolve: false });
  assert.deepEqual(await endpointArgsFor("2001:db8::1"), { ips: ["2001:db8::1"], domains: [], resolve: false });
  assert.deepEqual(await endpointArgsFor("vpn.example.com"), { ips: [], domains: ["vpn.example.com"], resolve: false });
  assert.deepEqual(await endpointArgsFor(null), { ips: [], domains: [], resolve: false });
});

// A domain made only of hex letters and dots passed the former check as an "IP address".
test("dpi exclude: hex-домен не выдаёт себя за IP", async () => {
  for (const host of ["abc.def", "dead.cf", "cafe.ba", "de.ad", "face.ee"]) {
    assert.deepEqual(await endpointArgsFor(host), { ips: [], domains: [host], resolve: false }, host);
  }
});

test("dpi exclude: битый адрес не уезжает в ip-список", async () => {
  assert.deepEqual(await endpointArgsFor("999.1.1.1"), { ips: [], domains: ["999.1.1.1"], resolve: false });
  assert.deepEqual(await endpointArgsFor("1.2.3"), { ips: [], domains: ["1.2.3"], resolve: false });
});

test("адрес WARP с портом исключается как IP", async () => {
  assert.deepEqual(await endpointArgsFor("162.159.192.1:2408"), { ips: ["162.159.192.1"], domains: [], resolve: false });
  assert.deepEqual(await endpointArgsFor("[2001:db8::2]:443"), { ips: ["2001:db8::2"], domains: [], resolve: false });
  assert.deepEqual(
    await endpointArgsFor("engage.cloudflareclient.com:2408"),
    { ips: [], domains: ["engage.cloudflareclient.com"], resolve: false },
  );
});

test("при выключенном DPI резолв доменов не запрашивается", async () => {
  await clearVpnNodeExclusion();
  setVpnNodesProvider(() => ({ ips: ["10.0.0.1:443", "10.0.0.1"], domains: ["a.example.com", "b.example.com:8443"] }));
  calls.length = 0;
  await refreshVpnNodeExclusion();
  assert.deepEqual(calls, [{ ips: ["10.0.0.1"], domains: ["a.example.com", "b.example.com"], resolve: false }]);
});

test("перед стартом winws берётся свежий набор провайдера и просится резолв", async () => {
  let nodes = { ips: ["10.0.0.1"], domains: ["old.example.com"] };
  setVpnNodesProvider(async () => nodes);
  await refreshVpnNodeExclusion();
  // The user changed the source — the provider already returns a different config.
  nodes = { ips: ["10.0.0.2"], domains: ["new.example.com"], extra: true };
  calls.length = 0;
  commands.length = 0;
  await toggleDpi();
  const startAt = commands.indexOf("dpi_start");
  const excludeAt = commands.indexOf("dpi_set_active_vpn_endpoint");
  assert.ok(startAt > -1, "dpi_start вызван");
  assert.ok(excludeAt > -1 && excludeAt < startAt, "исключение отправлено ДО запуска winws");
  assert.deepEqual(calls[0], { ips: ["10.0.0.2"], domains: ["new.example.com"], resolve: true });
});

test("провайдер, бросивший исключение, не ломает запуск", async () => {
  setVpnNodesProvider(() => { throw new Error("конфиг ещё не собран"); });
  calls.length = 0;
  await refreshVpnNodeExclusion();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ips, []);
  setVpnNodesProvider(null);
});
