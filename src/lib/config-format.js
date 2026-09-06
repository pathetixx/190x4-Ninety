// Ninety · распознавание формата чужого конфига.
//
// Лист без зависимостей: и импортёры, и вызывающие спрашивают формат здесь,
// поэтому знать про них он не должен.
//
// Ключ `outbounds` есть и у sing-box, и у Xray — различает их форма записи
// сервера: у sing-box это `type` и плоские поля, у Xray — `protocol` плюс
// `settings`/`streamSettings`. Ошибиться тут дороже, чем не распознать: разбор
// не тем импортёром даст «конфиг без серверов» на здоровом файле.

export function safeJsonParse(text) {
  const s = String(text ?? "").trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Xray-подписка v2rayN — это массив целых конфигов, а не один конфиг.
function configList(root) {
  if (Array.isArray(root)) return root.filter(isPlainObject);
  return isPlainObject(root) ? [root] : [];
}

function outboundsOf(root) {
  const out = [];
  for (const config of configList(root)) {
    if (Array.isArray(config.outbounds)) out.push(...config.outbounds.filter(isPlainObject));
    // Голый массив outbound'ов: сам элемент и есть outbound.
    else if (config.type || config.protocol) out.push(config);
  }
  return out;
}

function looksLikeXray(root) {
  if (outboundsOf(root).some(item => typeof item.protocol === "string")) return true;
  return configList(root).some(config => isPlainObject(config.routing) || isPlainObject(config.policy));
}

function looksLikeSingbox(root) {
  if (configList(root).some(config => Array.isArray(config.endpoints))) return true;
  return outboundsOf(root).some(item => typeof item.type === "string" && !item.protocol);
}

// Clash — YAML, а не JSON: распознаём только чтобы честно назвать формат в
// сообщении об ошибке, разбирать его здесь нечем.
const CLASH_RE = /^\s*proxies\s*:/m;

/**
 * @returns {"sing-box"|"xray"|"clash"|null} null — это не конфиг клиента.
 */
export function detectConfigFormat(text) {
  const root = safeJsonParse(text);
  if (root) {
    if (looksLikeXray(root)) return "xray";
    if (looksLikeSingbox(root)) return "sing-box";
    return null;
  }
  const s = String(text ?? "");
  if (CLASH_RE.test(s) && /^\s*-\s+(?:name|\{)/m.test(s)) return "clash";
  return null;
}

// Имя формата пишем так, как его пишет сам проект.
export const CONFIG_FORMAT_NAMES = {
  "sing-box": "sing-box",
  xray: "Xray",
  clash: "Clash",
};
