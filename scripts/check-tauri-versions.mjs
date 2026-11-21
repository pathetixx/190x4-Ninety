#!/usr/bin/env node
// Tauri plugin versions: the Rust crate and its npm package must match in
// major.minor.
//
// `tauri build` checks them itself and refuses to build on a mismatch. But
// it's called only on a tag, so a mismatch reaches the release intact:
// dependabot bumps the halves in different PRs (the crate in one, the npm package in
// another), both halves pass Checks separately, and it's the build that fails
// after `git push --tags`. That's how release v0.6.1 got stuck on
// tauri-plugin-updater 2.11.0 vs @tauri-apps/plugin-updater 2.10.1.
//
// Versions are taken from the locks, not from the ranges in the manifests: what gets built is what's
// in the locks, and "^2.0.1" says nothing about what will actually be installed.

import { readFileSync } from "node:fs";

// "crate ↔ npm package" pairs. A plugin without a frontend half (Tauri's process
// has one, single-instance doesn't) isn't included in the check.
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
  // Cargo.lock is TOML with repeating [[package]]; there's no point pulling in a parser for two
  // fields, and the blocks are delimited unambiguously.
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
