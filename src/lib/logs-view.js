// Ninety · экран «Логи»: чтение хвоста лог-файлов движков (sing-box/xray/naive/
// trusttunnel/dpi), парсинг в записи, фильтр по уровню/тексту, подсветка.
// Выделен из main.js: вью самодостаточно (свои DOM-refs и invoke); main зовёт
// mountLogsView() на старте, onLogsViewEnter/Leave при навигации и
// rerenderLogsView() при смене языка.

import { activityController } from "/lib/activity-controller.js";
import { perfObserver } from "/lib/performance-observer.js";
import { t } from "/lib/i18n/index.js";
import { toast } from "/lib/toast.js";
import { FLAGS_BASE, flagIsoFromName as isoFromNodeName } from "/lib/flags.js";
import { classifyEngineLogSeverity, healthProbeNodeTag, isGeoLookupNoise } from "/lib/log-severity.js";

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
let logsEntries = [];
let logsLastRenderKey = null;
let logsFilterQuery = "";
let logsFilterLevel = "";
let searchDebounceTimer = null;
let unlistenActivity = null;
let logsRequestId = 0;

function currentLogSource() { return logsSource?.value || "singbox"; }

// Тег активной ноды знает только main.js (эффективный сервер приходит из clash).
// Без него журнал прячет все отчёты health-checker'а — они и относятся к нодам,
// через которые трафик не идёт.
let getActiveNodeTag = () => null;

export function configureLogsRuntime({ getActiveNodeTag: getter } = {}) {
  if (typeof getter === "function") getActiveNodeTag = getter;
}

function formatBytes(n) {
  if (n < 1024) return `${n} ${t("logs.bytesB")}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ${t("logs.bytesKiB")}`;
  return `${(n / 1024 / 1024).toFixed(2)} ${t("logs.bytesMiB")}`;
}

