// Ninety · auto-updater wrapper
// Uses window.__TAURI__ (withGlobalTauri:true). No npm package bundling.

const t = () => window.__TAURI__;

function api() {
  const root = t();
  if (!root) return null;
  // In Tauri 2 with withGlobalTauri the plugin API is available as __TAURI__.updater
  const u = root.updater;
  const p = root.process;
  if (!u || !p) return null;
  return { updater: u, process: p };
}

export function isAvailable() {
  return !!api();
}

// checkForUpdate({ proxy, timeoutMs }).
// proxy ("http://127.0.0.1:PORT") — with the VPN up the check explicitly goes through our own
// local inbound. The system proxy can't be relied on: in the "Proxy" and TUN
// modes there isn't one (in TUN Ninety.exe's traffic goes direct via the
// bypass rule), and without the VPN there may be someone else's or a dead proxy. Without
// an explicit proxy the check goes "direct" — with some ISPs the endpoints aren't reachable that way.
// The proxy from check()
// is remembered by the plugin in Update, and the download goes through the same client (also into the tunnel).
export async function checkForUpdate({ proxy = null, timeoutMs = 30_000 } = {}) {
  const a = api();
  if (!a) return null;
  const opts = { timeout: timeoutMs };
  if (proxy) opts.proxy = proxy;
  // Errors (no network / a blocked asset CDN) are NOT swallowed — they're thrown
  // up so that runUpdateCheck can tell "couldn't check" from "no updates".
  // Previously both cases returned null → the app lied "you have the latest version".
  return a.updater.check(opts); // null = no update; {version, ...} = there is one
}
