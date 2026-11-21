#!/usr/bin/env node
// Ninety · a release in one command, from the bump to OTA distribution. Wraps the whole
// ritual (RELEASING.md) so that the two manual variables — the version number and
// the notes — are authored once each and can't drift apart:
//   version → bump-version.mjs (app manifests + website fallback);
//   notes → this version's CHANGELOG.md section → git tag -a -F → the draft body.
// CHANGELOG.md is the single source of notes: the same bytes go into the tag annotation
// (→ latest.json/OTA) and into the release body.
//
// Compilation happens in CI (we don't build locally): pushing the tag starts the build/signing/
// publishing/mirrors. After starting CI the script exits immediately and doesn't watch
// the run. Checking an already finished release remains a separate --verify mode.
//
// Usage:
//   node scripts/release.mjs X.Y.Z [--dry-run] [--yes]
//   node scripts/release.mjs X.Y.Z --verify        # only check an already published release
// Before running: add a "## vX.Y.Z — YYYY-MM-DD" section at the TOP of CHANGELOG.md.

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

// Drive fn() to true with retries — OTA endpoints/CDN may take a couple of seconds to catch up.
async function retry(fn, tries = 8, delayMs = 5000) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true; } catch { /* transient */ }
    if (i < tries - 1) await sleep(delayMs);
  }
  return false;
}

// Checking that the release has actually landed and is being served. Used by the --verify mode.
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
  check(names.some((n) => /_windows-x64-portable\.zip\.sig$/.test(n)), "подпись Portable ZIP (.zip.sig)");
  check(names.includes("latest.json"), "ассет latest.json");

  // GitHub /releases/latest/ serves our version ⇒ the release became Latest, and the signature is in place.
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

  // GitLab is the primary OTA source. CI checks the installer + versioned metadata,
  // switches stable/latest.json and only after that publishes the GitHub draft.
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
  const ghPortable = ghMetadata?.platforms?.["windows-x86_64-portable"];
  const glPortable = glMetadata?.platforms?.["windows-x86_64-portable"];
  check(!!ghPortable?.signature && ghPortable.signature === glPortable?.signature
    && !!glPortable?.url?.includes(`/packages/generic/ninety/${version}/`),
  "Portable OTA: GitHub и GitLab отдают ZIP с одной подписью");
}

// --- arguments ---
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

// --- verify-only mode ---
if (flags.has("--verify")) {
  await verifyRelease(version);
  console.log(failed ? `\n✗ проверка: ${failed} провал(ов)` : "\n✓ всё встало");
  process.exit(failed ? 1 : 0);
}

// --- prechecks (read-only) ---
// --allow-branch was declared in supportedFlags and described in RELEASING.md, but used to
// be read nowhere: the script accepted the flag and still failed on the branch check.
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

// The script itself commits only the release files. Any other dirt (especially already
// staged) could silently get into the release commit via a shared git commit.
const dirty = cap("git", ["status", "--porcelain=v1"])
  .split("\n")
  .filter(Boolean);
// cap() trims output, so for a single line the first porcelain space
// may disappear (" M CHANGELOG.md" → "M CHANGELOG.md").
const releaseNotesOnly = /^(?:[ MARC?][ MDARC?]|[MARC?]) CHANGELOG\.md$/;
const unexpectedDirty = dirty.filter((line) => !releaseNotesOnly.test(line));
if (unexpectedDirty.length) {
  die(`перед релизом разрешено менять только CHANGELOG.md:\n${unexpectedDirty.join("\n")}`);
}

if (cap("git", ["tag", "-l", tag])) die(`тег ${tag} уже существует локально`);
try {
  if (cap("git", ["ls-remote", "--tags", "origin", tag]))
    die(`тег ${tag} уже существует на origin`);
} catch { /* an ls-remote network failure isn't fatal */ }

// --- notes from CHANGELOG.md (the single source) ---
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

// Release notes must be bilingual: OTA and the GitHub Release read the same
// tag annotation, so forgotten English text can no longer be
// fixed after publication without releasing a new version.
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

// --- plan ---
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

// --- execution (writes + network) ---
if (needDate) {
  lines[headIdx] = `## ${tag} — ${today}`;
  writeFileSync(clPath, lines.join("\n"));
}

run("node", ["scripts/bump-version.mjs", version]);
run("node", ["scripts/check-version.mjs"]);
// The list must cover EVERYTHING bump-version.mjs touches: a file forgotten
// here stays modified in the working tree, and the old version goes into the tag.
// The equality of the two lists is checked by tests/release-flags.test.mjs.
run("git", ["add", "package.json", "package-lock.json",
  "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock",
  "src/lib/build-info.js", "site/app.js", "site/index.html", "site/ru/index.html", "CHANGELOG.md"]);
// Running again after a red build is a regular case: the version was already bumped
// by the previous run, and there's nothing to commit. An empty `git commit` would break the ritual
// exactly where it's supposed to carry the release through to the tag.
if (cap("git", ["diff", "--cached", "--name-only"])) {
  run("git", ["commit", "-m", tag]);
} else {
  console.log("  версия уже закоммичена — коммит пропущен");
}

const dir = mkdtempSync(join(tmpdir(), "ninety-rel-"));
const notesFile = join(dir, "notes.md");
writeFileSync(notesFile, notes + "\n");           // the same bytes as in CHANGELOG

// Without verbatim Git treats Markdown headings as comments and throws them
// out of the annotation. It's exactly the annotation that becomes the OTA notes on the Windows runner.
run("git", ["tag", "-a", "--cleanup=verbatim", tag, "-F", notesFile]);
run("git", ["push", "origin", branch]);
run("git", ["push", "origin", tag]);
run("gh", ["release", "create", tag, "--draft", "--title", `Ninety ${tag}`,
  "-F", notesFile]);
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ ${tag} запушен, тег на месте, draft создан.`);
console.log("CI запущен; скрипт завершает работу без отслеживания результата.");
