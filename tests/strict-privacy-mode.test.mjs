import test from "node:test";
import assert from "node:assert/strict";

import {
  clearStrictTunnelPreviousMode,
  readStrictTunnelPreviousMode,
  rememberStrictTunnelPreviousMode,
  STRICT_TUNNEL_PREVIOUS_MODE_KEY,
} from "/lib/strict-privacy-mode.js";

function makeStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("strict tunnel remembers and clears the system proxy mode", () => {
  const storage = makeStorage();

  assert.equal(rememberStrictTunnelPreviousMode("systemProxy", storage), true);
  assert.equal(readStrictTunnelPreviousMode(storage), "systemProxy");
  clearStrictTunnelPreviousMode(storage);
  assert.equal(readStrictTunnelPreviousMode(storage), null);
  assert.equal(storage.getItem(STRICT_TUNNEL_PREVIOUS_MODE_KEY), null);
});

test("strict tunnel accepts TUN as a no-op restore and rejects invalid state", () => {
  const storage = makeStorage();

  assert.equal(rememberStrictTunnelPreviousMode("tun", storage), true);
  assert.equal(readStrictTunnelPreviousMode(storage), "tun");
  assert.equal(rememberStrictTunnelPreviousMode("unexpected", storage), false);
  assert.equal(readStrictTunnelPreviousMode(storage), "tun");
});
