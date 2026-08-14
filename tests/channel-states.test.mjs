// Индикатор «Канал» красит точку через `#tele-channel[data-q=…]`. Состояние
// PRESSURE («движок перестал измерять — ПК загружен») доезжало до атрибута, но
// правила под него не было: точка оставалась в цвете предыдущего состояния,
// обычно зелёном, и рядом стоял текст «Отлично» при полном отсутствии данных.
// Инвариант: множество состояний в коде == множеству селекторов в CSS.
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
