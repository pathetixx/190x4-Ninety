// Сторож внешних пинов держится на том, что его регулярки всё ещё находят себя
// в build.yml. Если формат пина поменяют, сторож не упадёт — он просто перестанет
// видеть компонент и будет молча зеленеть, а инсталлятор останется на старой
// версии навсегда. Поэтому описания пинов проверяются против настоящего файла.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { pins, currentSha, shaSources, compareVersions } = await import("../scripts/check-pins.mjs");
const yml = readFileSync(".github/workflows/build.yml", "utf8");

test("каждый пин находит своё текущее значение в build.yml", () => {
  for (const pin of pins) {
    const value = pin.read(yml);
    assert.ok(value, `${pin.name}: пин не найден — сторож ослеп`);
    assert.match(value, /^[\w.\-+]+$/, `${pin.name}: странное значение ${value}`);
  }
});

test("для бинарей рядом с URL находится их sha256", () => {
  for (const [name, pattern] of Object.entries(shaSources)) {
    const sha = currentSha(yml, pattern);
    assert.ok(sha, `${name}: sha256 рядом с URL не найден`);
    assert.match(sha, /^[0-9a-f]{64}$/);
  }
});

test("apply подставляет новую версию и хеш, не задевая остальные пины", () => {
  const naive = pins.find((pin) => pin.name === "naive");
  const before = naive.read(yml);
  const current = { version: before, sha: currentSha(yml, shaSources.naive) };
  const latest = {
    version: "v999.0.0-1",
    url: "https://github.com/klzgrad/naiveproxy/releases/download/v999.0.0-1/naiveproxy-v999.0.0-1-win-x64.zip",
    digest: "f".repeat(64),
  };
  const updated = naive.apply(yml, latest, current);

  assert.equal(naive.read(updated), "v999.0.0-1");
  assert.ok(updated.includes(latest.digest), "новый sha256 не подставлен");
  assert.ok(!updated.includes(current.sha), "старый sha256 остался");
  // Соседние пины трогать нельзя: один PR — один компонент.
  for (const other of pins.filter((pin) => pin.name !== "naive")) {
    assert.equal(other.read(updated), other.read(yml), `${other.name} задет чужим обновлением`);
  }
});

test("версии wintun сравниваются по числам, а не по строкам", () => {
  assert.ok(compareVersions("0.14.1", "0.9.2") > 0);
  assert.ok(compareVersions("0.14.1", "0.14.1") === 0);
  assert.ok(compareVersions("1.0", "0.14.1") > 0);
});
