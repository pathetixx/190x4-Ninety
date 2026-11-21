// Ninety · backend errors in the interface language. Only the frontend knows the language, so
// Rust returns not text but a token with a catalog key: [[key {"name":"value"}]]
// (see i18n_error in util.rs). The token may sit inside a string with technical
// details, so we replace it in place and leave the rest untouched.
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

// A wrapper over invoke: a command failure arrives already translated. The failure type is the same
// (a string), so the places that show errors don't need to change.
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
