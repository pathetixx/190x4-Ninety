// Ninety · Proxies view — Hiddify-style: SVG-флаги, авто-сортировка по пингу,
// клик-выбор через Selector, AUTO-режим сверху, FAB-молния перетеста.

import {
  getProxies, testGroup, testNode, selectProxy,
  pickSelectorNow, pickEffectiveNode,
  lastDelay, gradeDelay,
} from "/lib/clash-api.js";
import { getActiveSource, nodeTag } from "/lib/singbox.js";

function $(id) { return document.getElementById(id); }

const POLL_MS = 4000;
const FLAGS_BASE = "/assets/flags";

let pollTimer = null;
let testingAll = false;
let lastClashSnapshot = null;
// Локальный optimistic-active: после клика подсвечиваем сразу, не ждём поллинг.
let optimisticActiveTag = null;
let optimisticUntilTs = 0;
// Запомненный effective node — чтобы диспатчить ninety:node-changed только при реальном изменении
let lastEffectiveTag = null;

function dispatchNodeChanged(tag, node) {
  window.dispatchEvent(new CustomEvent("ninety:node-changed", {
    detail: { tag, node: node || null },
  }));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// ── флаги: имя ноды → ISO-3166-1 alpha-2 (lowercase) ────────
// 1) Regional-indicator pair в названии (🇫🇮, 🇩🇪) → конвертим в "fi", "de".
// 2) Полное название страны словом ("Poland", "Финляндия") → ISO.
// 3) Иначе ищем явный 2-буквенный токен на границе слова ("FI", "DE-Mobile").
// 4) Маппинг частых не-ISO-сокращений в подписках (UK→gb, EN→gb и т.п.).
const NON_ISO_ALIAS = { uk: "gb", en: "gb", uae: "ae", usa: "us", rus: "ru" };

// Полные названия стран (англ. + рус.) → ISO. Для нод без эмодзи/кода в имени
// (hysteria/naive от EOFVPN: «Poland», «Germany», «Netherlands»…).
const COUNTRY_NAME = {
  poland: "pl", польша: "pl",
  germany: "de", deutschland: "de", германия: "de",
  finland: "fi", финляндия: "fi",
  czechia: "cz", "czech republic": "cz", czech: "cz", чехия: "cz",
  netherlands: "nl", holland: "nl", нидерланды: "nl", голландия: "nl",
  "united states": "us", "united states of america": "us", america: "us", сша: "us", америка: "us",
  "united kingdom": "gb", britain: "gb", england: "gb", британия: "gb", англия: "gb",
  france: "fr", франция: "fr",
  italy: "it", италия: "it",
  spain: "es", испания: "es",
  sweden: "se", швеция: "se",
  norway: "no", норвегия: "no",
  denmark: "dk", дания: "dk",
  switzerland: "ch", швейцария: "ch",
  austria: "at", австрия: "at",
  belgium: "be", бельгия: "be",
  ireland: "ie", ирландия: "ie",
  portugal: "pt", португалия: "pt",
  ukraine: "ua", украина: "ua",
  russia: "ru", россия: "ru",
  turkey: "tr", türkiye: "tr", турция: "tr",
  japan: "jp", япония: "jp",
  singapore: "sg", сингапур: "sg",
  "hong kong": "hk", hongkong: "hk", гонконг: "hk",
  taiwan: "tw", тайвань: "tw",
  korea: "kr", "south korea": "kr", корея: "kr",
  china: "cn", китай: "cn",
  india: "in", индия: "in",
  canada: "ca", канада: "ca",
  australia: "au", австралия: "au",
  brazil: "br", бразилия: "br",
  estonia: "ee", эстония: "ee",
  latvia: "lv", латвия: "lv",
  lithuania: "lt", литва: "lt",
  hungary: "hu", венгрия: "hu",
  romania: "ro", румыния: "ro",
  bulgaria: "bg", болгария: "bg",
  greece: "gr", греция: "gr",
  serbia: "rs", сербия: "rs",
  moldova: "md", молдова: "md",
  kazakhstan: "kz", казахстан: "kz",
  "united arab emirates": "ae", emirates: "ae", dubai: "ae", оаэ: "ae",
  israel: "il", израиль: "il",
  iceland: "is", исландия: "is",
  luxembourg: "lu", люксембург: "lu",
  argentina: "ar", аргентина: "ar",
  mexico: "mx", мексика: "mx",
  "south africa": "za",
  indonesia: "id", индонезия: "id",
  vietnam: "vn", вьетнам: "vn",
  thailand: "th", таиланд: "th",
  malaysia: "my", малайзия: "my",
  philippines: "ph", филиппины: "ph",
};
// Ключи, отсортированные по длине (убыв.) — многословные («united states»)
// матчатся раньше, чем их части («states» нет, но порядок надёжнее).
const COUNTRY_NAME_KEYS = Object.keys(COUNTRY_NAME).sort((a, b) => b.length - a.length);
// Экранируем для regex; ищем по границе слова, чтобы «romania» не дала «oman».
const COUNTRY_NAME_RE = new RegExp(
  "(?:^|[^\\p{L}])(" + COUNTRY_NAME_KEYS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![\\p{L}])",
  "iu"
);

