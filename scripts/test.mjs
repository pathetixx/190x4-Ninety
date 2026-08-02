#!/usr/bin/env node
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const coverage = process.argv.includes("--coverage");
if (coverage) {
  mkdirSync("coverage", { recursive: true });
  rmSync("coverage/lcov.info", { force: true });
}
const files = readdirSync("tests")
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("tests", name));

const result = spawnSync(process.execPath, [
  ...(coverage
    ? [
        "--experimental-test-coverage",
        "--test-coverage-include=src/lib/deeplink.js",
        "--test-coverage-lines=80",
        "--test-coverage-functions=80",
        "--test-coverage-branches=70",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=lcov",
        "--test-reporter-destination=coverage/lcov.info",
      ]
    : []),
  "--test",
  "--import",
  "./tests/register.mjs",
  ...files,
], { stdio: "inherit" });

process.exit(result.status ?? 1);
