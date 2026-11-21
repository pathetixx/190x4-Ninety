// Ninety · Proxies view — SVG flags, auto-sorting by ping,
// click selection via Selector, AUTO mode on top, the retest lightning FAB.

import {
  getProxies, testGroup, testNode, selectProxy,
  pickSelectorNow, pickEffectiveNode,
  lastDelay, gradeDelay,
} from "/lib/clash-api.js";
import { getActiveSource, nodeTag } from "/lib/singbox.js";
import { FLAGS_BASE, flagIsoFromName, stripFlag } from "/lib/flags.js";
import { escapeHtml, escapeAttr } from "/lib/esc.js";
import { isContextMenuKey, openPMenu } from "/lib/pmenu.js";
import { t, tn } from "/lib/i18n/index.js";
import {
  getRememberedProxySelection,
  rememberProxySelection,
} from "/lib/proxy-selection.js";
import { getFavourites, toggleFavourite } from "/lib/favourites.js";
import { isAmneziaWg2, isAmneziaWg3 } from "/lib/protocol-parsers.js";
import { countryName } from "/lib/country-names.js";
import { PROXIES_UI_PREFIX } from "/lib/storage-policy.js";
import { recordProbes, getProbeHistory, pruneProbeHistory } from "/lib/delay-history.js";
import {
  liveDelays, medianOf, stdevOf, scoreNode, reasonKeys,
} from "/lib/node-ranking.js";

function $(id) { return document.getElementById(id); }

const POLL_MS = 4000;
const SOURCE_READY_RETRIES = 4;
const SOURCE_READY_BACKOFF_MS = 250;

let pollTimer = null;
// Is the screen open? In strict mode there's no polling, so visibility can't be
// determined from pollTimer — we keep a separate flag.
let viewActive = false;
let testingAll = false;
// "Measure all" progress: { done, total }. null — no run in progress.
let sweep = null;
let lastClashSnapshot = null;
// Local optimistic active: after a click we highlight right away, without waiting for polling.
let optimisticActiveTag = null;
let optimisticUntilTs = 0;
// The remembered effective node — so that ninety:node-changed is dispatched only on an actual change
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
    // A new single-node subscription is safely selected on its own. But if the source
    // used to be multi-node and keeps Auto/a vanished pin, we don't draw false
    // activity: a click on the single card will pin it explicitly.
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

// ── flags: node name → ISO ── (logic in /lib/flags.js, imported above)
// The fallback for a missing .svg is attached NOT with an inline handler (`onerror=`), but
// via addEventListener in attachFlagFallbacks() after the markup is inserted: a strict
// CSP (`script-src 'self'` without unsafe-inline) blocks inline event handlers,
// so inline onerror silently didn't fire. data-flag-fallback carries the replacement text.
function flagHtml(iso, fallbackText) {
  if (iso) {
    return `<img class="prox__flag-img" src="${FLAGS_BASE}/${iso}.svg" alt="" loading="lazy" data-flag-fallback="${escapeAttr(fallbackText || "?")}">`;
  }
  return `<span class="prox__flag-fallback">${escapeHtml(fallbackText || "?")}</span>`;
}

// After inserting the markup: attach a load error handler to every flag img
// (CSP-compatible) and immediately check the ones that already failed (complete && naturalWidth=0,
// e.g. from the cache) — replace a broken flag with the text fallback.
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

