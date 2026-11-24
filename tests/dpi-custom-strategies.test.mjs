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

const { MAX_CUSTOM_STRATEGIES, splitTokens, argsToSections, sectionLabel, guessBase } = await import("/lib/dpi-view.js");
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
  const commands = dpi.slice(dpi.indexOf("fn custom_issue"), dpi.indexOf("fn strategy_file_name"));
  for (const source of [custom, commands]) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) codes.add(match[1]);
    }
  }
  return codes;
}

test("каждый код ошибки своей стратегии есть во всех каталогах", async () => {
  const codes = emittedCodes();
  // The scan must actually see the checker, not silently match nothing.
  for (const known of ["unknown", "managed", "path", "binMissing", "limit", "nameTaken", "noFilter", "json", "descLong"]) {
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

// The strategy Dima tested: ALT11 with only the game TCP section replaced.
const alt11Game = JSON.parse(readFileSync("src-tauri/src/dpi/custom_alt11_game.json", "utf8"));
const builtins = JSON.parse(readFileSync("src-tauri/dpi/strategies.json", "utf8"));

test("секции режутся по --new, а --wf-* собирается заново", () => {
  const sections = argsToSections(alt11Game.args);
  assert.equal(sections.length, 9);
  assert.ok(!sections.join("\n").includes("--wf-"), "перехват не переносится в секции");
  assert.ok(sections[7].includes("--dpi-desync-fake-unknown=%BIN%tls_clienthello_max_ru.bin"));
  // A stored strategy keeps its extra interception in the first section.
  assert.equal(argsToSections(["--wf-tcp=80", "--filter-tcp=443"], { dropWf: false })[0], "--wf-tcp=80\n--filter-tcp=443");
});

test("подпись секции говорит, какой трафик она берёт", () => {
  const sections = argsToSections(alt11Game.args);
  assert.equal(sectionLabel(sections[0]), "UDP 443 · list-general + list-general-user");
  assert.match(sectionLabel(sections[1]), /^UDP 19294-19344,50000-50100 · discord,stun$/);
  assert.equal(sectionLabel(sections[2]), "TCP 2053,2083,2087,2096,8443 · discord.media");
  assert.match(sectionLabel(sections[7]), /^TCP .+ · ipset$/);
  assert.match(sectionLabel("--dpi-desync=fake"), /^\S/);
});

test("импорт узнаёт основу, из которой сделана стратегия", () => {
  const sections = argsToSections(alt11Game.args);
  const alt11 = builtins.find((s) => s.id === "alt11");
  const same = argsToSections(alt11.args).filter((b, i) => b === sections[i]).length;
  // Only the game TCP section differs from the bundled ALT11, if the bundle matches 1.10.x.
  if (same === 8) assert.equal(guessBase(sections, builtins), "alt11");
  assert.equal(guessBase(["--filter-tcp=1 --dpi-desync=fake"], builtins), "");
});

test("кавычки из .bat снимаются при разборе", () => {
  assert.deepEqual(splitTokens('--hostlist="%LISTS%list-general.txt" --new'), ["--hostlist=%LISTS%list-general.txt", "--new"]);
});
