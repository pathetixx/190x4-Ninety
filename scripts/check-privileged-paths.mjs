#!/usr/bin/env node
// System paths aren't taken from the process environment.
//
// %SystemRoot%, %ProgramFiles% and neighboring variables are written by HKCU\Environment —
// i.e. a regular user without administrator rights. From these paths we
// launch binaries under `runas`, rewrite the system hosts and decide
// whether to give the autostart task RunLevel=highest. A swapped variable in
// such a place turns into a silent privilege escalation.
//
// Safe sources: util::system_directory / windows_directory /
// system_hosts_path (GetSystemDirectoryW, GetWindowsDirectoryW) and
// util::program_files_roots (HKLM).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = "src-tauri/src";
const FORBIDDEN = /\benv::var(?:_os)?\s*\(\s*"(SystemRoot|windir|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)"/gi;

async function rustFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await rustFiles(path)));
    else if (entry.name.endsWith(".rs")) out.push(path);
  }
  return out.sort();
}

const files = await rustFiles(ROOT);
const violations = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(FORBIDDEN)) {
      violations.push(
        `${file}:${index + 1}: путь к системному каталогу взят из окружения (${match[1]}). ` +
        "Используйте util::system_directory / windows_directory / system_hosts_path / program_files_roots"
      );
    }
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(`Privileged path sources OK: ${files.length} Rust files checked`);
