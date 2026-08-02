// Подписки: refreshAllSubscriptions должен сохранять all-settled поведение,
// но не запускать безлимитный сетевой burst.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key: (i) => Array.from(data.keys())[i] ?? null,
    getItem: (k) => data.has(k) ? data.get(k) : null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

let invokeHandler = async () => {
  throw new Error("invoke handler is not configured");
};

globalThis.window = {
  __TAURI__: {
    core: {
      invoke: (...args) => invokeHandler(...args),
    },
  },
};

const {
  assignStableNodeIds,
  detectAddInput,
  mergeSubscriptionRefresh,
  refreshSubscription,
  saveSubscriptions,
  refreshAllSubscriptions,
} = await import("/lib/subscriptions.js");
const { nodeTag, parseLink } = await import("/lib/singbox.js");
const { getRememberedProxySelection, rememberProxySelection } = await import("/lib/proxy-selection.js");

test("refreshAllSubscriptions ограничивает concurrency и не валит общий refresh ошибкой одной подписки", async () => {
  const localStorage = makeStorage();
  globalThis.localStorage = localStorage;
  invokeHandler = async (cmd, { url }) => {
    assert.equal(cmd, "fetch_subscription");
    seenUrls.push(url);
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(url.endsWith("/2") ? 25 : 5);
    active--;
    if (url.endsWith("/4")) throw new Error("boom");
    const host = new URL(url).hostname;
    return { status: 200, body: `vless://uuid@${host}:443` };
  };

  let active = 0;
  let maxActive = 0;
  const seenUrls = [];
  saveSubscriptions(Array.from({ length: 7 }, (_, i) => ({
    id: `s${i}`,
    url: `https://sub${i}.example/${i}`,
    name: `S${i}`,
    autoUpdate: i === 3 ? false : true,
    profiles: [],
  })));

  const res = await refreshAllSubscriptions();
  assert.ok(maxActive <= 3, `одновременно было ${maxActive}, ожидали не больше 3`);
  assert.equal(res.length, 7);
  assert.deepEqual(res.map((r) => r.id), ["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
  assert.ok(seenUrls.some((url) => url === "https://sub3.example/3"), "ручной refreshAll должен обновлять autoUpdate=false");
  assert.equal(res.filter((r) => r.ok).length, 6);
  assert.equal(res.find((r) => r.id === "s4")?.ok, false);
  assert.match(res.find((r) => r.id === "s4")?.error || "", /boom/);
});

test("detectAddInput различает одиночный config, списки, URL и TrustTunnel TOML", () => {
  const one = detectAddInput("vless://uuid@example.com:443#one");
  assert.equal(one.kind, "config");
  assert.equal(one.content, "vless://uuid@example.com:443#one");

  const multi = "vless://uuid@example.com:443#one\ntrojan://pw@example.net:443#two";
  assert.deepEqual(detectAddInput(multi), { kind: "list", content: multi });

  const encodedList = b64(multi);
  assert.deepEqual(detectAddInput(encodedList), { kind: "list", content: multi });

  assert.deepEqual(detectAddInput("https://panel.example/sub"), { kind: "url", url: "https://panel.example/sub" });

  const toml = `
hostname = "tt.example.com"
addresses = ["1.2.3.4:443"]
username = "user"
password = "pw"
`;
  assert.deepEqual(detectAddInput(toml), { kind: "tt-toml", content: toml.trim() });
});

test("mergeSubscriptionRefresh сохраняет ручной интервал при серверном header", () => {
  const merged = mergeSubscriptionRefresh(
    { id: "s1", name: "Manual", updateIntervalMode: "manual", updateIntervalHours: 24, serverUpdateIntervalHours: 6 },
    { profile_update_interval_hours: 12, body: "", profile_title: "Server" },
    [{ id: "p1" }]
  );
  assert.equal(merged.updateIntervalMode, "manual");
  assert.equal(merged.updateIntervalHours, 24);
  assert.equal(merged.serverUpdateIntervalHours, 12);
  assert.deepEqual(merged.profiles, [{ id: "p1" }]);
});

test("mergeSubscriptionRefresh обновляет auto-интервал из серверного header", () => {
  const merged = mergeSubscriptionRefresh(
    { id: "s1", updateIntervalMode: "auto", updateIntervalHours: 6, serverUpdateIntervalHours: 6 },
    { profile_update_interval_hours: 12 },
    []
  );
  assert.equal(merged.updateIntervalMode, "auto");
  assert.equal(merged.updateIntervalHours, 12);
  assert.equal(merged.serverUpdateIntervalHours, 12);
});

test("mergeSubscriptionRefresh для auto без header сохраняет старый effective interval", () => {
  const merged = mergeSubscriptionRefresh(
    { id: "s1", updateIntervalMode: "auto", updateIntervalHours: 8, serverUpdateIntervalHours: 8 },
    {},
    []
  );
  assert.equal(merged.updateIntervalMode, "auto");
  assert.equal(merged.updateIntervalHours, 8);
  assert.equal(merged.serverUpdateIntervalHours, 8);
});

test("mergeSubscriptionRefresh не ломает legacy-подписку с updateIntervalHours", () => {
  const merged = mergeSubscriptionRefresh(
    { id: "s1", updateIntervalHours: 24 },
    { profile_update_interval_hours: 6 },
    []
  );
  assert.equal(merged.updateIntervalMode, "manual");
  assert.equal(merged.updateIntervalHours, 24);
  assert.equal(merged.serverUpdateIntervalHours, 6);
});

test("stableId переживает смену имени в raw-ссылке подписки", () => {
  const previous = assignStableNodeIds([
    parseLink("vless://uuid@example.com:443?security=tls#Москва"),
  ], [], "s1");
  const next = assignStableNodeIds([
    parseLink("vless://uuid@example.com:443?security=tls#Рига"),
  ], previous, "s1");

  assert.equal(next[0].stableId, previous[0].stableId);
  assert.equal(nodeTag(0, next[0]), nodeTag(0, previous[0]));
});

test("первый refresh legacy-подписки переносит сохранённый ручной выбор", async () => {
  const localStorage = makeStorage();
  globalThis.localStorage = localStorage;
  const oldNode = parseLink("vless://uuid@example.com:443?security=tls#Москва");
  const source = { kind: "sub", subscription: { id: "legacy" } };
  saveSubscriptions([{
    id: "legacy",
    url: "https://sub.example/list",
    name: "Legacy",
    profiles: [oldNode],
  }]);
  const oldTag = nodeTag(0, oldNode);
  rememberProxySelection(source, oldTag);

  invokeHandler = async (cmd, { url }) => {
    assert.equal(cmd, "fetch_subscription");
    assert.equal(url, "https://sub.example/list");
    return { status: 200, body: "vless://uuid@example.com:443?security=tls#Рига" };
  };

  const refreshed = await refreshSubscription("legacy");
  const newTag = nodeTag(0, refreshed.profiles[0]);
  assert.notEqual(newTag, oldTag);
  assert.equal(getRememberedProxySelection(source), newTag);
});
