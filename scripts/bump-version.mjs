#!/usr/bin/env node
// Ninety · единая точка бампа версии. Раньше версию правили руками в четырёх
// местах (RELEASING.md шаг 1) — легко разъехаться. Этот скрипт проставляет одно
// значение во все места, где число дублируется:
//   src-tauri/tauri.conf.json — source of truth сборки (build.yml читает отсюда
//     version → бинарь, build-info.js, latest.json для OTA);
//   src-tauri/Cargo.toml      — версия крейта;
//   src-tauri/Cargo.lock      — пакет `ninety` (иначе cargo переписывал бы lock);
//   package.json              — версия npm-обёртки.
//
// Механизм чтения версии Tauri НЕ трогаем (напр. "version": "../package.json"):
// build.yml грепает число из tauri.conf.json как строку — путь-плейсхолдер там
// сломал бы генерацию latest.json и OTA. Поэтому синхронизируем, а не централизуем.
//
// Использование: node scripts/bump-version.mjs X.Y.Z

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Usage: node scripts/bump-version.mjs X.Y.Z  (got: ${version ?? "<none>"})`);
  process.exit(1);
}

// Заменяет по паттерну и падает, если паттерн не найден (файл переименовали /
// формат сменился) — молчаливый рассинхрон опаснее явной ошибки.
function edit(rel, re, replacement) {
  const path = join(root, rel);
  const before = readFileSync(path, "utf8");
  if (!re.test(before)) {
    console.error(`! ${rel}: version pattern not found — aborting`);
    process.exit(1);
  }
  writeFileSync(path, before.replace(re, replacement));
  console.log(`  ${rel}`);
}

// package.json + tauri.conf.json: первое "version": "X.Y.Z".
const jsonRe = /("version"\s*:\s*")\d+\.\d+\.\d+(")/;
edit("package.json", jsonRe, `$1${version}$2`);
edit("src-tauri/tauri.conf.json", jsonRe, `$1${version}$2`);

// Cargo.toml: version = "X.Y.Z" в начале строки ([package] — зависимости идут с
// отступом/inline и три-компонентный семвер к ним не подходит).
edit("src-tauri/Cargo.toml", /^version = "\d+\.\d+\.\d+"/m, `version = "${version}"`);

// Cargo.lock: блок пакета ninety (version сразу под его name).
edit(
  "src-tauri/Cargo.lock",
  /(name = "ninety"\nversion = ")\d+\.\d+\.\d+(")/,
  `$1${version}$2`,
);

console.log(`\nBumped to ${version}. Next: commit + push, then annotated tag (see RELEASING.md).`);
