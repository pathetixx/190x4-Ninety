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

function assertMinisignPublicKey(name, encoded) {
  const text = Buffer.from(encoded, "base64").toString("utf8");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines[0]?.startsWith("untrusted comment: minisign public key:")) {
    throw new Error(`${name} must contain exactly one base64 layer around a minisign public-key file`);
  }
  const keyLine = lines.find((line) => !line.startsWith("untrusted comment"));
  if (!keyLine || Buffer.from(keyLine, "base64").length !== 42) {
    throw new Error(`${name} does not contain a valid minisign public-key line`);
  }
}

assertMinisignPublicKey("Dedicated DPI public key", dedicatedMatch[1]);
assertMinisignPublicKey("Legacy DPI public key", legacyMatch[1]);

console.log("DPI key rotation guard OK: dedicated key differs from OTA key");
