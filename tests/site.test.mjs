import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const app = readFileSync("site/app.js", "utf8");
const html = readFileSync("site/index.html", "utf8");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

function translationKeys(block) {
  return [...block.matchAll(/^\s{4}"([^"]+)":/gm)].map((m) => m[1]).sort();
}

test("site fallback version совпадает с package version", () => {
  assert.match(app, new RegExp(`tagName:\\s*"v${version.replaceAll(".", "\\.")}"`));
  assert.match(html, new RegExp(`data-release-version>v${version.replaceAll(".", "\\.")}<`));
});

test("site RU и EN содержат одинаковые translation keys", () => {
  const ru = app.slice(app.indexOf("  ru: {"), app.indexOf("  en: {"));
  const en = app.slice(app.indexOf("  en: {"), app.indexOf("};\n\nconst releaseFallback"));
  assert.deepEqual(translationKeys(en), translationKeys(ru));
});

test("локальные assets из site/index.html существуют", () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => !/^(?:https?:|#|mailto:)/.test(ref));
  for (const ref of refs) {
    const clean = ref.split(/[?#]/)[0];
    assert.equal(existsSync(path.join("site", clean)), true, `missing site asset: ${clean}`);
  }
});
