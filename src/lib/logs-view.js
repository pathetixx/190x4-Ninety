// Ninety · экран «Логи»: чтение хвоста лог-файлов движков (sing-box/xray/naive/
// trusttunnel/dpi), парсинг в записи, фильтр по уровню/тексту, подсветка.
// Выделен из main.js: вью самодостаточно (свои DOM-refs и invoke); main зовёт
// mountLogsView() на старте, onLogsViewEnter/Leave при навигации и
// rerenderLogsView() при смене языка.

import { t } from "/lib/i18n/index.js";
import { toast } from "/lib/toast.js";
import { FLAGS_BASE, flagIsoFromName as isoFromNodeName } from "/lib/flags.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const LOG_SOURCE_LABEL = {
  singbox: "SING-BOX", xray: "XRAY", naive: "NAIVE",
  trusttunnel: "TRUSTTUNNEL", dpi: "DPI · WINWS",
};

let logsView, logsPath, logsSize, logsAuto, logsRefreshBtn, logsCopyBtn,
  logsClearBtn, logsOpenBtn, logsSearch, logsLevel, logsSource, logsKicker;

let logsTimer = null;
let logsActive = false;
let logsLastValue = "";
let logsFilterQuery = "";
let logsFilterLevel = "";

function currentLogSource() { return logsSource?.value || "singbox"; }

function formatBytes(n) {
  if (n < 1024) return `${n} ${t("logs.bytesB")}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ${t("logs.bytesKiB")}`;
  return `${(n / 1024 / 1024).toFixed(2)} ${t("logs.bytesMiB")}`;
}

