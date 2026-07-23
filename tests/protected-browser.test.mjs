import { test } from "node:test";
import assert from "node:assert/strict";

const {
  createProtectedBrowserService,
  normalizeProtectedBrowserStatus,
  normalizeProtectedBrowserUrl,
  PROTECTED_BROWSER_COMMANDS,
} = await import("/lib/protected-browser.js");

test("protected browser: status нормализует DTO и вызывает точную Tauri-команду", async () => {
  const calls = [];
  const service = createProtectedBrowserService({
    invoke: async (...args) => {
      calls.push(args);
      return {
        available: true,
        path: "  C:\\Program Files\\Mullvad Browser\\Browser\\mullvadbrowser.exe  ",
        version: "  155.0\u0000  ",
        supported: true,
      };
    },
  });

  const result = await service.status();

  assert.deepEqual(calls, [[PROTECTED_BROWSER_COMMANDS.status]]);
  assert.deepEqual(result, {
    ok: true,
    action: "status",
    data: {
      available: true,
      path: "C:\\Program Files\\Mullvad Browser\\Browser\\mullvadbrowser.exe",
      version: "155.0",
    },
  });
});

test("protected browser: отсутствие Mullvad Browser является валидным статусом", () => {
  assert.deepEqual(normalizeProtectedBrowserStatus({
    available: false,
    path: null,
  }), {
    available: false,
    path: null,
    version: null,
  });
});

test("protected browser: launch передаёт только проверенный абсолютный HTTP(S) URL", async () => {
  const calls = [];
  const service = createProtectedBrowserService({
    invoke: async (...args) => { calls.push(args); },
  });

  const result = await service.launch({ url: " https://example.com/path?q=1 " });

  assert.deepEqual(calls, [[
    PROTECTED_BROWSER_COMMANDS.launch,
    { url: "https://example.com/path?q=1" },
  ]]);
  assert.deepEqual(result, {
    ok: true,
    action: "launch",
    data: { launched: true },
  });
});

test("protected browser: launch без URL открывает пустую защищённую сессию", async () => {
  const calls = [];
  const service = createProtectedBrowserService({
    invoke: async (...args) => { calls.push(args); },
  });

  await service.launch();
  await service.launch(null);

  assert.deepEqual(calls, [
    [PROTECTED_BROWSER_COMMANDS.launch, {}],
    [PROTECTED_BROWSER_COMMANDS.launch, {}],
  ]);
});

test("protected browser: опасный URL отклоняется до IPC", async () => {
  let invoked = false;
  const service = createProtectedBrowserService({
    invoke: async () => { invoked = true; },
  });

  const result = await service.launch({ url: "file:///C:/secret.txt" });

  assert.equal(invoked, false);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_url");
  assert.equal(result.error.message.includes("file:"), false);
  assert.deepEqual(normalizeProtectedBrowserUrl("https://user:pass@example.com/"), {
    ok: false,
    value: null,
  });
  assert.equal((await service.launch("https://example.com/")).error.code, "invalid_url");
  assert.equal(
    normalizeProtectedBrowserUrl(`https://example.com/${"a".repeat(800)}`).ok,
    false,
  );
});

test("protected browser: сырая системная ошибка не попадает в пользовательский result", async () => {
  const technical = new Error("CreateProcess failed: C:\\Users\\Dima\\private\\firefox.exe");
  const warnings = [];
  const service = createProtectedBrowserService({
    invoke: async () => { throw technical; },
    warn: (...args) => warnings.push(args),
  });

  const result = await service.launch();

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "launch_failed");
  assert.equal(JSON.stringify(result).includes("C:\\\\Users"), false);
  assert.equal(warnings[0][1], technical);
});

test("protected browser: официальный download открывается отдельной командой", async () => {
  const calls = [];
  const service = createProtectedBrowserService({
    invoke: async (...args) => { calls.push(args); },
  });

  const result = await service.openOfficialDownload();

  assert.deepEqual(calls, [[PROTECTED_BROWSER_COMMANDS.openDownload]]);
  assert.deepEqual(result, {
    ok: true,
    action: "open_download",
    data: { opened: true },
  });
});

test("protected browser: malformed status и отсутствие Tauri дают безопасные ошибки", async () => {
  const malformed = createProtectedBrowserService({
    invoke: async () => ({ available: true, path: null }),
    warn: () => {},
  });
  const unavailable = createProtectedBrowserService();

  assert.equal((await malformed.status()).error.code, "invalid_response");
  assert.deepEqual(await unavailable.status(), {
    ok: false,
    action: "status",
    error: {
      code: "tauri_unavailable",
      message: "Эта функция доступна только в приложении Ninety.",
    },
  });
});
