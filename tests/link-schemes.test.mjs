// The link scheme lists live in three places and must match: the frontend registers
// handlers from its list, Rust rejects everything that isn't in its own, and parsing
// a top-level link follows the third. A divergence means "link handling can't be enabled
// at all" (registration fails) or "the scheme is registered, but a link with
// it isn't parsed".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window = globalThis.window || {};

const { LINK_HANDLER_SCHEMES } = await import("/lib/link-handlers.js");

// The bracket is taken after "=", otherwise in Rust the "[" from the `&[&str]` type would be found first.
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

// ninety:// is registered by the deep-link plugin, not by this list, so it's
// not in SUPPORTED_SCHEMES — but Rust must remove handlers for it too.
test("список снятия обработчиков = поддерживаемые схемы плюс ninety", () => {
  assert.deepEqual([...deepLinkAll].sort(), [...supported, "ninety"].sort());
});
