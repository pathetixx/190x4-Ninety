#!/usr/bin/env node
// Ninety · пред-CI релиз одной командой. Оборачивает ручной ритуал
// (RELEASING.md шаги 1–5) так, что две единственные ручные переменные —
// номер версии и заметки — авторятся по одному разу и разъезжаться не могут:
//   версия → bump-version.mjs (4 файла);
//   заметки → секция CHANGELOG.md этой версии → git tag -a -F → тело draft'а.
// CHANGELOG.md — единый источник заметок: те же байты уходят в аннотацию тега
// (→ latest.json/OTA) и в тело релиза. Скрипт останавливается ДО компиляции —
// push тега и есть то, что запускает сборку/подпись/публикацию/OTA в CI.
//
// Использование:
//   node scripts/release.mjs X.Y.Z [--dry-run] [--yes] [--allow-branch]
// Перед запуском: добавить секцию "## vX.Y.Z — YYYY-MM-DD" в НАЧАЛО CHANGELOG.md.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

function exec(cmd, a, { capture = false } = {}) {
  try {
    return execFileSync(cmd, a, {
      cwd: root, encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
  } catch (e) {
    if (capture) throw e;              // caller decides (e.g. optional ls-remote)
    die(`команда упала: ${cmd} ${a.join(" ")}`);
  }
}
const cap = (cmd, a) => exec(cmd, a, { capture: true }).trim();
const run = (cmd, a) => exec(cmd, a);

// --- аргументы ---
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const version = argv.find((a) => !a.startsWith("--"));
const dryRun = flags.has("--dry-run");
const autoYes = flags.has("--yes");

if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  die(`нужна версия X.Y.Z (получено: ${version ?? "<none>"})`);
const tag = `v${version}`;

// --- предпроверки (только чтение) ---
const branch = cap("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main" && !flags.has("--allow-branch"))
  die(`ветка ${branch}, ожидалась main (RELEASING.md). Обход: --allow-branch`);

if (cap("git", ["tag", "-l", tag])) die(`тег ${tag} уже существует локально`);
try {
  if (cap("git", ["ls-remote", "--tags", "origin", tag]))
    die(`тег ${tag} уже существует на origin`);
} catch { /* сетевой сбой ls-remote — не фатально */ }

// --- заметки из CHANGELOG.md (единый источник) ---
const clPath = join(root, "CHANGELOG.md");
const lines = readFileSync(clPath, "utf8").split("\n");
const isHeader = (l) => /^## v\d+\.\d+\.\d+\b/.test(l);
const headIdx = lines.findIndex(isHeader);
if (headIdx === -1) die("в CHANGELOG.md нет секций версий");

const topVer = lines[headIdx].match(/^## v(\d+\.\d+\.\d+)\b/)[1];
if (topVer !== version)
  die(`верхняя секция CHANGELOG.md — v${topVer}, а не ${tag}. `
    + `Сначала добавь "## ${tag} — <дата>" в начало файла.`);

let end = lines.findIndex((l, i) => i > headIdx && isHeader(l));
if (end === -1) end = lines.length;
const notes = lines.slice(headIdx + 1, end).join("\n").trim();
if (!notes) die(`секция ${tag} в CHANGELOG.md пустая`);

// дата в заголовке: проставить сегодняшнюю, если её нет
const today = new Date().toISOString().slice(0, 10);
const needDate = !/—\s*\d{4}-\d{2}-\d{2}/.test(lines[headIdx]);

// --- план ---
console.log(`\nРелиз ${tag}`);
console.log(`  бамп 4 файлов → ${version}`);
if (needDate) console.log(`  дата в заголовке CHANGELOG → ${today}`);
console.log(`  заметки (${notes.split("\n").length} стр. из CHANGELOG.md):`);
console.log(notes.split("\n").map((l) => "    " + l).join("\n"));
console.log(`\n  дальше: commit main · git tag -a ${tag} -F · `
  + `push origin main ${tag} · gh release create --draft`);
console.log(`  затем CI: компиляция → подпись → публикация draft'а → OTA. `
  + `Это уедет пользователям.`);

if (dryRun) { console.log("\n(dry-run: ничего не записано)"); process.exit(0); }

if (!autoYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`\nПушим ${tag} и запускаем релиз? [y/N] `))
    .trim().toLowerCase();
  rl.close();
  if (ans !== "y" && ans !== "yes") die("отменено — ничего не запушено");
}

// --- выполнение (записи + сеть) ---
if (needDate) {
  lines[headIdx] = `## ${tag} — ${today}`;
  writeFileSync(clPath, lines.join("\n"));
}

run("node", ["scripts/bump-version.mjs", version]);
run("git", ["add", "package.json", "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "CHANGELOG.md"]);
run("git", ["commit", "-m", tag]);

const dir = mkdtempSync(join(tmpdir(), "ninety-rel-"));
const notesFile = join(dir, "notes.md");
writeFileSync(notesFile, notes + "\n");           // те же байты, что в CHANGELOG

run("git", ["tag", "-a", tag, "-F", notesFile]);
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", tag]);
run("gh", ["release", "create", tag, "--draft", "--title", `Ninety ${tag}`,
  "-F", notesFile]);

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ ${tag} запушен, CI собирает. Следить: gh run watch`);
