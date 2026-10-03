import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OPTIONS,
  OPTIONS_SCHEMA_VERSION,
  generateLanPassword,
  lanCredentialsValid,
  normalizeOptions,
} from "/lib/options.js";

test("process lookup is enabled by default and preserves a versioned opt-out", () => {
  assert.equal(DEFAULT_OPTIONS.route.processLookup, true);
  assert.equal(normalizeOptions({}).route.processLookup, true);
  assert.equal(
    normalizeOptions({
      schemaVersion: OPTIONS_SCHEMA_VERSION,
      route: { processLookup: false },
    }).route.processLookup,
    false,
  );
});

test("normalizeOptions чинит повреждённые enum, boolean, port и URL", () => {
  const out = normalizeOptions({
    region: "invalid",
    general: { killSwitch: "false" },
    inbound: { mixedPort: 99 },
    urlTest: { connectionTestUrl: "javascript:alert(1)" },
    quality: { endpoints: ["file:///tmp/a", "https://speed.cloudflare.com/__down?bytes=262144"] },
  });
  assert.equal(out.region, DEFAULT_OPTIONS.region);
  assert.equal(out.general.killSwitch, DEFAULT_OPTIONS.general.killSwitch);
  assert.equal(out.inbound.mixedPort, 1024);
  assert.equal(out.urlTest.connectionTestUrl, DEFAULT_OPTIONS.urlTest.connectionTestUrl);
  assert.deepEqual(out.quality.endpoints, ["https://speed.cloudflare.com/__down?bytes=262144"]);
});

// Rust принимает пробу качества только на своём allowlist (quality.rs).
// Пропущенный сюда чужой адрес не отвергался бы настройкой, а тихо ломал весь
// движок: backend отдаёт ошибку на каждую пробу, и канал вечно «UNKNOWN».
test("quality endpoints ограничены тем же allowlist, что и backend", () => {
  const foreign = normalizeOptions({
    quality: { endpoints: ["https://speed.example/test", "http://speed.cloudflare.com/__down"] },
  });
  assert.deepEqual(foreign.quality.endpoints, DEFAULT_OPTIONS.quality.endpoints);

  const credentials = normalizeOptions({
    quality: { endpoints: ["https://user:pass@speed.cloudflare.com/__down"] },
  });
  assert.deepEqual(credentials.quality.endpoints, DEFAULT_OPTIONS.quality.endpoints);

  const allowed = normalizeOptions({
    quality: { endpoints: ["https://SPEED.CLOUDFLARE.COM/__down?bytes=16384"] },
  });
  assert.deepEqual(allowed.quality.endpoints, ["https://SPEED.CLOUDFLARE.COM/__down?bytes=16384"]);
});

test("normalizeOptions упорядочивает диапазоны и не мутирует input", () => {
  const input = { tlsTricks: { paddingSize: { from: 900, to: 100 } } };
  const out = normalizeOptions(input);
  assert.deepEqual(out.tlsTricks.paddingSize, { from: 100, to: 900 });
  assert.deepEqual(input.tlsTricks.paddingSize, { from: 900, to: 100 });
});

test("normalizeOptions игнорирует prototype-pollution ключи из localStorage", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const out = normalizeOptions(input);
  assert.equal(out.polluted, undefined);
  assert.equal({}.polluted, undefined);
});

// mixed-inbound и clash-API слушают один loopback: совпавшие порты роняли бинд
// уже в ядре, а UI показывал безымянное «не удалось подключиться».
test("options: порт clash-API не может совпасть с mixed-портом", () => {
  const clashCollision = normalizeOptions({
    inbound: { mixedPort: 7890 },
    experimental: { clashApiPort: 7890 },
  });
  assert.equal(clashCollision.inbound.mixedPort, 7890);
  assert.notEqual(clashCollision.experimental.clashApiPort, 7890);

  // Юзер занял под mixed сам дефолт clash-API — тогда уступает mixed-порт.
  const bothDefaults = normalizeOptions({
    inbound: { mixedPort: 9090 },
    experimental: { clashApiPort: 9090 },
  });
  assert.notEqual(bothDefaults.inbound.mixedPort, bothDefaults.experimental.clashApiPort);
});

