import { test } from "node:test";
import assert from "node:assert/strict";

import {
  acquireUpdateForCurrentRoute,
  closeUpdateResource,
  drainUpdateResourceCleanup,
  snapshotUpdate,
} from "../src/lib/update-resource.js";

test("snapshot OTA содержит только metadata, без нативных методов", () => {
  const metadata = snapshotUpdate({
    currentVersion: "0.2.42",
    version: "0.2.43",
    date: "2026-07-30",
    body: "notes",
    download: () => {},
    rawJson: { private: true },
  });
  assert.deepEqual(metadata, {
    currentVersion: "0.2.42",
    version: "0.2.43",
    date: "2026-07-30",
    body: "notes",
  });
  assert.equal("download" in metadata, false);
  assert.equal("rawJson" in metadata, false);
});

test("нативный Update закрывается идемпотентно", async () => {
  let closes = 0;
  const update = { close: async () => { closes++; } };
  assert.equal(await closeUpdateResource(update), true);
  assert.equal(await closeUpdateResource(update), false);
  assert.equal(closes, 1);
});

test("неудачный close можно безопасно повторить", async () => {
  let closes = 0;
  const update = {
    close: async () => {
      closes++;
      if (closes === 1) throw new Error("temporary IPC error");
    },
  };
  assert.equal(await closeUpdateResource(update), true);
  assert.equal(closes, 2);
});

test("persistent close ставит cleanup latch и запрещает следующий check", async () => {
  let closes = 0;
  let failing = true;
  const update = {
    close: async () => {
      closes++;
      if (failing) throw new Error("persistent IPC error");
    },
  };
  assert.equal(await closeUpdateResource(update), false);
  assert.equal(closes, 2);

  let checks = 0;
  await assert.rejects(acquireUpdateForCurrentRoute({
    getProxy: () => null,
    check: async () => {
      checks++;
      return { version: "0.2.43", close: async () => {} };
    },
    unstableMessage: "cleanup pending",
  }), /cleanup pending/);
  assert.equal(checks, 0);
  assert.equal(closes, 4);

  failing = false;
  assert.equal(await drainUpdateResourceCleanup(), true);
  assert.equal(closes, 5);
});

test("смена VPN во время fresh-check закрывает первый Resource и повторяет запрос", async () => {
  const proxies = ["http://127.0.0.1:7890", null];
  let proxyReads = 0;
  const checks = [];
  let firstClosed = 0;
  const first = { version: "0.2.43", close: async () => { firstClosed++; } };
  const second = { version: "0.2.43", close: async () => {} };

  const result = await acquireUpdateForCurrentRoute({
    getProxy: () => proxies[Math.min(proxyReads++, proxies.length - 1)],
    check: async ({ proxy }) => {
      checks.push(proxy);
      return checks.length === 1 ? first : second;
    },
  });

  assert.equal(result, second);
  assert.deepEqual(checks, ["http://127.0.0.1:7890", null]);
  assert.equal(firstClosed, 1);
});

test("повторная смена маршрута приводит к третьему стабильному check", async () => {
  const routeReads = ["proxy-a", "proxy-b", "proxy-b", "proxy-c", "proxy-c", "proxy-c"];
  let read = 0;
  const checks = [];
  const closed = [];
  const result = await acquireUpdateForCurrentRoute({
    getProxy: () => routeReads[Math.min(read++, routeReads.length - 1)],
    check: async ({ proxy }) => {
      checks.push(proxy);
      return {
        version: "0.2.43",
        proxy,
        close: async () => { closed.push(proxy); },
      };
    },
  });
  assert.equal(result.proxy, "proxy-c");
  assert.deepEqual(checks, ["proxy-a", "proxy-b", "proxy-c"]);
  assert.deepEqual(closed, ["proxy-a", "proxy-b"]);
});

test("стабильный маршрут выполняет только один fresh-check", async () => {
  let checks = 0;
  const update = { version: "0.2.43", close: async () => {} };
  const result = await acquireUpdateForCurrentRoute({
    getProxy: () => null,
    check: async ({ proxy }) => {
      assert.equal(proxy, null);
      checks++;
      return update;
    },
  });
  assert.equal(result, update);
  assert.equal(checks, 1);
});

// Ресурс, который не закрывается никогда (типично — rid уже освобождён на
// Rust-стороне), раньше выключал ВСЮ проверку обновлений до перезапуска
// приложения: каждый следующий check упирался в незакрытый quarantine и молча
// возвращал «не смогли проверить».
test("безнадёжный Resource отпускается и не глушит проверки навсегда", async () => {
  let closes = 0;
  const update = {
    close: async () => { closes++; throw new Error("resource id not found"); },
  };

  // Сам неудачный close — первый раунд, дальше два раунда уборки.
  assert.equal(await closeUpdateResource(update), false);
  assert.equal(await drainUpdateResourceCleanup(), false);
  // Третий раунд — последний: дальше уборка перестаёт держать OTA заложником.
  assert.equal(await drainUpdateResourceCleanup(), true);
  assert.equal(closes, 6, "три раунда по два бортовых ретрая");

  // И следующий check действительно проходит.
  let checks = 0;
  const fresh = await acquireUpdateForCurrentRoute({
    getProxy: () => null,
    check: async () => { checks++; return { version: "0.2.58", close: async () => {} }; },
  });
  assert.equal(checks, 1);
  assert.equal(fresh.version, "0.2.58");
});

// «Обновления нет» — это null, а не Resource. Раньше смена маршрута в этот
// момент трактовалась как отказ закрытия (закрывать нечего → false → throw), и
// спокойное «у вас последняя версия» превращалось в ошибку «не удалось
// проверить обновления».
test("смена маршрута при отсутствии обновления не превращается в ошибку", async () => {
  const proxies = ["http://127.0.0.1:7890", null];
  let proxyReads = 0;
  const checks = [];

  const result = await acquireUpdateForCurrentRoute({
    getProxy: () => proxies[Math.min(proxyReads++, proxies.length - 1)],
    check: async ({ proxy }) => {
      checks.push(proxy);
      return null;                       // обновления нет ни на одном маршруте
    },
  });

  assert.equal(result, null);
  assert.deepEqual(checks, ["http://127.0.0.1:7890", null]);
});
