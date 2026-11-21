// The list must match SUPPORTED_SCHEMES (src-tauri/src/url_handler.rs) and
// TOP_LEVEL_PROTOS (src/lib/deeplink.js) — equality is checked by
// tests/link-schemes.test.mjs. A scheme that isn't in Rust returns Err.
import { localizedInvoke } from "/lib/backend-errors.js";
export const LINK_HANDLER_SCHEMES = [
  "vless", "vmess", "ss", "trojan", "hysteria2", "hy2", "hysteria", "tuic", "sub",
  "anytls", "tt", "naive+https", "naive+quic",
];

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// A failure on ONE scheme must not cancel the rest: previously the loop broke off at
// the first error, leaving some schemes registered with the setting
// turned off. We go through the whole list and report an aggregated error — the registry
// state then matches what we managed to apply.
export async function applyLinkHandlers(enable) {
  const cmd = enable ? "register_url_handler" : "unregister_url_handler";
  const results = await Promise.allSettled(
    LINK_HANDLER_SCHEMES.map((scheme) => invoke(cmd, { scheme })),
  );
  const failed = results
    .map((result, index) => ({ result, scheme: LINK_HANDLER_SCHEMES[index] }))
    .filter(({ result }) => result.status === "rejected");
  if (failed.length) {
    const detail = failed
      .map(({ scheme, result }) => `${scheme}: ${result.reason?.message || result.reason}`)
      .join("; ");
    throw new Error(detail);
  }
}
