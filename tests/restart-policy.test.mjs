// Матрица «какая настройка требует рестарта ядра». Ошибка здесь = либо лишние
// обрывы VPN на каждое движение тумблера, либо молча не применившаяся настройка.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathNeedsRestart } from "/lib/restart-policy.js";

const warpOn  = { warp: { enabled: true } };
const warpOff = { warp: { enabled: false } };

test("пустой/неизвестный path — консервативно рестарт", () => {
  assert.equal(pathNeedsRestart("", {}, "systemProxy"), true);
  assert.equal(pathNeedsRestart(null, {}, "systemProxy"), true);
  assert.equal(pathNeedsRestart("dns.remoteDns", {}, "systemProxy"), true);
  assert.equal(pathNeedsRestart("route.bypassLan", {}, "tun"), true);
});

test("Windows-state и kill switch не трогают ядро", () => {
  for (const p of ["general.autostart", "general.startMinimized", "general.linkHandlers", "general.killSwitch"]) {
    assert.equal(pathNeedsRestart(p, warpOn, "tun"), false, p);
  }
});

test("warp.enabled всегда рестартит (вкл И выкл)", () => {
  assert.equal(pathNeedsRestart("warp.enabled", warpOn, "systemProxy"), true);
  assert.equal(pathNeedsRestart("warp.enabled", warpOff, "systemProxy"), true);
});

test("warp.* при выключенном WARP в config не попадают", () => {
  assert.equal(pathNeedsRestart("warp.endpoint", warpOff, "systemProxy"), false);
  assert.equal(pathNeedsRestart("warp.mode", warpOff, "systemProxy"), false);
  assert.equal(pathNeedsRestart("warp.endpoint", warpOn, "systemProxy"), true);
});

test("warp.registered рестартит только при активном WARP", () => {
  assert.equal(pathNeedsRestart("warp.registered", warpOn, "systemProxy"), true);
  assert.equal(pathNeedsRestart("warp.registered", warpOff, "systemProxy"), false);
});

test("deepScan и autoRescan* — UI/JS-loop, не config", () => {
  for (const p of ["warp.deepScan", "warp.autoRescan", "warp.autoRescanIntervalMin", "warp.autoRescanThresholdMs"]) {
    assert.equal(pathNeedsRestart(p, warpOn, "systemProxy"), false, p);
  }
});

test("customNoise зависит от noisePreset", () => {
  const custom = { warp: { enabled: true, noisePreset: "custom" } };
  const preset = { warp: { enabled: true, noisePreset: "default" } };
  assert.equal(pathNeedsRestart("warp.customNoise.count", custom, "systemProxy"), true);
  assert.equal(pathNeedsRestart("warp.customNoise.count", preset, "systemProxy"), false);
});

test("TUN-only поля рестартят только в TUN-режиме", () => {
  for (const p of ["inbound.mtu", "inbound.tunStack", "inbound.strictRoute", "route.tunSplitDiscord"]) {
    assert.equal(pathNeedsRestart(p, {}, "tun"), true, p);
    assert.equal(pathNeedsRestart(p, {}, "proxy"), false, p);
    assert.equal(pathNeedsRestart(p, {}, "systemProxy"), false, p);
  }
});
