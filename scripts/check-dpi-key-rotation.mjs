import { readFile } from "node:fs/promises";

const [tauriConfigText, dpiSource] = await Promise.all([
  readFile("src-tauri/tauri.conf.json", "utf8"),
  readFile("src-tauri/src/dpi.rs", "utf8"),
]);
const updaterKey = JSON.parse(tauriConfigText).plugins?.updater?.pubkey;
const dedicatedMatch = dpiSource.match(/const CHANNEL_DEDICATED_PUBKEY_B64: &str = "([^"]+)";/);
const legacyMatch = dpiSource.match(/const CHANNEL_LEGACY_PUBKEY_B64: &str = "([^"]+)";/);

if (!updaterKey || !dedicatedMatch || !legacyMatch) {
  throw new Error("DPI key rotation constants are missing");
}
if (dedicatedMatch[1] === updaterKey) {
  throw new Error("Dedicated DPI public key must not match the OTA updater public key");
}
if (legacyMatch[1] !== updaterKey) {
  throw new Error("Legacy DPI public key must match the current OTA updater public key during rotation");
}

console.log("DPI key rotation guard OK: dedicated key differs from OTA key");