function flagIsoFromName(name) {
  if (!name) return null;
  const codepoints = Array.from(name);
  for (let i = 0; i < codepoints.length - 1; i++) {
    const a = codepoints[i].codePointAt(0);
    const b = codepoints[i + 1].codePointAt(0);
    if (a >= 0x1F1E6 && a <= 0x1F1FF && b >= 0x1F1E6 && b <= 0x1F1FF) {
      const iso = String.fromCharCode(97 + (a - 0x1F1E6)) + String.fromCharCode(97 + (b - 0x1F1E6));
      return iso;
    }
  }
  // Полное название страны словом (англ./рус.) → ISO
  const cm = name.match(COUNTRY_NAME_RE);
  if (cm) return COUNTRY_NAME[cm[1].toLowerCase()];
  // Fallback: 2-3-буквенный токен в начале или после нечислового границы
  const m = name.match(/(?:^|[\s|·,])([A-Za-z]{2,3})\b/);
  if (m) {
    const tok = m[1].toLowerCase();
    if (NON_ISO_ALIAS[tok]) return NON_ISO_ALIAS[tok];
    if (tok.length === 2) return tok;
  }
  return null;
}

function stripFlag(name) {
  return String(name || "").replace(/(?:\p{Regional_Indicator}){2}\s*/u, "").trim();
}

function flagHtml(iso, fallbackText) {
  if (iso) {
    return `<img class="prox__flag-img" src="${FLAGS_BASE}/${iso}.svg" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'prox__flag-fallback',textContent:'${escapeHtml(fallbackText || "?")}'}))">`;
  }
  return `<span class="prox__flag-fallback">${escapeHtml(fallbackText || "?")}</span>`;
}

// ── список нод подписки → ноды с clash-тэгами ──────────────
function nodesFromSource() {
  const src = getActiveSource();
  if (!src) return [];
  const raw = src.kind === "sub" ? src.nodes : [src.profile];
  // С форком hiddify-sing-box xhttp поддерживается — больше не фильтруем.
  const filtered = raw;
  return filtered.map((n, i) => ({
    ...n,
    clashTag: filtered.length >= 2 ? nodeTag(i, n) : "proxy",
  }));
}

// ── сортировка ─────────────────────────────────────────────
const GRADE_ORDER = { good: 0, mid: 1, bad: 2, dead: 3 };

function sortNodes(nodes, clashData) {
  return nodes
    .map(n => {
      const delay = lastDelay(clashData?.proxies?.[n.clashTag]);
      return { n, delay, grade: gradeDelay(delay) };
    })
    .sort((a, b) => {
      const ga = GRADE_ORDER[a.grade], gb = GRADE_ORDER[b.grade];
      if (ga !== gb) return ga - gb;
      // внутри одного grade — по фактическому delay (live первые)
      if (a.delay !== b.delay) {
        const aa = a.delay > 0 ? a.delay : 99999;
        const bb = b.delay > 0 ? b.delay : 99999;
        return aa - bb;
      }
      return String(a.n.name || a.n.host).localeCompare(String(b.n.name || b.n.host));
    })
    .map(x => x.n);
}

