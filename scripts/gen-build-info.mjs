// Ninety · the build passport generator (src/lib/build-info.js).
//
// The "About" screen shows the versions of what the app actually ships.
// Previously the version/commit/date were baked in by inline PowerShell from build.yml, and the core
// line was edited by hand — and lagged behind: the core pins live in .github/pins.json and
// are updated by a bot (scripts/check-pins.mjs), which knows nothing about build-info.js.
// Now there's one source: pins.json + tauri.conf.json.
//
// Usage:
//   node scripts/gen-build-info.mjs [--commit <sha>] [--date <DD.MM.YYYY>]
// Without arguments it takes the commit from git and today's UTC date.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PINS_PATH = ".github/pins.json";
const CONFIG_PATH = "src-tauri/tauri.conf.json";
const TARGET_PATH = "src/lib/build-info.js";

// Pin tag → the version for display: a leading "v" tells the user nothing.
export function pinVersion(tag) {
  return String(tag || "").replace(/^v/, "");
}

// Cores are named the way the world calls them: "sing-box 1.13.19-ninety.8" —
// this is the revision of OUR fork, and it must be visible in full, otherwise the passport
// lies about what was built.
export function coreLabels(pins) {
  return {
    core: `sing-box ${pinVersion(pins?.["ninety-core"]?.tag)}`,
    coreXray: `Xray ${pinVersion(pins?.["xray-core"]?.tag)}`,
  };
}

// Components that ship next to the cores: sidecar clients and the TUN driver.
// The DPI engine isn't included — its version is reported by winws itself at runtime
// (dpi_versions), and baking it in would be a second source of truth.
export function componentVersions(pins) {
  return {
    naive: pinVersion(pins?.naive?.version),
    trusttunnel: pinVersion(pins?.trusttunnel_client?.version),
    wintun: pinVersion(pins?.wintun?.version),
  };
}

// The maturity channel is the only field set by hand: the release
// matrix (docs/RELEASE_QUALIFICATION.md) changes it to "Stable" after
// qualification passes. The generator must preserve it, otherwise the very next
// build would silently bring back "Early access".
export function currentChannel(existing, fallback = "Early access") {
  const match = /channel:\s*"([^"]*)"/.exec(String(existing || ""));
  return match ? match[1] : fallback;
}

export function renderBuildInfo({ version, commit, date, pins, channel = "Early access" }) {
  const { core, coreXray } = coreLabels(pins);
  const components = componentVersions(pins);
  const q = (value) => JSON.stringify(String(value ?? ""));
  return `// Ninety · build passport. This file is GENERATED: scripts/gen-build-info.mjs
// builds it from .github/pins.json (core and component versions) and
// src-tauri/tauri.conf.json (app version), and CI calls the script before
// \`tauri build\`. Don't edit by hand — the edit will be lost with the next build.
// In the dev tree the commit/date values stay placeholders: the version is taken
// from the runtime anyway (__TAURI__.app.getVersion), and the passport doesn't lie with numbers.
// The only field for manual editing is channel: the generator carries it over from
// the previous version of the file.
export const BUILD_INFO = {
  version: ${q(version)},
  commit: ${q(commit)},
  date: ${q(date)},
  core: ${q(core)},
  coreXray: ${q(coreXray)},
  channel: ${q(channel)},
  platform: "Windows · x64",
  components: {
    naive: ${q(components.naive)},
    trusttunnel: ${q(components.trusttunnel)},
    wintun: ${q(components.wintun)},
  },
};
`;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return fallback();
  return process.argv[index + 1];
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "local";
  }
}

function todayUtc() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(now.getUTCDate())}.${pad(now.getUTCMonth() + 1)}.${now.getUTCFullYear()}`;
}

function main() {
  const pins = JSON.parse(readFileSync(PINS_PATH, "utf8"));
  const version = JSON.parse(readFileSync(CONFIG_PATH, "utf8")).version;
  const commit = arg("commit", gitCommit);
  const date = arg("date", todayUtc);
  let existing = "";
  try { existing = readFileSync(TARGET_PATH, "utf8"); } catch { /* first launch */ }
  const channel = currentChannel(existing);
  const rendered = renderBuildInfo({ version, commit, date, pins, channel });
  writeFileSync(TARGET_PATH, rendered);
  const { core, coreXray } = coreLabels(pins);
  console.log(
    `build-info: version=${version} commit=${commit} date=${date} `
    + `core=${core} xray=${coreXray} channel=${channel}`,
  );
}

// Importing from tests must not overwrite anything.
if (process.argv[1] && process.argv[1].endsWith("gen-build-info.mjs")) main();
