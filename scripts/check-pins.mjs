#!/usr/bin/env node
// Ninety · the watcher of external build pins.
//
// Everything not built from our sources gets into the installer by
// an exact pin in .github/pins.json: the core by tag and commit, binaries by URL and
// sha256. A pin protects
// against substitution, but says nothing about a new version being released: that was
// learned by chance. The script checks each pin against its source and in --write mode
// substitutes the new values, including the recomputed sha256 of the actually downloaded
// file (rewriting a hash "by eye" isn't possible — then the pin stops meaning
// anything).
//
// Usage:
//   node scripts/check-pins.mjs            # report, changes nothing
//   node scripts/check-pins.mjs --write    # update the pins in .github/pins.json
//
// winws/WinDivert aren't included here: they're handled by engine-watch.yml, which compares
// the binaries' bytes themselves, not the version.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { currentChannel, renderBuildInfo } from "./gen-build-info.mjs";
import { writeNotices } from "./gen-notices.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinsPath = join(root, ".github/pins.json");

const write = process.argv.includes("--write");
// The module is imported by a test that checks that the pin descriptions still
// find themselves in build.yml: "the watcher went blind" is the quietest possible breakage.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// GitHub returns more without a token than with one only when the token is broken:
// we set the header only if it exists, so the script works locally too.
const ghHeaders = {
  accept: "application/vnd.github+json",
  ...(process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}` }
    : {}),
};

async function gh(path) {
  const response = await fetch(`https://api.github.com/${path}`, { headers: ghHeaders });
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response.json();
}

// The newest release by publication date, NOT /releases/latest: XTLS marks all
// fresh releases as pre-release, and their "latest" shows a version many months
// old — a watcher based on latest would suggest rolling back.
//
// The opposite case is TrustTunnel: there stable releases come out as is, and
// rc's pile up on top. Taking the topmost one means suggesting an rc for
// the installer, so the pre-release policy is set per source
// rather than guessed.
async function newestRelease(repo, { allowPrerelease = false } = {}) {
  const releases = await gh(`repos/${repo}/releases?per_page=30`);
  const usable = releases
    .filter((release) => !release.draft && (allowPrerelease || !release.prerelease))
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  if (!usable.length) throw new Error(`${repo}: no usable releases`);
  return usable[0];
}

async function sha256(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  return { digest: createHash("sha256").update(body).digest("hex"), bytes: body.length };
}

function assetUrl(release, pattern) {
  const asset = (release.assets || []).find((item) => pattern.test(item.name));
  if (!asset) throw new Error(`${release.tag_name}: no asset matching ${pattern}`);
  return asset.browser_download_url;
}

// Each pin can: read itself from build.yml, find out the current value and
// return a replacement. An error from one source must not hide the others, so
// they run independently.
const pins = [
  {
    name: "ninety-core",
    // The fork watches upstream itself (upstream-watch.yml in ninety-core); here
    // the opposite is checked — whether Ninety has fallen behind the fork's tag.
    read: (data) => data["ninety-core"].tag,
    async latest() {
      const tags = await gh("repos/pathetixx/ninety-core/tags?per_page=1");
      if (!tags.length) throw new Error("ninety-core: no tags");
      return { version: tags[0].name, sha: tags[0].commit.sha };
    },
    apply: (data, latest) => {
      data["ninety-core"] = { tag: latest.version, sha: latest.sha };
    },
  },
  {
    name: "xray-core",
    read: (data) => data["xray-core"].tag,
    async latest() {
      // For XTLS pre-release is the regular release mode, the stable one is ancient.
      const release = await newestRelease("XTLS/Xray-core", { allowPrerelease: true });
      const commit = await gh(`repos/XTLS/Xray-core/commits/${release.tag_name}`);
      return { version: release.tag_name, sha: commit.sha };
    },
    apply: (data, latest) => {
      data["xray-core"] = { tag: latest.version, sha: latest.sha };
    },
  },
  {
    name: "naive",
    read: (data) => data.naive.version,
    async latest() {
      const release = await newestRelease("klzgrad/naiveproxy");
      const url = assetUrl(release, /-win-x64\.zip$/);
      return { version: release.tag_name, url, ...(await sha256(url)) };
    },
    apply: (data, latest) => {
      data.naive = { version: latest.version, url: latest.url, sha256: latest.digest };
    },
  },
  {
    name: "trusttunnel_client",
    read: (data) => data.trusttunnel_client.version,
    async latest() {
      const release = await newestRelease("TrustTunnel/TrustTunnelClient");
      const url = assetUrl(release, /-windows-x86_64\.zip$/);
      return { version: release.tag_name, url, ...(await sha256(url)) };
    },
    apply: (data, latest) => {
      data.trusttunnel_client = { version: latest.version, url: latest.url, sha256: latest.digest };
    },
  },
  {
    name: "wintun",
    // wintun.net isn't GitHub and has no API: the version lives in the file name on the page.
    read: (data) => data.wintun.version,
    async latest() {
      const response = await fetch("https://www.wintun.net/");
      if (!response.ok) throw new Error(`wintun.net: HTTP ${response.status}`);
      const page = await response.text();
      const versions = [...page.matchAll(/wintun-([0-9]+(?:\.[0-9]+)+)\.zip/g)].map((m) => m[1]);
      if (!versions.length) throw new Error("wintun.net: no wintun-X.Y.Z.zip link");
      const version = versions.sort(compareVersions).at(-1);
      const url = `https://www.wintun.net/builds/wintun-${version}.zip`;
      return { version, url, ...(await sha256(url)) };
    },
    apply: (data, latest) => {
      data.wintun = { version: latest.version, url: latest.url, sha256: latest.digest };
    },
  },
];

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}