// ── render ─────────────────────────────────────────────────
function effectiveSelectorTag(clashData) {
  // optimistic override живёт 4 сек — пока бэк не подтвердит
  if (optimisticActiveTag && Date.now() < optimisticUntilTs) {
    return optimisticActiveTag;
  }
  return pickSelectorNow(clashData);
}

function pingCellHtml(delay, grade) {
  if (delay > 0 && delay < 65000) {
    return `<div class="prox__ping" data-grade="${grade}">${delay}<span class="prox__ping-unit">мс</span></div>`;
  }
  return `<div class="prox__ping" data-grade="dead">—</div>`;
}

function nodeCardHtml(n, isActive, delay, grade) {
  const iso = flagIsoFromName(n.name);
  const cleanName = stripFlag(n.name) || n.host;
  const fallback = (iso ? iso.toUpperCase() : (cleanName.slice(0, 2).toUpperCase() || "?"));
  // naive/trusttunnel идут через sidecar (n.type не задан) — показываем имя
  // протокола, остальным — транспорт (tcp/xhttp/…).
  const PROTO_LABEL = { naive: "Naive", trusttunnel: "TrustTunnel" };
  const proto = PROTO_LABEL[n.proto] || (n.type || "tcp").toUpperCase();
  return `
    <div class="prox" data-active="${isActive}" data-tag="${escapeHtml(n.clashTag)}" role="button" tabindex="0">
      <div class="prox__flag">${flagHtml(iso, fallback)}</div>
      <div class="prox__main">
        <div class="prox__name">${escapeHtml(cleanName)}</div>
        <div class="prox__sub">
          <span>${escapeHtml(n.host)}</span>
          <span class="prox__sub-type">${escapeHtml(proto)}</span>
        </div>
      </div>
      ${pingCellHtml(delay, grade)}
    </div>
  `;
}

function autoCardHtml(isActive, effectiveTag, allNodes, clashData) {
  let subText = "Быстрейший по пингу";
  let pingHtml = `<div class="prox__ping" data-grade="dead">—</div>`;
  if (effectiveTag && effectiveTag !== "auto") {
    const node = allNodes.find(n => n.clashTag === effectiveTag);
    const delay = lastDelay(clashData?.proxies?.[effectiveTag]);
    const grade = gradeDelay(delay);
    if (node) {
      subText = `Сейчас → ${stripFlag(node.name) || node.host}`;
      pingHtml = pingCellHtml(delay, grade);
    }
  }
  return `
    <div class="prox prox--auto" data-active="${isActive}" data-tag="auto" role="button" tabindex="0">
      <div class="prox__flag" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>
        </svg>
      </div>
      <div class="prox__main">
        <div class="prox__name">Авто</div>
        <div class="prox__sub"><span>${escapeHtml(subText)}</span></div>
      </div>
      ${pingHtml}
    </div>
  `;
}

function render(nodes, selectorTag, effectiveTag, clashData) {
  const grid = $("proxies-grid");
  const metaEl = $("proxies-meta");
  if (!grid) return;

  if (!nodes?.length) {
    grid.innerHTML = `<div class="onb" style="grid-column:1/-1;margin:32px auto 0;text-align:center;"><div class="onb__kicker">NODES · EMPTY</div><h2 class="onb__title" style="font-size:18px">Нет нод</h2><p class="onb__sub">Подписка пуста или не подключена.</p></div>`;
    if (metaEl) metaEl.textContent = "Подписка не выбрана";
    return;
  }

  const alive = nodes.filter(n => {
    const d = lastDelay(clashData?.proxies?.[n.clashTag]);
    return d > 0 && d < 65000;
  }).length;

  if (metaEl) {
    const activeLabel = selectorTag === "auto"
      ? "Авто"
      : (selectorTag ? (nodes.find(n => n.clashTag === selectorTag)?.name?.slice(0, 24) || selectorTag) : "—");
    metaEl.textContent = `${nodes.length} нод · ${alive} активных · режим: ${activeLabel}`;
  }

  const sorted = sortNodes(nodes, clashData);
  const multi = nodes.length >= 2;

  let html = "";
  if (multi) {
    html += autoCardHtml(selectorTag === "auto", effectiveTag, nodes, clashData);
  }
  for (const n of sorted) {
    const delay = lastDelay(clashData?.proxies?.[n.clashTag]);
    const grade = gradeDelay(delay);
    const isManualActive = n.clashTag === selectorTag && selectorTag !== "auto";
    html += nodeCardHtml(n, isManualActive, delay, grade);
  }
  grid.innerHTML = html;
}

