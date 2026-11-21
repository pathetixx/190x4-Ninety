#!/usr/bin/env node
// Ninety · a single version bump point. Previously the version was edited by hand in four
// places (RELEASING.md step 1) — easy to get out of sync. This script sets one
// value in all places where the number is duplicated:
//   src-tauri/tauri.conf.json — the build's source of truth (build.yml reads the
//     version from here → the binary, build-info.js, latest.json for OTA);
//   src-tauri/Cargo.toml      — the crate version;
//   src-tauri/Cargo.lock      — the `ninety` package (otherwise cargo would rewrite the lock);
//   package.json + package-lock.json — the npm wrapper version and lock metadata;
//   site/app.js + index.html  — the site's offline fallback version (and site/ru/).
//
// We DON'T touch the Tauri version reading mechanism (e.g. "version": "../package.json"):
// build.yml greps the number from tauri.conf.json as a string — a path placeholder there
// would break latest.json generation and OTA. So we synchronize rather than centralize.
//
// Usage: node scripts/bump-version.mjs X.Y.Z

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeRuPage } from "./build-site-ru.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Usage: node scripts/bump-version.mjs X.Y.Z  (got: ${version ?? "<none>"})`);
  process.exit(1);
}

// Replaces by pattern and fails if the pattern isn't found (the file was renamed /
// the format changed) — a silent desync is more dangerous than an explicit error.
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

// package.json + tauri.conf.json: the first "version": "X.Y.Z".
const jsonRe = /("version"\s*:\s*")\d+\.\d+\.\d+(")/;
edit("package.json", jsonRe, `$1${version}$2`);
edit(
  "package-lock.json",
  /(\{\s*"name":\s*"ninety",\s*"version":\s*")\d+\.\d+\.\d+("\s*,)/s,
  `$1${version}$2`,
);
edit(
  "package-lock.json",
  /("packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name":\s*"ninety",\s*"version":\s*")\d+\.\d+\.\d+("\s*,)/s,
  `$1${version}$2`,
);
edit("src-tauri/tauri.conf.json", jsonRe, `$1${version}$2`);

// Cargo.toml: version = "X.Y.Z" at the start of a line ([package] — dependencies come
// indented/inline and a three-component semver doesn't fit them).
edit("src-tauri/Cargo.toml", /^version = "\d+\.\d+\.\d+"/m, `version = "${version}"`);

// Cargo.lock: the ninety package block (version right under its name).
edit(
  "src-tauri/Cargo.lock",
  /(name = "ninety"\r?\nversion = ")\d+\.\d+\.\d+(")/,
  `$1${version}$2`,
);

// build-info.js is generated (scripts/gen-build-info.mjs) and in a release
// CI overwrites it, but in the dev tree the version is visible on the "About" screen before
// the runtime responds — and it lagged two minors behind, because it was bumped only
// in the four "real" places.
edit("src/lib/build-info.js", /(version:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);

edit("site/app.js", /(tagName:\s*"v)\d+\.\d+\.\d+(")/, `$1${version}$2`);
edit("site/index.html", /(data-release-version>v)\d+\.\d+\.\d+(<\/strong>)/, `$1${version}$2`);
// The Russian site page is built from index.html — we rebuild it with the new version.
writeRuPage(root);

console.log(`\nBumped to ${version}. Next: commit + push, then annotated tag (see RELEASING.md).`);