test("настройки диагностики можно сохранить: путь есть в белом списке", async () => {
  // updateOption бросает на неизвестном пути, и промах белого списка выглядит
  // как «интерфейс не реагирует»: именно так молча ломался выбор странового
  // пакета — экран рисовал список, а запись падала исключением.
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  const { updateOption } = await import("../src/lib/options.js?diagnose-paths");
  assert.equal(updateOption("diagnose.regionPack", "de").diagnose.regionPack, "de");
  assert.equal(
    updateOption("diagnose.pinned", [{ id: "x", name: "x", url: "https://x/" }]).diagnose.pinned.length,
    1,
  );
});

test("порт для локальной сети уступает mixed и clash-API", () => {
  const out = normalizeOptions({
    inbound: { mixedPort: 7891, lanPort: 7891 },
    experimental: { clashApiPort: 7892 },
  });
  assert.equal(out.inbound.mixedPort, 7891);
  assert.equal(out.experimental.clashApiPort, 7892);
  assert.equal(out.inbound.lanPort, 7893);
  assert.equal(normalizeOptions({}).inbound.lanPort, 7891);
});

// normalize вызывается на каждое чтение: придумай он пароль сам, значение
// менялось бы до первого сохранения. Испорченную пару он только чистит.
test("normalizeOptions чистит логин и пароль для сети, но не придумывает их", () => {
  const out = normalizeOptions({
    inbound: { lanAuth: true, lanUsername: "us er:ы", lanPassword: "p a\nss\u0007" },
  });
  assert.equal(out.inbound.lanUsername, "user");
  assert.equal(out.inbound.lanPassword, "pass");
  const empty = normalizeOptions({ inbound: { lanAuth: true, lanUsername: 5, lanPassword: null } });
  assert.equal(empty.inbound.lanUsername, "5");
  assert.equal(empty.inbound.lanPassword, "");
  assert.equal(lanCredentialsValid(empty.inbound), false);
});

test("generateLanPassword отбрасывает байты хвоста, а не смещает алфавит", () => {
  let call = 0;
  const random = {
    getRandomValues(bytes) {
      bytes.fill(call++ === 0 ? 255 : 0);
      return bytes;
    },
  };
  assert.equal(generateLanPassword(random), "A".repeat(16));
  assert.equal(call, 2);
  assert.match(generateLanPassword(), /^[A-HJ-NP-Za-km-z2-9]{16}$/);
});

test("пароль для сети: включение выдаёт рабочую пару, очищенное поле — новое значение", async () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

  const { updateOption } = await import("../src/lib/options.js?lan-auth");
  const enabled = updateOption("inbound.lanAuth", true).inbound;
  assert.equal(enabled.lanUsername, "ninety");
  assert.match(enabled.lanPassword, /^[A-Za-z0-9]{16}$/);
  assert.ok(lanCredentialsValid(enabled));

  // Повторное включение не перевыпускает пароль, уже вписанный на устройствах.
  updateOption("inbound.lanAuth", false);
  assert.equal(updateOption("inbound.lanAuth", true).inbound.lanPassword, enabled.lanPassword);

  const typed = updateOption("inbound.lanPassword", " my pass:wörd ").inbound;
  assert.equal(typed.lanPassword, "mypass:wrd");
  assert.equal(updateOption("inbound.lanUsername", "us:er").inbound.lanUsername, "user");

  const regenerated = updateOption("inbound.lanPassword", "").inbound;
  assert.match(regenerated.lanPassword, /^[A-Za-z0-9]{16}$/);
  assert.equal(updateOption("inbound.lanUsername", "  ").inbound.lanUsername, "ninety");
});
