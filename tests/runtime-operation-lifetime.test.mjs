import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Runtime operation ownership is released in finally. If the operation itself
// returns from try without await, finally fires at the moment of return, not
// after the work is done: the token is released while the connection or the channel check
// is still running, and Rust answers "stale or cancelled runtime operation
// token". The user sees "Failed to disconnect" out of nowhere.
// We check the invariant against the source: main.js can't be imported because of the DOM.
// On the Windows runner checkout comes with CRLF: a search for "\n" would otherwise miss.
const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

const guarded = [
  "runReconnectAttempt(connectNetwork,",
  "verifyRuntimeOperationDataplane(operationToken)",
];

// A confirmed stop must close the state even if ownership was taken over by
// a newer intent: "disconnecting" is awaited by both the hero disc and runtimeIdleGate, and
// notify() in this state doesn't wake the waiters — the reconnect queue hung until
// the user's next click.
test("disconnectNetwork не бросает UI в disconnecting при чужом intent", () => {
  const body = main.slice(main.indexOf("async function disconnectNetwork("));
  const tail = body.slice(0, body.indexOf("\nasync function userToggleNetwork("));
  assert.ok(tail.includes("finalizeStoppedRuntime()"), "финализатор состояния исчез");
  const stale = tail.match(/if \(!isCurrentNetworkIntent\(epoch, "idle"\)\) return false;/g) || [];
  assert.equal(
    stale.length,
    0,
    "выход по чужому intent после подтверждённого stop обязан идти через finalizeStoppedRuntime()",
  );
  // The late-started core is stopped before any intent check.
  const late = tail.slice(tail.indexOf("if (lateStart) {"));
  const lateBlock = late.slice(0, late.indexOf("\n  }\n"));
  assert.ok(lateBlock.includes("await coreStartBarrier.wait()"), "ожидание позднего старта исчезло");
  assert.ok(lateBlock.includes("await shutdownCore({ finalize: false })"), "позднее ядро обязано останавливаться");
  assert.ok(!lateBlock.includes("isCurrentNetworkIntent"), "проверка намерения не должна пропускать остановку позднего ядра");
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
