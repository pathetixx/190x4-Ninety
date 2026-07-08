#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const files = readdirSync("tests")
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("tests", name));

const result = spawnSync(process.execPath, [
  "--test",
  "--import",
  "./tests/register.mjs",
  ...files,
], { stdio: "inherit" });

process.exit(result.status ?? 1);
