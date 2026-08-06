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
//
// За DoH обязательно идут plain-DNS ступени. ТСПУ режет DoH КЛАССОМ, а не по
// одному адресу: 06.08.2026 разом легли :443 у Quad9, Yandex, Google и Cloudflare
// при живом UDP:53 и живом обычном TCP:443. Цепочка из одних DoH в такой день
// вырождается — все кандидаты мертвы, guard уходит в all-dead и НЕ лечит, хотя
// рабочий резолвер под рукой. Plain-DNS слабее (открытый запрос, подмена
// провайдером), поэтому он ниже DoH, но он последняя ступень, на которой
// туннель вообще поднимается.

import { loadOptions, updateOption } from "/lib/options.js";
import { t } from "/lib/i18n/index.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// Нейтральный контрольный домен (IANA, вечный) — проверяем сам факт резолюции,
// не привязываясь к конкретной ноде/инфре.
const CONTROL_HOST = "example.com";

// Цепочка резервов: DoH (Quad9 → Yandex), затем plain-DNS теми же операторами.
// Дефолтный direct-DNS (Yandex UDP) в вершину не ставим — если упал именно он,
// Quad9 надёжнее; но ниже он обязан быть, иначе уход с UDP на DoH необратим.
const FALLBACKS = [
  "https://149.112.112.112/dns-query", // Quad9 secondary DoH
  "https://77.88.8.8/dns-query",        // Yandex DoH (крайний DoH-резерв)
  "udp://149.112.112.112",              // Quad9 plain — когда DoH срезан классом
  "udp://77.88.8.8",                    // Yandex plain — дефолт, самый живучий в РФ
];

const PROBE_TIMEOUT_MS = 4000;
// Все резервы легли = скорее всего нет сети вообще. Не спамим: тост не чаще
// раза в 30 мин, watchdog после этого отступает на 15 мин.
const ALL_DEAD_TOAST_GAP_MS = 30 * 60_000;
const ALL_DEAD_BACKOFF_MS = 15 * 60_000;
let lastAllDeadToastAt = 0;
let allDeadBackoffUntil = 0;

// Короткое человекочитаемое имя DNS для тоста.
function prettyDns(dns) {
  try {
    if (dns.startsWith("https://")) return new URL(dns).hostname;
    return dns.replace(/^\w+:\/\//, "");
  } catch { return dns; }
}

async function probe(dns) {
  try {
    const r = await invoke("dns_probe", { dns, host: CONTROL_HOST, timeoutMs: PROBE_TIMEOUT_MS });
    // Причину смерти — в console: без неё «почему dead» не выяснить (так и
    // отловили бы 505 от HTTP/1.1-пробы сразу, а не по жалобе на тосты).
    if (r?.status === "dead") console.warn("[dns-guard] проба dead:", dns, r?.detail || "");
    return r?.status || "skip";
  } catch (e) {
    console.warn("[dns-guard] dns_probe invoke failed:", e?.message || e);
    return "skip";
  }
}

// Проверяет текущий direct-DNS; если он "dead" — ищет первый рабочий резерв,
// сохраняет его в настройки и возвращает новый адрес (иначе null — трогать нечего).
// toast инжектится из main.js. onlyIf — предикат «ещё актуально» (не переключать,
// если юзер за время пробы отключился/сменил источник).
export async function ensureWorkingDirectDns({ toast, onlyIf } = {}) {
  const cur = loadOptions().dns?.directAddress || "";
  const st = await probe(cur);
  if (st !== "dead") return null; // ok / skip — не вмешиваемся
  // Перепроверка: не переключаемся по одиночному сбою (сеть моргнула, пакет
  // потерялся) — dead признаём только по двум провалам подряд.
  if ((await probe(cur)) !== "dead") return null;
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
  // Все резервы легли тоже — настройку не трогаем; сообщаем сдержанно
  // (гейт по времени), watchdog отступает — иначе тост долбил каждый тик.
  allDeadBackoffUntil = Date.now() + ALL_DEAD_BACKOFF_MS;
  if (Date.now() - lastAllDeadToastAt >= ALL_DEAD_TOAST_GAP_MS) {
    lastAllDeadToastAt = Date.now();
    toast?.(t("dns.allDead"), "error", 7000, { desc: t("dns.allDeadDesc") });
  }
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
    if (Date.now() < allDeadBackoffUntil) return; // после all-dead — отступаем
    inFlight = true;
    try {
      // ensureWorkingDirectDns сам делает быстрый выход по первой ok-пробе и
      // double-check перед переключением — отдельная предпроба не нужна.
      const next = await ensureWorkingDirectDns({ toast, onlyIf: isConnected });
      if (next) onDnsSwitched?.(next);
    } catch { /* фоновая задача — ошибки не эскалируем */ }
    finally { inFlight = false; }
  }, intervalMs);
}

export function stopDnsGuard() {
  if (timer) { clearInterval(timer); timer = null; }
}
