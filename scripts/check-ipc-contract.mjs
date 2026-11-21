#!/usr/bin/env node
// The Rust ↔ frontend IPC contract: generate_handler! has no commands nobody
// calls, and the frontend doesn't call what isn't there.
//
// Every entry in generate_handler! is a handle available to any code inside
// the WebView, and the compiler keeps its function alive. Screens move to aggregates
// (health_snapshot, read_log_chunk), while the old commands stay: by v0.6.0
// thirteen of them had piled up. The flip side is calling a nonexistent command: it
// fails only at runtime, with a "command not found" toast.
//
// Command names are searched among ALL frontend string literals, not only inside
// invoke(...): some calls assemble the name in a variable (clash-api, autostart,
// link-handlers), and the literal still lies nearby in the code.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const HANDLER_FILE = "src-tauri/src/lib.rs";
const FRONTEND_ROOT = "src";

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "vendor" || entry.name === "assets") continue;
      out.push(...(await jsFiles(path)));
    } else if (entry.name.endsWith(".js")) {
      out.push(path);
    }
  }
  return out.sort();
}

const handlerSource = await readFile(HANDLER_FILE, "utf8");
const handlerBlock = handlerSource.match(/generate_handler!\[([\s\S]*?)\]\s*\)/);
if (!handlerBlock) {
  console.error(`${HANDLER_FILE}: не найден generate_handler![...]`);
  process.exit(1);
}
const registered = new Map(); // command → path, as written in lib.rs
for (const raw of handlerBlock[1].split(",")) {
  const path = raw.replace(/\/\/.*$/gm, "").trim();
  if (!path) continue;
  registered.set(path.split("::").pop(), path);
}

const literals = new Set();
const invoked = new Map(); // command → the first call site
for (const file of await jsFiles(FRONTEND_ROOT)) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/["'`]([A-Za-z_][A-Za-z0-9_:]*)["'`]/g)) {
    literals.add(match[1]);
  }
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(/invoke\w*\(\s*["']([A-Za-z_][A-Za-z0-9_:]*)["']/g)) {
      const name = match[1];
      if (name.startsWith("plugin:")) continue;
      if (!invoked.has(name)) invoked.set(name, `${file}:${index + 1}`);
    }
  }
}

const violations = [];
for (const [name, path] of registered) {
  if (!literals.has(name)) {
    violations.push(
      `${HANDLER_FILE}: команда ${path} зарегистрирована, но фронт её не зовёт. ` +
      "Удалите её вместе с функцией или начните использовать"
    );
  }
}
for (const [name, where] of invoked) {
  if (!registered.has(name)) {
    violations.push(
      `${where}: invoke("${name}") — такой команды нет в generate_handler!`
    );
  }
}

if (violations.length) {
  console.error("IPC-контракт разошёлся:\n");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`IPC-контракт цел: ${registered.size} команд, все вызываются фронтом.`);
