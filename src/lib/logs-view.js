// Ninety · the "Logs" screen: reading the tail of engine log files (sing-box/xray/naive/
// trusttunnel/dpi), parsing into records, filtering by level/text, highlighting.
// Split out of main.js: the view is self-contained (its own DOM refs and invoke); main calls
// mountLogsView() at startup, onLogsViewEnter/Leave on navigation and
// rerenderLogsView() on a language change.

import { activityController } from "/lib/activity-controller.js";
import { perfObserver } from "/lib/performance-observer.js";
import { t } from "/lib/i18n/index.js";
import { toast } from "/lib/toast.js";
import { FLAGS_BASE, flagIsoFromName as isoFromNodeName } from "/lib/flags.js";
import { classifyEngineLogSeverity, healthProbeNodeTag } from "/lib/log-severity.js";
import { openPMenu, wantsNativeContextMenu } from "/lib/pmenu.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const ICON_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
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
// The position in the file from which the backend will continue reading next time. null = read
// the whole tail (first visit, source change, log cleared, a composite
// source like naive/trusttunnel — those have no single position).
let logsOffset = null;
// Version of the accumulated tail. The render key is computed from it, not from the buffer length:
// when appending, as much is cut off at the top as arrived at the bottom, and the length
// may match the previous one — the render would decide there's nothing new to show.
let logsBufferVersion = 0;
// The selection (source + filters) the current DOM was built for, and a flag
// that the container holds a service line rather than log records.
let logsRenderedScope = null;
let logsRenderedInfo = true;
let logsEntries = [];
let logsLastRenderKey = null;
let logsFilterQuery = "";
let logsFilterLevel = "";
let searchDebounceTimer = null;
let unlistenActivity = null;
let logsRequestId = 0;

function currentLogSource() { return logsSource?.value || "singbox"; }

