// Все HTTP-клиенты бэкенда строятся через util::direct_client_builder().
//
// Голый reqwest::Client::builder() на Windows читает системный прокси: Cargo
// объединяет фичи графа, и чтение ProxyServer из реестра включают зависимости
// tauri. Исключения `127.*` и `<local>` для IP-адресов при этом не работают,
// поэтому запрос к clash-API на 127.0.0.1 уходил в чужой или мёртвый прокси, а
// «прямые» замеры в режиме системного прокси шли через туннель. Тест ловит
// такой клиент до того, как он попадёт в сборку.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUST_DIR = "src-tauri/src";
const HELPER_FILE = "util.rs";
const FORBIDDEN = [
  /reqwest::Client::builder\s*\(/,
  /reqwest::Client::new\s*\(/,
  /reqwest::ClientBuilder::new\s*\(/,
  /\bClientBuilder::new\s*\(/,
  /reqwest::get\s*\(/,
];

function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...rustFiles(path));
    else if (entry.name.endsWith(".rs")) out.push(path);
  }
  return out;
}

test("HTTP-клиенты бэкенда не читают системный прокси", () => {
  const offenders = [];
  for (const file of rustFiles(RUST_DIR)) {
    if (file.endsWith(join(RUST_DIR, HELPER_FILE))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (line.trim().startsWith("//")) return;
      if (FORBIDDEN.some((pattern) => pattern.test(line))) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "используйте crate::util::direct_client_builder()");
});

test("общий билдер явно отключает системный прокси", () => {
  const source = readFileSync(join(RUST_DIR, HELPER_FILE), "utf8");
  const start = source.indexOf("fn direct_client_builder");
  assert.notEqual(start, -1, "нет util::direct_client_builder");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /\.no_proxy\(\)/);
});
