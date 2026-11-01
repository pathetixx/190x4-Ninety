// Каталоги синхронны между собой (i18n.test.mjs), но это не значит, что ключ,
// который просит код, вообще существует: t() при промахе возвращает сам ключ, и
// пользователь видит в интерфейсе строку вида «dg.row.unpin». Проверяем каждый
// статически заданный ключ во всём фронтенде.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const { ru } = await import("/lib/i18n/ru.js");
const { en } = await import("/lib/i18n/en.js");

function flatten(obj, prefix = "", out = new Set()) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, path, out);
    else out.add(path);
  }
  return out;
}

function jsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Каталоги переводов — источник ключей, а не их потребитель.
      if (full.endsWith("i18n") || entry === "vendor") continue;
      jsFiles(full, out);
    } else if (entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

// tn(key, n) обращается к key.<форма>; наличие любой формы = ключ есть.
const PLURAL_FORMS = ["zero", "one", "two", "few", "many", "other"];

function collectUsed() {
  const used = new Map();
  for (const file of jsFiles("src")) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      // Комментарии показывают форму ключа («qEngine.steps.<id>»), а не просят
      // его у каталога.
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*")) return;
      // Только цельный ключ: за строкой обязаны идти закрывающая скобка или
      // запятая. Иначе в улов попадает префикс из конкатенации
      // (`t("mode.hint." + mode)`), которого в каталоге и не должно быть.
      for (const match of line.matchAll(/\b(?:t|tn)\(\s*"([^"${}]+)"\s*[),]/g)) {
        if (!used.has(match[1])) used.set(match[1], `${file}:${index + 1}`);
      }
    });
  }
  return used;
}

const catalogues = { ru: flatten(ru), en: flatten(en) };

test("каждый запрошенный кодом ключ есть в каталоге", () => {
  const used = collectUsed();
  assert.ok(used.size > 500, `ключей найдено подозрительно мало: ${used.size}`);
  for (const [lang, keys] of Object.entries(catalogues)) {
    const missing = [...used]
      .filter(([key]) => !keys.has(key) && !PLURAL_FORMS.some((form) => keys.has(`${key}.${form}`)))
      .map(([key, at]) => `${key} (${at})`);
    assert.deepEqual(missing, [], `в каталоге ${lang} нет ключей: ${missing.join(", ")}`);
  }
});

function rustSources() {
  const dir = "src-tauri/src";
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".rs"))
    .map((entry) => [entry, readFileSync(join(dir, entry), "utf8")]);
}

test("каждый ключ ошибки из бэкенда есть в каталоге, и у него те же подстановки", () => {
  const found = new Map();
  for (const [, source] of rustSources()) {
    for (const match of source.matchAll(/"((?:subs\.err|backend)\.[\w.]+)"/g)) found.set(match[1], true);
  }
  assert.ok(found.size > 80, `ключей найдено подозрительно мало: ${found.size}`);
  for (const [lang, known] of Object.entries(catalogues)) {
    const missing = [...found.keys()].filter((key) => !known.has(key));
    assert.deepEqual(missing, [], `в каталоге ${lang} нет ключей: ${missing.join(", ")}`);
  }
});

// Русский текст в коде бэкенда пользователь увидит и при английском интерфейсе:
// ошибка для него — ключ i18n_error, техническая подробность — по-английски.
test("в строках бэкенда нет русского текста", () => {
  const offenders = [];
  for (const [name, source] of rustSources()) {
    let inTests = false;
    source.split("\n").forEach((line, index, lines) => {
      if (/^\s*mod tests \{/.test(line) && /#\[cfg\(test\)\]/.test(lines[index - 1] ?? "")) inTests = true;
      else if (inTests && line === "}") inTests = false;
      const code = line.trim();
      if (inTests || code.startsWith("//")) return;
      const literals = code.replace(/\s\/\/.*$/, "").match(/"(?:[^"\\]|\\.)*"/g) ?? [];
      if (literals.some((literal) => /[А-Яа-яЁё]/.test(literal))) offenders.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