// sing-box stdout: `+0300 2025-01-01 12:34:56 INFO [tag] message`
//                  `12:34:56.123 INFO message`           (timestamp без даты)
//                  `INFO message`                        (timestamp выключен)
//                  `+0300 INFO message`                  (offset без timestamp)
const LOG_LINE_RE = /^(?:([+-]\d{4})\s+)?(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)?\s*(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\s+(.*)$/i;
const LOG_ANSI_RE = /\x1b\[[0-9;]*m/g;        // eslint-disable-line no-control-regex
const LOG_STD_PREFIX_RE = /^(?:STDERR|STDOUT):\s*/;
function cleanLogLine(s) { return s.replace(LOG_ANSI_RE, "").replace(LOG_STD_PREFIX_RE, ""); }

function escapeLog(s) {
  return s.replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

// Порядок подстановок значим. IP и URL подсвечиваем ПЕРВЫМИ — по плоскому
// экранированному тексту. Если делать наоборот, жадный `[^\s]+` URL-регэкспа
// захватывает уже вставленную разметку (`https://x]</b>` внутри `[tag]`) и
// ломает вложенность тегов: браузер закрывает <b> не там, и остаток строки
// уезжает по стилю. Классы символов сужены так, чтобы совпадение не могло
// перешагнуть в тег: `[^\s<]` для URL, `[^\]<]` для тега.
function highlightMessage(msg) {
  return escapeLog(msg)
    .replace(/\b(\d+\.\d+\.\d+\.\d+)(?::\d+)?\b/g, '<span class="acc">$&</span>')
    .replace(/\b(?:wss?|https?):\/\/[^\s<]+/gi, '<span class="acc">$&</span>')
    .replace(/\[([^\]<]+)\]/g, (_m, tag) => {
      const iso = isoFromNodeName(tag);
      const flag = iso ? `<img class="log-flag" src="${FLAGS_BASE}/${iso}.svg" alt="">` : "";
      return `<b>[${flag}${tag}]</b>`;
    });
}

function attachLogFlagFallbacks(root) {
  if (!root) return;
  for (const img of root.querySelectorAll("img.log-flag")) {
    img.addEventListener("error", () => img.remove(), { once: true });
    if (img.complete && img.naturalWidth === 0) img.remove();
  }
}

const LOG_RENDER_MAX_LINES = 800;
const LOG_LEVEL_GROUP = {
  trace: ["TRACE"], debug: ["DEBUG"], info: ["INFO"],
  warn: ["WARN", "WARNING"], error: ["ERROR", "FATAL", "PANIC"],
};

// Парс выполняется только при получении нового file tail. Изменение search/level
// фильтрует уже готовые entries и больше не split/regex-парсит 800 строк заново.
export function parseLogEntries(text, activeNodeTag = getActiveNodeTag()) {
  const lines = String(text || "").split(/\r?\n/).slice(-LOG_RENDER_MAX_LINES);
  const entries = [];
  let cur = null;
  // Отброшенная запись забирает с собой и свои продолжения: иначе хвост
  // многострочной ошибки прилип бы к предыдущей, ни к чему не относящейся.
  let dropped = false;
  for (const raw0 of lines) {
    const raw = cleanLogLine(raw0);
    if (!raw) { if (cur) cur.cont.push(""); continue; }
    const m = LOG_LINE_RE.exec(raw);
    if (m) {
      const [, , date, time, level, rest] = m;
      const probeTag = healthProbeNodeTag(rest);
      if (probeTag && probeTag !== activeNodeTag) { cur = null; dropped = true; continue; }
      if (isGeoLookupNoise(rest)) { cur = null; dropped = true; continue; }
      dropped = false;
      const tm = time || (date ? date.slice(5) : "—");
      const classified = classifyEngineLogSeverity(level, rest);
      cur = { t: tm, lvl: classified.level, grade: classified.grade, msg: rest, cont: [] };
      entries.push(cur);
    } else if (cur) {
      cur.cont.push(raw);
    } else if (!dropped) {
      cur = { t: "—", lvl: "", grade: "info", msg: raw, cont: [] };
      entries.push(cur);
    }
  }
  return entries;
}

export function filterLogEntries(entries, query = logsFilterQuery, level = logsFilterLevel) {
  const group = level ? LOG_LEVEL_GROUP[level] : null;
  const words = query ? query.split(/\s+/).filter(Boolean) : [];
  if (!group && !words.length) return entries;
  return entries.filter((entry) => {
    if (group && !group.includes(entry.lvl)) return false;
    if (words.length) {
      const hay = `${entry.t} ${entry.lvl} ${entry.msg} ${entry.cont.join(" ")}`.toLowerCase();
      if (!words.every((word) => hay.includes(word))) return false;
    }
    return true;
  });
}

function renderLogEntries(entries) {
  const out = [];
  for (const entry of entries) {
    const lvlDisp = entry.lvl || "···";
    const tail = entry.cont.length ? escapeLog("\n" + entry.cont.join("\n")) : "";
    out.push(`<div class="log-line"><span class="log-line__t">${escapeLog(entry.t)}</span><span class="log-line__l log-line__l--${entry.grade}">${lvlDisp}</span><span class="log-line__m">${highlightMessage(entry.msg)}${tail}</span></div>`);
  }
  return out.join("");
}

function logsInfoLine(text) {
  return `<div class="log-line"><span class="log-line__t">—</span><span class="log-line__l log-line__l--info">···</span><span class="log-line__m" style="font-style:italic;color:var(--text-faint)">${escapeLog(text)}</span></div>`;
}

// Дешёвый ключ вместо сравнения собранного HTML целиком. Прежняя проверка
// требовала сначала склеить всю разметку и только затем сравнить её посимвольно
// с прошлым результатом — и то и другое на каждом тике таймера, даже когда
// показывать нечего нового.
function logsRenderKey(count) {
  return `${currentLogSource()} ${logsLastValue.length} ${count} ${logsFilterQuery} ${logsFilterLevel}`;
}

function applyLogsRender({ keepScroll = false, force = false } = {}) {
  if (!logsView) return;
  const text = logsLastValue && logsLastValue !== "__force__" ? logsLastValue : "";
  const atBottom = !keepScroll || (logsView.scrollTop + logsView.clientHeight >= logsView.scrollHeight - 24);

  const filtered = text ? filterLogEntries(logsEntries) : [];
  const key = text ? logsRenderKey(filtered.length) : `empty ${currentLogSource()}`;
  if (!force && key === logsLastRenderKey) {
    perfObserver.increment("logs.render.suppressed");
    if (atBottom) logsView.scrollTop = logsView.scrollHeight;
    return;
  }

  let html;
  if (!text) {
    const label = LOG_SOURCE_LABEL[currentLogSource()] || t("logs.compFallback");
    html = logsInfoLine(t("logs.empty", { comp: label }));
  } else {
    html = filtered.length ? renderLogEntries(filtered) : logsInfoLine(t("logs.notFound"));
  }

  const finish = perfObserver.time("logs.render.ms", { entries: logsEntries.length });
  logsView.innerHTML = html;
  logsLastRenderKey = key;
  attachLogFlagFallbacks(logsView);
  finish();
  if (atBottom) logsView.scrollTop = logsView.scrollHeight;
}

async function refreshLogs({ keepScroll = false } = {}) {
  if (!logsView || !activityController.isInteractive()) return;
  const requestId = ++logsRequestId;
  const source = currentLogSource();
  try {
    const finish = perfObserver.time("logs.read.ms", { source });
    const text = await invoke("read_log", { source, tailBytes: 256 * 1024 });
    finish();
    if (requestId !== logsRequestId || source !== currentLogSource()) return;
    if (text === logsLastValue) return;
    logsLastValue = text;
    logsEntries = parseLogEntries(text);
    logsLastRenderKey = null;
    if (logsSize) {
      // Blob().size даёт длину в байтах без второй копии всего хвоста в памяти:
      // TextEncoder().encode() аллоцировал ещё 256 КБ каждые 2 секунды только
      // ради одного числа.
      const bytes = text ? new Blob([text]).size : 0;
      logsSize.textContent = text ? formatBytes(bytes) : t("logs.sizeEmpty");
    }
    applyLogsRender({ keepScroll });
  } catch (e) {
    if (requestId !== logsRequestId || source !== currentLogSource()) return;
    logsView.innerHTML = `<div class="log-line"><span class="log-line__t">—</span><span class="log-line__l log-line__l--err">ERR</span><span class="log-line__m">${escapeLog(t("logs.readErr", { err: e?.message || e }))}</span></div>`;
  }
}

async function refreshLogsPath() {
  if (!logsPath) return;
  try {
    const path = await invoke("singbox_log_path");
    const dir = path.replace(/[\\/][^\\/]*$/, "");
    logsPath.textContent = dir;
    logsPath.title = t("logs.pathTitle");
  } catch {
    logsPath.textContent = "—";
  }
}

function startLogsAuto() {
  stopLogsAuto();
  if (!logsAuto?.checked || !logsActive || !activityController.isInteractive()) return;
  logsTimer = setInterval(() => refreshLogs({ keepScroll: true }), 2000);
}

function stopLogsAuto() {
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
}

function applyKicker() {
  if (logsKicker) logsKicker.textContent = `${t("logs.kicker")} · ${LOG_SOURCE_LABEL[currentLogSource()] || "—"}`;
}

function resetLogCache() {
  logsLastValue = "__force__";
  logsEntries = [];
  logsLastRenderKey = null;
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

  if (!unlistenActivity) {
    unlistenActivity = activityController.subscribe(({ visible, focused }) => {
      if (!logsActive) return;
      if (visible && focused) {
        refreshLogs({ keepScroll: true });
        startLogsAuto();
      } else {
        stopLogsAuto();
        perfObserver.increment("logs.auto.pauses");
      }
    });
  }

  logsAuto?.addEventListener("change", () => {
    if (logsActive && logsAuto.checked) startLogsAuto();
    else stopLogsAuto();
  });

  logsRefreshBtn?.addEventListener("click", () => refreshLogs());

  logsSearch?.addEventListener("input", () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      logsFilterQuery = logsSearch.value.trim().toLowerCase();
      applyLogsRender();
    }, 120);
  });

  logsLevel?.addEventListener("change", () => {
    logsFilterLevel = logsLevel.value;
    applyLogsRender();
  });

  logsSource?.addEventListener("change", () => {
    logsRequestId++;
    applyKicker();
    resetLogCache();
    refreshLogs();
  });

  logsCopyBtn?.addEventListener("click", async () => {
    const raw = logsLastValue && logsLastValue !== "__force__" ? logsLastValue : "";
    if (!raw) { toast(t("logs.emptyToast"), "info", 1400); return; }
    const text = raw.split(/\r?\n/).map(cleanLogLine).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast(t("logs.copied"), "success", 1600);
    } catch {
      toast(t("logs.copyErr"), "error", 3000);
    }
  });

  logsClearBtn?.addEventListener("click", async () => {
    logsRequestId++;
    const source = currentLogSource();
    try {
      await invoke("clear_log", { source });
      if (source !== currentLogSource()) return;
      resetLogCache();
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
  logsRequestId++;
  stopLogsAuto();
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
}

// Смена языка интерфейса: перерисовать кикер/контент/путь, если экран активен.
export function rerenderLogsView() {
  if (!logsActive) return;
  applyKicker();
  logsLastRenderKey = null;
  applyLogsRender({ keepScroll: true, force: true });
  refreshLogsPath();
}
