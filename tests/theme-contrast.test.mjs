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

// ── Контраст текста по WCAG 2.x (issue #159) ─────────────────────────────
// Ступени текста каждой темы проверяются против всех основных поверхностей:
// --text-lo — самый тихий цвет текста (AA, 4.5:1), --text-faint — иконки,
// разделители и графика (AA для нетекстовых элементов, 3:1).

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (rgb) => {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const TEXT_TOKEN = /--(ink-[0-4]|text-(?:hi|mid|lo|faint))\s*:\s*(#[0-9A-Fa-f]{6})/g;

function themePalettes() {
  const themeFiles = ["tokens.css", ...files.filter((name) => name.startsWith("premium-theme-"))];
  const palettes = new Map();
  for (const file of themeFiles) {
    const css = stripComments(readFileSync(join(STYLES, file), "utf8"));
    for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const tokens = Object.fromEntries([...body.matchAll(TEXT_TOKEN)].map(([, k, v]) => [k, hexRgb(v)]));
      if (!tokens["text-lo"]) continue;
      const id = selector.match(/data-theme="(\w+)"/)?.[1] ?? "base";
      palettes.set(id, { ...palettes.get("base"), ...tokens });
    }
  }
  return palettes;
}

const SURFACES = ["ink-0", "ink-1", "ink-2"];
const worst = (fg, palette) => Math.min(...SURFACES.map((ink) => ratio(fg, palette[ink])));

test("каждая тема даёт тексту и иконкам контраст WCAG AA", () => {
  const palettes = themePalettes();
  assert.ok(palettes.size >= 11, `найдено тем с текстовыми токенами: ${palettes.size}`);
  const failures = [];
  for (const [id, palette] of palettes) {
    for (const [token, min] of [["text-mid", 4.5], ["text-lo", 4.5], ["text-faint", 3]]) {
      const value = worst(palette[token], palette);
      if (value < min) failures.push(`${id} --${token} ${value.toFixed(2)}:1 < ${min}:1`);
    }
  }
  assert.deepEqual(failures, []);
});

test("плейсхолдеры полей не красятся иконочным --text-faint", () => {
  const offenders = [];
  for (const file of files) {
    const css = stripComments(readFileSync(join(STYLES, file), "utf8"));
    for (const match of css.matchAll(/([^{}]*::placeholder[^{}]*)\{([^{}]*)\}/g)) {
      if (/var\(--text-faint\)/.test(match[2])) offenders.push(`${file}: ${match[1].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "текст плейсхолдера — минимум --text-lo");
});
