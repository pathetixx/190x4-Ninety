// The "Channel" indicator colors the dot via `#tele-channel[data-q=…]`. The
// PRESSURE state ("the engine stopped measuring — the PC is loaded") reached the attribute, but
// there was no rule for it: the dot stayed in the previous state's color,
// usually green, and next to it stood the text "Excellent" with no data at all.
// Invariant: the set of states in the code == the set of selectors in CSS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync("src/main.js", "utf8");
const css = readFileSync("src/styles/app.css", "utf8");

test("каждое состояние канала имеет правило в app.css", () => {
  const declared = main.match(/const CHANNEL_STATES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(declared, "CHANNEL_STATES не найден в main.js");
  const states = [...declared[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1].toUpperCase());
  assert.ok(states.length >= 5, `подозрительно мало состояний: ${states}`);

  const styled = new Set(
    [...css.matchAll(/#tele-channel\[data-q="([A-Z]+)"\]/g)].map((m) => m[1]),
  );
  const missing = states.filter((state) => !styled.has(state));
  assert.deepEqual(missing, [], `нет CSS для состояний: ${missing.join(", ")}`);
});
