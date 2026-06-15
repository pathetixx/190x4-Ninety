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

export const RULE_TYPES = ["domain", "ip", "process"];
export const DOMAIN_MATCHES = ["suffix", "exact", "keyword"];
export const RULE_ACTIONS = ["proxy", "direct", "block"];

// Подписи для UI (человеческим языком, без жаргона).
export const TYPE_LABELS = { domain: "Домен", ip: "IP / подсеть", process: "Процесс" };
export const MATCH_LABELS = { suffix: "Поддомены (suffix)", exact: "Точно", keyword: "Содержит" };
export const ACTION_LABELS = { proxy: "Через VPN", direct: "Напрямую", block: "Блок" };

// crypto.randomUUID есть в webview2/Tauri; фолбэк на случай старого окружения/тестов.
function uuid() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// Новое правило с дефолтами (для кнопки «Добавить»).
export function newRule(partial = {}) {
  return {
    id: uuid(),
    enabled: true,
    type: "domain",
    match: "suffix",
    values: [],
    action: "proxy",
    ...partial,
  };
}

// ── Нормализация значений по типу ───────────────────────────────────
// Домен: срезаем схему/путь/порт/ведущий "*.", нижний регистр.
export function normalizeDomain(v) {
  let s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z]+:\/\//, ""); // https:// и т.п.
  s = s.split("/")[0]; // путь
  s = s.split("?")[0];
  s = s.replace(/^\*\./, ""); // *.youtube.com → youtube.com (suffix покрывает поддомены)
  s = s.replace(/:\d+$/, ""); // :443
  return s;
}

const RE_DOMAIN = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}$/i;
const RE_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function validIpv4(s) {
  const m = s.match(RE_IPV4);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255 && String(Number(o)) === o.replace(/^0+(?=\d)/, ""));
}
// Грубая, но достаточная проверка IPv6 (полные/сжатые формы).
function validIpv6(s) {
  if (!s.includes(":")) return false;
  if (!/^[0-9a-f:]+$/i.test(s)) return false;
  return s.split("::").length <= 2 && s.split(":").length <= 8;
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
export function normalizeValue(type, v) {
  if (type === "ip") return normalizeIp(v);
  if (type === "process") return normalizeProcess(v);
  return normalizeDomain(v); // domain
}

// Валидно ли значение (для подсветки поля в UI).
export function isValidValue(type, v) {
  const n = normalizeValue(type, v);
  if (!n) return false;
  if (type === "domain") return RE_DOMAIN.test(n);
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
    if (!isValidValue(type, raw)) {
      if (String(raw || "").trim()) dropped++;
      continue;
    }
    const n = normalizeValue(type, raw);
    if (seen.has(n)) continue;
    seen.add(n);
    values.push(n);
  }
  return {
    rule: {
      id: rule?.id || uuid(),
      enabled: rule?.enabled !== false,
      type,
      ...(type === "domain" ? { match } : {}),
      values,
      action,
    },
    dropped,
  };
}
