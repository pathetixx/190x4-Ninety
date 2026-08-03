import test from "node:test";
import assert from "node:assert/strict";
import { classifyEngineLogSeverity } from "../src/lib/log-severity.js";

test("sing-box geo provider 429 remains visible but is classified non-fatal", () => {
  assert.deepEqual(
    classifyEngineLogSeverity(
      "WARN",
      "monitoring: Failed try 2 to get IP info: https://example.invalid non-200 response: 429",
    ),
    { level: "INFO", grade: "info", nonFatal: true },
  );
});

test("sing-box geo provider deadline timeout is non-fatal", () => {
  assert.deepEqual(
    classifyEngineLogSeverity(
      "WARN",
      "monitoring: Failed try 2 to get IP info: https://api.my-ip.io/v2/ip.json: context deadline exceeded",
    ),
    { level: "INFO", grade: "info", nonFatal: true },
  );
});

test("real URL-test transport warnings retain warning severity", () => {
  assert.deepEqual(
    classifyEngineLogSeverity("WARN", "outbound node URL test failed: i/o timeout"),
    { level: "WARN", grade: "warn", nonFatal: false },
  );
});
