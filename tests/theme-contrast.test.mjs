// Текст и иконки поверх акцентной заливки обязаны брать цвет из --on-accent.
// Литеральный белый ломается в темах со светлым акцентом: у mono акцент
// #E8E8EE, и подпись кнопки «ОБНОВИТЬ» в модалке OTA становилась невидимой
// (контраст ~1.06:1). Токен --on-accent для этого и заведён — и переопределён
// в каждой из 16 тем.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STYLES = "src/styles";
const files = readdirSync(STYLES).filter((name) => name.endsWith(".css"));

// Ищем правила, где рядом стоят акцентный фон и литеральный белый цвет текста.
const RULE = /\{[^}]*\}/g;

test("нет литерального белого поверх var(--accent)", () => {
  const offenders = [];
  for (const file of files) {
    const css = readFileSync(join(STYLES, file), "utf8");
    for (const match of css.matchAll(RULE)) {
      const body = match[0];
      const hasAccentBackground = /background(-color)?:\s*var\(--accent\)/.test(body);
      const hasLiteralWhite = /(?:^|[^-])color:\s*(#fff\b|#ffffff\b|white\b)/i.test(body);
      if (hasAccentBackground && hasLiteralWhite) {
        const line = css.slice(0, match.index).split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `используйте var(--on-accent): ${offenders.join(", ")}`);
});

test("--on-accent определён во всех темах с переопределённым --accent", () => {
  const themeFiles = files.filter((name) => name === "tokens.css" || name.startsWith("premium-theme-"));
  const missing = [];
  for (const file of themeFiles) {
    const css = readFileSync(join(STYLES, file), "utf8");
    for (const match of css.matchAll(RULE)) {
      const body = match[0];
      // Блок темы: задаёт свой --accent. Базовый :root задаёт и --on-accent.
      if (!/--accent:\s*#/.test(body)) continue;
      const before = css.slice(0, match.index);
      const selector = before.slice(before.lastIndexOf("}") + 1).trim().split("\n").pop().trim();
      // command наследует белый из :root — это осознанно (акцент тёмно-красный).
      if (selector.includes("command")) continue;
      if (!/--on-accent:/.test(body)) missing.push(`${file}: ${selector}`);
    }
  }
  assert.deepEqual(missing, [], `тема без --on-accent: ${missing.join("; ")}`);
});