async function refresh() {
  let data = null;
  try {
    data = await getProxies();
    lastClashSnapshot = data;
  } catch (e) {
    data = lastClashSnapshot;
  }
  const nodes = nodesFromSource();
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
  const tag = card.dataset.tag;
  if (!tag) return;
  // optimistic UI
  optimisticActiveTag = tag;
  optimisticUntilTs = Date.now() + 4500;
  document.querySelectorAll("#proxies-grid .prox").forEach(c => {
    c.dataset.active = c.dataset.tag === tag ? "true" : "false";
  });
  try {
    await selectProxy("proxy", tag);
    onToast?.(tag === "auto" ? "Режим Авто" : "Сервер переключён", "success", 1200);
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
    onToast?.(`Не удалось переключить: ${e?.message || e}`, "error", 2500);
    await refresh();
  }
}

export function onProxiesViewEnter() {
  refresh().then(() => kickstartAutoIfNeeded());
  stopPoll();
  pollTimer = setInterval(refresh, POLL_MS);
}

// Если active = "auto" но monitoring ещё пустой — Balancer "auto" не знает
// delay'ев и фолбэчится к первой ноде. Форсим URLTest "lowest" (он наполняет
// monitoring) — после первого теста Balancer возьмёт реального лидера.
async function kickstartAutoIfNeeded() {
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
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export function mountProxiesView({ onToast } = {}) {
  const grid = $("proxies-grid");
  grid?.addEventListener("click", (e) => {
    const card = e.target.closest(".prox");
    if (!card) return;
    handleNodeClick(card, onToast);
  });
  grid?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".prox");
    if (!card) return;
    e.preventDefault();
    handleNodeClick(card, onToast);
  });

  // FAB test-all
  const fab = $("proxies-fab");
  fab?.addEventListener("click", async () => {
    if (testingAll) return;
    testingAll = true;
    fab.dataset.testing = "true";
    try {
      const nodes = nodesFromSource();
      // refresh по ходу — список оживает прогрессивно, не ждёт все ноды
      let last = 0;
      await testAllNodes(nodes, () => {
        const now = Date.now();
        if (now - last > 600) { last = now; refresh(); }
      });
      onToast?.("Перетестировал все ноды", "success", 1600);
      await refresh();
    } catch (e) {
      onToast?.(`Ошибка теста: ${e?.message || e}`, "error", 2500);
    } finally {
      testingAll = false;
      delete fab.dataset.testing;
    }
  });
}

// Перетест ВСЕХ нод по одной через /proxies/{tag}/delay (пропатчен на unified →
// точно, и перемеряет КАЖДЫЙ вызов). Групповой /group/lowest/delay тут не годится:
// он interval-gated (urlTest skip нод с history моложе 600с) → «обновить всё»
// освежало лишь устаревшие, а свежие (включая то, что дёргает автозамер главной)
// застывали. Пул concurrency=8 — как batch-лимит в самом ядре, без UDP/TCP-всплеска.
async function testAllNodes(nodes, onProgress) {
  const tags = [...new Set(nodes.map(n => n.clashTag))];
  let i = 0;
  async function worker() {
    while (i < tags.length) {
      const t = tags[i++];
      try { await testNode(t, { timeoutMs: 5000 }); } catch {}
      try { onProgress?.(); } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, tags.length) }, worker));
}