// sing-box stdout: `+0300 2025-01-01 12:34:56 INFO [tag] message`
//                  `12:34:56.123 INFO message`           (timestamp без даты)
//                  `INFO message`                        (timestamp выключен)
//                  `+0300 INFO message`                  (offset без timestamp)
// Группы: 1=offset, 2=date, 3=time, 4=level, 5=rest
const LOG_LINE_RE = /^(?:([+-]\d{4})\s+)?(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)?\s*(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\s+(.*)$/i;

// sing-box/xray льют в stderr с ANSI-цветами, а капча процессов префиксует строку
// «STDERR: »/«STDOUT: ». И то и другое сбивает LOG_LINE_RE (уровень обёрнут в \x1b[..m,
// якорь ^ упирается в префикс) → строка падала в сырьё. Снимаем перед парсингом.
const LOG_ANSI_RE = /\x1b\[[0-9;]*m/g;        // eslint-disable-line no-control-regex
const LOG_STD_PREFIX_RE = /^(?:STDERR|STDOUT):\s*/;
function cleanLogLine(s) { return s.replace(LOG_ANSI_RE, "").replace(LOG_STD_PREFIX_RE, ""); }

function levelGrade(lvl) {
  const l = lvl.toUpperCase();
  if (l === "ERROR" || l === "FATAL" || l === "PANIC") return "err";
  if (l === "WARN" || l === "WARNING") return "warn";
  if (l === "TRACE" || l === "DEBUG") return "ok";
  return "info";
}

function escapeLog(s) {
  return s.replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

function highlightMessage(msg) {
  const safe = escapeLog(msg);
  // tag в [скобках] подсветить; если в теге узнаётся страна (имя ноды
  // «node-17-Latvia-…») — вклеиваем флаг той же логикой, что на экране Нод.
  // Служебные скобки ([mixed-in], [3589469481 0ms], [direct]) флага не дают —
  // flagIsoFromName на них возвращает null. Фолбэк битого .svg — attachLogFlagFallbacks.
  return safe
    .replace(/\[([^\]]+)\]/g, (_m, tag) => {
      const iso = isoFromNodeName(tag);
      const flag = iso ? `<img class="log-flag" src="${FLAGS_BASE}/${iso}.svg" alt="">` : '';
      return `<b>[${flag}${tag}]</b>`;
    })
    .replace(/\b(\d+\.\d+\.\d+\.\d+)(?::\d+)?\b/g, '<span class="acc">$&</span>')
    .replace(/\b(?:wss?|https?):\/\/[^\s]+/gi, '<span class="acc">$&</span>');
}

// CSP-safe фолбэк для флагов в логах (inline onerror блокируется): битый .svg
// просто убираем — остаётся обычный тег ноды. Зовётся после каждого рендера лога.
function attachLogFlagFallbacks(root) {
  if (!root) return;
  for (const img of root.querySelectorAll("img.log-flag")) {
    img.addEventListener("error", () => img.remove(), { once: true });
    if (img.complete && img.naturalWidth === 0) img.remove();
  }
}

const LOG_RENDER_MAX_LINES = 800;
// Уровень из дропдауна → набор токенов лога. WARN/WARNING и ERROR/FATAL/PANIC
// группируются, чтобы «warn»/«error» ловили все варианты.
const LOG_LEVEL_GROUP = {
  trace: ["TRACE"], debug: ["DEBUG"], info: ["INFO"],
  warn: ["WARN", "WARNING"], error: ["ERROR", "FATAL", "PANIC"],
};

// Парс текста лога в структурные записи (с прилепленными многострочными
// продолжениями) — нужно, чтобы фильтр по уровню/тексту работал по записи
// целиком, не разрывая мульти-line сообщения.
function parseLogEntries(text) {
  const lines = text.split(/\r?\n/).slice(-LOG_RENDER_MAX_LINES);
  const entries = [];
  let cur = null;
  for (const raw0 of lines) {
    const raw = cleanLogLine(raw0);
    if (!raw) { if (cur) cur.cont.push(''); continue; }
    const m = LOG_LINE_RE.exec(raw);
    if (m) {
      const [, , date, time, level, rest] = m;
      // НЕ называть локальную переменную t — затенила бы i18n-функцию (см.
      // прецедент R3 в quality-actions).
      const tm = time || (date ? date.slice(5) : '—');
      const lvl = level.toUpperCase();
      cur = { t: tm, lvl, grade: levelGrade(lvl), msg: rest, cont: [] };
      entries.push(cur);
    } else if (cur) {
      cur.cont.push(raw);
    } else {
      cur = { t: '—', lvl: '', grade: 'info', msg: raw, cont: [] };
      entries.push(cur);
    }
  }
  return entries;
}

function filterLogEntries(entries) {
  const group = logsFilterLevel ? LOG_LEVEL_GROUP[logsFilterLevel] : null;
  const words = logsFilterQuery ? logsFilterQuery.split(/\s+/).filter(Boolean) : [];
  if (!group && !words.length) return entries;
  return entries.filter(e => {
    if (group && !group.includes(e.lvl)) return false;
    if (words.length) {
      const hay = `${e.t} ${e.lvl} ${e.msg} ${e.cont.join(' ')}`.toLowerCase();
      if (!words.every(w => hay.includes(w))) return false;
    }
    return true;
  });
}

function renderLogEntries(entries) {
  const out = [];
  for (const e of entries) {
    const lvlDisp = e.lvl || '···';
    const tail = e.cont.length ? escapeLog('\n' + e.cont.join('\n')) : '';
    out.push(`<div class="log-line"><span class="log-line__t">${escapeLog(e.t)}</span><span class="log-line__l log-line__l--${e.grade}">${lvlDisp}</span><span class="log-line__m">${highlightMessage(e.msg)}${tail}</span></div>`);
  }
  return out.join('');
}

function logsInfoLine(text) {
  return `<div class="log-line"><span class="log-line__t">—</span><span class="log-line__l log-line__l--info">···</span><span class="log-line__m" style="font-style:italic;color:var(--text-faint)">${escapeLog(text)}</span></div>`;
}

// Рендер из кэша (logsLastValue) с учётом фильтров — зовётся и при обновлении
// лога, и при смене фильтра (без повторного чтения файла).
function applyLogsRender({ keepScroll = false } = {}) {
  if (!logsView) return;
  const text = logsLastValue && logsLastValue !== "__force__" ? logsLastValue : "";
  const atBottom = !keepScroll || (logsView.scrollTop + logsView.clientHeight >= logsView.scrollHeight - 24);
  if (!text) {
    const label = LOG_SOURCE_LABEL[currentLogSource()] || t("logs.compFallback");
    logsView.innerHTML = logsInfoLine(t("logs.empty", { comp: label }));
  } else {
    const filtered = filterLogEntries(parseLogEntries(text));
    logsView.innerHTML = filtered.length
      ? renderLogEntries(filtered)
      : logsInfoLine(t("logs.notFound"));
    attachLogFlagFallbacks(logsView);
  }
  if (atBottom) logsView.scrollTop = logsView.scrollHeight;
}

async function refreshLogs({ keepScroll = false } = {}) {
  if (!logsView) return;
  try {
    const text = await invoke("read_log", { source: currentLogSource(), tailBytes: 256 * 1024 });
    if (text === logsLastValue) return;
    logsLastValue = text;
    if (logsSize) {
      const bytes = new TextEncoder().encode(text || "").length;
      logsSize.textContent = text ? formatBytes(bytes) : t("logs.sizeEmpty");
    }
    applyLogsRender({ keepScroll });
  } catch (e) {
    logsView.innerHTML = `<div class="log-line"><span class="log-line__t">—</span><span class="log-line__l log-line__l--err">ERR</span><span class="log-line__m">${escapeLog(t("logs.readErr", { err: e?.message || e }))}</span></div>`;
  }
}

async function refreshLogsPath() {
  if (!logsPath) return;
  try {
    const path = await invoke("singbox_log_path");
    // Показываем ПАПКУ журналов, а не singbox.log: в ней лежат логи всех
    // компонентов (sing-box, xray, naive, trusttunnel, dpi). Кнопка «Папка»
    // её открывает. В консоли ниже — лог ядра sing-box.
    const dir = path.replace(/[\\/][^\\/]*$/, "");
    logsPath.textContent = dir;
    logsPath.title = t("logs.pathTitle");
  } catch {
    logsPath.textContent = "—";
  }
}

function startLogsAuto() {
  stopLogsAuto();
  if (!logsAuto?.checked) return;
  logsTimer = setInterval(() => refreshLogs({ keepScroll: true }), 2000);
}

function stopLogsAuto() {
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
}

function applyKicker() {
  if (logsKicker) logsKicker.textContent = `${t("logs.kicker")} · ${LOG_SOURCE_LABEL[currentLogSource()] || "—"}`;
}

export function mountLogsView() {
  logsView = document.getElementById("logs-view");
  logsPath = document.getElementById("logs-path");
  logsSize = document.getElementById("logs-size");
  logsAuto = document.getElementById("logs-auto");
  logsRefreshBtn = document.getElementById("logs-refresh");
  logsCopyBtn = document.getElementById("logs-copy");
  logsClearBtn = document.getElementById("logs-clear");
  logsOpenBtn = document.getElementById("logs-open");
  logsSearch = document.getElementById("logs-search");
  logsLevel = document.getElementById("logs-level");
  logsSource = document.getElementById("logs-source");
  logsKicker = document.getElementById("logs-kicker");

  logsAuto?.addEventListener("change", () => {
    if (logsActive && logsAuto.checked) startLogsAuto();
    else stopLogsAuto();
  });

  logsRefreshBtn?.addEventListener("click", () => refreshLogs());

  logsSearch?.addEventListener("input", () => {
    logsFilterQuery = logsSearch.value.trim().toLowerCase();
    applyLogsRender();
  });

  logsLevel?.addEventListener("change", () => {
    logsFilterLevel = logsLevel.value;
    applyLogsRender();
  });

  logsSource?.addEventListener("change", () => {
    applyKicker();
    logsLastValue = "__force__"; // сменился источник — перечитать файл и перерисовать
    refreshLogs();
  });

  logsCopyBtn?.addEventListener("click", async () => {
    const raw = logsLastValue && logsLastValue !== "__force__" ? logsLastValue : "";
    if (!raw) { toast(t("logs.emptyToast"), "info", 1400); return; }
    // копируем без ANSI/префиксов — ровно то, что на экране, а не управляющие коды
    const text = raw.split(/\r?\n/).map(cleanLogLine).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast(t("logs.copied"), "success", 1600);
    } catch {
      toast(t("logs.copyErr"), "error", 3000);
    }
  });

  logsClearBtn?.addEventListener("click", async () => {
    try {
      await invoke("clear_log", { source: currentLogSource() });
      logsLastValue = "__force__";
      await refreshLogs();
      toast(t("logs.cleared"), "info", 1400);
    } catch (e) {
      toast(t("logs.clearErr", { err: e?.message || e }), "error", 2500);
    }
  });

  logsOpenBtn?.addEventListener("click", async () => {
    try { await invoke("open_log_dir"); }
    catch (e) { toast(t("logs.openErr", { err: e?.message || e }), "error", 2500); }
  });
}

export function onLogsViewEnter() {
  logsActive = true;
  refreshLogsPath();
  refreshLogs();
  startLogsAuto();
}

export function onLogsViewLeave() {
  logsActive = false;
  stopLogsAuto();
}

// Смена языка интерфейса: перерисовать кикер/контент/путь, если экран активен.
export function rerenderLogsView() {
  if (!logsActive) return;
  applyKicker();
  applyLogsRender({ keepScroll: true });
  refreshLogsPath();
}
