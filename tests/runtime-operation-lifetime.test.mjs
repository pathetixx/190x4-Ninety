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

// Подтверждённый stop обязан закрыть состояние, даже если владение перехватил
// более новый intent: «disconnecting» ждут и hero-диск, и runtimeIdleGate, а
// notify() в этом состоянии waiter'ов не будит — очередь реконнекта висела до
// следующего клика пользователя.
test("disconnectNetwork не бросает UI в disconnecting при чужом intent", () => {
  const body = main.slice(main.indexOf("async function disconnectNetwork("));
  const tail = body.slice(0, body.indexOf("\nasync function userToggleNetwork("));
  assert.ok(tail.includes("finalizeStoppedRuntime()"), "финализатор состояния исчез");
  const stale = tail.match(/if \(!isCurrentNetworkIntent\(epoch, "idle"\)\) return false;/g) || [];
  assert.equal(
    stale.length,
    1,
    "выход по чужому intent после подтверждённого stop обязан идти через finalizeStoppedRuntime()",
  );
});

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
