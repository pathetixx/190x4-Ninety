// Сторож внешних пинов держится на том, что он и сборка читают один и тот же
// файл. Если пин переименуют или уберут, сторож не упадёт — он просто перестанет
// видеть компонент и будет молча зеленеть, а инсталлятор останется на старой
// версии навсегда. Поэтому набор пинов сверяется с тем, что реально читают
// build.yml и security.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { pins, compareVersions, readPins } = await import("../scripts/check-pins.mjs");
const data = readPins();
const buildYml = readFileSync(".github/workflows/build.yml", "utf8");
const securityYml = readFileSync(".github/workflows/security.yml", "utf8");

test("каждый пин находит своё текущее значение в pins.json", () => {
  for (const pin of pins) {
    const value = pin.read(data);
    assert.ok(value, `${pin.name}: пин не найден — сторож ослеп`);
    assert.match(value, /^[\w.\-+]+$/, `${pin.name}: странное значение ${value}`);
  }
});

test("у бинарных пинов есть URL и sha256, и версия стоит в URL", () => {
  for (const name of ["naive", "trusttunnel_client", "wintun"]) {
    const pin = data[name];
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${name}: sha256 не на месте`);
    assert.match(pin.url, /^https:\/\//, `${name}: url не на месте`);
    assert.ok(pin.url.includes(pin.version), `${name}: версия ${pin.version} не совпадает с URL`);
  }
});

// Пины вынесены из workflow ровно затем, чтобы бот мог их править: GITHUB_TOKEN
// не имеет права пушить изменения под .github/workflows. Захардкоженное
// значение, вернувшееся в workflow, тихо выключит эту возможность.
test("workflow читают пины из файла, а не хранят их у себя", () => {
  assert.ok(buildYml.includes(".github/pins.json"), "build.yml не читает pins.json");
  assert.ok(securityYml.includes(".github/pins.json"), "security.yml не читает pins.json");
  for (const yml of [buildYml, securityYml]) {
    assert.doesNotMatch(yml, /CORE_TAG: v/, "тег ядра снова захардкожен в workflow");
    assert.doesNotMatch(yml, /XRAY_TAG: v/, "тег xray снова захардкожен в workflow");
    assert.doesNotMatch(yml, /\b[0-9a-f]{64}\b/, "sha256 бинаря снова захардкожен в workflow");
  }
});

test("apply подставляет новую версию и хеш, не задевая остальные пины", () => {
  const naive = pins.find((pin) => pin.name === "naive");
  const copy = readPins();
  const latest = {
    version: "v999.0.0-1",
    url: "https://github.com/klzgrad/naiveproxy/releases/download/v999.0.0-1/naiveproxy-v999.0.0-1-win-x64.zip",
    digest: "f".repeat(64),
  };
  naive.apply(copy, latest);

  assert.equal(copy.naive.version, "v999.0.0-1");
  assert.equal(copy.naive.sha256, latest.digest);
  for (const other of pins.filter((pin) => pin.name !== "naive")) {
    assert.deepEqual(other.read(copy), other.read(data), `${other.name} задет чужим обновлением`);
  }
});

test("версии wintun сравниваются по числам, а не по строкам", () => {
  assert.ok(compareVersions("0.14.1", "0.9.2") > 0);
  assert.equal(compareVersions("0.14.1", "0.14.1"), 0);
  assert.ok(compareVersions("1.0", "0.14.1") > 0);
});
