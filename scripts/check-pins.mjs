#!/usr/bin/env node
// Ninety · сторож внешних пинов сборки.
//
// Всё, что не собирается из наших исходников, приезжает в инсталлятор по
// точному пину в .github/pins.json: ядро — тегом и коммитом, бинари — URL и
// sha256. Пин защищает
// от подмены, но ничего не говорит о том, что вышла новая версия: об этом
// узнавали случайно. Скрипт сверяет каждый пин с источником и в режиме --write
// подставляет новые значения, включая пересчитанный sha256 реально скачанного
// файла (переписать хеш «на глаз» нельзя — тогда пин перестаёт что-либо
// значить).
//
// Использование:
//   node scripts/check-pins.mjs            # отчёт, ничего не меняет
//   node scripts/check-pins.mjs --write    # обновить пины в .github/pins.json
//
// winws/WinDivert сюда не входят: их ведёт engine-watch.yml, который сверяет
// сами байты бинарей, а не версию.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { currentChannel, renderBuildInfo } from "./gen-build-info.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinsPath = join(root, ".github/pins.json");

const write = process.argv.includes("--write");
// Модуль импортируется тестом, который проверяет, что описания пинов всё ещё
// находят себя в build.yml: «сторож ослеп» — самая тихая из возможных поломок.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// GitHub отдаёт больше без токена, чем с ним, только когда токен битый:
// заголовок ставим лишь если он есть, чтобы скрипт работал и локально.
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

// Свежий релиз по дате публикации, а НЕ /releases/latest: XTLS помечает все
// свежие релизы pre-release, и «latest» у них показывает версию многомесячной
// давности — сторож по latest предлагал бы откатиться назад.
//
// Обратный случай — TrustTunnel: там стабильные релизы выходят как есть, а
// сверху копятся rc. Брать оттуда верхний подряд значит предлагать rc в
// инсталлятор, поэтому политика pre-release задаётся на каждый источник
// отдельно, а не угадывается.
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

// Каждый пин умеет: прочитать себя из build.yml, узнать актуальное значение и
// вернуть замену. Ошибка одного источника не должна прятать остальные, поэтому
// они выполняются независимо.
const pins = [
  {
    name: "ninety-core",
    // Форк сторожит апстрим сам (upstream-watch.yml в ninety-core); здесь
    // проверяется обратное — не отстал ли Ninety от тега форка.
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
      // У XTLS pre-release — обычный режим выпуска, стабильным висит старьё.
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
    // wintun.net — не GitHub и без API: версия живёт в имени файла на странице.
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


// sha256, который сейчас стоит рядом с этим URL: строка вида


export { pins, compareVersions, readPins };

if (!isMain) {
  // Импорт — только за описаниями пинов; сеть и запись остаются за запуском.
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
    // «О программе» показывает версии ядер и компонентов из этих же пинов.
    // Без пересборки паспорт бы отставал ровно на один бамп — и именно так он
    // и отставал, пока строка ядра правилась руками.
    refreshBuildInfo(data);
  }

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT,
      `outdated=${report.length ? "true" : "false"}\nsummary<<EOF\n${report.join("\n")}\nEOF\n`,
      { flag: "a" });
  }

  // Недоступный источник — это не «всё в порядке»: молчаливый зелёный ран здесь
  // означал бы, что сторож перестал сторожить.
  process.exitCode = failures ? 1 : 0;
}

// Паспорт сборки пересобираем прямо здесь: commit/date в дев-дереве остаются
// плейсхолдерами (их ставит CI перед сборкой), меняются только версии.
function refreshBuildInfo(pins) {
  const buildInfoPath = join(root, "src/lib/build-info.js");
  const configPath = join(root, "src-tauri/tauri.conf.json");
  let existing = "";
  try { existing = readFileSync(buildInfoPath, "utf8"); } catch { /* нет файла — соберём заново */ }
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
