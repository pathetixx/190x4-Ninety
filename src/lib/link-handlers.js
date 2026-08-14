// Список обязан совпадать с SUPPORTED_SCHEMES (src-tauri/src/url_handler.rs) и
// TOP_LEVEL_PROTOS (src/lib/deeplink.js) — равенство проверяет
// tests/link-schemes.test.mjs. Схема, которой нет в Rust, возвращает Err.
export const LINK_HANDLER_SCHEMES = [
  "vless", "vmess", "ss", "trojan", "hysteria2", "hy2", "hysteria", "tuic", "sub",
  "anytls", "tt", "naive+https", "naive+quic",
];

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// Отказ на ОДНОЙ схеме не должен отменять остальные: раньше цикл обрывался на
// первой ошибке, оставляя часть схем зарегистрированной при выключенной
// настройке. Проходим весь список и сообщаем агрегированную ошибку — состояние
// реестра тогда соответствует тому, что удалось применить.
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
