import test from "node:test";
import assert from "node:assert/strict";
import {
  disableSystemProxy,
  enableSystemProxy,
} from "../src/lib/system-proxy-runtime.js";

test("enable system proxy sends the complete generation-bound contract", async () => {
  const calls = [];
  const result = await enableSystemProxy(async (...args) => {
    calls.push(args);
    return "ok";
  }, {
    hostPort: " 127.0.0.1:7890 ",
    bypassLan: false,
    expectedGeneration: 12,
    operationToken: { id: 7, kind: "UserConnect" },
  });
  assert.equal(result, "ok");
  assert.deepEqual(calls, [["enable_system_proxy", {
    hostPort: "127.0.0.1:7890",
    bypassLan: false,
    expectedGeneration: 12,
    operationToken: { id: 7, kind: "UserConnect" },
  }]]);
});

// Токен нужен аварийной остановке при провале готовности прокси: без него Rust
// берёт implicit-операцию, а не гасит чужой runtime вслепую.
test("enable system proxy passes an explicit null when the caller owns no token", async () => {
  const calls = [];
  await enableSystemProxy(async (...args) => { calls.push(args); }, {
    hostPort: "127.0.0.1:7890",
    expectedGeneration: 3,
  });
  assert.deepEqual(calls[0][1], {
    hostPort: "127.0.0.1:7890",
    bypassLan: true,
    expectedGeneration: 3,
    operationToken: null,
  });
});

test("disable system proxy has a zero-argument IPC contract", async () => {
  const calls = [];
  await disableSystemProxy(async (...args) => { calls.push(args); });
  assert.deepEqual(calls, [["disable_system_proxy"]]);
});

test("invalid enable request is rejected before IPC", () => {
  let calls = 0;
  const invoke = () => { calls++; };
  assert.throws(() => enableSystemProxy(invoke, {
    hostPort: "",
    expectedGeneration: 1,
  }), /runtime endpoint/);
  assert.throws(() => enableSystemProxy(invoke, {
    hostPort: "127.0.0.1:7890",
    expectedGeneration: 0,
  }), /positive runtime generation/);
  assert.equal(calls, 0);
});
