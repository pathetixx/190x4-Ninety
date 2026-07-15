#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const configPath = resolve(root, "src-tauri/tauri.conf.json");
const configDir = dirname(configPath);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const bundle = config.bundle ?? {};
const windows = bundle.windows ?? {};
const nsis = windows.nsis ?? {};

function fail(message) {
  console.error(`installer check: ${message}`);
  process.exitCode = 1;
}

function configFile(label, value) {
  if (typeof value !== "string" || !value) {
    fail(`${label} не задан`);
    return null;
  }
  const path = resolve(configDir, value);
  if (!existsSync(path)) fail(`${label}: файл не найден (${value})`);
  return path;
}

function checkBmp(path, width, height) {
  if (!existsSync(path)) {
    fail(`BMP не найден (${path})`);
    return;
  }
  const bmp = readFileSync(path);
  if (
    bmp.length < 54 ||
    bmp.subarray(0, 2).toString("ascii") !== "BM" ||
    bmp.readInt32LE(18) !== width ||
    Math.abs(bmp.readInt32LE(22)) !== height ||
    bmp.readUInt16LE(28) !== 24
  ) {
    fail(`BMP ${path} должен быть ${width}x${height}, 24-bit`);
  }
}

if (!Array.isArray(bundle.targets) || !bundle.targets.includes("nsis")) {
  fail("NSIS отсутствует в bundle.targets");
}
if (windows.allowDowngrades !== false) {
  fail("bundle.windows.allowDowngrades должен быть false");
}
if (nsis.installMode !== "both") {
  fail("NSIS installMode должен сохранять поддержку per-user и per-machine");
}
if (nsis.displayLanguageSelector !== false) {
  fail("кастомный Kurogane UI не должен открывать системный выбор языка перед окном");
}

configFile("licenseFile", bundle.licenseFile);
configFile("installerIcon", nsis.installerIcon);
configFile("uninstallerIcon", nsis.uninstallerIcon);
const templatePath = configFile("template", nsis.template);
const entryPath = configFile("installerHooks", nsis.installerHooks);
const hooksPath = resolve(configDir, "./windows/hooks.nsh");
const kuroganeDir = resolve(configDir, "./windows/kurogane");

for (const name of [
  "kurogane-ui.nsh",
  "kurogane-ui.rc",
  "kurogane-ui.exe",
  "left-panel.bmp",
  "title-brand.bmp",
  "progress-frame.bmp",
  "progress-fill.bmp",
]) {
  if (!existsSync(resolve(kuroganeDir, name))) fail(`Kurogane: файл не найден (${name})`);
}

const resourceExe = resolve(kuroganeDir, "kurogane-ui.exe");
if (existsSync(resourceExe)) {
  const magic = readFileSync(resourceExe).subarray(0, 2).toString("ascii");
  if (magic !== "MZ") fail("Kurogane resource UI не является Windows PE-файлом");
}

for (const [path, width, height] of [
  [resolve(configDir, "./windows/header.bmp"), 150, 57],
  [resolve(configDir, "./windows/sidebar.bmp"), 164, 314],
  [resolve(kuroganeDir, "left-panel.bmp"), 330, 463],
  [resolve(kuroganeDir, "title-brand.bmp"), 225, 55],
  [resolve(kuroganeDir, "progress-frame.bmp"), 396, 45],
  [resolve(kuroganeDir, "progress-fill.bmp"), 368, 13],
]) {
  checkBmp(path, width, height);
}

if (entryPath && existsSync(entryPath)) {
  const entry = readFileSync(entryPath, "utf8");
  for (const include of ["hooks.nsh", "kurogane\\kurogane-ui.nsh"]) {
    if (!entry.includes(include)) fail(`installer-entry.nsh не подключает ${include}`);
  }
}

if (templatePath && existsSync(templatePath)) {
  const template = readFileSync(templatePath, "utf8");
  for (const marker of [
    "ManifestDPIAwareness PerMonitorV2",
    "NinetyPrevPerUser",
    "NinetyPrevPerMachine",
    "NSIS_HOOK_PREINSTALL",
    "NSIS_HOOK_PREUNINSTALL",
    "MULTIUSER_PAGE_INSTALLMODE",
    "KuroganeInstFilesShow",
    "un.KuroganeInstFilesShow",
  ]) {
    if (!template.includes(marker)) fail(`в installer.nsi отсутствует ${marker}`);
  }
}

if (hooksPath && existsSync(hooksPath)) {
  const hooks = readFileSync(hooksPath, "utf8");
  for (const process of [
    "Ninety.exe",
    "sing-box.exe",
    "xray.exe",
    "naive.exe",
    "trusttunnel_client.exe",
    "winws.exe",
  ]) {
    if (!hooks.includes(`/IM ${process}`)) fail(`hooks.nsh не завершает ${process}`);
  }
  for (const service of ["NinetyTunnelService", "WinDivert", "WinDivert14", "Monkey"]) {
    if (!hooks.includes(`query ${service}`)) fail(`hooks.nsh не проверяет службу ${service}`);
  }
}

if (!process.exitCode) {
  const python = ["python3", "python"].find((command) =>
    spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0
  );
  if (!python) {
    fail("Python не найден — невозможно проверить сгенерированный RTF");
  } else {
    const scripts = ["src-tauri/windows/make_license_rtf.py"];
    const pillowAvailable =
      spawnSync(python, ["-c", "import PIL"], { stdio: "ignore" }).status === 0;
    if (pillowAvailable) {
      scripts.push(
        "src-tauri/windows/make_installer_bitmaps.py",
        "src-tauri/windows/kurogane/make_kurogane_assets.py"
      );
    } else {
      console.log("Pillow unavailable: BMP headers validated without regeneration");
    }
    for (const script of scripts) {
      const result = spawnSync(python, [script, "--check"], { stdio: "inherit" });
      if (result.status !== 0) {
        fail(`${script} --check завершился с кодом ${result.status ?? "unknown"}`);
        break;
      }
    }
  }
}

if (!process.exitCode) console.log("✓ конфигурация и lifecycle EXE-установщика проверены");
