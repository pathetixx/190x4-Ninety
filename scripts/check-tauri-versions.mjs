#!/usr/bin/env node
// Версии Tauri-плагинов: Rust-крейт и его npm-пакет обязаны совпадать по
// major.minor.
//
// `tauri build` сверяет их сам и отказывается собирать при расхождении. Но
// зовётся он только на теге, поэтому расхождение доезжает до релиза целым:
// dependabot поднимает половинки разными PR (крейт — одним, npm-пакет —
// другим), обе половинки проходят Checks по отдельности, и падает уже сборка
// после `git push --tags`. Так релиз v0.6.1 и встал на
// tauri-plugin-updater 2.11.0 против @tauri-apps/plugin-updater 2.10.1.
//
// Версии берём из локов, а не из диапазонов в манифестах: собирается то, что
// в локах, и «^2.0.1» ничего не говорит о том, что реально встанет.

import { readFileSync } from "node:fs";

// Пары «крейт ↔ npm-пакет». Плагин без фронтенд-половинки (process у Tauri её
// имеет, single-instance — нет) в сверку не попадает.
const PAIRS = [
  ["tauri", "@tauri-apps/api"],
  ["tauri-plugin-deep-link", "@tauri-apps/plugin-deep-link"],
  ["tauri-plugin-dialog", "@tauri-apps/plugin-dialog"],
  ["tauri-plugin-notification", "@tauri-apps/plugin-notification"],
  ["tauri-plugin-process", "@tauri-apps/plugin-process"],
  ["tauri-plugin-shell", "@tauri-apps/plugin-shell"],
  ["tauri-plugin-updater", "@tauri-apps/plugin-updater"],
];

function crateVersions(path) {
  const out = new Map();
  // Cargo.lock — TOML с повторяющимися [[package]]; тащить парсер ради двух
  // полей не за чем, а блоки разделены однозначно.
  for (const block of readFileSync(path, "utf8").split("[[package]]")) {
    const match = block.match(/\nname = "([^"]+)"\nversion = "([^"]+)"/);
    if (match) out.set(match[1], match[2]);
  }
  return out;
}

function npmVersions(path) {
  const lock = JSON.parse(readFileSync(path, "utf8"));
  const out = new Map();
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key.startsWith("node_modules/") || !entry?.version) continue;
    out.set(key.slice("node_modules/".length), entry.version);
  }
  return out;
}

const minor = (version) => String(version).split(".").slice(0, 2).join(".");

const crates = crateVersions("src-tauri/Cargo.lock");
const npm = npmVersions("package-lock.json");

const problems = [];
for (const [crate, pkg] of PAIRS) {
  const rust = crates.get(crate);
  const node = npm.get(pkg);
  if (!rust) { problems.push(`${crate}: нет в src-tauri/Cargo.lock`); continue; }
  if (!node) { problems.push(`${pkg}: нет в package-lock.json`); continue; }
  if (minor(rust) !== minor(node)) {
    problems.push(`${crate} (${rust}) ≠ ${pkg} (${node}) — tauri build откажется собирать`);
  }
}

if (problems.length) {
  console.error("✗ версии Tauri разъехались:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`tauri versions OK: ${PAIRS.length} пар совпадают по major.minor`);
