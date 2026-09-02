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

// navigator в Node доступен только на чтение: `global.navigator = {...}` молча
// не срабатывает, и тест начинает проверять локаль машины вместо мока. Поэтому
// navigator приходит параметром функции.
function siteFunction(name) {
  const block = app.slice(app.indexOf("const SUPPORTED_LANGUAGES"), app.indexOf("let currentLanguage"));
  return new Function("navigator", `${block}; return ${name};`);
}

const translations = new Function(`${app.slice(0, app.indexOf("\n};") + 3)}; return translations;`)();
const defaultLanguage = app.match(/const DEFAULT_LANGUAGE = "(\w+)";/)[1];

test("язык браузера определяется, незнакомый уходит в язык по умолчанию", () => {
  const make = siteFunction("detectBrowserLanguage");
  const detect = (languages) => make({ languages, language: languages[0] })();
  assert.equal(detect(["ru-RU", "en-US"]), "ru", "региональный тег сводится к базовому");
  assert.equal(detect(["en-GB"]), "en");
  assert.equal(detect(["de-DE", "fr"]), defaultLanguage, "незнакомый язык → язык по умолчанию");
  assert.equal(detect(["de", "ru-RU"]), "ru", "берётся первый знакомый по приоритету");
  assert.equal(detect([]), defaultLanguage, "пустой список не должен ломать определение");
});

// Разметка index.html — это то, что видят краулер и посетитель до выполнения JS.
// Если она разойдётся с языком по умолчанию, страница откроется на одном языке,
// а через долю секунды переедет на другой.
test("статическая разметка сайта написана на языке по умолчанию", () => {
  assert.match(html, new RegExp(`<html lang="${defaultLanguage}">`));
  const nodes = [...html.matchAll(/<(\w+)[^>]*\bdata-i18n="([^"]+)"[^>]*>(.*?)<\/\1>/gs)];
  assert.ok(nodes.length > 0, "на странице нет ни одного data-i18n");
  for (const [, , key, body] of nodes) {
    assert.equal(body.trim(), translations[defaultLanguage][key], `data-i18n="${key}" разошёлся со словарём`);
  }
});
