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
const conceptCapturePath = resolve(root, "./scripts/capture-installer-concepts.ps1");

for (const name of [
  "kurogane-ui.nsh",
  "kurogane-ui.rc",
  "kurogane-ui.exe",
  "left-panel.bmp",
  "title-brand.bmp",
  "progress-frame.bmp",
  "chrome-minimize.bmp",
  "chrome-close.bmp",
  "nav-back-en.bmp",
  "nav-back-ru.bmp",
  "nav-next-en.bmp",
  "nav-next-ru.bmp",
  "nav-install-en.bmp",
  "nav-install-ru.bmp",
  "nav-remove-en.bmp",
  "nav-remove-ru.bmp",
  "nav-finish-en.bmp",
  "nav-finish-ru.bmp",
  "nav-cancel-en.bmp",
  "nav-cancel-ru.bmp",
  "concept-gallery.nsi",
  "concept-gallery.nsh",
]) {
  if (!existsSync(resolve(kuroganeDir, name))) fail(`Kurogane: файл не найден (${name})`);
}

if (!existsSync(conceptCapturePath)) {
  fail("Kurogane: скрипт захвата концептов не найден");
}

const resourceExe = resolve(kuroganeDir, "kurogane-ui.exe");
if (existsSync(resourceExe)) {
  const magic = readFileSync(resourceExe).subarray(0, 2).toString("ascii");
  if (magic !== "MZ") fail("Kurogane resource UI не является Windows PE-файлом");
}

const conceptGalleryPath = resolve(kuroganeDir, "concept-gallery.nsh");
if (existsSync(conceptGalleryPath)) {
  const conceptGallery = readFileSync(conceptGalleryPath, "utf8");
  for (const marker of [
    "CONCEPT A  /  CORE CARDS",
    "CONCEPT B  /  TERMINAL MANIFEST",
    "CONCEPT C  /  SIGNAL MATRIX",
  ]) {
    if (!conceptGallery.includes(marker)) fail(`Kurogane concept gallery не содержит ${marker}`);
  }
}

const kuroganeUiPath = resolve(kuroganeDir, "kurogane-ui.nsh");
if (existsSync(kuroganeUiPath)) {
  const kuroganeUi = readFileSync(kuroganeUiPath, "utf8");
  for (const marker of [
    "KuroganeEnableManagedOtaWindowImpl",
    "DwmSetWindowAttribute",
    "EnableMenuItem",
  ]) {
    if (!kuroganeUi.includes(marker)) fail(`Kurogane OTA chrome не содержит ${marker}`);
  }
}

for (const [path, width, height] of [
  [resolve(configDir, "./windows/header.bmp"), 150, 57],
  [resolve(configDir, "./windows/sidebar.bmp"), 164, 314],
  [resolve(kuroganeDir, "left-panel.bmp"), 384, 538],
  [resolve(kuroganeDir, "title-brand.bmp"), 264, 66],
  [resolve(kuroganeDir, "progress-frame.bmp"), 460, 53],
  [resolve(kuroganeDir, "chrome-minimize.bmp"), 44, 35],
  [resolve(kuroganeDir, "chrome-close.bmp"), 44, 35],
  [resolve(kuroganeDir, "nav-back-en.bmp"), 104, 35],
  [resolve(kuroganeDir, "nav-back-ru.bmp"), 104, 35],
  [resolve(kuroganeDir, "nav-next-en.bmp"), 118, 35],
  [resolve(kuroganeDir, "nav-next-ru.bmp"), 118, 35],
  [resolve(kuroganeDir, "nav-install-en.bmp"), 118, 35],
  [resolve(kuroganeDir, "nav-install-ru.bmp"), 118, 35],
  [resolve(kuroganeDir, "nav-remove-en.bmp"), 118, 35],
  [resolve(kuroganeDir, "nav-remove-ru.bmp"), 118, 35],
  [resolve(kuroganeDir, "nav-finish-en.bmp"), 118, 35],
  [resolve(kuroganeDir, "nav-finish-ru.bmp"), 118, 35],
  [resolve(kuroganeDir, "nav-cancel-en.bmp"), 110, 35],
  [resolve(kuroganeDir, "nav-cancel-ru.bmp"), 110, 35],
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
    "KuroganeInstallModeShow",
    "KuroganeLicenseShow",
    "KuroganeDirectoryShow",
    "KuroganeStartMenuShow",
    "KuroganeUninstallConfirmPageImpl $mui.UnConfirmPage",
    "un.NinetyFinishShow",
    "KuroganeInstFilesShow",
    "un.KuroganeInstFilesShow",
    "Call KuroganeProgressTick",
    "Call un.KuroganeProgressTick",
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
