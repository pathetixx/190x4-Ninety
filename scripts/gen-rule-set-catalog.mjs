#!/usr/bin/env node
// Ninety · каталог готовых списков для правил маршрутизации.
//
// Правило «Готовый список» ссылается на файл из SagerNet/sing-geosite или
// SagerNet/sing-geoip (ветка rule-set). Имя, которого там нет, ядро скачать не
// сможет, поэтому в правило попадают только имена из этого каталога. Его
// снимок лежит в src/lib/rule-set-catalog.js; категории меняются редко, и
// перегенерировать его достаточно перед релизом.
//
// Использование:
//   node scripts/gen-rule-set-catalog.mjs
// GH_TOKEN/GITHUB_TOKEN необязателен, но снимает лимит анонимных запросов.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "src/lib/rule-set-catalog.js";

const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "ninety-rule-set-catalog",
  ...(process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}` }
    : {}),
};

async function listSets(repo, prefix) {
  const response = await fetch(`https://api.github.com/repos/SagerNet/${repo}/git/trees/rule-set`, { headers });
  if (!response.ok) throw new Error(`${repo}: HTTP ${response.status}`);
  const tree = await response.json();
  if (tree.truncated) throw new Error(`${repo}: дерево обрезано, каталог был бы неполным`);
  const names = tree.tree
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(prefix) && path.endsWith(".srs"))
    .map((path) => path.slice(prefix.length, -".srs".length))
    .sort();
  if (!names.length) throw new Error(`${repo}: ни одного списка`);
  return names;
}

const geosite = await listSets("sing-geosite", "geosite-");
const geoip = await listSets("sing-geoip", "geoip-");

const wrap = (names) => {
  const lines = [];
  let line = "";
  for (const name of names) {
    const item = `${JSON.stringify(name)},`;
    if (line && line.length + item.length + 1 > 78) {
      lines.push(line);
      line = "";
    }
    line += (line ? " " : "") + item;
  }
  if (line) lines.push(line);
  return lines.map((l) => `  ${l}`).join("\n");
};

const body = `// Сгенерировано scripts/gen-rule-set-catalog.mjs — руками не править.
// Списки SagerNet/sing-geosite и SagerNet/sing-geoip (ветка rule-set).

export const GEOSITE_NAMES = [
${wrap(geosite)}
];

export const GEOIP_CODES = [
${wrap(geoip)}
];
`;

writeFileSync(join(root, OUT), body);
console.log(`${OUT}: geosite ${geosite.length}, geoip ${geoip.length}`);
