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
const toGamma = (c) => {
  const v = Math.min(Math.max(c, 0), 1);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};
const luminance = (rgb) => {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const toOklab = (rgb) => {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
const fromOklab = ([L, a, b]) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toGamma);
};
// color-mix(in oklab, a p%, b)
const mixOklab = (a, b, p) => {
  const [x, y] = [toOklab(a), toOklab(b)];
  return fromOklab(x.map((v, i) => v * p + y[i] * (1 - p)));
};
// color-mix(in srgb, fg p%, transparent), положенный на bg
const overlay = (fg, bg, p) => fg.map((v, i) => v * p + bg[i] * (1 - p));

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

test("повышенный контраст подключён после тем и действует на #app-root", () => {
  const html = readFileSync("src/index.html", "utf8");
  const rtl = html.indexOf('href="/styles/rtl.css"');
  const contrast = html.indexOf('href="/styles/contrast.css"');
  assert.ok(rtl > 0 && contrast > rtl, "contrast.css должен идти после rtl.css (а с ним — премиум-тем)");
  const css = stripComments(readFileSync(join(STYLES, "contrast.css"), "utf8"));
  assert.match(css, /:root\[data-contrast="more"\]\s+\[data-theme\]/);
});

test("повышенный контраст выдерживает свои пороги в каждой теме", () => {
  const css = stripComments(readFileSync(join(STYLES, "contrast.css"), "utf8"));
  const blocks = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => {
    const share = (token) => Number(body.match(new RegExp(`--${token}:[^;]*?(\\d+)%`))[1]) / 100;
    return {
      themes: new Set([...selector.matchAll(/data-theme="(\w+)"/g)].map((m) => m[1])),
      share: Object.fromEntries(["text-mid", "text-lo", "text-faint", "line-2"].map((t) => [t, share(t)])),
    };
  });
  const [generic, ...overrides] = blocks;
  const failures = [];
  for (const [id, palette] of themePalettes()) {
    const { share } = overrides.find((block) => block.themes.has(id)) ?? generic;
    for (const [token, min] of [["text-mid", 10], ["text-lo", 7], ["text-faint", 4.5]]) {
      const value = worst(mixOklab(palette["text-hi"], palette["ink-1"], share[token]), palette);
      if (value < min) failures.push(`${id} --${token} ${value.toFixed(2)}:1 < ${min}:1`);
    }
    const border = ratio(overlay(palette["text-hi"], palette["ink-1"], share["line-2"]), palette["ink-1"]);
    if (border < 3) failures.push(`${id} --line-2 ${border.toFixed(2)}:1 < 3:1`);
  }
  assert.deepEqual(failures, []);
});
