// Ninety · ids for storage entities (profiles, subscriptions, routing rules).
// crypto.randomUUID exists in webview2/Tauri; the fallback is for an old environment/node tests.
// Consolidates the former local copies (routing-rules uuid; singbox/subscriptions
// used plain Math.random — theoretical collisions on a bulk import).
export function uid(prefix = "") {
  let id;
  try {
    id = globalThis.crypto?.randomUUID?.();
  } catch { /* no WebCrypto — fallback below */ }
  if (!id) id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  return prefix + id;
}
