// License texts name the exact versions of what's in the installer, and
// for the GPL core — the tag to look up the build's sources by. Done by hand they lagged
// several bumps behind, so the versions are generated from pins.json and src-tauri/dpi,
// and here we check that the files in the tree match these sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LICENSE_TXT_PATH,
  NOTICES_PATH,
  readSources,
  renderLicenseTxt,
  renderNotices,
} from "../scripts/gen-notices.mjs";

const sources = readSources();
const notices = readFileSync(NOTICES_PATH, "utf8");
const licenseTxt = readFileSync(LICENSE_TXT_PATH, "utf8");
const fix = "запусти node scripts/gen-notices.mjs";

test("THIRD-PARTY-NOTICES.md совпадает с пинами и версиями DPI", () => {
  assert.equal(renderNotices(notices, sources), notices, fix);
});

test("license.txt называет запиненный тег ядра", () => {
  assert.equal(renderLicenseTxt(licenseTxt, sources), licenseTxt, fix);
});

test("новый пин попадает во все разделы и в обе части лицензии", () => {
  const bumped = structuredClone(sources);
  bumped.pins["ninety-core"] = { tag: "v9.9.9-ninety.1", sha: "a".repeat(40) };
  bumped.pins.naive.version = "v999.0.0-1";
  bumped.strategies = "9.9.9";
  const text = renderNotices(notices, bumped);
  assert.ok(text.includes("| Version | `v9.9.9-ninety.1` (commit `" + "a".repeat(40) + "`) |"));
  assert.ok(text.includes("| Version | `v999.0.0-1` |"));
  assert.ok(text.includes("strategy set `9.9.9`"));
  const license = renderLicenseTxt(licenseTxt, bumped);
  assert.ok(license.includes("(tag v9.9.9-ninety.1)"));
  assert.ok(license.includes("(тег v9.9.9-ninety.1)"));
});

test("пропавший раздел — ошибка, а не молчаливый пропуск", () => {
  assert.throws(() => renderNotices(notices.replace("## Wintun ", "## WinTUN "), sources), /Wintun/);
  assert.throws(() => renderLicenseTxt("", sources), /найдено 0/);
});

test("переводы строк CRLF сохраняются", () => {
  const crlf = notices.replace(/\r?\n/g, "\r\n");
  assert.equal(renderNotices(crlf, sources), crlf);
});
