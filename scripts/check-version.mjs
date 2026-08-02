#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(SCRIPT_PATH), "..");

export function collectVersionFailures(root = REPO_ROOT, refName = "") {
  const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const checks = [
    ["src-tauri/tauri.conf.json", /"version"\s*:\s*"(\d+\.\d+\.\d+)"/],
    ["src-tauri/Cargo.toml", /^version = "(\d+\.\d+\.\d+)"/m],
    ["src-tauri/Cargo.lock", /name = "ninety"\r?\nversion = "(\d+\.\d+\.\d+)"/],
    ["site/app.js", /tagName:\s*"v(\d+\.\d+\.\d+)"/],
    ["site/index.html", /data-release-version>v(\d+\.\d+\.\d+)</],
  ];

  const failures = [];
  for (const [file, pattern] of checks) {
    const version = readFileSync(join(root, file), "utf8").match(pattern)?.[1];
    if (version !== packageVersion) failures.push(`${file}: ${version || "missing"} != ${packageVersion}`);
  }

  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (lock.version !== packageVersion) {
    failures.push(`package-lock.json: ${lock.version || "missing"} != ${packageVersion}`);
  }
  if (lock.packages?.[""]?.version !== packageVersion) {
    failures.push(`package-lock.json packages[""].version: ${lock.packages?.[""]?.version || "missing"} != ${packageVersion}`);
  }

  if (refName.startsWith("v") && refName !== `v${packageVersion}`) {
    failures.push(`tag: ${refName} != v${packageVersion}`);
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const failures = collectVersionFailures(REPO_ROOT, process.env.GITHUB_REF_NAME || "");
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  const packageVersion = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
  console.log(`version consistency OK: ${packageVersion}`);
}