// ── subscription node list → nodes with clash tags ──────────────
export function nodesFromSource() {
  const src = getActiveSource();
  if (!src) return [];
  const raw = src.kind === "sub" ? src.nodes : [src.profile];
  // We don't filter nodes: transports the core can't handle itself are served by the app
  // with a separate core on a local bridge — in the list they're full-fledged.
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

// A Clash snapshot belongs to the active source only if it already
// contains the topology built for this source. This separates the new UI
// from the old core during a reconnect.
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
  return ["auto", ...expectedTags].every(tag =>
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

// ── favorites / search / sorting / grouping ────────────
let query = "";
let sortState = loadUi("sort", { key: "ping", dir: "asc" });
let grouped = loadUi("grouped", true);
let recOpen = loadUi("recOpen", true);
const collapsedGroups = new Set();
let lastSignature = "";
// Row data is separate from the list structure: while only numbers change,
// the table doesn't need to be rebuilt — see renderTable.
let lastDataSignature = "";
// The row order frozen for the duration of a "Measure all" run.
//
// It can't be kept permanently: the "Latency" column is highlighted as the active
// sort, and a list that doesn't match it reads as a breakage —
// the server picked by "Auto" ends up below rows with smaller numbers. So
// outside a run the order is recomputed on every update; this is cheap because
// ready rows are rearranged rather than the table being rebuilt.
//
// During a run the order is frozen after all: measurements arrive there in batches
// several times a second, and the list would otherwise reshuffle under the cursor.
let sortFreeze = null;
// tag → fingerprint of the drawn latency cells. Lets us touch only the rows
// where the number actually changed.
const rowState = new Map();

// A full rebuild on the next render: the list structure no longer matches
// what's drawn.
function invalidateRender() {
  lastSignature = "";
  lastDataSignature = "";
  rowState.clear();
}

// The screen's UI key prefix comes from the storage policy, not from a literal here.
function loadUi(k, dflt) {
  try {
    const v = localStorage.getItem(PROXIES_UI_PREFIX + k);
    return v == null ? dflt : JSON.parse(v);
  } catch { return dflt; }
}
function saveUi(k, v) {
  try { localStorage.setItem(PROXIES_UI_PREFIX + k, JSON.stringify(v)); } catch {}
}

// ── statistics from the clash measurement history ─────────────────────
// The history is kept by the app: the core doesn't have one (see lib/delay-history.js).
// The source fixed for the duration of one render pass. The latency history
// is needed by EVERY row (plus the signature, sorting and recommendations), and
// getActiveSource() gets the subscription from the protected storage with a deep
// copy: on a subscription of three hundred servers this produced over a thousand
// copies per render and seconds of interface freeze.
let renderSource = null;

function historyOf(_clashData, tag) {
  return getProbeHistory(renderSource || getActiveSource(), tag);
}
// ── recommendation engine ─────────────────────────────────────
function rankNodes(nodes, clashData) {
  return nodes
    // A recommendation must be about a server that responds NOW. The measurement
    // history lives in the app and survives both a reconnect and the death of a subscription,
    // so by itself it only proves that the server worked at some point:
    // without this check "best by measurements" included a server the core hadn't confirmed in
    // the current session and through which traffic wouldn't go.
    .map(n => ({ n, s: coreDelay(clashData, n.clashTag) ? scoreNode(n, historyOf(clashData, n.clashTag)) : null }))
    .filter(x => x.s)
    .sort((a, b) => b.s.total - a.s.total);
}
function reasonFor(key, s, node, superlative) {
  if (key === "latency")   return { icon: ICON_GAUGE,  text: t(superlative ? "proxies.whyFastest" : "proxies.whyLatency", { ms: Math.round(s.med) }) };
  if (key === "stability") return { icon: ICON_PULSE,  text: t("proxies.whyStable", { ms: Math.round(s.jit || 0) }) };
  if (key === "liveness")  return { icon: ICON_SHIELD, text: tn("proxies.whyLive", s.okN, { all: s.allN }) };
  return { icon: ICON_SERVER, text: t("proxies.whyTransport", { name: transportLabel(node) }) };
}
function reasonsFor(top, field) {
  return reasonKeys(top, field).map(({ key, superlative }, i) =>
    reasonFor(key, top[i].s, top[i].n, superlative));
}

// ── icons (canonical Lucide, stroke adjusted to the system) ──
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
const ICON_CHECK = SVG('<path d="M20 6 9 17l-5-5"/>', 1.9);
const ICON_REFRESH = SVG('<path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/>');

const _isoMemo = new Map();
function isoOf(name) {
  const key = String(name || "");
  if (_isoMemo.has(key)) return _isoMemo.get(key);
  const v = flagIsoFromName(key);
  if (_isoMemo.size > 512) _isoMemo.clear();
  _isoMemo.set(key, v);
  return v;
}
const _cleanMemo = new Map();
function cleanNameOf(name) {
  const key = String(name || "");
  if (_cleanMemo.has(key)) return _cleanMemo.get(key);
  const v = stripFlag(key);
  if (_cleanMemo.size > 512) _cleanMemo.clear();
  _cleanMemo.set(key, v);
  return v;
}

function transportLabel(n) {
  const PROTO_LABEL = {
    naive: "Naive", trusttunnel: "TrustTunnel", anytls: "AnyTLS", mieru: "Mieru",
    hysteria: "Hysteria", hysteria2: "Hysteria2", tuic: "TUIC",
    socks: "SOCKS", shadowsocks: "Shadowsocks", openvpn: "OpenVPN",
  };
  // AmneziaWG shaping sets a profile apart from regular WireGuard more than
  // the transport does: this label is how the user recognizes what they imported.
  if (n?.proto === "wireguard") {
    const awg = n.awg || {};
    if (isAmneziaWg3(awg)) return "AmneziaWG 3";
    if (isAmneziaWg2(awg)) return "AmneziaWG 2.0";
    const shaped = awg.jc > 0 || awg.s1 > 0 || awg.s2 > 0 || awg.i1
      || [awg.h1, awg.h2, awg.h3, awg.h4].some((value, index) => value && value !== index + 1);
    return shaped ? "AmneziaWG" : "WireGuard";
  }
  // A ready Xray outbound: the label (XMC, VLESS ML-KEM) is set by the importer.
  if (n?.proto === "xray") return n.label || "Xray";
  if (PROTO_LABEL[n?.proto]) return PROTO_LABEL[n.proto];
  const sec = String(n?.security || "").toLowerCase();
  if (sec === "reality") return "REALITY";
  return String(n?.type || "tcp").toUpperCase();
}

// ── search match highlighting ─────────────────────────────
// Highlighting search matches. We search in the ORIGINAL text and escape each
// piece separately. The former order (escapeHtml first, then a regex over the ready
// markup) cut HTML entities: the query "amp" turned `&amp;` into
// `&<mark>amp</mark>;`, and instead of "&" the node name showed the raw text of the
// entity. Escaping didn't get weaker: both the text between matches and the matches
// themselves go through escapeHtml; only <mark> stays a literal.
function highlight(text) {
  const raw = String(text ?? "");
  const q = query.trim();
  if (!q) return escapeHtml(raw);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    .map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return escapeHtml(raw);
  // The terms are non-empty (filter(Boolean)), so a zero-length match and
  // the related infinite matchAll loop are impossible.
  const re = new RegExp("(" + terms.join("|") + ")", "gi");
  let out = "";
  let last = 0;
  for (const m of raw.matchAll(re)) {
    out += escapeHtml(raw.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(raw.slice(last));
}

// ── jitter: the last 12 measurements ───────────────────────────
function sparkHtml(hs) {
  const L = liveDelays(hs);
  if (L.length < 2) {
    const title = !hs.length ? t("proxies.sparkNever")
      : L.length ? t("proxies.sparkOne", { all: hs.length })
                 : t("proxies.sparkDead", { all: hs.length });
    // There aren't two points yet — nothing to draw a line with. A dash is more honest than a flat line,
    // which is easy to mistake for a broken chart.
    return `<span class="n-spark-none" title="${escapeAttr(title)}">—</span>`;
  }
  const mn = Math.min(...L), mx = Math.max(...L), sp = Math.max(1, mx - mn);
  const title = t("proxies.sparkTip", {
    ok: L.length, all: hs.length, min: mn, max: mx,
    med: medianOf(L), jit: Math.round(stdevOf(L)),
  });
  // The same live value filter as in liveDelays: the 65535 timeout sentinel
  // would otherwise go far beyond the viewBox and break the chart.
  const alive = (d) => d > 0 && d < 65000;
  const yOf = (d) => alive(d) ? 13 - ((d - mn) / sp) * 11 : 13;
  const pts = hs.map((d, i) => `${((i / Math.max(1, hs.length - 1)) * 52).toFixed(1)},${yOf(d).toFixed(1)}`).join(" ");
  const lastY = yOf(hs.at(-1));
  return `<svg class="n-spark" viewBox="-1 0 55 15" role="img"><title>${escapeHtml(title)}</title><polyline points="${pts}"/><circle cx="52" cy="${lastY.toFixed(1)}" r="1.5"/></svg>`;
}

// The CORE measurement, without falling back to the local archive. Only it answers the question
// "does the server respond now": currentDelay below can substitute the last
// saved point, and the "responding" counter built on it showed
// measurements from past sessions — on a dead subscription the screen reported "88 of 268"
// and didn't change after "Measure all".
function coreDelay(clashData, tag) {
  const d = lastDelay(clashData?.proxies?.[tag]);
  return d > 0 && d < 65000 ? d : 0;
}

// The number exists only in the local archive — the core hasn't confirmed this node in the current
// session. Such values are shown dimmed so that a dead server doesn't
// look alive.
function isStaleDelay(clashData, tag) {
  return !coreDelay(clashData, tag) && currentDelay(clashData, tag) > 0;
}

function currentDelay(clashData, tag) {
  const live = lastDelay(clashData?.proxies?.[tag]);
  if (live > 0 && live < 65000) return live;
  // We take the last RECORDED point, including a zero one: falling back to the last
  // successful measurement left a dead server with an old green number, counted
  // it as responding and let it into the sorting of live ones.
  const own = historyOf(clashData, tag);
  const lastOwn = own.length ? own[own.length - 1] : 0;
  return lastOwn > 0 && lastOwn < 65000 ? lastOwn : 0;
}

function pingHtml(delay, grade, stale = false) {
  if (delay > 0 && delay < 65000) {
    const attrs = stale ? ` data-stale="true" title="${escapeAttr(t("proxies.staleHint"))}"` : "";
    return `<div class="n-ping" data-grade="${grade}"${attrs}>${delay}<span class="n-unit">${t("proxies.pingUnit")}</span></div>`;
  }
  return `<div class="n-ping" data-grade="dead">—</div>`;
}

function starHtml(tag, on) {
  return `<button class="n-star" type="button" data-fav="${escapeAttr(tag)}" aria-pressed="${on}"
    aria-label="${escapeAttr(on ? t("proxies.favOff") : t("proxies.favOn"))}"
    title="${escapeAttr(on ? t("proxies.favIn") : t("proxies.favAdd"))}">${ICON_STAR}</button>`;
}

// ── table row ──────────────────────────────────────────
function nodeRowHtml(n, ctx) {
  const hs = historyOf(ctx.clashData, n.clashTag);
  const delay = currentDelay(ctx.clashData, n.clashTag);
  const iso = isoOf(n.name);
  const cleanName = cleanNameOf(n.name) || n.host;
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
      ${pending ? `<span class="n-dash">···</span>` : pingHtml(delay, gradeDelay(delay), isStaleDelay(ctx.clashData, n.clashTag))}
      ${starHtml(n.clashTag, ctx.favs.has(n.clashTag))}
      <button class="n-icon" type="button" data-node-menu="${escapeAttr(n.clashTag)}"
        aria-haspopup="menu" aria-label="${escapeAttr(t("proxies.rowActions"))}">${ICON_DOTS}</button>
    </div>`;
}

function fullName(node) {
  return cleanNameOf(node?.name) || node?.host || "";
}

// Subtitle "Selected {name} · {n} of {total} responding". Providers' names
// can be decorated ("Estonia #2 ⚡ 10 Gbit ⚡ Low Ping"), so we cut them
// not by character count but when space actually runs out: the name is truncated via CSS,
// and the responding counter stays whole (it's short and more important than the tail of the name).
// Previously the name was cut in JS at 16 characters and stayed truncated even
// at full screen.
function metaLineHtml(pin, alive) {
  const SLOT_PIN = "\u0001", SLOT_ALIVE = "\u0002";
  const line = t("proxies.metaLine", { pin: SLOT_PIN, alive: SLOT_ALIVE });
  const at = line.indexOf(SLOT_PIN);
  // The separator from the template goes into the tail rather than staying a separate text
  // node between flex items: otherwise the spaces around it risk collapsing.
  const head = at < 0 ? "" : line.slice(0, at);
  const tail = at < 0 ? line : line.slice(at + SLOT_PIN.length);
  return `<span class="screen__sub-pin">${escapeHtml(head + pin)}</span>`
    + `<span class="screen__sub-rest">${escapeHtml(tail).replace(SLOT_ALIVE, escapeHtml(alive))}</span>`;
}

function countryOf(n) {
  const iso = isoOf(n.name);
  // Provider service entries ("22 October 2026", banners) have no country.
  // Previously each created its own group and cluttered the list.
  if (!iso) return t("proxies.groupOther");
  return countryName(iso);
}

// ── recommendations block ───────────────────────────────────────
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
  const rankedTop = ranked.length ? ranked[0].n : null;
  // "Now" must name the node through which the core actually routes traffic
  // (Balancer.Now() → proxies.auto.now → ctx.liveTag), NOT the ranking winner.
  // Previously both lines were taken from the ranking, and on a dead subscription the screen claimed
  // "Now → Russia [03] 44 ms" while traffic was on the first node in the list.
  const leaderNode = ctx.selectorTag === "auto" && ctx.liveTag
    ? nodes.find(n => n.clashTag === ctx.liveTag) || null
    : null;
  const autoPick = ctx.selectorTag === "auto" ? leaderNode : rankedTop;
  const autoDelay = autoPick ? currentDelay(ctx.clashData, autoPick.clashTag) : 0;
  const autoSub = !autoPick
    ? t("proxies.autoIdle")
    : ctx.selectorTag === "auto"
      ? t("proxies.autoNow", { name: cleanNameOf(autoPick.name) || autoPick.host })
      : t("proxies.autoWould", { name: cleanNameOf(autoPick.name) || autoPick.host });

  const autoRow = `
    <div class="n-row rec-row prox" data-active="${ctx.selectorTag === "auto"}" data-tag="auto" role="button" tabindex="-1">
      <span class="n-flag rec-row__bolt">${ICON_BOLT}</span>
      <div class="rec-row__main">
        <span class="rec-row__name"><span class="n-primary">${t("proxies.auto")}</span></span>
        <span class="rec-row__reason">${ICON_PULSE}${escapeHtml(autoSub)}</span>
      </div>
      ${autoPick ? sparkHtml(historyOf(ctx.clashData, autoPick.clashTag)) : `<span></span>`}
      ${autoPick ? pingHtml(autoDelay, gradeDelay(autoDelay), isStaleDelay(ctx.clashData, autoPick.clashTag)) : `<span class="n-ping" data-grade="dead">—</span>`}
    </div>`;

  // No measurements yet: "Auto" stays, and instead of the list there's an explanation and an action.
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
    const iso = isoOf(n.name);
    const cleanName = cleanNameOf(n.name) || n.host;
    const fallback = iso ? iso.toUpperCase() : (cleanName.slice(0, 2).toUpperCase() || "?");
    const delay = currentDelay(ctx.clashData, n.clashTag);
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
        ${pingHtml(delay, gradeDelay(delay), isStaleDelay(ctx.clashData, n.clashTag))}
      </div>`;
  }).join("");

  box.innerHTML = head(`<span class="n-group__n">${tn("proxies.byProbesN", ranked[0].s.allN)}</span>`) +
    `<div class="n-plate rec__body" id="rec-body"${recOpen ? "" : " hidden"}>${autoRow}${rows}</div>`;

}

// Rearranging already existing rows into a new order. appendChild moves
// the node rather than copying it, so the cost is moving references, without parsing markup.
// If the order already matches, the DOM isn't touched at all.
function reorderRows(container, nodes) {
  if (!container || !Array.isArray(nodes)) return;
  const rows = container.querySelectorAll(".nt-row[data-tag]");
  if (rows.length !== nodes.length) return;
  let same = true;
  for (let i = 0; i < nodes.length; i++) {
    if (rows[i].dataset.tag !== nodes[i].clashTag) { same = false; break; }
  }
  if (same) return;
  // We rearrange only what's out of place. A full reordering
  // would touch all rows even when two swapped places, and each such
  // edit means layout work for the whole list.
  const byTag = new Map([...rows].map(el => [el.dataset.tag, el]));
  let cursor = container.firstElementChild;
  for (const node of nodes) {
    const el = byTag.get(node.clashTag);
    if (!el) continue;
    if (el === cursor) { cursor = cursor.nextElementSibling; continue; }
    container.insertBefore(el, cursor);
  }
}

// Grouping of the "rest" by country: the lists, the group order and the group label.
// It's computed the same way for a full rebuild and for a soft update,
// so it lives in a separate function — otherwise the two paths diverge.
function groupRest(rest, { cmpNode, cmp, val, clashData }) {
  const byC = {};
  rest.forEach(n => { const c = countryOf(n); (byC[c] ||= []).push(n); });
  Object.keys(byC).forEach(c => byC[c].sort(cmpNode));
  // Countries are reordered with the same click: by name — alphabetically, by the other
  // columns — by a representative, i.e. by the first row within the country.
  const gkey = (c) => sortState.key === "name" ? c : val[sortState.key](byC[c][0]);
  const order = Object.keys(byC).sort((a, b) => cmp(gkey(a), gkey(b)));
  const noteOf = (c) => {
    const list = byC[c];
    const mins = list.map(x => val.ping(x)).filter(x => x < 1e9);
    const never = list.every(x => !historyOf(clashData, x.clashTag).length);
    return mins.length ? t("proxies.groupFrom", { ms: Math.min(...mins) })
      : never ? t("proxies.groupNever") : t("proxies.groupDead");
  };
  return { byC, order, noteOf };
}

// Soft update of the grouped list. The same idea as for the flat one:
// the composition hasn't changed, the numbers and the order have. Previously this branch existed only
// for the flat list, while grouping by country is the default mode, and every
// new measurement rebuilt the whole table in it from scratch.
// false = the structure on screen isn't what we expect → the caller does a full render.
function patchGroupedRows(grid, { favList, byC, order, noteOf }) {
  const favHead = grid.querySelector(".nt__grp--static");
  if (!!favList.length !== !!favHead) return false;
  const heads = [...grid.querySelectorAll(".nt__grp[data-c]")];
  if (heads.length !== order.length) return false;

  const pairs = new Map();
  for (const head of heads) {
    const body = head.nextElementSibling;
    if (!body?.classList.contains("nt-body")) return false;
    if (!byC[head.dataset.c]) return false;
    pairs.set(head.dataset.c, { head, body });
  }
  if (pairs.size !== order.length) return false;

  if (favHead) {
    const favBody = favHead.nextElementSibling;
    if (!favBody?.classList.contains("nt-body")) return false;
    reorderRows(favBody, favList);
  }

  for (const c of order) {
    const { head, body } = pairs.get(c);
    reorderRows(body, byC[c]);
    const meta = head.querySelector(".n-meta");
    const note = noteOf(c);
    if (meta && meta.textContent !== note) meta.textContent = note;
  }

  // The order of the countries themselves is touched only if it actually changed: moving
  // a node means layout work for the whole list, there's no point doing it idly.
  const domOrder = heads.map(h => h.dataset.c);
  if (domOrder.some((c, i) => c !== order[i])) {
    for (const c of order) {
      const { head, body } = pairs.get(c);
      grid.appendChild(head);
      grid.appendChild(body);
    }
  }
  return true;
}

function restoreRowFocus(grid, tag) {
  if (document.activeElement?.closest?.(".nt-row, .rec-row")) return;
  const sel = `[data-tag="${CSS.escape(tag)}"]`;
  const again = grid.querySelector(`.nt-row${sel}`) || $("proxies-rec")?.querySelector(`.rec-row${sel}`);
  if (again) again.focus({ preventScroll: true });
}

// Targeted update of the "Jitter" and "Latency" cells in already drawn rows.
// We change only those whose fingerprint changed: one run tick brings
// a few results, not three hundred, so the work comes to a handful of
// rows instead of a full rebuild with all the flags and handlers.
function patchDelayCells(grid, pool, ctx) {
  for (const node of pool) {
    const tag = node.clashTag;
    const hs = historyOf(ctx.clashData, tag);
    const delay = currentDelay(ctx.clashData, tag);
    const stale = isStaleDelay(ctx.clashData, tag);
    const pending = ctx.testing && !hs.length;
    const key = `${delay}|${hs.length}|${pending ? 1 : 0}|${stale ? 1 : 0}`;
    if (rowState.get(tag) === key) continue;
    const row = grid.querySelector(`.nt-row[data-tag="${CSS.escape(tag)}"]`);
    if (!row) continue;
    rowState.set(tag, key);
    row.dataset.pending = String(pending);
    const spark = row.querySelector(".n-spark, .n-spark-none, .n-wait");
    if (spark) spark.outerHTML = pending ? `<span class="n-wait"></span>` : sparkHtml(hs);
    const ping = row.querySelector(".n-ping, .n-dash");
    if (ping) {
      ping.outerHTML = pending
        ? `<span class="n-dash">···</span>`
        : pingHtml(delay, gradeDelay(delay), stale);
    }
  }
}

// ── table ─────────────────────────────────────────────────
function sortHeader(key, label, end) {
  const on = sortState.key === key;
  return `<button class="nt__h${end ? " nt__h--end" : ""}" type="button" data-k="${key}"
    data-sorted="${on}" data-dir="${on ? sortState.dir : "desc"}">${escapeHtml(label)}${ICON_CHEV}</button>`;
}

function render(nodes, selectorTag, effectiveTag, clashData, options = {}) {
  const source = getActiveSource();
  renderSource = source;
  try {
    return renderTable(nodes, selectorTag, effectiveTag, clashData, options, source);
  } finally {
    renderSource = null;
  }
}

function renderTable(nodes, selectorTag, effectiveTag, clashData, { strict = false } = {}, source) {
  const grid = $("proxies-grid");
  const metaEl = $("proxies-meta");
  if (!grid) return;

  const favs = getFavourites(source);
  const multi = nodes.length >= 2 && !strict;
  // Pinned by me ≠ what the traffic actually goes through. In "Auto" these are different rows.
  const liveTag = selectorTag === "auto" ? effectiveTag : selectorTag;
  const ctx = { clashData, selectorTag, liveTag, favs, multi, testing: testingAll };

  if (!nodes.length) {
    grid.innerHTML = `<div class="n-empty"><span class="n-empty__i">${ICON_SERVER}</span>
      <h3>${escapeHtml(t("proxies.emptyTitle"))}</h3><p>${escapeHtml(t("proxies.emptySub"))}</p></div>`;
    if (metaEl) metaEl.textContent = t("proxies.metaNone");
    const rec = $("proxies-rec"); if (rec) { rec.hidden = true; rec.innerHTML = ""; }
    invalidateRender();
    return;
  }

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (n) => terms.every(term =>
    `${cleanNameOf(n.name)} ${n.host} ${transportLabel(n)} ${countryOf(n)}`.toLowerCase().includes(term));
  const pool = terms.length ? nodes.filter(matches) : nodes;
  const flat = !grouped || terms.length > 0;

  // A full innerHTML every 4 seconds would reset row focus and the search input.
  // We rebuild only when something actually changed — and distinguish two kinds of
  // "changed": composition/order/filters require a rebuild, while a new latency
  // number only requires replacing two cells in a ready row. During a
  // "Measure all" run results arrive in batches several times a second, and
  // rebuilding three hundred rows with flags for every batch is exactly those
  // seconds the window froze for.
  // Fingerprints are built by concatenation, not JSON.stringify: that one on every tick
  // (every 4 seconds) produced an array of tags plus a couple more for EVERY node — on
  // a subscription of three hundred nodes that's hundreds of short-lived objects into the garbage just
  // to compare "did anything change".
  const SEP = "\u0001";
  const sigParts = [
    selectorTag, effectiveTag, query, sortState.key, sortState.dir,
    grouped, recOpen, strict, testingAll, !!sortFreeze,
    [...favs].sort().join(","), [...collapsedGroups].sort().join(","),
  ];
  for (const n of pool) sigParts.push(n.clashTag);
  const signature = sigParts.join(SEP);

  const dataParts = [sweep ? `${sweep.done}/${sweep.total}` : ""];
  for (const n of pool) {
    dataParts.push(`${lastDelay(clashData?.proxies?.[n.clashTag])}|${historyOf(clashData, n.clashTag).length}`);
  }
  const dataSignature = dataParts.join(SEP);
  if (signature === lastSignature && dataSignature === lastDataSignature) return;
  const structureChanged = signature !== lastSignature;
  lastSignature = signature;
  lastDataSignature = dataSignature;

  // We count by the CORE measurements. The former count via currentDelay fell back to
  // the local archive, so the "responding" number got fixed in the first session and
  // wasn't recomputed either on "Measure all" or when the subscription died.
  const alive = nodes.filter(n => coreDelay(clashData, n.clashTag) > 0).length;

  if (metaEl) {
    if (terms.length) {
      metaEl.textContent = tn("proxies.metaFound", pool.length, { total: nodes.length });
    } else if (strict) {
      metaEl.textContent = t("proxies.meta", { srv: tn("prof.srvN", nodes.length), alive: "—", mode: t("proxies.strictPinned") });
    } else {
      const liveNode = nodes.find(n => n.clashTag === liveTag);
      const pin = selectorTag === "auto"
        ? (liveNode ? t("proxies.pinAuto", { name: fullName(liveNode) }) : t("proxies.auto"))
        : t("proxies.pinNode", { name: selectorTag ? fullName(nodes.find(n => n.clashTag === selectorTag)) || "—" : "—" });
      // During a run we show progress, not the total: otherwise the counter crawls
      // up from zero and looks like "the subscription died".
      const tail = sweep
        ? t("proxies.metaTesting", { done: sweep.done, total: sweep.total, alive })
        : tn("proxies.metaAlive", alive, { total: nodes.length });
      metaEl.innerHTML = metaLineHtml(pin, tail);
    }
  }

  const focusedTag = document.activeElement?.closest?.(".nt-row, .rec-row")?.dataset.tag || null;
  recHtml(nodes, ctx);


  const val = {
    name: n => cleanNameOf(n.name) || n.host,
    host: n => n.host,
    tr:   n => transportLabel(n),
    // Core-confirmed ones are sorted among themselves by latency, archived ones
    // come after them, those without data at the very end. Otherwise a number from a past
    // session squeezes in between live servers and looks like the best choice.
    ping: n => {
      const live = coreDelay(clashData, n.clashTag);
      if (live) return live;
      const archived = currentDelay(clashData, n.clashTag);
      return archived ? 1e6 + archived : 1e9;
    },
  };
  const dir = sortState.dir === "asc" ? 1 : -1;
  const raw = (x, y) => typeof x === "number" ? x - y : String(x).localeCompare(String(y), "ru");
  const cmp = (x, y) => raw(x, y) * dir;
  // With a tie on the main column — the fastest goes higher, then by name.
  // Without this "all REALITY" came out in the order they were added.
  // During a run the order is frozen: sorting by latency would otherwise
  // rearrange rows under the cursor on every arriving measurement, and the list
  // would "jump" for the whole run. After the run the render re-sorts everything at once.
  const frozenIndex = (n) => (sortFreeze?.has(n.clashTag) ? sortFreeze.get(n.clashTag) : Number.MAX_SAFE_INTEGER);
  const cmpNode = sortFreeze
    ? (a, b) => frozenIndex(a) - frozenIndex(b) || raw(val.name(a), val.name(b))
    : (a, b) => cmp(val[sortState.key](a), val[sortState.key](b))
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

  // Favorites are always on top and aren't duplicated in countries: the user's choice
  // matters more than the machine's and more than geography.
  const favList = pool.filter(n => favs.has(n.clashTag)).sort(cmpNode);
  const rest = pool.filter(n => !favs.has(n.clashTag));
  const restSorted = flat ? rest.slice().sort(cmpNode) : null;

  const groups = flat ? null : groupRest(rest, { cmpNode, cmp, val, clashData });

  // Soft update. The list composition is the same — the numbers and possibly
  // the order changed. The rows already exist: rearranging ready nodes and replacing two
  // cells in them is incomparably cheaper than building and parsing five thousand
  // nodes anew. A full rebuild when sorting by latency happened on EVERY
  // arriving measurement, i.e. every few seconds, and that's what was felt
  // as interface jerks.
  if (!structureChanged && grid.querySelector(".nt-row[data-tag]")) {
    let patched = false;
    if (flat) {
      const bodies = grid.querySelectorAll(".nt-body");
      const favBody = favList.length ? bodies[0] : null;
      const restBody = favList.length ? bodies[1] : bodies[0];
      if (restBody && (!favList.length || favBody)) {
        if (favBody) reorderRows(favBody, favList);
        reorderRows(restBody, restSorted);
        patched = true;
      }
    } else {
      patched = patchGroupedRows(grid, { favList, ...groups });
    }
    if (patched) {
      patchDelayCells(grid, pool, ctx);
      if (focusedTag) restoreRowFocus(grid, focusedTag);
      return;
    }
  }
  rowState.clear();

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
    body = `<div class="nt-body">${restSorted.map(n => nodeRowHtml(n, ctx)).join("")}</div>`;
  } else {
    const { byC, order, noteOf } = groups;
    body = order.map(c => {
      const list = byC[c];
      const open = !collapsedGroups.has(c);
      const note = noteOf(c);
      const iso = isoOf(list[0].name);
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

  // A new measurement redraws the whole table. Without this row focus would be lost
  // on every update and keyboard navigation would break every 4 seconds.
  grid.innerHTML = head + favBlock + body;
  attachFlagFallbacks(grid);
  // Fingerprints of what's drawn — so that the next patch touches only what changed.
  for (const node of pool) {
    const hs = historyOf(clashData, node.clashTag);
    const pending = ctx.testing && !hs.length;
    rowState.set(node.clashTag, `${currentDelay(clashData, node.clashTag)}|${hs.length}`
      + `|${pending ? 1 : 0}|${isStaleDelay(clashData, node.clashTag) ? 1 : 0}`);
  }
  if (focusedTag) {
    const sel = `[data-tag="${CSS.escape(focusedTag)}"]`;
    const again = grid.querySelector(`.nt-row${sel}`) || $("proxies-rec")?.querySelector(`.rec-row${sel}`);
    if (again) again.focus({ preventScroll: true });
  }
}

// ── render: related states ─────────────────────────
function effectiveSelectorTag(clashData) {
  // the optimistic override lives 4 s — until the backend confirms
  if (optimisticActiveTag && Date.now() < optimisticUntilTs) return optimisticActiveTag;
  return pickSelectorNow(clashData);
}

function renderApplying(nodes) {
  if (strictPrivacyEnabled()) { renderStrict(nodes); return; }
  invalidateRender();
  render(nodes, null, null, null);
  const metaEl = $("proxies-meta");
  if (metaEl) {
    metaEl.textContent = t("proxies.metaIdle", { srv: tn("prof.srvN", nodes.length) });
  }
}

function renderStrict(nodes = nodesFromSource()) {
  const selectedTag = strictSelectedTag(nodes);
  lastClashSnapshot = null;
  lastEffectiveTag = selectedTag;
  setRetestVisible(false);
  invalidateRender();
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
  const tags = nodes.map(n => n.clashTag);
  pruneProbeHistory(getActiveSource(), tags);
  // A new point in the history used to be accompanied by a full render invalidation —
  // i.e. every arriving measurement rebuilt the whole table. Now the difference
  // is seen by the data signature, and the cell patch handles it.
  recordProbes(getActiveSource(), data, tags);
  const selectorTag = effectiveSelectorTag(data);
  const effectiveTag = pickEffectiveNode(data);
  // URLTest may have reselected the node itself — sync the header and IP
  if (effectiveTag && effectiveTag !== lastEffectiveTag) {
    lastEffectiveTag = effectiveTag;
    const node = nodes.find(n => n.clashTag === effectiveTag) || null;
    dispatchNodeChanged(effectiveTag, node);
  }
  render(nodes, selectorTag, effectiveTag, data);
}

// ── click handler: node selection via Selector ───────────────
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
  // A single source has no Selector: the card is already the active
  // final outbound, so PUT /proxies/proxy isn't allowed here.
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
    if (selected?.stale) return;
    // The core has already accepted the choice — we remember it BEFORE the generation check. Otherwise leaving
    // the screen right after the click (onProxiesViewLeave bumps the generation)
    // left the core with the new server and the app with the old one in memory, and
    // the next reconnect brought back the previous one.
    rememberProxySelection(getActiveSource(), tag);
    if (generation !== sourceGeneration) return;
    onToast?.(tag === "auto" ? t("proxies.toastAuto") : t("proxies.toastSwitched"), "success", 1200);
    // For "auto" the actual outbound is determined by URLTest — we'll learn it after refresh.
    // For a manual choice — sync hero/location/IP right away.
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
  viewActive = true;
  invalidateRender();
  if (strictPrivacyEnabled()) {
    stopPoll();
    renderStrict();
    return;
  }
  refresh({ retry: true }).then(() => kickstartAutoIfNeeded());
  stopPoll();
  pollTimer = setInterval(refresh, POLL_MS);
}

// If active = "auto" but there are no measurements yet — the Balancer has nothing to choose with and
// holds the first node of the list. We force a group run, it fills the history.
//
// The former condition ("exit if auto.now is non-empty") never fired:
// Balancer.Now() always returns a tag — with an empty history it's a fallback to
// the first node. What has to be checked isn't the presence of a leader but the presence of its MEASUREMENT.
async function kickstartAutoIfNeeded() {
  if (strictPrivacyEnabled()) return;
  const data = lastClashSnapshot;
  if (!data) return;
  if (pickSelectorNow(data) !== "auto") return;
  const auto = data.proxies?.auto;
  if (!auto) return;
  const leader = auto.now && auto.now !== "auto" ? auto.now : null;
  if (leader && coreDelay(data, leader) > 0) return;
  // Cutting this run off by timeout is safe: the core no longer erases
  // the history of nodes whose probes didn't finish before the request was cancelled.
  try { await testGroup("auto", { timeoutMs: 20000 }); await refresh(); } catch {}
}

export function onProxiesViewLeave() {
  viewActive = false;
  stopPoll();
  sourceGeneration++;
  testingAll = false;
  sweep = null;
}

export function resetProxiesViewForSourceChange() {
  sourceGeneration++;
  lastClashSnapshot = null;
  optimisticActiveTag = null;
  optimisticUntilTs = 0;
  lastEffectiveTag = null;
  // There's no point redrawing a hidden screen: on a subscription of hundreds of servers that's
  // half a second of main thread blocking right in the middle of a source switch.
  // Entering the screen always starts with a render, and the reset signature won't let
  // it consider the list unchanged.
  if (!viewActive) {
    invalidateRender();
    return;
  }
  const nodes = nodesFromSource();
  if (strictPrivacyEnabled()) renderStrict(nodes);
  else renderApplying(nodes);
  void refresh({ retry: true });
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Live re-render on a language change (from onLangChange). Without the network we take the last
// clash snapshot; if there's none, render draws an empty state.
export function rerenderProxiesView() {
  if (!$("proxies-grid")) return;
  // A language change on a hidden screen: there's no need to rebuild the list, it will
  // be redrawn on entry anyway — but we reset the signature so that entry does it.
  if (!viewActive) {
    invalidateRender();
    return;
  }
  invalidateRender();
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
    invalidateRender();
    if (strictPrivacyEnabled()) renderStrict();
    else render(nodesFromSource(), effectiveSelectorTag(lastClashSnapshot),
                pickEffectiveNode(lastClashSnapshot), lastClashSnapshot);
  };

  const screen = document.querySelector('.screen[data-view="proxies"]');

  screen?.addEventListener("click", (e) => {
    // Actions inside a row must not select the node
    const fav = e.target.closest("[data-fav]");
    if (fav) {
      e.stopPropagation();
      const on = toggleFavourite(getActiveSource(), fav.dataset.fav);
      rerender();
      onToast?.(on ? t("proxies.favToastOn") : t("proxies.favToastOff"), "success", 1400);
      return;
    }
    const menu = e.target.closest("[data-node-menu]");
    if (menu) {
      e.stopPropagation();
      // detail === 0 — a keyboard press: focus goes straight to the first item.
      openNodeMenu(menu, menu.closest(".prox"), onToast, { focusFirst: e.detail === 0 });
      return;
    }
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
      invalidateRender();
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

  // Right click on a server row → the row menu at the cursor. The "Auto" row
  // has no actions of its own — no menu there.
  screen?.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".nt-row.prox");
    if (!row) return;
    e.preventDefault();
    openNodeMenu({ x: e.clientX, y: e.clientY }, row, onToast, { returnFocus: row });
  });

  // ── keyboard: a dense table must be navigable with the arrows ──
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
    if (isContextMenuKey(e)) {
      const row = e.target.closest?.(".nt-row.prox");
      if (!row) return;
      e.preventDefault();
      openNodeMenu(row, row, onToast, { returnFocus: e.target, focusFirst: true });
      return;
    }
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
    else if ((e.key === "Enter" || e.key === " ") && cur) {
      // A row has its own buttons (★, ⋯) — they need their own Enter.
      if (e.target.closest("button")) return;
      e.preventDefault(); handleNodeClick(cur, onToast);
    }
    else if (e.key.toLowerCase() === "f" && cur && !e.ctrlKey && !e.metaKey && cur.dataset.tag !== "auto") {
      e.preventDefault();
      const on = toggleFavourite(getActiveSource(), cur.dataset.tag);
      rerender();
      onToast?.(on ? t("proxies.favToastOn") : t("proxies.favToastOff"), "success", 1400);
    }
  });

  // ── search ──
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

  // ── grouping ──
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

  // ── measure all ──
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
      // We fix the order the user sees right now: from here on rows
      // are only updated in place. If the table isn't drawn yet, there's nothing to freeze —
      // then the run goes with the regular rebuild.
      const drawn = [...($("proxies-grid")?.querySelectorAll(".nt-row[data-tag]") || [])];
      sortFreeze = drawn.length ? new Map(drawn.map((el, i) => [el.dataset.tag, i])) : null;
      invalidateRender();
      // refresh along the way — the list comes alive progressively, without waiting for all nodes
      let last = 0;
      sweep = { done: 0, total: new Set(nodes.map(n => n.clashTag)).size };
      await testAllNodes(nodes, (done) => {
        if (generation !== sourceGeneration) return;
        if (sweep) sweep.done = done;
        // Each refresh is a /proxies response for all nodes of the subscription: over a hundred
        // kilobytes of JSON through IPC. Updating the list once a second is
        // lively enough, and the window isn't busy parsing responses.
        const now = Date.now();
        if (now - last > 1000) { last = now; refresh(); }
      }, () => generation === sourceGeneration);
      sweep = null;
      if (generation !== sourceGeneration) return;
      onToast?.(t("proxies.toastRetested"), "success", 1600);
      await refresh();
    } catch (e) {
      onToast?.(t("proxies.toastTestErr", { err: e?.message || e }), "error", 2500);
    } finally {
      testingAll = false;
      sweep = null;
      // We unfreeze the order and rebuild the list once — with the final
      // sorting by fresh measurements.
      sortFreeze = null;
      invalidateRender();
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

// ── the "how it's calculated" popover ─────────────────────────────────
function hideScorePopover() { document.getElementById("rec-pop")?.remove(); }
function showScorePopover(anchor) {
  // Created on the spot, like the row menu: index.html doesn't have the element, and previously
  // "how it's calculated" silently didn't open.
  hideScorePopover();
  const p = document.createElement("div");
  p.className = "rec-pop";
  p.id = "rec-pop";
  p.setAttribute("role", "dialog");
  document.body.appendChild(p);
  const ranked = rankNodes(nodesFromSource(), lastClashSnapshot);
  if (!ranked.length) {
    p.innerHTML = `<div class="rec-pop__t">${escapeHtml(t("proxies.scoreNoneTitle"))}</div>
      <div class="rec-pop__d">${escapeHtml(t("proxies.scoreNoneBody"))}</div>`;
  } else {
    const { n, s } = ranked[0];
    const bar = (lbl, v) => `<div class="rec-pop__r"><span class="n-lbl">${escapeHtml(lbl)}</span>
      <div class="n-meter"><div class="n-meter__f" style="width:${(v * 100).toFixed(0)}%"></div></div>
      <span class="n-num">${(v * 100).toFixed(0)}</span></div>`;
    p.innerHTML = `<div class="rec-pop__t">${escapeHtml(t("proxies.scoreTitle", { name: cleanNameOf(n.name) || n.host }))}</div>
      <div class="rec-pop__d">${escapeHtml(t("proxies.scoreBody"))}</div>
      <div class="rec-pop__f">
        ${bar(t("proxies.scoreLatency"), s.latency)}${bar(t("proxies.scoreStability"), s.stability)}
        ${bar(t("proxies.scoreLiveness"), s.liveness)}${bar(t("proxies.scoreTransport"), s.transport)}
      </div>
      <div class="rec-pop__note">${escapeHtml(t("proxies.scoreNote", {
        med: Math.round(s.med), jit: Math.round(s.jit), ok: s.okN, all: s.allN }))}</div>`;
  }
  const ar = anchor.getBoundingClientRect();
  p.style.top = Math.min(ar.bottom + 6, window.innerHeight - p.offsetHeight - 10) + "px";
  p.style.left = Math.max(10, Math.min(ar.right - p.offsetWidth, window.innerWidth - p.offsetWidth - 10)) + "px";
}

// ── server action menu ────────────────────────────────
// The app's shared menu (lib/pmenu.js): the "⋯" button, a right click on a row and
// the Menu / Shift+F10 key open the same thing.
function openNodeMenu(anchor, row, onToast, opts = {}) {
  const tag = row?.dataset.tag;
  const node = tag && nodesFromSource().find(n => n.clashTag === tag);
  if (!node) return;
  const fav = getFavourites(getActiveSource()).has(tag);
  // An action that won't change anything must not look clickable:
  // on an already selected server the item shows a state, not an offer.
  const current = effectiveSelectorTag(lastClashSnapshot) === tag;
  openPMenu(anchor, [
    current
      ? { state: true, label: t("proxies.menuAlready"), icon: ICON_CHECK }
      : { id: "pin", label: t("proxies.menuPin"), icon: ICON_BOLT },
    { id: "fav", label: fav ? t("proxies.favOff") : t("proxies.favOn"), icon: ICON_STAR },
    { id: "test", label: t("proxies.menuTestOne"), icon: ICON_GAUGE },
  ], {
    align: "end",
    ...opts,
    onSelect: async (act) => {
      if (act === "pin") { handleNodeClick(row, onToast); return; }
      if (act === "fav") {
        const on = toggleFavourite(getActiveSource(), tag);
        invalidateRender();
        await refresh();
        onToast?.(on ? t("proxies.favToastOn") : t("proxies.favToastOff"), "success", 1400);
        return;
      }
      try { await testNode(tag, { timeoutMs: 5000 }); invalidateRender(); await refresh(); }
      catch (e2) { onToast?.(t("proxies.toastTestErr", { err: e2?.message || e2 }), "error", 2500); }
    },
  });
}

// Retesting ALL nodes one by one via /proxies/{tag}/delay (patched to unified →
// accurate, and EVERY call re-measures). The group endpoint would also re-measure everything,
// but with one node at a time the progress is visible, and the run survives leaving the screen.
//
// The run time is determined not by live servers but by dead ones: almost all of it goes to
// waiting for those who won't answer. So the count is based on how many of those we wait for
// simultaneously. The order is by the last known latency: a server that was already
// fast is checked first, and the list comes alive from the top rows rather than in
// the subscription's random order.
// A measurement costs about four round trips to the target through the server: even a distant
// node fits into a couple of seconds, so four are more than enough, and everything
// beyond is waiting for those who will never answer. Twenty simultaneous
// connections go unnoticed on a home connection (a browser opens more), while
// a run on a three-hundred-node subscription fits into less than a minute instead of
// three. We don't go higher: the gain is already small, and a burst of requests through
// IPC is noticeable in window responsiveness.
const TEST_ALL_CONCURRENCY = 24;
const TEST_ALL_TIMEOUT_MS = 4000;

async function testAllNodes(nodes, onProgress, shouldContinue = () => true) {
  const tags = [...new Set(nodes.map(n => n.clashTag))]
    .sort((a, b) => (currentDelay(lastClashSnapshot, a) || 1e9) - (currentDelay(lastClashSnapshot, b) || 1e9));
  let i = 0;
  let done = 0;
  async function worker() {
    while (i < tags.length) {
      if (!shouldContinue()) return;
      const tag = tags[i++];
      try { await testNode(tag, { timeoutMs: TEST_ALL_TIMEOUT_MS }); } catch {}
      done++;
      if (!shouldContinue()) return;
      try { onProgress?.(done); } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(TEST_ALL_CONCURRENCY, tags.length) }, worker));
}
