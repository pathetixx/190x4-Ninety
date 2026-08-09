// Ninety · Гибкие правила маршрутизации — контракт + валидация/нормализация.
// Чистые хелперы (без DOM/Tauri): UI подраздела «Правила маршрутизации» (из
// Claude Design) зовёт их при добавлении/сохранении правила, а движок конфига
// (singbox.js::customRulesToSingbox) превращает готовые правила в route-rules
// sing-box. Источник истины по форме правила и допустимым значениям.
//
// Правило:
//   { id, enabled, type:"domain"|"ip"|"process",
//     match:"suffix"|"exact"|"keyword" (только domain),
//     values:[…], action:"proxy"|"direct"|"block" }

import { uid } from "/lib/uid.js";

export const RULE_TYPES = ["domain", "ip", "process"];
export const DOMAIN_MATCHES = ["suffix", "exact", "keyword"];
export const RULE_ACTIONS = ["proxy", "direct", "block"];

// Подписи для UI — в каталоге i18n (rr.type/rr.match/rr.action), берёт routing-view.js.

// Новое правило с дефолтами (для кнопки «Добавить»).
export function newRule(partial = {}) {
  return {
    id: uid("r-"),
    enabled: true,
    type: "domain",
    match: "suffix",
    values: [],
    action: "proxy",
    ...partial,
  };
}

// ── Нормализация значений по типу ───────────────────────────────────
// Unicode-домен → punycode (A-label). sing-box матчит домены в том виде, в каком
// их видит резолвер, то есть в punycode: правило, сохранённое как «почта.рф», не
// совпало бы никогда. Конверсию делает сам WHATWG-URL — без внешних зависимостей.
// Трогаем ТОЛЬКО строки с не-ASCII: для чистого ASCII парсер URL заодно
// нормализовал бы «0x7f.1» в IP-адрес, чего пользователь не просил.
function hasNonAscii(s) {
  for (const ch of s) if (ch.codePointAt(0) > 0x7f) return true;
  return false;
}

function toPunycode(host) {
  if (!hasNonAscii(host)) return host;
  try {
    const { hostname } = new URL(`http://${host}/`);
    return hostname || host;
  } catch { return host; }
}

// Домен: срезаем схему/путь/порт/ведущий "*.", нижний регистр.
// match="keyword" — это подстрока имени, а не домен: срез схемы/пути/порта там
// менял бы сам искомый фрагмент, поэтому для него только trim/lowercase/punycode.
export function normalizeDomain(v, match = "suffix") {
  let s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  if (match === "keyword") return toPunycode(s);
  s = s.replace(/^[a-z]+:\/\//, ""); // https:// и т.п.
  s = s.split("/")[0]; // путь
  s = s.split("?")[0];
  s = s.replace(/^\*\./, ""); // *.youtube.com → youtube.com (suffix покрывает поддомены)
  s = s.replace(/:\d+$/, ""); // :443
  return toPunycode(s);
}

// Метка LDH: 1..63 символа, не начинается и не заканчивается дефисом.
// Подчёркивание оставлено намеренно (служебные имена вида _acme-challenge).
const RE_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

// Валидный домен. Прежняя регулярка требовала TLD из одних букв ([a-z]{2,63}) и
// молча выбрасывала весь punycode (xn--p1ai, то есть любой .рф/.中国) и TLD с
// цифрой (.p2p, .b2b): правило исчезало из списка, а причина нигде не всплывала.
function isValidDomainName(s) {
  if (!s || s.length > 253) return false;
  const labels = s.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => RE_LABEL.test(label))) return false;
  const tld = labels[labels.length - 1];
  // Чисто числовой TLD запрещён — иначе "1.2.3.4" прошёл бы как домен.
  return tld.length >= 2 && !/^\d+$/.test(tld);
}

// Ключевое слово — подстрока имени хоста, а не домен: точка и TLD не нужны.
// Проверяем только длину и алфавит имени хоста.
function isValidDomainKeyword(s) {
  return !!s && s.length <= 253 && /^[a-z0-9_.-]+$/.test(s);
}

const RE_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function validIpv4(s) {
  const m = s.match(RE_IPV4);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255 && String(Number(o)) === o.replace(/^0+(?=\d)/, ""));
}
function validIpv6(s) {
  if (!s.includes(":")) return false;
  if (s.includes("%")) return false; // zone-id в sing-box ip_cidr не нужен
  try {
    new URL(`http://[${s}]/`);
    return true;
  } catch {
    return false;
  }
}

// IP/CIDR: вернуть нормализованную запись (одиночный IP → /32 или /128) либо "".
export function normalizeIp(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const [addr, cidrRaw, ...rest] = s.split("/");
  if (rest.length) return "";
  const isV6 = addr.includes(":");
  const okAddr = isV6 ? validIpv6(addr) : validIpv4(addr);
  if (!okAddr) return "";
  if (cidrRaw === undefined) return `${addr}/${isV6 ? 128 : 32}`;
  const cidr = Number(cidrRaw);
  if (!Number.isInteger(cidr) || cidr < 0 || cidr > (isV6 ? 128 : 32)) return "";
  return `${addr}/${cidr}`;
}

// Процесс: имя исполняемого файла. Срезаем путь, добавляем .exe если забыли.
export function normalizeProcess(v) {
  let s = String(v || "").trim();
  if (!s) return "";
  s = s.replace(/[\\/]+$/, "");
  s = s.split(/[\\/]/).pop(); // C:\…\Telegram.exe → Telegram.exe
  if (!/\.exe$/i.test(s)) s += ".exe";
  return s;
}

// Нормализовать одно значение по типу. "" = невалидно.
export function normalizeValue(type, v, match = "suffix") {
  if (type === "ip") return normalizeIp(v);
  if (type === "process") return normalizeProcess(v);
  return normalizeDomain(v, match); // domain
}

// Валидно ли значение (для подсветки поля в UI).
export function isValidValue(type, v, match = "suffix") {
  const n = normalizeValue(type, v, match);
  if (!n) return false;
  if (type === "domain") {
    return match === "keyword" ? isValidDomainKeyword(n) : isValidDomainName(n);
  }
  return true; // ip/process уже выверены нормализацией
}

// Привести правило к чистому виду перед сохранением: нормализовать values,
// выкинуть пустые/битые, дедуп. Вернуть { rule, dropped } — dropped = сколько
// значений отброшено (UI может предупредить).
export function sanitizeRule(rule) {
  const type = RULE_TYPES.includes(rule?.type) ? rule.type : "domain";
  const match = type === "domain" && DOMAIN_MATCHES.includes(rule?.match) ? rule.match : "suffix";
  const action = RULE_ACTIONS.includes(rule?.action) ? rule.action : "proxy";
  const seen = new Set();
  const values = [];
  let dropped = 0;
  for (const raw of Array.isArray(rule?.values) ? rule.values : []) {
    if (!isValidValue(type, raw, match)) {
      if (String(raw || "").trim()) dropped++;
      continue;
    }
    const n = normalizeValue(type, raw, match);
    if (seen.has(n)) continue;
    seen.add(n);
    values.push(n);
  }
  return {
    rule: {
      id: rule?.id || uid("r-"),
      enabled: rule?.enabled !== false,
      type,
      ...(type === "domain" ? { match } : {}),
      values,
      action,
    },
    dropped,
  };
}
