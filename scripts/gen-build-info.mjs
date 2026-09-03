// Ninety · генератор паспорта сборки (src/lib/build-info.js).
//
// Экран «О программе» показывает версии того, что приложение реально возит.
// Раньше версия/коммит/дата запекались inline-PowerShell из build.yml, а строка
// ядра правилась руками — и отставала: пины ядер живут в .github/pins.json и
// обновляются ботом (scripts/check-pins.mjs), про build-info.js он не знает.
// Теперь один источник: pins.json + tauri.conf.json.
//
// Использование:
//   node scripts/gen-build-info.mjs [--commit <sha>] [--date <DD.MM.YYYY>]
// Без аргументов берёт коммит из git, дату — сегодняшнюю UTC.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PINS_PATH = ".github/pins.json";
const CONFIG_PATH = "src-tauri/tauri.conf.json";
const TARGET_PATH = "src/lib/build-info.js";

// Тег пина → версия для показа: ведущая "v" пользователю ничего не сообщает.
export function pinVersion(tag) {
  return String(tag || "").replace(/^v/, "");
}

// Ядра называем так же, как их зовут в мире: "sing-box 1.13.19-ninety.8" —
// это ревизия НАШЕГО форка, и она обязана быть видна целиком, иначе паспорт
// врёт о том, что собрано.
export function coreLabels(pins) {
  return {
    core: `sing-box ${pinVersion(pins?.["ninety-core"]?.tag)}`,
    coreXray: `Xray ${pinVersion(pins?.["xray-core"]?.tag)}`,
  };
}

// Компоненты, которые едут рядом с ядрами: sidecar-клиенты и драйвер TUN.
// Движок DPI сюда не попадает — его версию отдаёт сам winws в рантайме
// (dpi_versions), и запекать её было бы вторым источником правды.
export function componentVersions(pins) {
  return {
    naive: pinVersion(pins?.naive?.version),
    trusttunnel: pinVersion(pins?.trusttunnel_client?.version),
    wintun: pinVersion(pins?.wintun?.version),
  };
}

// Канал зрелости — единственное поле, которое ставится руками: релизная
// матрица (docs/RELEASE_QUALIFICATION.md) меняет его на «Stable» после
// прохождения квалификации. Генератор обязан его сохранять, иначе следующая же
// сборка молча вернула бы «Early access».
export function currentChannel(existing, fallback = "Early access") {
  const match = /channel:\s*"([^"]*)"/.exec(String(existing || ""));
  return match ? match[1] : fallback;
}

export function renderBuildInfo({ version, commit, date, pins, channel = "Early access" }) {
  const { core, coreXray } = coreLabels(pins);
  const components = componentVersions(pins);
  const q = (value) => JSON.stringify(String(value ?? ""));
  return `// Ninety · паспорт сборки. Файл СГЕНЕРИРОВАН: scripts/gen-build-info.mjs
// собирает его из .github/pins.json (версии ядер и компонентов) и
// src-tauri/tauri.conf.json (версия приложения), а CI зовёт скрипт перед
// \`tauri build\`. Руками не править — правка уедет со следующей сборкой.
// В дев-дереве значения commit/date остаются плейсхолдерами: версия всё равно
// берётся из рантайма (__TAURI__.app.getVersion), а паспорт не врёт цифрами.
// Единственное поле для ручной правки — channel: генератор переносит его из
// предыдущей версии файла.
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
  try { existing = readFileSync(TARGET_PATH, "utf8"); } catch { /* первый запуск */ }
  const channel = currentChannel(existing);
  const rendered = renderBuildInfo({ version, commit, date, pins, channel });
  writeFileSync(TARGET_PATH, rendered);
  const { core, coreXray } = coreLabels(pins);
  console.log(
    `build-info: version=${version} commit=${commit} date=${date} `
    + `core=${core} xray=${coreXray} channel=${channel}`,
  );
}

// Импорт из тестов не должен ничего перезаписывать.
if (process.argv[1] && process.argv[1].endsWith("gen-build-info.mjs")) main();
