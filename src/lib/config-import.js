// Ninety · importing a ready client config → profiles.
//
// A single entry point over the format importers: recognizes whose config it is and
// calls the right one. Callers (subscription body, add window) don't know about the formats
// themselves — they need a list of servers and an honest count of what couldn't be
// taken.
//
// Identical servers are collapsed. This isn't cosmetic: a panel's array subscription
// lists each server as a separate config, and then once more — all together, in
// a balancer config ("Best Ping"). Without merging the user would get
// every server twice. The fingerprint is computed from the node contents and doesn't depend
// on the name, so the same server under two names is one server.

import { CONFIG_FORMAT_NAMES, detectConfigFormat } from "/lib/config-format.js";
import { parseSingboxConfig } from "/lib/singbox-config-import.js";
import { parseXrayConfig } from "/lib/xray-config-import.js";
import { nodeSemanticFingerprint } from "/lib/runtime-identity.js";
import { t } from "/lib/i18n/index.js";

export { detectConfigFormat };

const PARSERS = {
  "sing-box": parseSingboxConfig,
  xray: parseXrayConfig,
};

function dedupe(profiles) {
  const seen = new Set();
  const out = [];
  for (const profile of profiles) {
    const shape = nodeSemanticFingerprint(profile);
    if (seen.has(shape)) continue;
    seen.add(shape);
    out.push(profile);
  }
  return out;
}

/**
 * Parses a client config, whatever it is.
 * @returns {{format: string|null, profiles: object[], skipped: number, unsupported: string[]}}
 */
export function parseClientConfig(text) {
  const format = detectConfigFormat(text);
  const parser = PARSERS[format];
  if (!parser) return { format, profiles: [], skipped: 0, unsupported: [] };
  const { profiles, skipped, unsupported } = parser(text);
  return { format, profiles: dedupe(profiles), skipped, unsupported };
}

/**
 * Message for a config Ninety can't read.
 * @returns {string|null} null — the format is readable, or it isn't a config at all.
 */
export function unsupportedFormatMessage(format) {
  if (!format || PARSERS[format]) return null;
  // An archive isn't a foreign format but an unpacked file: inside lies exactly
  // what Ninety can already read, and that's exactly how it should be said.
  if (format === "archive") return t("subs.archiveBody");
  const name = CONFIG_FORMAT_NAMES[format];
  return name ? t("subs.foreignConfig", { format: name }) : null;
}

/** Format name for display: "sing-box", "Xray". */
export function configFormatName(format) {
  return CONFIG_FORMAT_NAMES[format] || "";
}
