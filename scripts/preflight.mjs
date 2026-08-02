#!/usr/bin/env node

export const MIN_NODE_VERSION = Object.freeze([20, 19, 0]);

export function parseNodeVersion(raw) {
  const match = String(raw || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

export function isSupportedNodeVersion(raw, minimum = MIN_NODE_VERSION) {
  const actual = Array.isArray(raw) ? raw : parseNodeVersion(raw);
  if (!actual) return false;
  for (let i = 0; i < minimum.length; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

if (process.argv[1]?.endsWith("preflight.mjs")) {
  const current = process.versions.node;
  if (!isSupportedNodeVersion(current)) {
    console.error(`Ninety requires Node.js ${MIN_NODE_VERSION.join(".")} or newer; current version is ${current}. Node.js 22 LTS is recommended.`);
    process.exit(1);
  }
  console.log(`Node.js preflight OK: ${current}`);
}
