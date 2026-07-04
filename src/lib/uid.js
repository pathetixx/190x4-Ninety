// Ninety · id для сущностей storage (профили, подписки, правила маршрутизации).
// crypto.randomUUID есть в webview2/Tauri; фолбэк — старое окружение/node-тесты.
// Консолидирует прежние локальные копии (routing-rules uuid; singbox/subscriptions
// делали чистый Math.random — теоретические коллизии при массовом импорте).
export function uid(prefix = "") {
  let id;
  try {
    id = globalThis.crypto?.randomUUID?.();
  } catch { /* нет WebCrypto — фолбэк ниже */ }
  if (!id) id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  return prefix + id;
}
