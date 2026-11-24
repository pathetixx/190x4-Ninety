// Custom DPI strategies: the Rust checker owns parsing and the allowlist, the
// editor only translates its issue codes. A code the catalog doesn't know would
// reach the user as a raw "dpi.custom.issue.<code>" string, and a limit that
// drifted between Rust and the UI would let the editor promise a slot the
// backend then refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.document = { getElementById: () => null };
globalThis.window = { __TAURI__: { core: { invoke: async () => {} } }, dispatchEvent: () => {} };

const { MAX_CUSTOM_STRATEGIES } = await import("/lib/dpi-view.js");
const CODES = ["ru", "en", "fa", "zh", "ar", "es", "de", "uk", "ja", "fr", "it", "pt", "ko", "pl", "tr"];

const custom = readFileSync("src-tauri/src/dpi/custom.rs", "utf8");
const dpi = readFileSync("src-tauri/src/dpi.rs", "utf8");

function emittedCodes() {
  const codes = new Set();
  const patterns = [
    /Issue::(?:error|warn)\(\s*"([A-Za-z]+)"/g,
    /custom_issue\(\s*"([A-Za-z]+)"/g,
    /Err\("([A-Za-z]+)"\)/g,
    /\.ok_or\("([A-Za-z]+)"\)/g,
  ];
  for (const source of [custom, dpi.slice(dpi.indexOf("fn custom_issue"))]) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) codes.add(match[1]);
    }
  }
  return codes;
}

test("каждый код ошибки своей стратегии есть во всех каталогах", async () => {
  const codes = emittedCodes();
  // The scan must actually see the checker, not silently match nothing.
  for (const known of ["unknown", "managed", "path", "binMissing", "limit", "nameTaken", "noBase"]) {
    assert.ok(codes.has(known), `не найден код ${known} — изменился разбор custom.rs?`);
  }
  for (const code of CODES) {
    const catalog = (await import(`/lib/i18n/${code}.js`))[code];
    const issues = catalog.dpi.custom.issue;
    for (const issue of codes) {
      assert.equal(typeof issues[issue], "string", `${code}: нет dpi.custom.issue.${issue}`);
    }
    assert.equal(typeof catalog.backend.dpi.customBroken, "string", `${code}: нет backend.dpi.customBroken`);
  }
});

test("лимит своих стратегий в интерфейсе совпадает с бэкендом", () => {
  const match = custom.match(/MAX_CUSTOM_STRATEGIES: usize = (\d+);/);
  assert.ok(match, "в custom.rs нет MAX_CUSTOM_STRATEGIES");
  assert.equal(MAX_CUSTOM_STRATEGIES, Number(match[1]));
  assert.equal(MAX_CUSTOM_STRATEGIES, 3);
});

test("сообщение о лимите подставляет число", async () => {
  for (const code of CODES) {
    const catalog = (await import(`/lib/i18n/${code}.js`))[code];
    assert.match(catalog.dpi.custom.limit, /\{max\}/, `${code}: dpi.custom.limit без {max}`);
    assert.match(catalog.dpi.custom.issue.limit, /\{arg\}/, `${code}: issue.limit без {arg}`);
  }
});