// The sha256 currently next to this URL: a line like


export { pins, compareVersions, readPins };

if (!isMain) {
  // Importing is only for the pin descriptions; network and writing are left to the run.
} else {
  await main();
}

async function main() {
  const raw = readFileSync(pinsPath, "utf8");
  const data = JSON.parse(raw);
  const report = [];
  let failures = 0;
  let changed = false;

  for (const pin of pins) {
    let current;
    try {
      current = pin.read(data);
    } catch {
      current = undefined;
    }
    if (!current) {
      console.error(`✗ ${pin.name}: пин не найден в pins.json — сторож ослеп`);
      failures++;
      continue;
    }
    let latest;
    try {
      latest = await pin.latest();
    } catch (error) {
      console.error(`✗ ${pin.name}: ${error.message}`);
      failures++;
      continue;
    }
    if (latest.version === current) {
      console.log(`✓ ${pin.name}: ${current}`);
      continue;
    }
    console.log(`→ ${pin.name}: ${current} → ${latest.version}`);
    report.push(`- \`${pin.name}\`: \`${current}\` → \`${latest.version}\``);
    if (write) {
      pin.apply(data, latest);
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(pinsPath, `${JSON.stringify(data, null, 2)}\n`);
    console.log("pins.json обновлён");
    // "About" shows core and component versions from these same pins.
    // Without a rebuild the passport would lag exactly one bump behind — and that's exactly how it
    // lagged while the core line was edited by hand.
    refreshBuildInfo(data);
    // License texts name the same versions, and for the core also the tag by
    // which to look up the build's sources.
    const notices = writeNotices(root);
    if (notices.length) console.log(`лицензионные тексты обновлены: ${notices.join(", ")}`);
  }

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT,
      `outdated=${report.length ? "true" : "false"}\nsummary<<EOF\n${report.join("\n")}\nEOF\n`,
      { flag: "a" });
  }

  // An unavailable source isn't "all good": a silent green run here
  // would mean the watcher stopped watching.
  process.exitCode = failures ? 1 : 0;
}

// The build passport is rebuilt right here: commit/date in the dev tree stay
// placeholders (CI sets them before the build), only the versions change.
function refreshBuildInfo(pins) {
  const buildInfoPath = join(root, "src/lib/build-info.js");
  const configPath = join(root, "src-tauri/tauri.conf.json");
  let existing = "";
  try { existing = readFileSync(buildInfoPath, "utf8"); } catch { /* no file — rebuild it */ }
  const version = JSON.parse(readFileSync(configPath, "utf8")).version;
  const commit = existing.match(/commit: "([^"]*)"/)?.[1] ?? "local";
  const date = existing.match(/date: "([^"]*)"/)?.[1] ?? "—";
  writeFileSync(buildInfoPath, renderBuildInfo({
    version,
    commit,
    date,
    pins,
    channel: currentChannel(existing),
  }));
  console.log("build-info.js пересобран под новые пины");
}

function readPins() {
  return JSON.parse(readFileSync(pinsPath, "utf8"));
}
