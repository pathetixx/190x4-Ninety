// Ninety · Proxies view — SVG-флаги, авто-сортировка по пингу,
// клик-выбор через Selector, AUTO-режим сверху, FAB-молния перетеста.

import {
  getProxies, testGroup, testNode, selectProxy,
  pickSelectorNow, pickEffectiveNode,
  lastDelay, gradeDelay,
} from "/lib/clash-api.js";
import { getActiveSource, nodeTag } from "/lib/singbox.js";
import { FLAGS_BASE, flagIsoFromName, stripFlag } from "/lib/flags.js";
import { escapeHtml, escapeAttr } from "/lib/esc.js";
import { t, getLang } from "/lib/i18n/index.js";
import {
  getRememberedProxySelection,
  rememberProxySelection,
} from "/lib/proxy-selection.js";
import { getFavourites, toggleFavourite } from "/lib/favourites.js";

function $(id) { return document.getElementById(id); }

const POLL_MS = 4000;
const SOURCE_READY_RETRIES = 4;
const SOURCE_READY_BACKOFF_MS = 250;

let pollTimer = null;
let testingAll = false;
let lastClashSnapshot = null;
// Локальный optimistic-active: после клика подсвечиваем сразу, не ждём поллинг.
let optimisticActiveTag = null;
let optimisticUntilTs = 0;
// Запомненный effective node — чтобы диспатчить ninety:node-changed только при реальном изменении
let lastEffectiveTag = null;
let sourceGeneration = 0;
let isStrictPrivacy = () => false;
let onStrictNodeSelected = null;

function strictPrivacyEnabled() {
  try { return isStrictPrivacy() === true; }
  catch { return false; }
}

function strictSelectedTag(nodes) {
  const remembered = getRememberedProxySelection(getActiveSource());
  if (nodes.length === 1) {
    const onlyTag = nodes[0]?.clashTag || null;
    // Новая singleton-подписка безопасно выбирается сама. Но если источник
    // раньше был multi-node и хранит Auto/исчезнувший pin, не рисуем ложную
    // активность: клик по единственной карточке явно закрепит её.
    return !remembered || remembered === "proxy" || remembered === onlyTag
      ? onlyTag
      : null;
  }
  if (!remembered || remembered === "auto" || remembered === "lowest") return null;
  return nodes.some((node) => node.clashTag === remembered) ? remembered : null;
}

function setRetestVisible(visible) {
  const btn = $("proxies-test");
  if (btn) btn.hidden = !visible;
}

function dispatchNodeChanged(tag, node) {
  window.dispatchEvent(new CustomEvent("ninety:node-changed", {
    detail: { tag, node: node || null },
  }));
}

// ── флаги: имя ноды → ISO ── (логика в /lib/flags.js, импортируется выше)
// Фолбэк при отсутствии .svg вешается НЕ inline-обработчиком (`onerror=`), а
// через addEventListener в attachFlagFallbacks() после вставки разметки: строгий
// CSP (`script-src 'self'` без unsafe-inline) блокирует inline event-handlers,
// поэтому inline-onerror молча не срабатывал. data-flag-fallback несёт текст-замену.
function flagHtml(iso, fallbackText) {
  if (iso) {
    return `<img class="prox__flag-img" src="${FLAGS_BASE}/${iso}.svg" alt="" loading="lazy" data-flag-fallback="${escapeAttr(fallbackText || "?")}">`;
  }
  return `<span class="prox__flag-fallback">${escapeHtml(fallbackText || "?")}</span>`;
}

// После вставки разметки: на каждый флаг-img вешаем обработчик ошибки загрузки
// (CSP-совместимо) и сразу проверяем уже-провалившиеся (complete && naturalWidth=0,
// напр. из кэша) — заменяем битый флаг на текстовый фолбэк.
function attachFlagFallbacks(root) {
  if (!root) return;
  for (const img of root.querySelectorAll(".prox__flag-img[data-flag-fallback]")) {
    const swap = () => {
      const span = document.createElement("span");
      span.className = "prox__flag-fallback";
      span.textContent = img.getAttribute("data-flag-fallback") || "?";
      img.replaceWith(span);
    };
    img.addEventListener("error", swap, { once: true });
    if (img.complete && img.naturalWidth === 0) swap();
  }
}

// ── список нод подписки → ноды с clash-тэгами ──────────────
export function nodesFromSource() {
  const src = getActiveSource();
  if (!src) return [];
  const raw = src.kind === "sub" ? src.nodes : [src.profile];
  // Ноды не фильтруем: транспорты, которых ядро не умеет само, приложение
  // обслуживает отдельным ядром на локальном мосту — в списке они полноценны.
  return raw.map((n, i) => ({
    ...n,
    clashTag: raw.length >= 2 ? nodeTag(i, n) : "proxy",
  }));
}

function proxyType(proxy) {
  return String(proxy?.type || "").toLowerCase();
}

function selectorMembers(proxy) {
  return Array.isArray(proxy?.all) ? proxy.all : [];
}

// Snapshot Clash относится к активному источнику только если в нём уже
// присутствует собранная для этого источника топология. Это отделяет новый UI
// от старого ядра во время реконнекта.
export function snapshotMatchesSource(clashData, nodes) {
  const proxies = clashData?.proxies;
  const proxy = proxies?.proxy;
  if (!proxy || !Array.isArray(nodes) || nodes.length === 0) return false;

  if (nodes.length === 1) {
    return proxyType(proxy) !== "selector";
  }

  if (proxyType(proxy) !== "selector") return false;
  const expectedTags = nodes.map(n => n.clashTag);
  const members = selectorMembers(proxy);
  return ["auto", "lowest", ...expectedTags].every(tag =>
    members.includes(tag) && proxies[tag]
  );
}

export function snapshotCanSelectTag(clashData, nodes, tag) {
  if (!snapshotMatchesSource(clashData, nodes) || nodes.length < 2) return false;
  const selector = clashData.proxies.proxy;
  return proxyType(selector) === "selector"
    && selectorMembers(selector).includes(tag)
    && Boolean(clashData.proxies[tag]);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function readMatchingSnapshot(nodes, { attempts = 1 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const data = await getProxies();
      if (snapshotMatchesSource(data, nodes)) return data;
    } catch {}
    if (attempt + 1 < attempts) await sleep(SOURCE_READY_BACKOFF_MS * (attempt + 1));
  }
  return null;
}

