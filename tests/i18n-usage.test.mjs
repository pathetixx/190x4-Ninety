// The catalogs are in sync with each other (i18n.test.mjs), but that doesn't mean the key
// the code asks for exists at all: on a miss t() returns the key itself, and
// the user sees a string like "dg.row.unpin" in the interface. We check every
// statically specified key across the whole frontend.
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
      // Translation catalogs are a source of keys, not their consumer.
      if (full.endsWith("i18n") || entry === "vendor") continue;
      jsFiles(full, out);
    } else if (entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

// tn(key, n) accesses key.<form>; the presence of any form = the key exists.
const PLURAL_FORMS = ["zero", "one", "two", "few", "many", "other"];

function collectUsed() {
  const used = new Map();
  for (const file of jsFiles("src")) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      // Comments show the shape of a key ("qEngine.steps.<id>") rather than asking
      // the catalog for it.
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*")) return;
      // Only a whole key: the string must be followed by a closing parenthesis or
      // a comma. Otherwise a prefix from a concatenation gets caught
      // (`t("mode.hint." + mode)`), which isn't supposed to be in the catalog.
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

// Russian text in the backend code will be seen by the user even with an English interface:
// for them an error is an i18n_error key, a technical detail is in English.
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
