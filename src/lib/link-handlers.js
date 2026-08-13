export const LINK_HANDLER_SCHEMES = [
  "vless", "vmess", "ss", "trojan", "hysteria2", "hy2", "hysteria", "tuic", "sub",
  "anytls", "tt", "naive+https", "naive+quic",
];

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

export async function applyLinkHandlers(enable) {
  const cmd = enable ? "register_url_handler" : "unregister_url_handler";
  for (const scheme of LINK_HANDLER_SCHEMES) {
    await invoke(cmd, { scheme });
  }
}
