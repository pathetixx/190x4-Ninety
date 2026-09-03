import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runtimeEndpointMatchesGeneration,
  runtimeProbeProxyPort,
  runtimeSnapshotReadyForMode,
} from "/lib/runtime-lifecycle.js";

const snapshot = (over = {}) => ({
  running: true,
  clashReady: true,
  listenerReady: true,
  processGeneration: 7,
  probeProxyEndpoint: { address: "127.0.0.1:2080" },
  systemProxyOwnership: "not_owned",
  proxyEnable: false,
  proxyServer: null,
  ...over,
});
test("System Proxy runtime contract requires a live listener and exact endpoint", () => {
  const ready = snapshot({
    systemProxyOwnership: "owned",
    proxyEnable: true,
    proxyServer: "127.0.0.1:2080",
  });
  assert.equal(runtimeSnapshotReadyForMode(ready, "systemProxy"), true);
  assert.equal(runtimeSnapshotReadyForMode({ ...ready, listenerReady: false }, "systemProxy"), false);
  assert.equal(runtimeSnapshotReadyForMode({ ...ready, proxyServer: "127.0.0.1:2081" }, "systemProxy"), false);
});

test("stale generation and endpoint A are rejected after transition to endpoint B", () => {
  const endpointA = snapshot({ processGeneration: 7 });
  const endpointB = snapshot({ processGeneration: 8, probeProxyEndpoint: { address: "127.0.0.1:2081" } });
  assert.equal(runtimeEndpointMatchesGeneration(endpointA, 7, "127.0.0.1:2080"), true);
  assert.equal(runtimeEndpointMatchesGeneration(endpointA, 8, "127.0.0.1:2081"), false);
  assert.equal(runtimeEndpointMatchesGeneration(endpointB, 8, "127.0.0.1:2081"), true);
});

test("systemProxy → tun → systemProxy never reuses the previous published endpoint", () => {
  const systemA = snapshot({
    processGeneration: 10,
    probeProxyEndpoint: { address: "127.0.0.1:2080" },
    systemProxyOwnership: "owned",
    proxyEnable: true,
    proxyServer: "127.0.0.1:2080",
  });
  const tun = snapshot({
    processGeneration: 11,
    probeProxyEndpoint: { address: "127.0.0.1:2081" },
    systemProxyOwnership: "not_owned",
    proxyEnable: false,
    proxyServer: "127.0.0.1:2080",
  });
  const systemB = snapshot({
    processGeneration: 12,
    probeProxyEndpoint: { address: "127.0.0.1:2082" },
    systemProxyOwnership: "owned",
    proxyEnable: true,
    proxyServer: "127.0.0.1:2082",
  });
  assert.equal(runtimeSnapshotReadyForMode(systemA, "systemProxy"), true);
  assert.equal(runtimeSnapshotReadyForMode(tun, "tun"), true);
  assert.equal(runtimeSnapshotReadyForMode(systemB, "systemProxy"), true);
  assert.equal(runtimeEndpointMatchesGeneration(systemB, 12, systemA.probeProxyEndpoint.address), false);
});

// Порт для запросов «через туннель» обязан приходить от живого runtime: раньше
// DPI-раздел брал его из настроек, и смена inbound.mixedPort без реконнекта
// уводила загрузку списков в порт, которого ядро не слушает.
test("probe proxy port is read from the live runtime snapshot only", () => {
  assert.equal(runtimeProbeProxyPort(snapshot()), 2080);
  assert.equal(runtimeProbeProxyPort(snapshot({ probeProxyEndpoint: { address: "[::1]:7891" } })), 7891);
  assert.equal(runtimeProbeProxyPort(snapshot({ running: false })), 0);
  assert.equal(runtimeProbeProxyPort(snapshot({ listenerReady: false })), 0);
  assert.equal(runtimeProbeProxyPort(snapshot({ probeProxyEndpoint: { address: "127.0.0.1:0" } })), 0);
  assert.equal(runtimeProbeProxyPort(snapshot({ probeProxyEndpoint: null })), 0);
  assert.equal(runtimeProbeProxyPort(null), 0);
});
