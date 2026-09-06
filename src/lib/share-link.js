// Ninety · сборка share-ссылки из полей сервера.
//
// Общий низ для импортёров чужих конфигов: и sing-box, и Xray описывают один и
// тот же сервер, просто разными именами полей. Каждый импортёр раскладывает
// свой outbound по параметрам v2rayN — словарю, который читают парсеры
// Ninety, — а собирает из них строку уже этот модуль.
//
// Почему вообще через ссылку: на поле `raw` профиля держатся хранилище,
// экспорт ноды и обратная совместимость старых записей. Ветка «чужой конфиг →
// сразу объект профиля» означала бы вторую модель ноды со своей валидацией.

/** Сервер в ссылке: IPv6 обязан быть в скобках, иначе разбор режет по
 *  последнему двоеточию и отрезает не порт, а половину адреса. */
export function hostForUri(server) {
  const host = String(server ?? "").trim().replace(/^\[|\]$/g, "");
  if (!host) return "";
  return host.includes(":") ? `[${host}]` : host;
}

/** Адрес для полей, которые ядро принимает без скобок (server, peer address). */
export function bareHost(server) {
  return String(server ?? "").trim().replace(/^\[|\]$/g, "");
}

function b64(text, urlSafe) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  const encoded = btoa(bin);
  return urlSafe ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
}

export const b64urlUtf8 = (text) => b64(text, true);
export const b64Utf8 = (text) => b64(text, false);

/** Список ALPN приезжает и массивом, и строкой через запятую. */
export function joinList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean).join(",");
  return String(value ?? "").trim();
}

export function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Собирает ссылку. Пустые параметры не пишутся вовсе: у парсеров свои
 * значения по умолчанию, и `sni=` пустой строкой отличается от отсутствующего.
 * @param {object} spec {scheme, userinfo, server, port, params: [key, value][], tag}
 */
export function buildShareLink({ scheme, userinfo = "", server, port, params = [], tag = "" }) {
  const query = new URLSearchParams();
  for (const [key, value] of params) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const auth = userinfo ? `${userinfo}@` : "";
  const search = query.toString();
  const name = tag ? `#${encodeURIComponent(tag)}` : "";
  return `${scheme}://${auth}${hostForUri(server)}:${Number(port)}${search ? `?${search}` : ""}${name}`;
}

/** vmess — единственная схема, где «ссылка» это base64 от JSON v2rayN. */
export function buildVmessLink(payload, tag) {
  return `vmess://${b64Utf8(JSON.stringify(payload))}${tag ? `#${encodeURIComponent(tag)}` : ""}`;
}

/** SIP002: userinfo — base64url(method:password). */
export function shadowsocksUserinfo(method, password) {
  return b64urlUtf8(`${method ?? ""}:${password ?? ""}`);
}

/** socks/http: «user:pass», обе половины экранированы. */
export function credentialsUserinfo(username, password) {
  const user = username ? encodeURIComponent(username) : "";
  const pass = password ? encodeURIComponent(password) : "";
  return user || pass ? `${user}:${pass}` : "";
}
