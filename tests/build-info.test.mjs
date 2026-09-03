// Паспорт сборки обязан говорить правду о том, что реально собрано. Строка
// ядра раньше правилась руками рядом с пином, а пины двигает бот
// (scripts/check-pins.mjs) — расхождение было вопросом времени. Теперь файл
// генерируется из pins.json, и здесь проверяется именно эта связь.
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
  // Ревизия нашего форка — часть правды о сборке: "1.13.19" вместо
  // "1.13.19-ninety.8" уже неточность.
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

test("файл в дереве совпадает с тем, что даст генератор на тех же пинах", () => {
  const onDisk = readFileSync("src/lib/build-info.js", "utf8");
  const version = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
  const commit = onDisk.match(/commit: "([^"]*)"/)?.[1] ?? "";
  const date = onDisk.match(/date: "([^"]*)"/)?.[1] ?? "";
  const channel = currentChannel(onDisk);
  assert.equal(onDisk, renderBuildInfo({ version, commit, date, pins, channel }));
});

// Канал зрелости ставится руками по итогам релизной матрицы. Генератор, который
// его затирает, молча вернул бы «Early access» на стабильной сборке.
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
