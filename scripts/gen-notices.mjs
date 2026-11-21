#!/usr/bin/env node
// Ninety · component versions in the license texts.
//
// THIRD-PARTY-NOTICES.md and the installer license text name the exact versions
// of what's in the package — for the GPL core that's also the address of the build's sources.
// They were edited by hand and lagged several bumps behind: the pins are moved by bots
// (check-pins.mjs, engine-watch.yml), and the strategy set by the DPI channel sync.
// Now the versions are substituted from the same files the build reads:
// .github/pins.json, src-tauri/dpi/engine-version.txt, src-tauri/dpi/version.txt.
//
// Usage:
//   node scripts/gen-notices.mjs
// license.rtf is rebuilt from license.txt via make_license_rtf.py.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const NOTICES_PATH = "src-tauri/licenses/THIRD-PARTY-NOTICES.md";
export const LICENSE_TXT_PATH = "src-tauri/windows/license.txt";
const LICENSE_RTF_SCRIPT = "src-tauri/windows/make_license_rtf.py";

export function readSources(base = root) {
  const read = (path) => readFileSync(join(base, path), "utf8");
  return {
    pins: JSON.parse(read(".github/pins.json")),
    engine: read("src-tauri/dpi/engine-version.txt").trim(),
    strategies: read("src-tauri/dpi/version.txt").trim(),
  };
}

// Section heading → the contents of the Version cell in its table.
function versionCells({ pins, engine, strategies }) {
  const commit = (pin) => `\`${pin.tag}\` (commit \`${pin.sha}\`)`;
  return [
    ["## sing-box ", commit(pins["ninety-core"])],
    ["## Xray-core ", commit(pins["xray-core"])],
    ["## NaiveProxy ", `\`${pins.naive.version}\``],
    ["## TrustTunnel Client ", `\`${pins.trusttunnel_client.version}\``],
    ["## Wintun ", `\`${pins.wintun.version}\``],
    ["## zapret / winws ", `engine \`${engine}\`, strategy set \`${strategies}\``],
  ];
}

// Sections and lines are found by text: a missing section is an error, not a silent
// skip, otherwise the version would quietly freeze again.
export function renderNotices(text, sources) {
  // A Windows checkout may return CRLF: line endings are kept as they were.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  for (const [heading, cell] of versionCells(sources)) {
    const start = lines.findIndex((line) => line.startsWith(heading));
    if (start < 0) throw new Error(`${NOTICES_PATH}: нет раздела «${heading.trim()}»`);
    let row = -1;
    for (let i = start + 1; i < lines.length && !lines[i].startsWith("## "); i++) {
      if (lines[i].startsWith("| Version |")) {
        row = i;
        break;
      }
    }
    if (row < 0) throw new Error(`${NOTICES_PATH}: в разделе «${heading.trim()}» нет строки Version`);
    lines[row] = `| Version | ${cell} |`;
  }
  return lines.join(eol);
}

// The core tag stands in the English and Russian parts: "(tag …)" and "(тег …)".
export function renderLicenseTxt(text, { pins }) {
  const pattern = /(github\.com\/pathetixx\/ninety-core \((?:tag|тег) )[^)]+\)/g;
  const found = (text.match(pattern) || []).length;
  if (found < 2) {
    throw new Error(`${LICENSE_TXT_PATH}: ожидались теги ядра в обеих частях, найдено ${found}`);
  }
  return text.replace(pattern, `$1${pins["ninety-core"].tag})`);
}

function rebuildRtf(base) {
  const script = join(base, LICENSE_RTF_SCRIPT);
  for (const python of ["python3", "python"]) {
    try {
      execFileSync(python, [script], { stdio: "inherit" });
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`python не найден: запусти ${LICENSE_RTF_SCRIPT} вручную`);
}

// Returns the changed files (license.rtf goes together with license.txt).
export function writeNotices(base = root) {
  const sources = readSources(base);
  const changed = [];
  for (const [path, render] of [[NOTICES_PATH, renderNotices], [LICENSE_TXT_PATH, renderLicenseTxt]]) {
    const current = readFileSync(join(base, path), "utf8");
    const next = render(current, sources);
    if (next !== current) {
      writeFileSync(join(base, path), next);
      changed.push(path);
    }
  }
  if (changed.includes(LICENSE_TXT_PATH)) rebuildRtf(base);
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changed = writeNotices();
  console.log(changed.length ? `обновлено: ${changed.join(", ")}` : "версии в лицензионных текстах актуальны");
}