// ── избранное / поиск / сортировка / группировка ────────────
let query = "";
let sortState = loadUi("sort", { key: "ping", dir: "asc" });
let grouped = loadUi("grouped", true);
let recOpen = loadUi("recOpen", true);
const collapsedGroups = new Set();
let lastSignature = "";

function loadUi(k, dflt) {
  try {
    const v = localStorage.getItem("ninety.proxies." + k);
    return v == null ? dflt : JSON.parse(v);
  } catch { return dflt; }
}
function saveUi(k, v) {
  try { localStorage.setItem("ninety.proxies." + k, JSON.stringify(v)); } catch {}
}

// ── статистика по истории замеров clash ─────────────────────
function historyOf(clashData, tag) {
  const h = clashData?.proxies?.[tag]?.history;
  if (!Array.isArray(h)) return [];
  return h.slice(-12).map(x => Number(x?.delay) || 0);
}
const liveDelays = (hs) => hs.filter(d => d > 0 && d < 65000);
function medianOf(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function stdevOf(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ── движок рекомендаций ─────────────────────────────────────
// Считает ТОЛЬКО по замерам, которые приложение уже сделало: массив history
// clash-API и тип транспорта ноды. Никакой внешней телеметрии.
const TRANSPORT_W = { REALITY: 1, XHTTP: 0.95, TRUSTTUNNEL: 0.9, NAIVE: 0.85, GRPC: 0.8, WS: 0.75 };
function transportWeight(node) {
  const proto = String(node?.proto || "").toLowerCase();
  if (proto === "trusttunnel") return TRANSPORT_W.TRUSTTUNNEL;
  if (proto === "naive") return TRANSPORT_W.NAIVE;
  const sec = String(node?.security || "").toLowerCase();
  if (sec === "reality") return TRANSPORT_W.REALITY;
  const type = String(node?.type || "").toLowerCase();
  if (type === "xhttp") return TRANSPORT_W.XHTTP;
  if (type === "grpc") return TRANSPORT_W.GRPC;
  if (type === "ws") return TRANSPORT_W.WS;
  return 0.8;
}
function scoreNode(node, clashData) {
  const hs = historyOf(clashData, node.clashTag);
  const L = liveDelays(hs);
  // Хватает одного успешного замера: один прогон «Измерить все» даёт ровно один
  // замер на сервер, и порог выше этого делал рекомендации недостижимыми.
  if (!L.length) return null;
  const med = medianOf(L);
  const jit = L.length >= 2 ? stdevOf(L) : null;
  const latency = clamp01(1 - (med - 25) / 275);
  const stability = jit == null ? 0.5 : clamp01(1 - jit / 55);
  const liveness = L.length / hs.length;
  const transport = transportWeight(node);
  return {
    total: 0.45 * latency + 0.30 * stability + 0.15 * liveness + 0.10 * transport,
    latency, stability, liveness, transport, med, jit, okN: L.length, allN: hs.length,
  };
}
function rankNodes(nodes, clashData) {
  return nodes
    .map(n => ({ n, s: scoreNode(n, clashData) }))
    .filter(x => x.s)
    .sort((a, b) => b.s.total - a.s.total);
}
const REASON_KEYS = ["latency", "stability", "liveness", "transport"];
function reasonFor(key, s, node) {
  if (key === "latency")   return { icon: ICON_GAUGE,  text: t("proxies.whyLatency", { ms: Math.round(s.med) }) };
  if (key === "stability") return { icon: ICON_PULSE,  text: t("proxies.whyStable", { ms: Math.round(s.jit ?? 0) }) };
  if (key === "liveness")  return { icon: ICON_SHIELD, text: t("proxies.whyLive", { ok: s.okN, all: s.allN }) };
  return { icon: ICON_SERVER, text: t("proxies.whyTransport", { name: transportLabel(node) }) };
}
// Причина выбирается по тому, чем нода сильнее всего ОТРЫВАЕТСЯ от поля,
// а не по максимальному компоненту: иначе все получают «12 из 12 замеров»
// — правду, которая ничего не объясняет. Две строки не повторяются.
function reasonsFor(top, field) {
  const med = {};
  REASON_KEYS.forEach(k => { med[k] = medianOf(field.map(x => Math.round(x.s[k] * 100))) / 100; });
  const used = new Set();
  return top.map(({ n, s }) => {
    // Разброс без второго замера не измерен, доступность при единственном замере
    // тривиально равна единице — такие причины ничего не объясняют.
    const usable = REASON_KEYS.filter(k =>
      !(k === "stability" && s.jit == null) && !(k === "liveness" && s.allN < 2));
    const pool2 = usable.length ? usable : REASON_KEYS;
    const order = [...pool2].sort((a, b) => (s[b] - med[b]) - (s[a] - med[a]));
    const key = order.find(k => !used.has(k)) || order[0];
    used.add(key);
    return reasonFor(key, s, n);
  });
}

// ── иконки (канонический Lucide, обводка приведена к системе) ──
const SVG = (p, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICON_GAUGE  = SVG('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>');
const ICON_PULSE  = SVG('<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>');
const ICON_SHIELD = SVG('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>');
const ICON_SERVER = SVG('<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01M6 18h.01"/>');
const ICON_BOLT   = SVG('<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>');
const ICON_STAR   = SVG('<path d="M11.53 2.3a.53.53 0 0 1 .95 0l2.44 5.32 5.51.64c.44.05.62.6.29.9l-4.1 3.73 1.1 5.45c.09.44-.38.77-.76.55L12 16.14l-4.96 2.75c-.38.22-.85-.11-.76-.55l1.1-5.45-4.1-3.73c-.33-.3-.15-.85.29-.9l5.51-.64z"/>', 1.5);
const ICON_DOTS   = SVG('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>', 2.2);
const ICON_CHEV   = SVG('<path d="m6 9 6 6 6-6"/>', 1.9);
const ICON_INFO   = SVG('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>');
const ICON_SEARCH = SVG('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>');
const ICON_REFRESH = SVG('<path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/>');

function transportLabel(n) {
  const PROTO_LABEL = { naive: "Naive", trusttunnel: "TrustTunnel" };
  if (PROTO_LABEL[n?.proto]) return PROTO_LABEL[n.proto];
  const sec = String(n?.security || "").toLowerCase();
  if (sec === "reality") return "REALITY";
  return String(n?.type || "tcp").toUpperCase();
}

// ── подсветка совпадений поиска ─────────────────────────────
function highlight(text) {
  const safe = escapeHtml(text);
  const q = query.trim();
  if (!q) return safe;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    .map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return safe;
  return safe.replace(new RegExp("(" + terms.join("|") + ")", "gi"), "<mark>$1</mark>");
}

// ── разброс: 12 последних замеров ───────────────────────────
function sparkHtml(hs) {
  const L = liveDelays(hs);
  if (L.length < 2) {
    const title = !hs.length ? t("proxies.sparkNever")
      : L.length ? t("proxies.sparkOne", { all: hs.length })
                 : t("proxies.sparkDead", { all: hs.length });
    // Двух точек ещё нет — рисовать линию нечем. Прочерк честнее плоской черты,
    // которую легко принять за сломанный график.
    return `<span class="n-spark-none" title="${escapeAttr(title)}">—</span>`;
  }
  const mn = Math.min(...L), mx = Math.max(...L), sp = Math.max(1, mx - mn);
  const title = t("proxies.sparkTip", {
    ok: L.length, all: hs.length, min: mn, max: mx,
    med: medianOf(L), jit: Math.round(stdevOf(L)),
  });
  const pts = hs.map((d, i) => {
    const x = (i / Math.max(1, hs.length - 1)) * 52;
    const y = d > 0 ? 13 - ((d - mn) / sp) * 11 : 13;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const lastY = hs.at(-1) > 0 ? 13 - ((hs.at(-1) - mn) / sp) * 11 : 13;
  return `<svg class="n-spark" viewBox="-1 0 55 15" role="img"><title>${escapeHtml(title)}</title><polyline points="${pts}"/><circle cx="52" cy="${lastY.toFixed(1)}" r="1.5"/></svg>`;
}

function pingHtml(delay, grade) {
  if (delay > 0 && delay < 65000) {
    return `<div class="n-ping" data-grade="${grade}">${delay}<span class="n-unit">${t("proxies.pingUnit")}</span></div>`;
  }
  return `<div class="n-ping" data-grade="dead">—</div>`;
}

function starHtml(tag, on) {
  return `<button class="n-star" type="button" data-fav="${escapeAttr(tag)}" aria-pressed="${on}"
    aria-label="${escapeAttr(on ? t("proxies.favOff") : t("proxies.favOn"))}"
    title="${escapeAttr(on ? t("proxies.favIn") : t("proxies.favAdd"))}">${ICON_STAR}</button>`;
}

// ── строка таблицы ──────────────────────────────────────────
function nodeRowHtml(n, ctx) {
  const hs = historyOf(ctx.clashData, n.clashTag);
  const delay = lastDelay(ctx.clashData?.proxies?.[n.clashTag]);
  const iso = flagIsoFromName(n.name);
  const cleanName = stripFlag(n.name) || n.host;
  const fallback = iso ? iso.toUpperCase() : (cleanName.slice(0, 2).toUpperCase() || "?");
  const isPinned = n.clashTag === ctx.selectorTag && ctx.selectorTag !== "auto";
  const isLive = n.clashTag === ctx.liveTag;
  const pending = ctx.testing && !hs.length;
  return `
    <div class="n-row nt-row prox" data-active="${isPinned}" data-live="${isLive}" data-pending="${pending}"
         data-tag="${escapeAttr(n.clashTag)}" role="button" tabindex="-1" title="${escapeAttr(countryOf(n))}">
      <span class="n-flag">${flagHtml(iso, fallback)}</span>
      <span class="nt-row__name">
        ${isLive ? `<span class="n-live" title="${escapeAttr(t("proxies.liveHint"))}"></span>` : ""}
        <span class="n-primary">${highlight(cleanName)}</span>
      </span>
      <span class="nt-row__host">${highlight(n.host)}</span>
      <span class="nt-row__tr">${highlight(transportLabel(n))}</span>
      ${pending ? `<span class="n-wait"></span>` : sparkHtml(hs)}
      ${pending ? `<span class="n-dash">···</span>` : pingHtml(delay, gradeDelay(delay))}
      ${starHtml(n.clashTag, ctx.favs.has(n.clashTag))}
      <button class="n-icon" type="button" data-node-menu="${escapeAttr(n.clashTag)}"
        aria-label="${escapeAttr(t("proxies.rowActions"))}">${ICON_DOTS}</button>
    </div>`;
}

// Название страны словом: Intl.DisplayNames уже локализован под язык интерфейса,
// поэтому таблицу из 200 стран заводить не нужно. Нет ISO — группируем по имени.
let regionNames = null;
function countryOf(n) {
  const iso = flagIsoFromName(n.name);
  // У служебных записей провайдера («22 октября 2026», баннеры) страны нет.
  // Раньше каждая заводила свою группу и засоряла список.
  if (!iso) return t("proxies.groupOther");
  const code = iso.toUpperCase();
  try {
    if (!regionNames) {
      regionNames = new Intl.DisplayNames([getLang()], { type: "region" });
    }
    return regionNames.of(code) || code;
  } catch { return code; }
}
export function resetCountryNames() { regionNames = null; }

// ── блок рекомендаций ───────────────────────────────────────
function recHtml(nodes, ctx) {
  const box = $("proxies-rec");
  if (!box) return;
  if (!ctx.multi || query.trim()) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;

  const head = (extra) => `
    <div class="rec__head">
      <button class="rec__fold" type="button" id="rec-fold" aria-expanded="${recOpen}" aria-controls="rec-body">
        ${ICON_CHEV}<span class="n-lbl">${t("proxies.recommended")}</span>
      </button>
      ${extra}<span class="n-group__line"></span>
      <button class="rec__why" type="button" id="rec-why">${ICON_INFO}${t("proxies.howScored")}</button>
    </div>`;

  const ranked = rankNodes(nodes, ctx.clashData);
  const autoPick = ranked.length ? ranked[0].n : null;
  const autoDelay = autoPick ? lastDelay(ctx.clashData?.proxies?.[autoPick.clashTag]) : 0;
  const autoSub = !autoPick
    ? t("proxies.autoIdle")
    : ctx.selectorTag === "auto"
      ? t("proxies.autoNow", { name: stripFlag(autoPick.name) || autoPick.host })
      : t("proxies.autoWould", { name: stripFlag(autoPick.name) || autoPick.host });

  const autoRow = `
    <div class="n-row rec-row prox" data-active="${ctx.selectorTag === "auto"}" data-tag="auto" role="button" tabindex="-1">
      <span class="n-flag rec-row__bolt">${ICON_BOLT}</span>
      <div class="rec-row__main">
        <span class="rec-row__name"><span class="n-primary">${t("proxies.auto")}</span></span>
        <span class="rec-row__reason">${ICON_PULSE}${escapeHtml(autoSub)}</span>
      </div>
      ${autoPick ? sparkHtml(historyOf(ctx.clashData, autoPick.clashTag)) : `<span></span>`}
      ${autoPick ? pingHtml(autoDelay, gradeDelay(autoDelay)) : `<span class="n-ping" data-grade="dead">—</span>`}
    </div>`;

  // Замеров ещё нет: «Авто» остаётся, а вместо списка — объяснение и действие.
  if (!ranked.length) {
    box.innerHTML = head("") + `
      <div class="n-plate rec__body" id="rec-body"${recOpen ? "" : " hidden"}>
        ${autoRow}
        <div class="first">
          <span class="n-empty__i">${ctx.testing ? ICON_GAUGE : ICON_PULSE}</span>
          <div class="first__t">
            <div class="n-primary">${ctx.testing ? t("proxies.firstMeasuring") : t("proxies.firstIdle")}</div>
            <div class="n-meta">${ctx.testing ? t("proxies.firstWait") : t("proxies.firstHint")}</div>
          </div>
          ${ctx.testing ? "" : `<button class="btn btn--sm btn--primary" type="button" data-act="test">${ICON_REFRESH}<span>${t("proxies.testNow")}</span></button>`}
        </div>
      </div>`;
    return;
  }

  const top = ranked.slice(0, 3);
  const why = reasonsFor(top, ranked);

  const rows = top.map(({ n }, i) => {
    const iso = flagIsoFromName(n.name);
    const cleanName = stripFlag(n.name) || n.host;
    const fallback = iso ? iso.toUpperCase() : (cleanName.slice(0, 2).toUpperCase() || "?");
    const delay = lastDelay(ctx.clashData?.proxies?.[n.clashTag]);
    const isLive = n.clashTag === ctx.liveTag;
    return `
      <div class="n-row rec-row prox" data-active="${n.clashTag === ctx.selectorTag && ctx.selectorTag !== "auto"}"
           data-tag="${escapeAttr(n.clashTag)}" role="button" tabindex="-1">
        <span class="n-flag">${flagHtml(iso, fallback)}</span>
        <div class="rec-row__main">
          <span class="rec-row__name">
            ${isLive ? `<span class="n-live" title="${escapeAttr(t("proxies.liveHint"))}"></span>` : ""}
            <span class="n-primary">${escapeHtml(cleanName)}</span>
          </span>
          <span class="rec-row__reason">${why[i].icon}${escapeHtml(why[i].text)}</span>
        </div>
        ${sparkHtml(historyOf(ctx.clashData, n.clashTag))}
        ${pingHtml(delay, gradeDelay(delay))}
      </div>`;
  }).join("");

  box.innerHTML = head(`<span class="n-group__n">${t("proxies.byProbesN", { n: ranked[0].s.allN })}</span>`) +
    `<div class="n-plate rec__body" id="rec-body"${recOpen ? "" : " hidden"}>${autoRow}${rows}</div>`;

}

// ── таблица ─────────────────────────────────────────────────
function sortHeader(key, label, end) {
  const on = sortState.key === key;
  return `<button class="nt__h${end ? " nt__h--end" : ""}" type="button" data-k="${key}"
    data-sorted="${on}" data-dir="${on ? sortState.dir : "desc"}">${escapeHtml(label)}${ICON_CHEV}</button>`;
}

function render(nodes, selectorTag, effectiveTag, clashData, { strict = false } = {}) {
  const grid = $("proxies-grid");
  const metaEl = $("proxies-meta");
  if (!grid) return;

  const source = getActiveSource();
  const favs = getFavourites(source);
  const multi = nodes.length >= 2 && !strict;
  // Закреплено мной ≠ через что реально идёт трафик. В «Авто» это разные строки.
  const liveTag = selectorTag === "auto" ? effectiveTag : selectorTag;
  const ctx = { clashData, selectorTag, liveTag, favs, multi, testing: testingAll };

  if (!nodes.length) {
    grid.innerHTML = `<div class="n-empty"><span class="n-empty__i">${ICON_SERVER}</span>
      <h3>${escapeHtml(t("proxies.emptyTitle"))}</h3><p>${escapeHtml(t("proxies.emptySub"))}</p></div>`;
    if (metaEl) metaEl.textContent = t("proxies.metaNone");
    const rec = $("proxies-rec"); if (rec) { rec.hidden = true; rec.innerHTML = ""; }
    lastSignature = "";
    return;
  }

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (n) => terms.every(term =>
    `${stripFlag(n.name)} ${n.host} ${transportLabel(n)} ${countryOf(n)}`.toLowerCase().includes(term));
  const pool = terms.length ? nodes.filter(matches) : nodes;
  const flat = !grouped || terms.length > 0;

  // Полный innerHTML раз в 4 секунды сбрасывал бы фокус строки и ввод в поиске.
  // Пересобираем только когда что-то реально изменилось.
  const signature = JSON.stringify([
    pool.map(n => [n.clashTag, lastDelay(clashData?.proxies?.[n.clashTag]), historyOf(clashData, n.clashTag).length]),
    selectorTag, effectiveTag, query, sortState, grouped, recOpen, strict,
    [...favs].sort(), [...collapsedGroups].sort(), testingAll,
  ]);
  if (signature === lastSignature) return;
  lastSignature = signature;

  const alive = nodes.filter(n => {
    const d = lastDelay(clashData?.proxies?.[n.clashTag]);
    return d > 0 && d < 65000;
  }).length;

  if (metaEl) {
    if (terms.length) {
      metaEl.textContent = t("proxies.metaFound", { n: pool.length, total: nodes.length });
    } else if (strict) {
      metaEl.textContent = t("proxies.meta", { total: nodes.length, alive: "—", mode: t("proxies.strictPinned") });
    } else {
      const liveNode = nodes.find(n => n.clashTag === liveTag);
      const pin = selectorTag === "auto"
        ? (liveNode ? t("proxies.pinAuto", { name: stripFlag(liveNode.name) || liveNode.host }) : t("proxies.auto"))
        : t("proxies.pinNode", { name: selectorTag ? (stripFlag(nodes.find(n => n.clashTag === selectorTag)?.name || "") || "—") : "—" });
      metaEl.textContent = t("proxies.metaLine", { pin, alive, total: nodes.length });
    }
  }

  recHtml(nodes, ctx);

  const val = {
    name: n => stripFlag(n.name) || n.host,
    host: n => n.host,
    tr:   n => transportLabel(n),
    ping: n => { const d = lastDelay(clashData?.proxies?.[n.clashTag]); return d > 0 && d < 65000 ? d : 1e9; },
  };
  const dir = sortState.dir === "asc" ? 1 : -1;
  const raw = (x, y) => typeof x === "number" ? x - y : String(x).localeCompare(String(y), "ru");
  const cmp = (x, y) => raw(x, y) * dir;
  // При равенстве по основному столбцу — быстрейший выше, затем по имени.
  // Без этого «все REALITY» выпадали в порядке добавления.
  const cmpNode = (a, b) => cmp(val[sortState.key](a), val[sortState.key](b))
    || raw(val.ping(a), val.ping(b)) || raw(val.name(a), val.name(b));

  const head = `
    <div class="nt__head">
      <span></span>${sortHeader("name", t("proxies.colServer"))}${sortHeader("host", t("proxies.colAddr"))}
      ${sortHeader("tr", t("proxies.colTransport"))}
      <span class="n-lbl nt__h--trend" title="${escapeAttr(t("proxies.colSpreadHint"))}">${escapeHtml(t("proxies.colSpread"))}</span>
      ${sortHeader("ping", t("proxies.colDelay"), true)}<span></span><span></span>
    </div>`;

  if (!pool.length) {
    grid.innerHTML = head + `<div class="n-empty"><span class="n-empty__i">${ICON_SEARCH}</span>
      <h3>${escapeHtml(t("proxies.searchEmptyTitle"))}</h3>
      <p>${escapeHtml(t("proxies.searchEmptySub", { q: query.trim() }))}</p>
      <button class="btn btn--sm" type="button" data-act="clear-q">${escapeHtml(t("proxies.searchReset"))}</button></div>`;
    attachFlagFallbacks(grid);
    return;
  }

  // Избранное всегда наверху и не дублируется в странах: выбор пользователя
  // важнее машинного и важнее географии.
  const favList = pool.filter(n => favs.has(n.clashTag)).sort(cmpNode);
  const rest = pool.filter(n => !favs.has(n.clashTag));
  const favBlock = favList.length ? `
    <div class="nt__grp nt__grp--static">
      <span class="nt__grp-chev" style="visibility:hidden">${ICON_CHEV}</span>
      <span class="n-flag nt__grp-fav">${ICON_STAR}</span>
      <span class="n-lbl">${escapeHtml(t("proxies.favGroup"))}</span>
      <span class="n-group__n">${favList.length}</span><span class="nt__grp-line"></span>
    </div>
    <div class="nt-body">${favList.map(n => nodeRowHtml(n, ctx)).join("")}</div>` : "";

  let body;
  if (flat) {
    body = `<div class="nt-body">${rest.slice().sort(cmpNode).map(n => nodeRowHtml(n, ctx)).join("")}</div>`;
  } else {
    const byC = {};
    rest.forEach(n => { const c = countryOf(n); (byC[c] ||= []).push(n); });
    Object.keys(byC).forEach(c => byC[c].sort(cmpNode));
    // Страны переставляются тем же кликом: по имени — по алфавиту, по остальным
    // столбцам — по представителю, то есть по первой строке внутри страны.
    const gkey = (c) => sortState.key === "name" ? c : val[sortState.key](byC[c][0]);
    const order = Object.keys(byC).sort((a, b) => cmp(gkey(a), gkey(b)));
    body = order.map(c => {
      const list = byC[c];
      const open = !collapsedGroups.has(c);
      const mins = list.map(x => val.ping(x)).filter(x => x < 1e9);
      const never = list.every(x => !historyOf(clashData, x.clashTag).length);
      const note = mins.length ? t("proxies.groupFrom", { ms: Math.min(...mins) })
                 : never ? t("proxies.groupNever") : t("proxies.groupDead");
      const iso = flagIsoFromName(list[0].name);
      return `
        <button class="nt__grp" type="button" data-c="${escapeAttr(c)}" aria-expanded="${open}">
          <span class="nt__grp-chev">${ICON_CHEV}</span>
          <span class="n-flag">${flagHtml(iso, c.slice(0, 2).toUpperCase())}</span>
          <span class="n-lbl">${highlight(c)}</span><span class="n-group__n">${list.length}</span>
          <span class="nt__grp-line"></span><span class="n-meta">${escapeHtml(note)}</span>
        </button>
        <div class="nt-body"${open ? "" : " hidden"}>${list.map(n => nodeRowHtml(n, ctx)).join("")}</div>`;
    }).join("");
  }

  grid.innerHTML = head + favBlock + body;
  attachFlagFallbacks(grid);
}

// ── render: сопутствующие состояния ─────────────────────────
function effectiveSelectorTag(clashData) {
  // optimistic override живёт 4 сек — пока бэк не подтвердит
  if (optimisticActiveTag && Date.now() < optimisticUntilTs) return optimisticActiveTag;
  return pickSelectorNow(clashData);
}

function renderApplying(nodes) {
  if (strictPrivacyEnabled()) { renderStrict(nodes); return; }
  lastSignature = "";
  render(nodes, null, null, null);
  const metaEl = $("proxies-meta");
  if (metaEl) {
    metaEl.textContent = t("proxies.metaIdle", { total: nodes.length });
  }
}

function renderStrict(nodes = nodesFromSource()) {
  const selectedTag = strictSelectedTag(nodes);
  lastClashSnapshot = null;
  lastEffectiveTag = selectedTag;
  setRetestVisible(false);
  lastSignature = "";
  render(nodes, selectedTag, selectedTag, null, { strict: true });
}

async function refresh({ retry = false } = {}) {
  if (strictPrivacyEnabled()) {
    renderStrict();
    return;
  }
  setRetestVisible(true);
  const generation = sourceGeneration;
  const nodes = nodesFromSource();
  const data = await readMatchingSnapshot(nodes, {
    attempts: retry ? SOURCE_READY_RETRIES : 1,
  });
  if (generation !== sourceGeneration) return;
  if (!data) {
    lastClashSnapshot = null;
    lastEffectiveTag = null;
    renderApplying(nodes);
    return;
  }
  lastClashSnapshot = data;
  const selectorTag = effectiveSelectorTag(data);
  const effectiveTag = pickEffectiveNode(data);
  // URLTest сам мог перевыбрать ноду — синхронизируем хедер и IP
  if (effectiveTag && effectiveTag !== lastEffectiveTag) {
    lastEffectiveTag = effectiveTag;
    const node = nodes.find(n => n.clashTag === effectiveTag) || null;
    dispatchNodeChanged(effectiveTag, node);
  }
  render(nodes, selectorTag, effectiveTag, data);
}

// ── click-handler: выбор ноды через Selector ───────────────
async function handleNodeClick(card, onToast) {
  const generation = sourceGeneration;
  const tag = card.dataset.tag;
  if (!tag) return;
  const nodes = nodesFromSource();
  if (strictPrivacyEnabled()) {
    const node = nodes.find((candidate) => candidate.clashTag === tag);
    if (!node) return;
    rememberProxySelection(getActiveSource(), tag);
    optimisticActiveTag = null;
    optimisticUntilTs = 0;
    renderStrict(nodes);
    try {
      await onStrictNodeSelected?.(tag, node);
    } catch (e) {
      onToast?.(t("proxies.toastSwitchErr", { err: e?.message || e }), "error", 2500);
    }
    return;
  }
  // Одиночный source не имеет Selector: карточка уже является активным
  // конечным outbound, поэтому PUT /proxies/proxy здесь недопустим.
  if (nodes.length < 2) return;

  const data = await readMatchingSnapshot(nodes, { attempts: 2 });
  if (generation !== sourceGeneration) return;
  const selector = data?.proxies?.proxy;
  if (!data || proxyType(selector) !== "selector" || !snapshotCanSelectTag(data, nodes, tag)) {
    optimisticActiveTag = null;
    onToast?.(t("conn.applyingSettings"), "info", 2400);
    await refresh({ retry: true });
    return;
  }
  lastClashSnapshot = data;
  // optimistic UI
  optimisticActiveTag = tag;
  optimisticUntilTs = Date.now() + 4500;
  document.querySelectorAll("#proxies-grid .prox").forEach(c => {
    c.dataset.active = c.dataset.tag === tag ? "true" : "false";
  });
  try {
    const selected = await selectProxy("proxy", tag);
    if (generation !== sourceGeneration || selected?.stale) return;
    rememberProxySelection(getActiveSource(), tag);
    onToast?.(tag === "auto" ? t("proxies.toastAuto") : t("proxies.toastSwitched"), "success", 1200);
    // Для "auto" реальный исходящий определит URLTest — узнаем после refresh.
    // Для ручного выбора — сразу синхронизируем hero/location/IP.
    if (tag !== "auto") {
      const nodes = nodesFromSource();
      const node = nodes.find(n => n.clashTag === tag) || null;
      lastEffectiveTag = tag;
      dispatchNodeChanged(tag, node);
    }
    await refresh();
  } catch (e) {
    optimisticActiveTag = null;
    onToast?.(t("proxies.toastSwitchErr", { err: e?.message || e }), "error", 2500);
    await refresh();
  }
}

export function onProxiesViewEnter() {
  if (strictPrivacyEnabled()) {
    stopPoll();
    renderStrict();
    return;
  }
  refresh({ retry: true }).then(() => kickstartAutoIfNeeded());
  stopPoll();
  pollTimer = setInterval(refresh, POLL_MS);
}

// Если active = "auto", но замеров ещё нет — Balancer не знает задержек и
// остаётся на первой ноде. Форсим URLTest "lowest" (он наполняет общую историю
// замеров) — после первого прохода Balancer возьмёт реального лидера.
async function kickstartAutoIfNeeded() {
  if (strictPrivacyEnabled()) return;
  const data = lastClashSnapshot;
  if (!data) return;
  const selNow = pickSelectorNow(data);
  if (selNow !== "auto") return;
  const auto = data.proxies?.auto;
  if (!auto) return;
  if (auto.now && auto.now !== "auto") return;
  try { await testGroup("lowest"); await refresh(); } catch {}
}

export function onProxiesViewLeave() {
  stopPoll();
  sourceGeneration++;
  testingAll = false;
}

export function resetProxiesViewForSourceChange() {
  sourceGeneration++;
  lastClashSnapshot = null;
  optimisticActiveTag = null;
  optimisticUntilTs = 0;
  lastEffectiveTag = null;
  const nodes = nodesFromSource();
  if (strictPrivacyEnabled()) renderStrict(nodes);
  else renderApplying(nodes);
  if (pollTimer) void refresh({ retry: true });
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Живой ре-рендер при смене языка (из onLangChange). Без сети — берём последний
// снапшот clash; если его нет, render отрисует пустое состояние.
export function rerenderProxiesView() {
  if (!$("proxies-grid")) return;
  regionNames = null;      // язык мог смениться — названия стран пересобрать
  lastSignature = "";
  if (strictPrivacyEnabled()) {
    renderStrict();
    return;
  }
  const data = lastClashSnapshot;
  render(nodesFromSource(), effectiveSelectorTag(data), pickEffectiveNode(data), data);
}

export function mountProxiesView({
  onToast,
  isStrictPrivacy: strictPrivacyGetter,
  onStrictNodeSelected: strictNodeSelected,
} = {}) {
  if (typeof strictPrivacyGetter === "function") isStrictPrivacy = strictPrivacyGetter;
  onStrictNodeSelected = typeof strictNodeSelected === "function" ? strictNodeSelected : null;

  const rerender = () => {
    lastSignature = "";
    if (strictPrivacyEnabled()) renderStrict();
    else render(nodesFromSource(), effectiveSelectorTag(lastClashSnapshot),
                pickEffectiveNode(lastClashSnapshot), lastClashSnapshot);
  };

  const screen = document.querySelector('.screen[data-view="proxies"]');

  screen?.addEventListener("click", (e) => {
    // Действия внутри строки не должны выбирать ноду
    const fav = e.target.closest("[data-fav]");
    if (fav) {
      e.stopPropagation();
      const on = toggleFavourite(getActiveSource(), fav.dataset.fav);
      rerender();
      onToast?.(on ? t("proxies.favToastOn") : t("proxies.favToastOff"), "success", 1400);
      return;
    }
    const menu = e.target.closest("[data-node-menu]");
    if (menu) { e.stopPropagation(); openNodeMenu(menu, menu.dataset.nodeMenu, onToast); return; }
    if (e.target.closest("[data-act=clear-q]")) { setQuery(""); return; }
    if (e.target.closest("[data-act=test]")) { $("proxies-test")?.click(); return; }

    const fold = e.target.closest("#rec-fold");
    if (fold) { recOpen = !recOpen; saveUi("recOpen", recOpen); rerender(); return; }
    const why = e.target.closest("#rec-why");
    if (why) { showScorePopover(why); return; }

    const sorter = e.target.closest(".nt__h");
    if (sorter) {
      const k = sorter.dataset.k;
      sortState = { key: k, dir: sortState.key === k && sortState.dir === "asc" ? "desc" : "asc" };
      saveUi("sort", sortState); rerender(); return;
    }
    const grp = e.target.closest(".nt__grp[data-c]");
    if (grp) {
      const c = grp.dataset.c;
      collapsedGroups.has(c) ? collapsedGroups.delete(c) : collapsedGroups.add(c);
      rerender(); return;
    }
    const card = e.target.closest(".prox");
    if (card) handleNodeClick(card, onToast);
  });

  // ── клавиатура: плотная таблица должна ходить стрелками ──
  const rowsInOrder = () => [...screen.querySelectorAll(".rec-row, .nt-row")]
    .filter(r => r.offsetParent !== null);
  screen?.addEventListener("keydown", (e) => {
    const input = $("proxies-q");
    if (e.target === input) {
      if (e.key === "Escape") { e.stopPropagation(); if (query) setQuery(""); else input.blur(); }
      if (e.key === "ArrowDown") { e.preventDefault(); rowsInOrder()[0]?.focus(); }
      return;
    }
    const rows = rowsInOrder();
    const cur = e.target.closest?.(".rec-row, .nt-row");
    const i = cur ? rows.indexOf(cur) : -1;
    const go = (j) => {
      const el = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (el) { el.focus(); el.scrollIntoView({ block: "nearest" }); }
    };
    if (e.key === "ArrowDown") { e.preventDefault(); rows.length && go(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); i <= 0 ? input?.focus() : go(i - 1); }
    else if (e.key === "Home" && cur) { e.preventDefault(); go(0); }
    else if (e.key === "End" && cur) { e.preventDefault(); go(rows.length - 1); }
    else if ((e.key === "Enter" || e.key === " ") && cur) { e.preventDefault(); handleNodeClick(cur, onToast); }
    else if (e.key.toLowerCase() === "f" && cur && !e.ctrlKey && !e.metaKey && cur.dataset.tag !== "auto") {
      e.preventDefault();
      const on = toggleFavourite(getActiveSource(), cur.dataset.tag);
      rerender();
      onToast?.(on ? t("proxies.favToastOn") : t("proxies.favToastOff"), "success", 1400);
    }
  });

  // ── поиск ──
  function setQuery(v) {
    query = v;
    const input = $("proxies-q");
    if (input && input.value !== v) input.value = v;
    const clear = $("proxies-q-clear");
    if (clear) clear.hidden = !v;
    const wrap = input?.closest(".n-search");
    if (wrap) wrap.dataset.filled = String(Boolean(v));
    const seg = $("proxies-group");
    if (seg) seg.dataset.forced = String(Boolean(v.trim()));
    rerender();
  }
  $("proxies-q")?.addEventListener("input", (e) => setQuery(e.target.value));
  $("proxies-q-clear")?.addEventListener("click", () => { setQuery(""); $("proxies-q")?.focus(); });
  document.addEventListener("keydown", (e) => {
    if (screen?.hidden) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "f" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      const input = $("proxies-q");
      input?.focus(); input?.select();
    }
  });

  // ── группировка ──
  $("proxies-group")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-g]");
    if (!b) return;
    grouped = b.dataset.g === "country";
    saveUi("grouped", grouped);
    $("proxies-group").querySelectorAll("button").forEach(x =>
      x.setAttribute("aria-pressed", String((x.dataset.g === "country") === grouped)));
    rerender();
  });
  $("proxies-group")?.querySelectorAll("button").forEach(x =>
    x.setAttribute("aria-pressed", String((x.dataset.g === "country") === grouped)));

  // ── измерить все ──
  const testBtn = $("proxies-test");
  testBtn?.addEventListener("click", async () => {
    if (strictPrivacyEnabled()) return;
    if (testingAll) return;
    testingAll = true;
    const generation = sourceGeneration;
    testBtn.dataset.testing = "true";
    testBtn.disabled = true;
    rerender();
    try {
      const nodes = nodesFromSource();
      const ready = await readMatchingSnapshot(nodes, { attempts: SOURCE_READY_RETRIES });
      if (generation !== sourceGeneration) return;
      if (!ready) {
        onToast?.(t("conn.applyingSettings"), "info", 2400);
        renderApplying(nodes);
        return;
      }
      lastClashSnapshot = ready;
      // refresh по ходу — список оживает прогрессивно, не ждёт все ноды
      let last = 0;
      await testAllNodes(nodes, () => {
        if (generation !== sourceGeneration) return;
        const now = Date.now();
        if (now - last > 600) { last = now; refresh(); }
      }, () => generation === sourceGeneration);
      if (generation !== sourceGeneration) return;
      onToast?.(t("proxies.toastRetested"), "success", 1600);
      await refresh();
    } catch (e) {
      onToast?.(t("proxies.toastTestErr", { err: e?.message || e }), "error", 2500);
    } finally {
      testingAll = false;
      delete testBtn.dataset.testing;
      testBtn.disabled = false;
      rerender();
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#rec-pop") && !e.target.closest("#rec-why")) hideScorePopover();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideScorePopover(); });
}

// ── поповер «как считается» ─────────────────────────────────
function hideScorePopover() { const p = $("rec-pop"); if (p) p.hidden = true; }
function showScorePopover(anchor) {
  const p = $("rec-pop");
  if (!p) return;
  const ranked = rankNodes(nodesFromSource(), lastClashSnapshot);
  if (!ranked.length) {
    p.innerHTML = `<div class="rec-pop__t">${escapeHtml(t("proxies.scoreNoneTitle"))}</div>
      <div class="rec-pop__d">${escapeHtml(t("proxies.scoreNoneBody"))}</div>`;
  } else {
    const { n, s } = ranked[0];
    const bar = (lbl, v) => `<div class="rec-pop__r"><span class="n-lbl">${escapeHtml(lbl)}</span>
      <div class="n-meter"><div class="n-meter__f" style="width:${(v * 100).toFixed(0)}%"></div></div>
      <span class="n-num">${(v * 100).toFixed(0)}</span></div>`;
    p.innerHTML = `<div class="rec-pop__t">${escapeHtml(t("proxies.scoreTitle", { name: stripFlag(n.name) || n.host }))}</div>
      <div class="rec-pop__d">${escapeHtml(t("proxies.scoreBody"))}</div>
      <div class="rec-pop__f">
        ${bar(t("proxies.scoreLatency"), s.latency)}${bar(t("proxies.scoreStability"), s.stability)}
        ${bar(t("proxies.scoreLiveness"), s.liveness)}${bar(t("proxies.scoreTransport"), s.transport)}
      </div>
      <div class="rec-pop__note">${escapeHtml(t("proxies.scoreNote", {
        med: Math.round(s.med), jit: Math.round(s.jit), ok: s.okN, all: s.allN }))}</div>`;
  }
  p.hidden = false;
  const ar = anchor.getBoundingClientRect();
  p.style.top = Math.min(ar.bottom + 6, window.innerHeight - p.offsetHeight - 10) + "px";
  p.style.left = Math.max(10, Math.min(ar.right - p.offsetWidth, window.innerWidth - p.offsetWidth - 10)) + "px";
}

// ── меню действий по серверу ────────────────────────────────
function openNodeMenu(anchor, tag, onToast) {
  const nodes = nodesFromSource();
  const node = nodes.find(n => n.clashTag === tag);
  if (!node) return;
  document.getElementById("prox-menu")?.remove();
  const fav = getFavourites(getActiveSource()).has(tag);
  const menu = document.createElement("div");
  menu.className = "pmenu";
  menu.id = "prox-menu";
  menu.innerHTML = `
    <button class="pmenu__item" type="button" data-a="pin">${ICON_BOLT}${escapeHtml(t("proxies.menuPin"))}</button>
    <button class="pmenu__item" type="button" data-a="fav">${ICON_STAR}${escapeHtml(fav ? t("proxies.favOff") : t("proxies.favOn"))}</button>
    <button class="pmenu__item" type="button" data-a="test">${ICON_GAUGE}${escapeHtml(t("proxies.menuTestOne"))}</button>`;
  document.body.appendChild(menu);
  const ar = anchor.getBoundingClientRect();
  menu.style.top = Math.min(ar.bottom + 5, window.innerHeight - menu.offsetHeight - 10) + "px";
  menu.style.left = Math.max(8, ar.right - menu.offsetWidth) + "px";
  const close = () => menu.remove();
  menu.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    close();
    if (b.dataset.a === "pin") { handleNodeClick(anchor.closest(".prox"), onToast); return; }
    if (b.dataset.a === "fav") {
      const on = toggleFavourite(getActiveSource(), tag);
      lastSignature = "";
      await refresh();
      onToast?.(on ? t("proxies.favToastOn") : t("proxies.favToastOff"), "success", 1400);
      return;
    }
    try { await testNode(tag, { timeoutMs: 5000 }); lastSignature = ""; await refresh(); }
    catch (e2) { onToast?.(t("proxies.toastTestErr", { err: e2?.message || e2 }), "error", 2500); }
  });
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
}

// Перетест ВСЕХ нод по одной через /proxies/{tag}/delay (пропатчен на unified →
// точно, и перемеряет КАЖДЫЙ вызов). Групповой /group/lowest/delay тут не годится:
// он interval-gated (urlTest skip нод с history моложе 600с) → «обновить всё»
// освежало лишь устаревшие, а свежие (включая то, что дёргает автозамер главной)
// застывали. Пул concurrency=8 — как batch-лимит в самом ядре, без UDP/TCP-всплеска.
async function testAllNodes(nodes, onProgress, shouldContinue = () => true) {
  const tags = [...new Set(nodes.map(n => n.clashTag))];
  let i = 0;
  async function worker() {
    while (i < tags.length) {
      if (!shouldContinue()) return;
      const t = tags[i++];
      try { await testNode(t, { timeoutMs: 5000 }); } catch {}
      if (!shouldContinue()) return;
      try { onProgress?.(); } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, tags.length) }, worker));
}
