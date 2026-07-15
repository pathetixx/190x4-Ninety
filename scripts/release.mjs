#!/usr/bin/env node
// Ninety · релиз одной командой, от бампа до раздачи по OTA. Оборачивает весь
// ритуал (RELEASING.md) так, что две ручные переменные — номер версии и
// заметки — авторятся по одному разу и разъезжаться не могут:
//   версия → bump-version.mjs (app manifests + website fallback);
//   заметки → секция CHANGELOG.md этой версии → git tag -a -F → тело draft'а.
// CHANGELOG.md — единый источник заметок: те же байты уходят в аннотацию тега
// (→ latest.json/OTA) и в тело релиза.
//
// Компиляция — в CI (локально не собираем): push тега запускает сборку/подпись/
// публикацию/зеркала. С --watch скрипт доводит до конца: ждёт CI-ран и проверяет,
// что релиз опубликован, ассеты на месте и latest.json реально раздаётся с
// GitHub и GitLab. CI сначала продвигает проверенный GitLab metadata и только
// затем публикует draft как GitHub Latest.
//
// Использование:
//   node scripts/release.mjs X.Y.Z [--watch] [--dry-run] [--yes]
//   node scripts/release.mjs X.Y.Z --verify        # только проверить уже вышедший релиз
// Перед запуском: добавить секцию "## vX.Y.Z — YYYY-MM-DD" в НАЧАЛО CHANGELOG.md.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";

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

const REPO = "pathetixx/190x4-Ninety";
const GH_LATEST = `https://github.com/${REPO}/releases/latest/download/latest.json`;
const GL_LATEST =
  "https://gitlab.com/api/v4/projects/83749391/packages/generic/ninety/stable/latest.json";

let failed = 0;
const check = (ok, label) => { console.log(`  ${ok ? "✓" : "✗"} ${label}`); if (!ok) failed++; };

// Поднять fn() до истины с ретраями — OTA-эндпоинты/CDN могут догонять пару секунд.
async function retry(fn, tries = 8, delayMs = 5000) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true; } catch { /* transient */ }
    if (i < tries - 1) await sleep(delayMs);
  }
  return false;
}

// Проверка, что релиз реально встал и раздаётся. Используется --watch и --verify.
async function verifyRelease(version) {
  const tag = `v${version}`;
  console.log(`\nПроверка релиза ${tag}:`);

  let rel;
  try {
    rel = JSON.parse(cap("gh", ["release", "view", tag,
      "--json", "isDraft,isPrerelease,assets"]));
  } catch {
    check(false, "gh release view — релиз не найден");
    return;
  }
  check(!rel.isDraft, "опубликован (не draft)");
  check(!rel.isPrerelease, "не prerelease (иначе выпадет из Latest → OTA сломан)");
  const names = rel.assets.map((a) => a.name);
  check(names.some((n) => /-setup\.exe$/.test(n)), "ассет установщика (.exe)");
  check(names.some((n) => /-setup\.exe\.sig$/.test(n)), "подпись установщика (.sig)");
  check(names.some((n) => /\.msi$/.test(n)), "ассет .msi");
  check(names.some((n) => /_windows-x64-portable\.zip$/.test(n)), "ассет Portable ZIP (Windows x64)");
  check(names.includes("latest.json"), "ассет latest.json");

  // GitHub /releases/latest/ отдаёт нашу версию ⇒ релиз стал Latest, и подпись на месте.
  let ghMetadata;
  const ghOk = await retry(async () => {
    const r = await fetch(GH_LATEST);
    if (!r.ok) return false;
    const j = await r.json();
    const platform = j.platforms?.["windows-x86_64"];
    if (j.version !== version || !platform?.signature) return false;
    ghMetadata = j;
    return true;
  });
  check(ghOk, `GitHub OTA: latest.json = ${version}, подпись есть (= релиз Latest)`);

  // GitLab — первичный OTA-источник. CI проверяет installer + versioned metadata,
  // переключает stable/latest.json и только после этого публикует GitHub draft.
  let glMetadata;
  const glOk = await retry(async () => {
    const r = await fetch(GL_LATEST);
    if (!r.ok) return false;
    const j = await r.json();
    const platform = j.platforms?.["windows-x86_64"];
    if (j.version !== version || !platform?.signature) return false;
    if (!platform.url?.includes(`/packages/generic/ninety/${version}/`)) return false;
    glMetadata = j;
    return true;
  });
  check(glOk, `GitLab OTA (первичный): latest.json = ${version}, immutable URL и подпись есть`);
  check(
    !!ghMetadata && !!glMetadata
      && ghMetadata.platforms["windows-x86_64"].signature
        === glMetadata.platforms["windows-x86_64"].signature,
    "GitHub/GitLab OTA используют одну updater signature",
  );
}

// --- аргументы ---
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const version = argv.find((a) => !a.startsWith("--"));
const dryRun = flags.has("--dry-run");
const autoYes = flags.has("--yes");
const watch = flags.has("--watch");

