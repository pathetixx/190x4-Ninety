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

test("refreshAllSubscriptions ограничивает concurrency и не валит общий refresh ошибкой одной подписки", async () => {
  const localStorage = makeStorage();
  globalThis.localStorage = localStorage;
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (cmd, { url }) => {
          assert.equal(cmd, "fetch_subscription");
          active++;
          maxActive = Math.max(maxActive, active);
          await sleep(url.endsWith("/2") ? 25 : 5);
          active--;
          if (url.endsWith("/4")) throw new Error("boom");
          const host = new URL(url).hostname;
          return { status: 200, body: `vless://uuid@${host}:443` };
        },
      },
    },
  };

  let active = 0;
  let maxActive = 0;
  const { saveSubscriptions, refreshAllSubscriptions } = await import("/lib/subscriptions.js");
  saveSubscriptions(Array.from({ length: 7 }, (_, i) => ({
    id: `s${i}`,
    url: `https://sub${i}.example/${i}`,
    name: `S${i}`,
    profiles: [],
  })));

  const res = await refreshAllSubscriptions();
  assert.ok(maxActive <= 3, `одновременно было ${maxActive}, ожидали не больше 3`);
  assert.equal(res.length, 7);
  assert.deepEqual(res.map((r) => r.id), ["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
  assert.equal(res.filter((r) => r.ok).length, 6);
  assert.equal(res.find((r) => r.id === "s4")?.ok, false);
  assert.match(res.find((r) => r.id === "s4")?.error || "", /boom/);
});
