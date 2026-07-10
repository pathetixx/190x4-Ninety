#!/usr/bin/env node
import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const checks = [
  ["src-tauri/tauri.conf.json", /"version"\s*:\s*"(\d+\.\d+\.\d+)"/],
  ["src-tauri/Cargo.toml", /^version = "(\d+\.\d+\.\d+)"/m],
  ["src-tauri/Cargo.lock", /name = "ninety"\r?\nversion = "(\d+\.\d+\.\d+)"/],
  ["site/app.js", /tagName:\s*"v(\d+\.\d+\.\d+)"/],
  ["site/index.html", /data-release-version>v(\d+\.\d+\.\d+)</],
];

const failures = [];
for (const [file, pattern] of checks) {
  const version = readFileSync(file, "utf8").match(pattern)?.[1];
  if (version !== packageVersion) failures.push(`${file}: ${version || "missing"} != ${packageVersion}`);
}

const refName = process.env.GITHUB_REF_NAME || "";
if (refName.startsWith("v") && refName !== `v${packageVersion}`) {
  failures.push(`tag: ${refName} != v${packageVersion}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`version consistency OK: ${packageVersion}`);
