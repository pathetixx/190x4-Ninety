// Лицензионные тексты называют точные версии того, что лежит в инсталляторе, а
// для GPL-ядра — тег, по которому искать исходники сборки. Руками они отставали
// на несколько бампов, поэтому версии генерируются из pins.json и src-tauri/dpi,
// а здесь проверяется, что файлы в дереве с этими источниками совпадают.
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
