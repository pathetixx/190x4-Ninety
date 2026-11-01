// Отказ команды бэкенда приходит токеном с ключом каталога: пользователь обязан
// увидеть текст на языке интерфейса, а не сам токен.
import { test } from "node:test";
import assert from "node:assert/strict";

const { localizeBackendText, localizedInvoke } = await import("/lib/backend-errors.js");

test("токен заменяется текстом из каталога с подстановками", () => {
  assert.equal(localizeBackendText("[[backend.vpn.running]]"), "The connection is already running");
  assert.equal(
    localizeBackendText('[[backend.secrets.passwordLength {"min":"8","max":"64"}]]'),
    "The password must be 8 to 64 characters long",
  );
});

test("токен внутри технической строки заменяется на месте", () => {
  assert.equal(
    localizeBackendText("rollback failed: [[backend.vpn.running]]; see log"),
    "rollback failed: The connection is already running; see log",
  );
});

test("значение подстановки с кавычками и скобками не ломает разбор", () => {
  const raw = `[[backend.browser.launchFailed ${JSON.stringify({ error: 'bad "path" [x]' })}]]`;
  assert.equal(localizeBackendText(raw), 'Could not start Mullvad Browser: bad "path" [x]');
});

test("обычный текст и не-строки проходят без изменений", () => {
  assert.equal(localizeBackendText("plain error"), "plain error");
  assert.equal(localizeBackendText(undefined), undefined);
});

test("localizedInvoke переводит отказ и не трогает успешный ответ", async () => {
  const invoke = localizedInvoke(async (cmd) => {
    if (cmd === "fail") throw "[[backend.vpn.starting]]";
    return cmd;
  });
  assert.equal(await invoke("ok"), "ok");
  await assert.rejects(invoke("fail"), (error) => error === "Connecting is already in progress");
  assert.equal(localizedInvoke(undefined), undefined);
});
