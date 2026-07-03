// Ninety · DNS-watchdog для direct-резолвера.
//
// Проблема: имя сервера ноды sing-box резолвит через dns-direct ДО поднятия
// туннеля. Мёртвый direct-DNS (в РФ так легли Google/Cloudflare DoH) роняет
// старт целиком — «i/o timeout» без внятной причины. Этот модуль активно пробует
// текущий direct-DNS (Rust: dns_probe) и при отказе переключает на рабочий резерв.
//
// Две точки: (1) ПЕРЕД коннектом ensureWorkingDirectDns лечит «VPN не стартует»;
// (2) периодический чек при connected ловит, если резолвер лёг в середине сессии.
//
// Порядок резервов НЕ случаен: Quad9 DoH первым — он держится в РФ и, в отличие
// от Yandex, не искажает urltest-проверку нод (Yandex резолвит часть серверов в
// адреса, которые тест ложно метит недоступными). Yandex DoH — крайний резерв:
// максимально устойчив, но с той же оговоркой про ложные failed.

import { loadOptions, updateOption } from "/lib/options.js";
import { t } from "/lib/i18n/index.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// Нейтральный контрольный домен (IANA, вечный) — проверяем сам факт резолюции,
// не привязываясь к конкретной ноде/инфре.
const CONTROL_HOST = "example.com";

// Цепочка резервов (Quad9 DoH → Yandex DoH). Дефолтный direct-DNS (Yandex UDP)
// сюда не включаем как приоритетный — если упал именно он, Quad9 надёжнее.
const FALLBACKS = [
  "https://149.112.112.112/dns-query", // Quad9 secondary DoH
  "https://77.88.8.8/dns-query",        // Yandex DoH (крайний резерв)
];

const PROBE_TIMEOUT_MS = 2500;

// Короткое человекочитаемое имя DNS для тоста.
function prettyDns(dns) {
  try {
    if (dns.startsWith("https://")) return new URL(dns).hostname;
    return dns.replace(/^\w+:\/\//, "");
  } catch { return dns; }
}

async function probe(dns) {
  try {
    return await invoke("dns_probe", { dns, host: CONTROL_HOST, timeoutMs: PROBE_TIMEOUT_MS });
  } catch { return "skip"; }
}

// Проверяет текущий direct-DNS; если он "dead" — ищет первый рабочий резерв,
// сохраняет его в настройки и возвращает новый адрес (иначе null — трогать нечего).
// toast инжектится из main.js. onlyIf — предикат «ещё актуально» (не переключать,
// если юзер за время пробы отключился/сменил источник).
export async function ensureWorkingDirectDns({ toast, onlyIf } = {}) {
  const cur = loadOptions().dns?.directAddress || "";
  const st = await probe(cur);
  if (st !== "dead") return null; // ok / skip — не вмешиваемся
  if (onlyIf && !onlyIf()) return null;

  for (const cand of FALLBACKS) {
    if (cand === cur) continue;
    if ((await probe(cand)) !== "ok") continue;
    if (onlyIf && !onlyIf()) return null;
    updateOption("dns.directAddress", cand);
    toast?.(t("dns.switched", { dns: prettyDns(cand) }), "warn", 6000, {
      desc: t("dns.switchedDesc"),
    });
    return cand;
  }
  // Все резервы легли тоже — честно сообщаем, настройку не трогаем.
  toast?.(t("dns.allDead"), "error", 7000, { desc: t("dns.allDeadDesc") });
  return null;
}

// Периодический watchdog при connected. onDnsSwitched(newDns) зовётся, когда
// резолвер сменён (main.js делает реконнект, чтобы sing-box перечитал DNS).
let timer = null;
let inFlight = false;

export function startDnsGuard({ toast, isConnected, onDnsSwitched, intervalMs = 150_000 } = {}) {
  stopDnsGuard();
  timer = setInterval(async () => {
    if (inFlight || !isConnected?.()) return;
    inFlight = true;
    try {
      const cur = loadOptions().dns?.directAddress || "";
      if ((await probe(cur)) !== "dead") return; // жив/skip — ничего не делаем
      const next = await ensureWorkingDirectDns({ toast, onlyIf: isConnected });
      if (next) onDnsSwitched?.(next);
    } catch { /* фоновая задача — ошибки не эскалируем */ }
    finally { inFlight = false; }
  }, intervalMs);
}

export function stopDnsGuard() {
  if (timer) { clearInterval(timer); timer = null; }
}
