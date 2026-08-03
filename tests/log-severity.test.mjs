import test from "node:test";
import assert from "node:assert/strict";
import { classifyEngineLogSeverity, healthProbeNodeTag } from "../src/lib/log-severity.js";

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

test("health-checker lines expose the node tag they report on", () => {
  assert.equal(
    healthProbeNodeTag("monitoring: outbound node-fx7hgi113tvwu URL test failed: i/o timeout"),
    "node-fx7hgi113tvwu",
  );
  assert.equal(
    healthProbeNodeTag("outbound node-le1qxy9h2fui URL test: 214ms"),
    "node-le1qxy9h2fui",
  );
});

test("ordinary lines are not mistaken for health-checker reports", () => {
  assert.equal(healthProbeNodeTag("inbound/tun[tun-in]: started at ninety-tun"), null);
  assert.equal(healthProbeNodeTag("monitoring: Failed try 2 to get IP info: 429"), null);
  assert.equal(healthProbeNodeTag(""), null);
});
