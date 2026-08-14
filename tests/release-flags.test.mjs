// Контракт флагов релизного скрипта. Разъезд здесь всплывает ровно в момент
// релиза: `--allow-branch` числился поддерживаемым и не был реализован (скрипт
// принимал его и всё равно падал на проверке ветки), а документация звала
// несуществующий `--watch`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync("scripts/release.mjs", "utf8");

const declared = (() => {
  const match = script.match(/const supportedFlags = new Set\(\[([^\]]+)\]\)/);
  assert.ok(match, "supportedFlags не найден");
  return [...match[1].matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]);
})();

test("каждый поддерживаемый флаг где-то читается", () => {
  const unread = declared.filter((flag) => {
    const uses = [...script.matchAll(new RegExp(`flags\\.has\\("${flag}"\\)`, "g"))];
    return uses.length === 0;
  });
  assert.deepEqual(unread, [], `флаг принимается, но не влияет ни на что: ${unread.join(", ")}`);
});

test("документация не зовёт флагов, которых нет", () => {
  const docs = ["RELEASING.md", "docs/RELEASE_QUALIFICATION.md"];
  const unknown = [];
  for (const doc of docs) {
    const text = readFileSync(doc, "utf8");
    for (const match of text.matchAll(/release\.mjs[^\n`]*?(--[a-z-]+)/g)) {
      if (!declared.includes(match[1])) unknown.push(`${doc}: ${match[1]}`);
    }
  }
  assert.deepEqual(unknown, [], `в доке несуществующий флаг: ${unknown.join(", ")}`);
});
