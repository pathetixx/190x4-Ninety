// Списки схем ссылок живут в трёх местах и обязаны совпадать: фронт регистрирует
// обработчики по своему списку, Rust отвергает всё, чего нет в его, а разбор
// top-level ссылки идёт по третьему. Разъезд означает «включить обработку ссылок
// нельзя вообще» (регистрация падает) либо «схема зарегистрирована, но ссылка по
// ней не разбирается».
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window = globalThis.window || {};

const { LINK_HANDLER_SCHEMES } = await import("/lib/link-handlers.js");

// Скобка берётся после "=", иначе в Rust первым нашёлся бы "[" из типа `&[&str]`.
const listFrom = (source, marker) => {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `не найден ${marker}`);
  const open = source.indexOf("[", source.indexOf("=", start));
  const close = source.indexOf("]", open);
  const values = [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(values.length > 0, `пустой список у ${marker}`);
  return values;
};

const deeplinkSource = readFileSync("src/lib/deeplink.js", "utf8");
const rustSource = readFileSync("src-tauri/src/url_handler.rs", "utf8");

const topLevel = listFrom(deeplinkSource, "const TOP_LEVEL_PROTOS");
const supported = listFrom(rustSource, "pub const SUPPORTED_SCHEMES");
const deepLinkAll = listFrom(rustSource, "const ALL_DEEP_LINK_SCHEMES");

test("фронт и Rust знают один и тот же набор схем", () => {
  assert.deepEqual([...LINK_HANDLER_SCHEMES].sort(), [...supported].sort());
});

test("разбор top-level ссылок покрывает все регистрируемые схемы", () => {
  assert.deepEqual([...topLevel].sort(), [...LINK_HANDLER_SCHEMES].sort());
});

// ninety:// регистрируется плагином deep-link, а не этим списком, поэтому в
// SUPPORTED_SCHEMES его нет — но снимать обработчики Rust обязан и для него.
test("список снятия обработчиков = поддерживаемые схемы плюс ninety", () => {
  assert.deepEqual([...deepLinkAll].sort(), [...supported, "ninety"].sort());
});
