// HWID: идентификатор устройства заводится один раз и уходит только тем
// подпискам, которым его включили.
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

let invokeHandler = async () => {
  throw new Error("invoke handler is not configured");
};

globalThis.window = {
  __TAURI__: { core: { invoke: (...args) => invokeHandler(...args) } },
};
globalThis.localStorage = makeStorage();

const {
  HWID_PATTERN,
  ensureDeviceIdentity,
  hwidSignal,
  isValidHwid,
  looksLikeHwidStub,
  peekDeviceIdentity,
  randomHwid,
  regenerateDeviceIdentity,
} = await import("/lib/hwid.js");
const { refreshSubscription, saveSubscriptions } = await import("/lib/subscriptions.js");

const MACHINE_HWID = "0123456789abcdef0123456789abcdef";

test("HWID принимается только в том виде, который проверяет панель", () => {
  assert.ok(isValidHwid(MACHINE_HWID));
  assert.ok(isValidHwid("A-B=C-D=E-F=G-H"));
  assert.ok(!isValidHwid("short1234"));
  assert.ok(!isValidHwid("a".repeat(65)));
  assert.ok(!isValidHwid("{6b9e0f3a-1c2d-4e5f}"));
  // base64url-алфавит панель не примет: подчёркивание вне её правила.
  assert.ok(!isValidHwid("base64_url_style_id"));
  assert.ok(HWID_PATTERN.test(randomHwid()));
  assert.notEqual(randomHwid(), randomHwid());
});

test("идентификатор берётся из бэкенда один раз и сохраняется", async () => {
  let calls = 0;
  invokeHandler = async (cmd) => {
    assert.equal(cmd, "device_identity");
    calls++;
    return { hwid: MACHINE_HWID, deviceOs: "Windows", verOs: "10.0.26100" };
  };

  const identity = await ensureDeviceIdentity();
  assert.equal(identity.hwid, MACHINE_HWID);
  assert.equal(identity.deviceOs, "Windows");
  assert.equal(identity.verOs, "10.0.26100");
  // Нейтральная модель: имя компьютера панели не показывается.
  assert.equal(identity.deviceModel, "Ninety");

  await ensureDeviceIdentity();
  assert.equal(calls, 1, "второй вызов берёт значение из кэша");
  assert.equal(peekDeviceIdentity().hwid, MACHINE_HWID);
  assert.equal(JSON.parse(localStorage.getItem("ninety.hwid.v1")).hwid, MACHINE_HWID);
});

test("смена идентификатора даёт новое значение и сохраняет его", async () => {
  const next = await regenerateDeviceIdentity();
  assert.ok(isValidHwid(next.hwid));
  assert.notEqual(next.hwid, MACHINE_HWID);
  assert.equal(next.deviceModel, "Ninety");
  assert.equal(JSON.parse(localStorage.getItem("ninety.hwid.v1")).hwid, next.hwid);
  assert.equal((await ensureDeviceIdentity()).hwid, next.hwid);
});

test("ноду-заглушку панели видно и без её ответных заголовков", () => {
  assert.ok(looksLikeHwidStub([{ host: "0.0.0.0", name: "Enable HWID parameter" }]));
  assert.ok(looksLikeHwidStub([{ host: "1.2.3.4", name: "Включите HWID параметр" }]));
  assert.ok(!looksLikeHwidStub([]));
  assert.ok(!looksLikeHwidStub([{ host: "1.2.3.4", name: "Amsterdam" }]));
  // Полноценный список серверов заглушкой не считается, даже если он короткий.
  assert.ok(!looksLikeHwidStub([
    { host: "1.2.3.4", name: "Amsterdam" },
    { host: "0.0.0.0", name: "Broken" },
  ]));
});

test("сигнал панели: требование HWID и исчерпанный лимит устройств", () => {
  assert.deepEqual(
    hwidSignal({ status: 200, hwid_not_supported: true }, []),
    { required: true, limitReached: false },
  );
  assert.deepEqual(
    hwidSignal({ status: 404 }, []),
    { required: true, limitReached: false },
  );
  // Если HWID уже ушёл, повторно предлагать нечего — остаётся только лимит.
  assert.deepEqual(
    hwidSignal({ status: 200, hwid_active: true, hwid_limit_reached: true }, [], { sent: true }),
    { required: false, limitReached: true },
  );
  assert.deepEqual(
    hwidSignal({ status: 200 }, [{ host: "1.2.3.4", name: "Amsterdam" }]),
    { required: false, limitReached: false },
  );
  // Лимит на панели включён, но этому пользователю он отключён и серверы
  // пришли: спрашивать про HWID незачем.
  assert.deepEqual(
    hwidSignal({ status: 200, hwid_active: true }, [{ host: "1.2.3.4", name: "Amsterdam" }]),
    { required: false, limitReached: false },
  );
  assert.deepEqual(
    hwidSignal({ status: 200, hwid_active: true }, []),
    { required: true, limitReached: false },
  );
});

test("подписка без флага HWID не отправляет идентификатор, с флагом — отправляет", async () => {
  const seen = [];
  invokeHandler = async (cmd, args) => {
    if (cmd === "device_identity") {
      return { hwid: MACHINE_HWID, deviceOs: "Windows", verOs: "10.0.26100" };
    }
    assert.equal(cmd, "fetch_subscription");
    seen.push(args);
    return { status: 200, body: "vless://uuid@node.example:443?security=tls#Amsterdam" };
  };

  saveSubscriptions([
    { id: "plain", url: "https://panel.example/sub/1", profiles: [] },
    { id: "limited", url: "https://panel.example/sub/2", hwid: true, profiles: [] },
  ]);

  await refreshSubscription("plain");
  assert.equal(seen.at(-1).hwid, null);

  await refreshSubscription("limited");
  const headers = seen.at(-1).hwid;
  assert.ok(isValidHwid(headers.hwid));
  assert.equal(headers.deviceOs, "Windows");
  assert.equal(headers.deviceModel, "Ninety");
});

test("панель, требующая HWID, объясняет пустой ответ вместо «подписка битая»", async () => {
  invokeHandler = async (cmd) => {
    if (cmd === "device_identity") {
      return { hwid: MACHINE_HWID, deviceOs: "Windows", verOs: "10.0.26100" };
    }
    return { status: 200, body: "", hwid_active: true, hwid_not_supported: true };
  };
  saveSubscriptions([{ id: "limited", url: "https://panel.example/sub", profiles: [] }]);

  await assert.rejects(
    () => refreshSubscription("limited"),
    (err) => {
      assert.equal(err.hwid.required, true);
      return true;
    },
  );
});
