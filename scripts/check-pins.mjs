#!/usr/bin/env node
// Ninety · сторож внешних пинов сборки.
//
// Всё, что не собирается из наших исходников, приезжает в инсталлятор по
// точному пину: ядро — тегом и коммитом, бинари — URL и sha256. Пин защищает
// от подмены, но ничего не говорит о том, что вышла новая версия: об этом
// узнавали случайно. Скрипт сверяет каждый пин с источником и в режиме --write
// подставляет новые значения, включая пересчитанный sha256 реально скачанного
// файла (переписать хеш «на глаз» нельзя — тогда пин перестаёт что-либо
// значить).
//
// Использование:
//   node scripts/check-pins.mjs            # отчёт, ничего не меняет
//   node scripts/check-pins.mjs --write    # обновить пины в build.yml
//
// winws/WinDivert сюда не входят: их ведёт engine-watch.yml, который сверяет
// сами байты бинарей, а не версию.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildYmlPath = join(root, ".github/workflows/build.yml");

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
    read: (yml) => yml.match(/^      CORE_TAG: (\S+)$/m)?.[1],
    async latest() {
      const tags = await gh("repos/pathetixx/ninety-core/tags?per_page=1");
      if (!tags.length) throw new Error("ninety-core: no tags");
      return { version: tags[0].name, sha: tags[0].commit.sha };
    },
    apply: (yml, latest) => yml
      .replace(/^      CORE_TAG: \S+$/m, `      CORE_TAG: ${latest.version}`)
      .replace(/^      CORE_SHA: \S+$/m, `      CORE_SHA: ${latest.sha}`),
  },
  {
    name: "Xray-core",
    read: (yml) => yml.match(/^      XRAY_TAG: (\S+)$/m)?.[1],
    async latest() {
      // У XTLS pre-release — обычный режим выпуска, стабильным висит старьё.
      const release = await newestRelease("XTLS/Xray-core", { allowPrerelease: true });
      const commit = await gh(`repos/XTLS/Xray-core/commits/${release.tag_name}`);
      return { version: release.tag_name, sha: commit.sha };
    },
    apply: (yml, latest) => yml
      .replace(/^      XRAY_TAG: \S+$/m, `      XRAY_TAG: ${latest.version}`)
      .replace(/^      XRAY_SHA: \S+$/m, `      XRAY_SHA: ${latest.sha}`),
  },
  {
    name: "naive",
    read: (yml) => yml.match(/naiveproxy\/releases\/download\/([^/]+)\//)?.[1],
    async latest() {
      const release = await newestRelease("klzgrad/naiveproxy");
      const url = assetUrl(release, /-win-x64\.zip$/);
      return { version: release.tag_name, url, ...(await sha256(url)) };
    },
    apply: (yml, latest, current) => yml
      .replace(currentUrlRe(yml, /https:\/\/github\.com\/klzgrad\/naiveproxy\/releases\/download\/\S+?\.zip/), latest.url)
      .replace(shaLineRe(yml, current.sha), latest.digest),
  },
  {
    name: "trusttunnel_client",
    read: (yml) => yml.match(/TrustTunnelClient\/releases\/download\/([^/]+)\//)?.[1],
    async latest() {
      const release = await newestRelease("TrustTunnel/TrustTunnelClient");
      const url = assetUrl(release, /-windows-x86_64\.zip$/);
      return { version: release.tag_name, url, ...(await sha256(url)) };
    },
    apply: (yml, latest, current) => yml
      .replace(currentUrlRe(yml, /https:\/\/github\.com\/TrustTunnel\/TrustTunnelClient\/releases\/download\/\S+?\.zip/), latest.url)
      .replace(shaLineRe(yml, current.sha), latest.digest),
  },
  {
    name: "wintun",
    // wintun.net — не GitHub и без API: версия живёт в имени файла на странице.
    read: (yml) => yml.match(/wintun-([0-9.]+)\.zip/)?.[1],
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
    apply: (yml, latest, current) => yml
      .replace(/https:\/\/www\.wintun\.net\/builds\/wintun-[0-9.]+\.zip/, latest.url)
      .replace(shaLineRe(yml, current.sha), latest.digest),
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

// sha256 бинаря живёт отдельной строкой рядом с URL; меняем именно его, а не
// первый попавшийся 64-символьный хеш в файле.
function shaLineRe(yml, current) {
  if (!current) throw new Error("current sha256 not found in build.yml");
  return new RegExp(current, "g");
}

function currentUrlRe(yml, pattern) {
  const match = yml.match(pattern);
  if (!match) throw new Error(`current url not found for ${pattern}`);
  return match[0];
}

// sha256, который сейчас стоит рядом с этим URL: строка вида
// "<sha>" ` идёт следующей за строкой с URL.
function currentSha(yml, urlPattern) {
  const lines = yml.split("\n");
  const index = lines.findIndex((line) => urlPattern.test(line));
  if (index < 0) return null;
  for (let i = index; i < Math.min(index + 4, lines.length); i++) {
    const sha = lines[i].match(/\b([0-9a-f]{64})\b/);
    if (sha && i !== index) return sha[1];
    if (i === index) {
      const inline = lines[i].match(/\b([0-9a-f]{64})\b/);
      if (inline) return inline[1];
    }
  }
  return null;
}

const shaSources = {
  naive: /klzgrad\/naiveproxy\/releases\/download\//,
  trusttunnel_client: /TrustTunnelClient\/releases\/download\//,
  wintun: /wintun\.net\/builds\/wintun-/,
};

export { pins, currentSha, shaSources, compareVersions };

if (!isMain) {
  // Импорт — только за описаниями пинов; сеть и запись остаются за запуском.
} else {
  await main();
}

async function main() {
const yml = readFileSync(buildYmlPath, "utf8");
let updated = yml;
const report = [];
let failures = 0;

for (const pin of pins) {
  const current = { version: pin.read(yml), sha: null };
  const source = shaSources[pin.name];
  if (source) current.sha = currentSha(yml, source);
  if (!current.version) {
    console.error(`✗ ${pin.name}: пин не найден в build.yml — сторож ослеп, проверьте формат`);
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
  if (latest.version === current.version) {
    console.log(`✓ ${pin.name}: ${current.version}`);
    continue;
  }
  console.log(`→ ${pin.name}: ${current.version} → ${latest.version}`);
  report.push(`- \`${pin.name}\`: \`${current.version}\` → \`${latest.version}\``);
  if (write) updated = pin.apply(updated, latest, current);
}

if (write && updated !== yml) {
  writeFileSync(buildYmlPath, updated);
  console.log("build.yml обновлён");
}

if (process.env.GITHUB_OUTPUT) {
  const outdated = report.length ? "true" : "false";
  writeFileSync(process.env.GITHUB_OUTPUT,
    `outdated=${outdated}\nsummary<<EOF\n${report.join("\n")}\nEOF\n`, { flag: "a" });
}

// Недоступный источник — это не «всё в порядке»: молчаливый зелёный ран здесь
// означал бы, что сторож перестал сторожить.
process.exitCode = failures ? 1 : 0;
}