// Only main.js knows the active node's tag (the effective server comes from clash).
// Without it the log hides all health checker reports — they're about nodes
// the traffic doesn't go through.
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
//                  `12:34:56.123 INFO message`           (timestamp without a date)
//                  `INFO message`                        (timestamp disabled)
//                  `+0300 INFO message`                  (offset without a timestamp)
const LOG_LINE_RE = /^(?:([+-]\d{4})\s+)?(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)?\s*(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\s+(.*)$/i;
const LOG_ANSI_RE = /\x1b\[[0-9;]*m/g;        // eslint-disable-line no-control-regex
const LOG_STD_PREFIX_RE = /^(?:STDERR|STDOUT):\s*/;
function cleanLogLine(s) { return s.replace(LOG_ANSI_RE, "").replace(LOG_STD_PREFIX_RE, ""); }

function escapeLog(s) {
  return s.replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

// The order of substitutions matters. IPs and URLs are highlighted FIRST — on the flat
// escaped text. Done the other way around, the URL regex's greedy `[^\s]+`
// captures already inserted markup (`https://x]</b>` inside `[tag]`) and
// breaks tag nesting: the browser closes <b> in the wrong place, and the rest of the line
// gets the wrong style. The character classes are narrowed so that a match can't
// step into a tag: `[^\s<]` for URLs, `[^\]<]` for a tag.
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
// The tail is read exactly to what the view is able to show: the render is
// cut to LOG_RENDER_MAX_LINES anyway, and the former 256 KB was sent every two seconds
// through IPC and parsed entirely just to throw half of it away right away.
const LOG_TAIL_BYTES = 128 * 1024;

// Length in bytes without a second copy of the tail in memory. Blob([text]) and
// TextEncoder().encode() allocated another hundred kilobytes for a single number on
// every timer tick.
function utf8Size(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
const LOG_LEVEL_GROUP = {
  trace: ["TRACE"], debug: ["DEBUG"], info: ["INFO"],
  warn: ["WARN", "WARNING"], error: ["ERROR", "FATAL", "PANIC"],
};

// Parsing happens only when a new file tail arrives. Changing search/level
// filters the already prepared entries and no longer splits/regex-parses 800 lines anew.
//
// carry is the last already parsed record, when an APPENDED chunk of the log is parsed:
// a multiline record (a stack, a config dump) is split at the chunk boundary, and its
// continuation must stick to that record rather than become a new levelless one.
// The record is mutated in place and doesn't get into the result — it's already in the list.
export function parseLogEntries(text, activeNodeTag = getActiveNodeTag(), { carry = null } = {}) {
  const lines = String(text || "").split(/\r?\n/).slice(-LOG_RENDER_MAX_LINES);
  const entries = [];
  let cur = carry;
  // A dropped record takes its continuations with it: otherwise the tail
  // of a multiline error would stick to the previous, unrelated one.
  let dropped = false;
  for (const raw0 of lines) {
    const raw = cleanLogLine(raw0);
    if (!raw) { if (cur) cur.cont.push(""); continue; }
    const m = LOG_LINE_RE.exec(raw);
    if (m) {
      const [, , date, time, level, rest] = m;
      const probeTag = healthProbeNodeTag(rest);
      if (probeTag && probeTag !== activeNodeTag) { cur = null; dropped = true; continue; }
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
  return `<div class="log-line"><span class="log-line__t">—</span><span class="log-line__l log-line__l--info">···</span><span class="log-line__m" style="font-style:italic;color:var(--text-lo)">${escapeLog(text)}</span></div>`;
}

// A cheap key instead of comparing the whole assembled HTML. The former check
// required first gluing all the markup together and only then comparing it character by character
// with the previous result — both on every timer tick, even when
// there's nothing new to show.
//
// The number of rendered lines is no longer in the key: the buffer version changes on any
// content change, and the filters are part of the key themselves — so there's no need to compute
// the filtered list just for one key.
function logsRenderKey() {
  return `${currentLogSource()}\u0000${logsBufferVersion}\u0000${logsFilterQuery}\u0000${logsFilterLevel}`;
}

// What is drawn right now. Appending to the end is possible only while it's the same
// source with the same filters and while the container holds log lines, not
// the "log is empty" / "nothing found" service line.
function logsRenderScope() {
  return `${currentLogSource()}\u0000${logsFilterQuery}\u0000${logsFilterLevel}`;
}

// Append to the end instead of rebuilding. The delta is already known — no point assembling and
// parsing the markup of eight hundred lines, each with a flag and highlighting, for one
// new one. false = can't append, the caller does a full render.
function appendRenderedLines({ added, dropped, carryGrew }) {
  if (logsRenderedInfo || logsRenderScope() !== logsRenderedScope) return false;
  if (!logsView.firstElementChild) return false;
  // The chunk started with the continuation of a multiline record: it's already drawn, and
  // its tail can't be appended to the end of the list — there it would end up as a separate
  // line. We rebuild entirely, otherwise the error's tail isn't visible until the filter
  // or source changes.
  if (carryGrew) return false;

  const visible = filterLogEntries(added);
  if (visible.length) {
    const first = logsView.childElementCount;
    logsView.insertAdjacentHTML("beforeend", renderLogEntries(visible));
    // Flag fallbacks are attached only to the appended part: the other lines already have them.
    for (let i = first; i < logsView.childElementCount; i++) {
      attachLogFlagFallbacks(logsView.children[i]);
    }
  }
  // From the top we remove exactly as many lines as left the record list and
  // were visible on screen: under a filter some records aren't drawn.
  const gone = dropped.length ? filterLogEntries(dropped).length : 0;
  for (let i = 0; i < gone && logsView.firstElementChild; i++) {
    logsView.firstElementChild.remove();
  }
  return true;
}

function applyLogsRender({ keepScroll = false, force = false, delta = null } = {}) {
  if (!logsView) return;
  const text = logsLastValue && logsLastValue !== "__force__" ? logsLastValue : "";
  const atBottom = !keepScroll || (logsView.scrollTop + logsView.clientHeight >= logsView.scrollHeight - 24);

  const key = text ? logsRenderKey() : `empty\u0000${currentLogSource()}`;
  if (!force && key === logsLastRenderKey) {
    perfObserver.increment("logs.render.suppressed");
    if (atBottom) logsView.scrollTop = logsView.scrollHeight;
    return;
  }

  // A delta arrived and the screen shows the same selection — append instead of rebuilding.
  if (text && !force && delta) {
    const finish = perfObserver.time("logs.render.append.ms", { added: delta.added.length });
    const appended = appendRenderedLines(delta);
    finish();
    if (appended) {
      logsLastRenderKey = key;
      if (atBottom) logsView.scrollTop = logsView.scrollHeight;
      return;
    }
    perfObserver.increment("logs.render.append.rejected");
  }

  const filtered = text ? filterLogEntries(logsEntries) : [];
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
  logsRenderedScope = logsRenderScope();
  logsRenderedInfo = !text || !filtered.length;
  attachLogFlagFallbacks(logsView);
  finish();
  if (atBottom) logsView.scrollTop = logsView.scrollHeight;
}

// The raw tail is kept to exactly what the view can show: it's needed by the "Copy"
// button and the size counter, not for endless accumulation in memory.
function trimRawTail(text) {
  if (text.length <= LOG_TAIL_BYTES) return text;
  const cut = text.length - LOG_TAIL_BYTES;
  const nl = text.indexOf("\n", cut);
  return text.slice(nl >= 0 ? nl + 1 : cut);
}

// Applying an appended chunk to the record list — without DOM and module
// state, so that the chunk boundary can be checked by a test.
//
// carryGrew=true means the chunk started with a continuation of the last record:
// it's already drawn, it isn't in `added`, and its tail can't be appended to the end of the list —
// the render will have to rebuild the list entirely.
export function applyLogChunk(entries, text, activeNodeTag, maxLines = LOG_RENDER_MAX_LINES) {
  const carry = entries.length ? entries[entries.length - 1] : null;
  const carryLines = carry ? carry.cont.length : 0;
  // A chunk always ends with a line break (the backend cuts exactly at it), and
  // the empty remainder after split would go into the previous record's cont as an extra
  // line break — at the boundary of every chunk, not once at the end of the file.
  const chunk = text.endsWith("\n") ? text.slice(0, -1) : text;
  const added = parseLogEntries(chunk, activeNodeTag, { carry });
  for (const entry of added) entries.push(entry);
  let dropped = [];
  if (entries.length > maxLines) {
    dropped = entries.splice(0, entries.length - maxLines);
  }
  return { added, dropped, carryGrew: !!carry && carry.cont.length !== carryLines };
}

// An appended chunk: we parse ONLY it and attach it to the already parsed part.
// Previously the whole tail was reparsed every two seconds.
function appendLogText(text) {
  const delta = applyLogChunk(logsEntries, text, getActiveNodeTag());
  logsLastValue = trimRawTail(logsLastValue + text);
  logsBufferVersion++;
  // The delta is returned to the outside: the render uses it to append lines instead of rebuilding.
  return delta;
}

async function refreshLogs({ keepScroll = false } = {}) {
  if (!logsView || !activityController.isInteractive()) return;
  const requestId = ++logsRequestId;
  const source = currentLogSource();
  try {
    const finish = perfObserver.time("logs.read.ms", { source });
    const chunk = await invoke("read_log_chunk", {
      source,
      tailBytes: LOG_TAIL_BYTES,
      fromOffset: logsOffset,
    });
    finish();
    if (requestId !== logsRequestId || source !== currentLogSource()) return;
    const text = chunk?.text || "";
    // reset=true — the backend returned the whole tail (first read, log cleared,
    // rotation, a gap larger than the shown tail): the accumulated data is replaced.
    const reset = chunk?.reset !== false;
    logsOffset = chunk?.incremental ? (chunk.offset ?? null) : null;
    let delta = null;
    if (reset) {
      if (text === logsLastValue) return;
      logsLastValue = text;
      logsBufferVersion++;
      logsEntries = parseLogEntries(text);
      perfObserver.increment("logs.read.full");
    } else {
      // The most frequent case: nothing was appended to the file since the last tick.
      if (!text) {
        perfObserver.increment("logs.read.idle");
        return;
      }
      delta = appendLogText(text);
      perfObserver.sample("logs.read.delta.bytes", text.length);
    }
    logsLastRenderKey = null;
    if (logsSize) {
      logsSize.textContent = logsLastValue
        ? formatBytes(utf8Size(logsLastValue))
        : t("logs.sizeEmpty");
    }
    applyLogsRender({ keepScroll, delta });
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
  logsBufferVersion++;
  logsRenderedScope = null;
  logsRenderedInfo = true;
  // The position is reset too: the next response must come as a full tail,
  // otherwise a delta would stick to someone else's (or an already cleared) log.
  logsOffset = null;
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

  // Right click on a log line: copy the line or the whole log. On
  // selected text the WebView2 menu stays — "Copy" is needed there.
  logsView?.addEventListener("contextmenu", (e) => {
    if (wantsNativeContextMenu(e.target, window.getSelection())) return;
    const line = e.target.closest(".log-line");
    if (!line) return;
    e.preventDefault();
    openPMenu({ x: e.clientX, y: e.clientY }, [
      { id: "line", label: t("logs.copyLine"), icon: ICON_COPY },
      { id: "all", label: t("logs.copyAll"), icon: ICON_COPY },
    ], {
      onSelect: async (act) => {
        if (act === "all") { logsCopyBtn?.click(); return; }
        const text = [...line.children].map((c) => c.textContent.trim()).filter(Boolean).join("  ");
        try {
          await navigator.clipboard.writeText(text);
          toast(t("logs.lineCopied"), "success", 1400);
        } catch {
          toast(t("logs.copyErr"), "error", 3000);
        }
      },
    });
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

// Interface language change: redraw the kicker/content/path if the screen is active.
export function rerenderLogsView() {
  if (!logsActive) return;
  applyKicker();
  logsLastRenderKey = null;
  applyLogsRender({ keepScroll: true, force: true });
  refreshLogsPath();
}
