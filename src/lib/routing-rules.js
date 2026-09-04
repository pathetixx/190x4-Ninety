// Ninety · Гибкие правила маршрутизации — контракт + валидация/нормализация.
// Чистые хелперы (без DOM/Tauri): UI подраздела «Правила маршрутизации» (из
// Claude Design) зовёт их при добавлении/сохранении правила, а движок конфига
// (singbox.js::customRulesToSingbox) превращает готовые правила в route-rules
// sing-box. Источник истины по форме правила и допустимым значениям.
//
// Правило:
//   { id, enabled, type:"domain"|"ip"|"process",
//     match:"suffix"|"exact"|"keyword" (только domain),
//     values:[…], action:"proxy"|"direct"|"block"|"node"|"warp",
//     target:{ tag, name } — только для action:"node" }

import { uid } from "/lib/uid.js";

export const RULE_TYPES = ["domain", "ip", "process"];
export const DOMAIN_MATCHES = ["suffix", "exact", "keyword"];
export const RULE_ACTIONS = ["proxy", "direct", "block", "node", "warp"];

// Действия, уводящие трафик в конкретный аутбаунд, а не в общий «через VPN».
// "node" требует target, "warp" — включённого WARP: и то, и другое может
// отсутствовать в момент сборки конфига, поэтому оба деградируют до "proxy"
// (см. resolveRuleTarget в singbox.js) вместо падения ядра на пустом теге.
export const TARGETED_ACTIONS = ["node", "warp"];

// Подписи для UI — в каталоге i18n (rr.type/rr.match/rr.action), берёт routing-view.js.

// Ссылка правила на конкретный сервер. Тег ноды — хеш её содержимого
// (singbox.js::nodeTag), поэтому переупорядочивание подписки правило переживает.
// Имя храним вторым ключом: если провайдер поменял параметры ноды, хеш уедет, а
// человекочитаемое имя обычно остаётся тем же — правило не осиротеет молча.
export function normalizeTarget(target) {
  const tag = String(target?.tag || "").trim().slice(0, 128);
  const name = String(target?.name || "").trim().slice(0, 200);
  if (!tag && !name) return null;
  return { ...(tag ? { tag } : {}), ...(name ? { name } : {}) };
}

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

// Канонический вид IPv4 или "" — ведущие нули снимаются здесь, а не только
// проверяются. Иначе «192.168.001.100» проходил валидацию и уезжал в конфиг
// ядра как есть: sing-box такую запись отвергает, и правило пользователя молча
// не работало (либо весь конфиг не поднимался).
function canonicalIpv4(s) {
  const m = s.match(RE_IPV4);
  if (!m) return "";
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "";
  return octets.join(".");
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
  const canonical = isV6 ? (validIpv6(addr) ? addr : "") : canonicalIpv4(addr);
  if (!canonical) return "";
  if (cidrRaw === undefined) return `${canonical}/${isV6 ? 128 : 32}`;
  const cidr = Number(cidrRaw);
  if (!Number.isInteger(cidr) || cidr < 0 || cidr > (isV6 ? 128 : 32)) return "";
  return `${canonical}/${cidr}`;
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
  const requested = RULE_ACTIONS.includes(rule?.action) ? rule.action : "proxy";
  // «Через сервер» без цели неотличимо от «через VPN», но в конфиг уехало бы с
  // пустым тегом и уронило старт ядра. Такое правило деградируем прямо здесь.
  const target = requested === "node" ? normalizeTarget(rule?.target) : null;
  const action = requested === "node" && !target ? "proxy" : requested;
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
      ...(target ? { target } : {}),
    },
    dropped,
  };
}
