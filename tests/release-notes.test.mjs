import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReleaseNotes } from "/lib/release-notes.js";

// The tag annotation is built with --cleanup=verbatim, otherwise Git would throw away lines
// with hashes as comments and OTA would be left without the language headings. So
// Markdown reaches the update window as is, and the client strips the markup.
const NOTES = [
  "## English",
  "",
  "- The **connection log** now records why a reconnect failed.",
  "- See [the changelog](https://example.invalid/CHANGELOG.md) for details.",
  "",
  "## Русский",
  "",
  "- Журнал подключения фиксирует, почему не удалось переподключиться.",
].join("\n");

test("заголовки языков теряют решётки, списки получают маркер", () => {
  assert.equal(formatReleaseNotes(NOTES), [
    "English",
    "",
    "• The connection log now records why a reconnect failed.",
    "• See the changelog for details.",
    "",
    "Русский",
    "",
    "• Журнал подключения фиксирует, почему не удалось переподключиться.",
  ].join("\n"));
});

test("код и вложенные списки остаются читаемыми", () => {
  assert.equal(
    formatReleaseNotes("### Fixes\n  - `stop_singbox` больше не падает\n"),
    "Fixes\n  • stop_singbox больше не падает",
  );
});

test("пустые края и повторные пустые строки схлопываются", () => {
  assert.equal(formatReleaseNotes("\n\n## A\n\n\n\n- x\n\n\n"), "A\n\n• x");
});

test("пустое тело не роняет форматирование", () => {
  assert.equal(formatReleaseNotes(""), "");
  assert.equal(formatReleaseNotes(null), "");
  assert.equal(formatReleaseNotes(undefined), "");
});

test("обычный текст без разметки не меняется", () => {
  const plain = "Соединение стало стабильнее.\nОкно обновления показывает прогресс.";
  assert.equal(formatReleaseNotes(plain), plain);
});

test("переводы строк Windows нормализуются", () => {
  assert.equal(formatReleaseNotes("## A\r\n\r\n- x\r\n"), "A\n\n• x");
});
