// Ninety · импорт готового конфига клиента → профили.
//
// Единая точка входа поверх импортёров формата: распознаёт, чей это конфиг, и
// зовёт нужный. Вызывающие (тело подписки, окно добавления) про сами форматы
// не знают — им нужен список серверов и честный счётчик того, что взять не
// удалось.
//
// Одинаковые серверы схлопываются. Это не косметика: подписка-массив у панелей
// перечисляет каждый сервер отдельным конфигом, а потом ещё раз — целиком, в
// конфиге-балансировщике («Best Ping»). Без склейки пользователь получил бы
// каждый сервер дважды. Отпечаток считается по содержимому ноды и не зависит
// от имени, так что один и тот же сервер под двумя именами — это один сервер.

import { CONFIG_FORMAT_NAMES, detectConfigFormat } from "/lib/config-format.js";
import { parseSingboxConfig } from "/lib/singbox-config-import.js";
import { parseXrayConfig } from "/lib/xray-config-import.js";
import { nodeSemanticFingerprint } from "/lib/runtime-identity.js";
import { t } from "/lib/i18n/index.js";

export { detectConfigFormat };

const PARSERS = {
  "sing-box": parseSingboxConfig,
  xray: parseXrayConfig,
};

function dedupe(profiles) {
  const seen = new Set();
  const out = [];
  for (const profile of profiles) {
    const shape = nodeSemanticFingerprint(profile);
    if (seen.has(shape)) continue;
    seen.add(shape);
    out.push(profile);
  }
  return out;
}

/**
 * Разбирает конфиг клиента, каким бы он ни был.
 * @returns {{format: string|null, profiles: object[], skipped: number, unsupported: string[]}}
 */
export function parseClientConfig(text) {
  const format = detectConfigFormat(text);
  const parser = PARSERS[format];
  if (!parser) return { format, profiles: [], skipped: 0, unsupported: [] };
  const { profiles, skipped, unsupported } = parser(text);
  return { format, profiles: dedupe(profiles), skipped, unsupported };
}

/**
 * Сообщение для конфига, который Ninety прочитать не может.
 * @returns {string|null} null — формат читаемый либо это вообще не конфиг.
 */
export function unsupportedFormatMessage(format) {
  if (!format || PARSERS[format]) return null;
  const name = CONFIG_FORMAT_NAMES[format];
  return name ? t("subs.foreignConfig", { format: name }) : null;
}

/** Имя формата для показа: «sing-box», «Xray». */
export function configFormatName(format) {
  return CONFIG_FORMAT_NAMES[format] || "";
}
