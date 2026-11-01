// Ninety · ошибки бэкенда на языке интерфейса. Язык знает только фронтенд, поэтому
// Rust отдаёт не текст, а токен с ключом каталога: [[ключ {"имя":"значение"}]]
// (см. i18n_error в util.rs). Токен может стоять внутри строки с техническими
// подробностями, поэтому заменяем его на месте, а остальное не трогаем.
import { t } from "/lib/i18n/index.js";

const TOKEN = /\[\[([\w.]+)(?: (\{.*?\}))?\]\]/g;

export function localizeBackendText(text) {
  if (typeof text !== "string") return text;
  return text.replace(TOKEN, (token, key, rawVars) => {
    try {
      return t(key, rawVars ? JSON.parse(rawVars) : undefined);
    } catch {
      return token;
    }
  });
}

// Обёртка над invoke: отказ команды приходит уже переведённым. Тип отказа прежний
// (строка), так что места показа ошибок менять не нужно.
export function localizedInvoke(invoke) {
  if (typeof invoke !== "function") return invoke;
  return async (...args) => {
    try {
      return await invoke(...args);
    } catch (error) {
      throw localizeBackendText(error);
    }
  };
}
