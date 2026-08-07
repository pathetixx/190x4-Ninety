import test from "node:test";
import assert from "node:assert/strict";
import { classifyEngineLogSeverity, healthProbeNodeTag, isGeoLookupNoise } from "../src/lib/log-severity.js";

test("гео-пробы прежнего ядра опознаются как чужая телеметрия", () => {
  assert.equal(
    isGeoLookupNoise("monitoring: Failed try 2 to get IP info: https://example.invalid non-200 response: 429"),
    true,
  );
  assert.equal(
    isGeoLookupNoise('monitoring: Failed try 0 to get IP info: https://api.country.is/ Get "https://api.country.is/": EOF'),
    true,
  );
  assert.equal(isGeoLookupNoise("monitoring: outbound node-aaa URL test failed: i/o timeout"), false);
  assert.equal(isGeoLookupNoise(""), false);
});

test("обрыв локального клиента не считается ошибкой туннеля", () => {
  assert.deepEqual(
    classifyEngineLogSeverity(
      "ERROR",
      "inbound/mixed[mixed-in]: process connection from 127.0.0.1:51234: write tcp 127.0.0.1:7890->127.0.0.1:51234: wsasend: An established connection was aborted by the software in your host machine.",
    ),
    { level: "DEBUG", grade: "ok", nonFatal: true },
  );
  assert.deepEqual(
    classifyEngineLogSeverity("ERROR", "connection: use of closed network connection"),
    { level: "DEBUG", grade: "ok", nonFatal: true },
  );
});

test("real URL-test transport warnings retain warning severity", () => {
  assert.deepEqual(
    classifyEngineLogSeverity("WARN", "outbound node URL test failed: i/o timeout"),
    { level: "WARN", grade: "warn", nonFatal: false },
  );
});

test("настоящий отказ соединения остаётся ошибкой", () => {
  assert.deepEqual(
    classifyEngineLogSeverity("ERROR", "outbound/vless[proxy]: dial tcp 1.2.3.4:443: i/o timeout"),
    { level: "ERROR", grade: "err", nonFatal: false },
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
