import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Владение runtime-операцией освобождается в finally. Если сама операция
// возвращается из try без await, finally срабатывает в момент return, а не
// после завершения работы: токен отпускается, пока подключение или проверка
// канала ещё идут, и Rust отвечает «stale or cancelled runtime operation
// token». Пользователь видит «Не удалось отключить» на ровном месте.
// Проверяем инвариант по исходнику: main.js не поддаётся импорту из-за DOM.
const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

const guarded = [
  "runReconnectAttempt(connectNetwork,",
  "verifyRuntimeOperationDataplane(operationToken)",
];

for (const call of guarded) {
  test(`${call} возвращается только через await`, () => {
    const occurrences = main.split(call).length - 1;
    assert.ok(occurrences > 0, `вызов ${call} исчез из main.js — тест устарел`);
    const bare = new RegExp(`return\\s+${call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
    assert.equal(
      main.match(bare),
      null,
      `${call} возвращается без await: токен операции отпустится раньше времени`,
    );
  });
}