if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  die(`нужна версия X.Y.Z (получено: ${version ?? "<none>"})`);
const tag = `v${version}`;

// --- режим только-проверки ---
if (flags.has("--verify")) {
  await verifyRelease(version);
  console.log(failed ? `\n✗ проверка: ${failed} провал(ов)` : "\n✓ всё встало");
  process.exit(failed ? 1 : 0);
}

// --- предпроверки (только чтение) ---
const branch = cap("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") die(`ветка ${branch}, ожидалась main (RELEASING.md)`);
run("git", ["fetch", "origin", "main"]);
const head = cap("git", ["rev-parse", "HEAD"]);
const originMain = cap("git", ["rev-parse", "origin/main"]);
if (head !== originMain) die("локальный main должен точно совпадать с origin/main перед релизом");

// Скрипт сам коммитит только release-файлы. Любая другая грязь (особенно уже
// staged) могла бы незаметно попасть в релизный commit через общий git commit.
const dirty = cap("git", ["status", "--porcelain=v1"])
  .split("\n")
  .filter(Boolean);
// cap() trims output, поэтому у единственной строки первый пробел porcelain
// может исчезнуть (" M CHANGELOG.md" → "M CHANGELOG.md").
const releaseNotesOnly = /^(?:[ MARC?][ MDARC?]|[MARC?]) CHANGELOG\.md$/;
const unexpectedDirty = dirty.filter((line) => !releaseNotesOnly.test(line));
if (unexpectedDirty.length) {
  die(`перед релизом разрешено менять только CHANGELOG.md:\n${unexpectedDirty.join("\n")}`);
}

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

const today = new Date().toISOString().slice(0, 10);
const needDate = !/—\s*\d{4}-\d{2}-\d{2}/.test(lines[headIdx]);

// --- план ---
console.log(`\nРелиз ${tag}`);
console.log(`  синхронизация версии приложения и сайта → ${version}`);
if (needDate) console.log(`  дата в заголовке CHANGELOG → ${today}`);
console.log(`  заметки (${notes.split("\n").length} стр. из CHANGELOG.md):`);
console.log(notes.split("\n").map((l) => "    " + l).join("\n"));
console.log(`\n  дальше: commit main · git tag -a ${tag} -F · `
  + `push origin main ${tag} · gh release create --draft`);
console.log(watch
  ? "  затем слежу за CI (компиляция→подпись→публикация) и проверяю OTA. Это уедет пользователям."
  : "  затем CI собирает/подписывает/публикует сам. Это уедет пользователям.");

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
run("node", ["scripts/check-version.mjs"]);
run("git", ["add", "package.json", "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "site/app.js",
  "site/index.html", "CHANGELOG.md"]);
run("git", ["commit", "-m", tag]);
const sha = cap("git", ["rev-parse", "HEAD"]);

const dir = mkdtempSync(join(tmpdir(), "ninety-rel-"));
const notesFile = join(dir, "notes.md");
writeFileSync(notesFile, notes + "\n");           // те же байты, что в CHANGELOG

run("git", ["tag", "-a", tag, "-F", notesFile]);
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", tag]);
run("gh", ["release", "create", tag, "--draft", "--title", `Ninety ${tag}`,
  "-F", notesFile]);
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ ${tag} запушен, тег на месте, draft создан.`);

if (!watch) {
  console.log("CI собирает. Следить: gh run watch  (или перезапусти с --watch/--verify)");
  process.exit(0);
}

// --- дождаться CI и проверить исход ---
console.log(`\nЖду CI-ран для ${sha.slice(0, 7)}…`);
let runId;
for (let i = 0; i < 20 && !runId; i++) {
  let runs = [];
  try {
    runs = JSON.parse(cap("gh", ["run", "list", "--workflow", "build.yml",
      "--json", "databaseId,headSha", "--limit", "20"]));
  } catch { /* ран ещё не зарегистрирован */ }
  const r = runs.find((x) => x.headSha === sha);
  if (r) runId = r.databaseId; else await sleep(3000);
}
if (!runId) die("CI-ран не появился за ~60с. Проверь: gh run list; потом --verify " + version);

console.log(`Ран ${runId}: компиляция → подпись → публикация. Слежу…`);
try {
  execFileSync("gh", ["run", "watch", String(runId), "--exit-status"],
    { cwd: root, stdio: "inherit" });
} catch {
  die("CI упал. Draft остался неопубликованным — OTA не тронута. "
    + "Разбери лог (gh run view " + runId + " --log-failed) и катни fix-forward следующим тегом.");
}

await verifyRelease(version);
console.log(failed
  ? `\n✗ ${tag} собрался, но проверка нашла ${failed} проблем(у) — глянь вручную`
  : `\n✓ ${tag} собран, опубликован и раздаётся по OTA (GitHub + GitLab)`);
process.exit(failed ? 1 : 0);
