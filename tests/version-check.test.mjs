import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectVersionFailures } from "../scripts/check-version.mjs";

function fixtureRoot(version = "1.2.3") {
  const root = mkdtempSync(join(tmpdir(), "ninety-version-"));
  mkdirSync(join(root, "src-tauri"), { recursive: true });
  mkdirSync(join(root, "site"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    version,
    packages: { "": { version } },
  }));
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "src-tauri/Cargo.toml"), `version = "${version}"\n`);
  writeFileSync(join(root, "src-tauri/Cargo.lock"), `name = "ninety"\nversion = "${version}"\n`);
  writeFileSync(join(root, "site/app.js"), `tagName: "v${version}"`);
  writeFileSync(join(root, "site/index.html"), `data-release-version>v${version}</strong>`);
  return root;
}

test("version checker validates both package-lock metadata fields", () => {
  const root = fixtureRoot();
  assert.deepEqual(collectVersionFailures(root), []);

  const lockPath = join(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.version = "1.2.2";
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.deepEqual(collectVersionFailures(root), ["package-lock.json: 1.2.2 != 1.2.3"]);

  lock.version = "1.2.3";
  lock.packages[""].version = "1.2.2";
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.deepEqual(collectVersionFailures(root), [
    'package-lock.json packages[""].version: 1.2.2 != 1.2.3',
  ]);
});
