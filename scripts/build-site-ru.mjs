#!/usr/bin/env node
// Ninety · статичная русская страница сайта (site/ru/index.html).
//
// Основная страница переводится скриптом в браузере, но краулеры и превью
// ссылок в мессенджерах JavaScript не выполняют и видят английский текст.
// Поэтому русская версия собирается заранее из site/index.html и словаря
// translations.ru в site/app.js. Руками site/ru/index.html не правится:
// tests/site.test.mjs сверяет его с выводом этого скрипта.
//
// Использование:
//   node scripts/build-site-ru.mjs          — пересобрать site/ru/index.html
//   node scripts/build-site-ru.mjs --check  — упасть, если файл устарел

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(SCRIPT_PATH), "..");
export const SITE_URL = "https://pathetixx.github.io/190x4-Ninety/";
export const RU_PAGE = "site/ru/index.html";

export function loadTranslations(appSource) {
  const end = appSource.indexOf("\n};");
  if (end < 0) throw new Error("site/app.js: словарь translations не найден");
  return new Function(`${appSource.slice(0, end + 3)}; return translations;`)();
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function replaceOnce(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`site/index.html: не найдено «${label}»`);
  return source.replace(pattern, replacement);
}

export function buildRuPage(html, translations) {
  const ru = translations.ru;
  let out = html;

  out = replaceOnce(out, /<html lang="en"[^>]*>/, '<html lang="ru" data-page-lang="ru" data-site-root="../">', "<html lang>");
  out = replaceOnce(out, /<title>[^<]*<\/title>/, `<title>${escapeHtml(ru["meta.title"])}</title>`, "<title>");
  out = replaceOnce(
    out,
    /(<meta\s+name="description"\s+content=")[^"]*(")/,
    `$1${escapeAttr(ru["meta.description"])}$2`,
    "meta description",
  );
  out = replaceOnce(
    out,
    /(<meta property="og:title" content=")[^"]*(")/,
    `$1${escapeAttr(ru["meta.title"])}$2`,
    "og:title",
  );
  out = replaceOnce(
    out,
    /(<meta\s+property="og:description"\s+content=")[^"]*(")/,
    `$1${escapeAttr(ru["meta.description"])}$2`,
    "og:description",
  );
  out = replaceOnce(out, /(<meta property="og:url" content=")[^"]*(")/, `$1${SITE_URL}ru/$2`, "og:url");
  out = replaceOnce(out, /(<meta property="og:locale" content=")[^"]*(")/, "$1ru_RU$2", "og:locale");
  out = replaceOnce(out, /(<link rel="canonical" href=")[^"]*(")/, `$1${SITE_URL}ru/$2`, "canonical");

  // Тексты с data-i18n. Тот же разбор, что и в тесте статической разметки.
  out = out.replace(/<(\w+)([^>]*\bdata-i18n="([^"]+)"[^>]*)>(.*?)<\/\1>/gs, (match, tag, attrs, key) => {
    if (!(key in ru)) throw new Error(`translations.ru: нет ключа ${key}`);
    return `<${tag}${attrs}>${escapeHtml(ru[key])}</${tag}>`;
  });

  // Активная кнопка языка.
  out = out.replace(
    /<button class="lang-button is-active" type="button" data-lang="en">/,
    '<button class="lang-button" type="button" data-lang="en">',
  );
  out = out.replace(
    /<button class="lang-button" type="button" data-lang="ru">/,
    '<button class="lang-button is-active" type="button" data-lang="ru">',
  );

  // Локальные пути: страница лежит на уровень глубже.
  out = out.replace(/\b(src|href)="(?!https?:|#|mailto:|\.\.\/)([^"]+)"/g, '$1="../$2"');

  // alt главного скриншота до выполнения JS.
  out = out.replace(/(data-screen-image src="[^"]+" alt=")[^"]*(")/, "$1Главный экран Ninety$2");

  return out;
}

export function renderRuPage(root = REPO_ROOT) {
  const html = readFileSync(join(root, "site/index.html"), "utf8");
  const app = readFileSync(join(root, "site/app.js"), "utf8");
  return buildRuPage(html, loadTranslations(app));
}

export function writeRuPage(root = REPO_ROOT) {
  const target = join(root, RU_PAGE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderRuPage(root));
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.includes("--check")) {
    const current = readFileSync(join(REPO_ROOT, RU_PAGE), "utf8");
    if (current !== renderRuPage()) {
      console.error(`${RU_PAGE} устарел: запустите node scripts/build-site-ru.mjs`);
      process.exit(1);
    }
  } else {
    writeRuPage();
    console.log(`Written ${RU_PAGE}`);
  }
}
