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
// публикацию/зеркала. После запуска CI скрипт сразу завершается и не следит за
// раном. Проверка уже завершённого релиза остаётся отдельным режимом --verify.
//
// Использование:
//   node scripts/release.mjs X.Y.Z [--dry-run] [--yes]
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

const englishMarkers = new Set([
  "added", "adds", "allows", "available", "client", "connection", "distinct",
  "each", "english", "fixed", "fixes", "for", "from", "improved", "improves",
  "in", "installation", "introduced", "keeps", "language", "new", "now", "of",
  "on", "prevents", "release", "removed", "removes", "settings", "support",
  "supports", "theme", "themes", "the", "to", "updated", "updates", "users",
  "version", "with",
]);
const noteLines = (value) => String(value ?? "")
  .split("\n").map((line) => line.trim()).filter(Boolean);
const hasRussianNotes = (value) => noteLines(value)
  .some((line) => /[\u0400-\u04FF]/u.test(line));
const hasEnglishNotes = (value) => noteLines(value).some((line) => {
  if (/[\u0400-\u04FF]/u.test(line)) return false;
  const words = line.toLowerCase().match(/\b[a-z]{2,}\b/g) ?? [];
  const markers = words.filter((word, index) =>
    englishMarkers.has(word) && words.indexOf(word) === index,
  );
  return words.length >= 3 && markers.length >= 2;
});
const hasBilingualNotes = (value) => hasRussianNotes(value) && hasEnglishNotes(value);
const normalizedNotes = (value) => noteLines(value)
  .filter((line) => !/^#{1,6}\s+/u.test(line))
  .join("\n");

// Поднять fn() до истины с ретраями — OTA-эндпоинты/CDN могут догонять пару секунд.
async function retry(fn, tries = 8, delayMs = 5000) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true; } catch { /* transient */ }
    if (i < tries - 1) await sleep(delayMs);
  }
  return false;
}

// Проверка, что релиз реально встал и раздаётся. Используется режимом --verify.
async function verifyRelease(version) {
  const tag = `v${version}`;
  console.log(`\nПроверка релиза ${tag}:`);

  let rel;
  try {
    rel = JSON.parse(cap("gh", ["release", "view", tag,
      "--json", "isDraft,isPrerelease,assets,body"]));
  } catch {
    check(false, "gh release view — релиз не найден");
    return;
  }
  check(!rel.isDraft, "опубликован (не draft)");
  check(!rel.isPrerelease, "не prerelease (иначе выпадет из Latest → OTA сломан)");
  check(hasBilingualNotes(rel.body), "GitHub Release notes сохранили UTF-8 и оба языка");
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
  check(!!ghMetadata && hasBilingualNotes(ghMetadata.notes),
    "GitHub OTA notes сохранили UTF-8 и оба языка");
  check(!!glMetadata && hasBilingualNotes(glMetadata.notes),
    "GitLab OTA notes сохранили UTF-8 и оба языка");
  check(!!ghMetadata && !!glMetadata && ghMetadata.notes === glMetadata.notes,
    "GitHub/GitLab OTA используют одинаковые notes");
  check(!!ghMetadata && normalizedNotes(rel.body) === normalizedNotes(ghMetadata.notes),
    "GitHub Release body совпадает с OTA notes");
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
const supportedFlags = new Set(["--allow-branch", "--dry-run", "--verify", "--yes"]);
const unknownFlags = [...flags].filter((flag) => !supportedFlags.has(flag));

if (unknownFlags.length) die(`неизвестный флаг: ${unknownFlags.join(", ")}`);

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
// --allow-branch объявлен в supportedFlags и описан в RELEASING.md, но раньше
// нигде не читался: скрипт принимал флаг и всё равно падал на проверке ветки.
const allowBranch = flags.has("--allow-branch");
const branch = cap("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") {
  if (!allowBranch) die(`ветка ${branch}, ожидалась main (RELEASING.md; --allow-branch снимает проверку)`);
  console.log(`! релиз не из main: ветка ${branch} (--allow-branch)`);
}
run("git", ["fetch", "origin", branch]);
const head = cap("git", ["rev-parse", "HEAD"]);
const originHead = cap("git", ["rev-parse", `origin/${branch}`]);
if (head !== originHead) die(`локальный ${branch} должен точно совпадать с origin/${branch} перед релизом`);

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

// Релизные заметки должны быть двуязычными: OTA и GitHub Release читают одну
// и ту же аннотацию тега, поэтому забытый английский текст уже нельзя
// исправить после публикации без выпуска новой версии.
const missingLanguages = [
  !hasRussianNotes(notes) && "русский",
  !hasEnglishNotes(notes) && "английский",
].filter(Boolean);
if (missingLanguages.length) {
  die(`секция ${tag} должна содержать отдельные заметки на русском и английском; `
    + `отсутствует: ${missingLanguages.join(" и ")}.`);
}

const today = new Date().toISOString().slice(0, 10);
const needDate = !/—\s*\d{4}-\d{2}-\d{2}/.test(lines[headIdx]);

// --- план ---
console.log(`\nРелиз ${tag}`);
console.log(`  синхронизация версии приложения и сайта → ${version}`);
if (needDate) console.log(`  дата в заголовке CHANGELOG → ${today}`);
console.log(`  заметки (${notes.split("\n").length} стр. из CHANGELOG.md):`);
console.log(notes.split("\n").map((l) => "    " + l).join("\n"));
console.log(`\n  дальше: commit main · git tag -a ${tag} -F · `
  + `push origin ${branch} ${tag} · gh release create --draft`);
console.log("  затем CI собирает/подписывает/публикует сам; скрипт не следит за его статусом.");

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
run("git", ["add", "package.json", "package-lock.json",
  "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
  "site/app.js", "site/index.html", "CHANGELOG.md"]);
run("git", ["commit", "-m", tag]);

const dir = mkdtempSync(join(tmpdir(), "ninety-rel-"));
const notesFile = join(dir, "notes.md");
writeFileSync(notesFile, notes + "\n");           // те же байты, что в CHANGELOG

// Без verbatim Git считает Markdown-заголовки комментариями и выкидывает их
// из аннотации. Именно аннотация становится OTA notes на Windows-раннере.
run("git", ["tag", "-a", "--cleanup=verbatim", tag, "-F", notesFile]);
run("git", ["push", "origin", branch]);
run("git", ["push", "origin", tag]);
run("gh", ["release", "create", tag, "--draft", "--title", `Ninety ${tag}`,
  "-F", notesFile]);
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ ${tag} запушен, тег на месте, draft создан.`);
console.log("CI запущен; скрипт завершает работу без отслеживания результата.");
