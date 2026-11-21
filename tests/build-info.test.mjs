// The build passport must tell the truth about what was actually built. The core
// line used to be edited by hand next to the pin, while the pins are moved by a bot
// (scripts/check-pins.mjs) — a divergence was a matter of time. Now the file
// is generated from pins.json, and exactly this link is checked here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  componentVersions,
  coreLabels,
  currentChannel,
  pinVersion,
  renderBuildInfo,
} from "../scripts/gen-build-info.mjs";

const pins = JSON.parse(readFileSync(".github/pins.json", "utf8"));

test("версии ядер берутся из пинов вместе с ревизией форка", () => {
  const { core, coreXray } = coreLabels(pins);
  assert.equal(core, `sing-box ${pins["ninety-core"].tag.replace(/^v/, "")}`);
  assert.equal(coreXray, `Xray ${pins["xray-core"].tag.replace(/^v/, "")}`);
  // The revision of our fork is part of the truth about the build: "1.13.19" instead of
  // "1.13.19-ninety.8" is already an inaccuracy.
  assert.ok(core.includes("-ninety."), `ревизия форка потеряна: ${core}`);
  assert.equal(pinVersion("v26.7.28"), "26.7.28");
  assert.equal(pinVersion(undefined), "");
});

test("компоненты приходят из тех же пинов", () => {
  const components = componentVersions(pins);
  assert.equal(components.naive, pins.naive.version.replace(/^v/, ""));
  assert.equal(components.trusttunnel, pins.trusttunnel_client.version.replace(/^v/, ""));
  assert.equal(components.wintun, String(pins.wintun.version));
});

test("сгенерированный файл — валидный модуль с полным набором полей", async () => {
  const rendered = renderBuildInfo({
    version: "9.9.9",
    commit: "abc1234",
    date: "01.01.2026",
    pins,
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(rendered).toString("base64")}`
  );
  const info = module.BUILD_INFO;
  assert.equal(info.version, "9.9.9");
  assert.equal(info.commit, "abc1234");
  assert.equal(info.date, "01.01.2026");
  assert.equal(info.core, coreLabels(pins).core);
  assert.equal(info.coreXray, coreLabels(pins).coreXray);
  assert.equal(info.platform, "Windows · x64");
  assert.equal(info.channel, "Early access");
  assert.deepEqual(info.components, componentVersions(pins));
});

// We compare the contents, not the line ending bytes: .gitattributes keeps the file
// in LF, but the test must not fall apart because of a checkout setting alone —
// that's exactly what broke the v0.5.5 build (the Windows runner returned CRLF).
const sameText = (actual, expected) =>
  assert.equal(actual.replace(/\r\n/g, "\n"), expected.replace(/\r\n/g, "\n"));

test("файл в дереве совпадает с тем, что даст генератор на тех же пинах", () => {
  const onDisk = readFileSync("src/lib/build-info.js", "utf8");
  const version = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
  const commit = onDisk.match(/commit: "([^"]*)"/)?.[1] ?? "";
  const date = onDisk.match(/date: "([^"]*)"/)?.[1] ?? "";
  const channel = currentChannel(onDisk);
  sameText(onDisk, renderBuildInfo({ version, commit, date, pins, channel }));
});

// The maturity channel is set by hand based on the release matrix. A generator that
// wipes it would silently bring back "Early access" on a stable build.
test("канал переносится из предыдущей версии файла", () => {
  const stable = renderBuildInfo({
    version: "1.0.0",
    commit: "abc1234",
    date: "01.01.2026",
    pins,
    channel: currentChannel('channel: "Stable",'),
  });
  assert.ok(stable.includes('channel: "Stable"'), stable);
  assert.equal(currentChannel(""), "Early access");
  assert.equal(currentChannel("нет такого поля"), "Early access");
});

// v0.5.5 regression: on the Windows runner checkout returns the file in CRLF, and the byte-by-byte
// comparison broke the release build although the contents matched.
test("сравнение не зависит от переводов строк checkout'а", () => {
  const rendered = renderBuildInfo({
    version: "0.5.5",
    commit: "abc1234",
    date: "03.09.2026",
    pins,
  });
  sameText(rendered.replace(/\n/g, "\r\n"), rendered);
});
