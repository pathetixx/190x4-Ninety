// Ninety · Server Drawer — slide-from-right панель выбора ноды.
// Открывается с главной по клику location-card (при secured).
// При connected — клик по ноде не закрывает drawer сразу, а показывает
// "Переключаюсь…" пока clash-api не подтвердит смену effective node.

import { getProxies, selectProxy, pickSelectorNow, pickEffectiveNode, lastDelay, gradeDelay } from "/lib/clash-api.js";
import { getActiveSource, nodeTag } from "/lib/singbox.js";

const FLAGS_BASE = "/assets/flags";
const NON_ISO_ALIAS = { uk: "gb", en: "gb", uae: "ae", usa: "us", rus: "ru" };

let bg, drawer, listEl, searchEl, titleEl, activeEl, activeText, closeBtn;
let pollTimer = null;
let lastSnapshot = null;
let onToastCb = null;
let isOpen = false;
let switchInFlight = false;
let searchQuery = "";

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function isoFromName(name) {
  if (!name) return null;
  const cp = Array.from(name);
  for (let i = 0; i < cp.length - 1; i++) {
    const a = cp[i].codePointAt(0), b = cp[i + 1].codePointAt(0);
    if (a >= 0x1F1E6 && a <= 0x1F1FF && b >= 0x1F1E6 && b <= 0x1F1FF) {
      return String.fromCharCode(97 + (a - 0x1F1E6)) + String.fromCharCode(97 + (b - 0x1F1E6));
    }
  }
  const m = String(name).match(/(?:^|[\s|·,])([A-Za-z]{2,3})\b/);
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
    return `<img src="${FLAGS_BASE}/${iso}.svg" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${escapeHtml(fallbackText || "?")}',style:'font-family:var(--font-mono);font-size:9px;color:var(--text-faint)'}))">`;
  }
  return `<span style="font-family:var(--font-mono);font-size:9px;color:var(--text-faint)">${escapeHtml(fallbackText || "?")}</span>`;
}

function nodesFromSource() {
  const src = getActiveSource();
  if (!src) return [];
  const raw = src.kind === "sub" ? src.nodes : [src.profile];
  return raw.map((n, i) => ({ ...n, clashTag: raw.length >= 2 ? nodeTag(i, n) : "proxy" }));
}

function srvCardHtml(node, isActive, delay, grade) {
  const iso = isoFromName(node.name);
  const cleanName = stripFlag(node.name) || node.host;
  const fallback = iso ? iso.toUpperCase() : cleanName.slice(0, 2).toUpperCase() || "?";
  const proto = (node.type || "tcp").toUpperCase();
  const hostLine = `${node.host} · ${proto}`;
  const pingText = delay > 0 && delay < 65000 ? delay : "—";
  const pingGradeAttr = delay > 0 && delay < 65000 ? grade : "dead";
  const gradeMap = { good: "ok", mid: "warn", bad: "err", dead: "" };
  return `
    <div class="srv" data-active="${isActive}" data-tag="${escapeHtml(node.clashTag)}">
      <span class="srv__flag">${flagHtml(iso, fallback)}</span>
      <div class="srv__main">
        <div class="srv__name">${escapeHtml(cleanName)}</div>
        <div class="srv__host">${escapeHtml(hostLine)}</div>
      </div>
      <div class="srv__load"></div>
      <div class="srv__ping" data-g="${gradeMap[pingGradeAttr] || ""}">${pingText}<span style="font-size:9px;color:var(--text-faint);margin-left:3px;letter-spacing:0.05em">МС</span></div>
    </div>
  `;
}

function autoCardHtml(isActive, effectiveTag, allNodes, clashData) {
  let subText = "Балансер — берёт лучший по delay";
  if (effectiveTag && effectiveTag !== "auto") {
    const node = allNodes.find(n => n.clashTag === effectiveTag);
    if (node) subText = `Сейчас → ${stripFlag(node.name) || node.host}`;
  }
  return `
    <div class="srv" data-active="${isActive}" data-tag="auto">
      <span class="srv__flag" style="background:var(--accent-soft);color:var(--accent-bright);display:grid;place-items:center;border:0;box-shadow:none;">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>
      </span>
      <div class="srv__main">
        <div class="srv__name" style="color:var(--accent-bright)">Авто</div>
        <div class="srv__host">${escapeHtml(subText)}</div>
      </div>
      <div></div>
      <div class="srv__ping" data-g="">—</div>
    </div>
  `;
}

function renderActiveLabel(selectorTag, effectiveTag, nodes, clashData) {
  if (!activeEl || !activeText) return;
  const isConnected = drawer?.dataset.connected === "true";
  if (!isConnected) { activeEl.hidden = true; return; }
  const tag = effectiveTag && effectiveTag !== "auto" ? effectiveTag : selectorTag;
  if (!tag) { activeEl.hidden = true; return; }
  const node = nodes.find(n => n.clashTag === tag);
  const name = node ? (stripFlag(node.name) || node.host) : tag;
  const delay = lastDelay(clashData?.proxies?.[tag]);
  const pingLabel = delay > 0 && delay < 65000 ? `${delay} мс` : "—";
  activeText.textContent = `Активна: ${name} · ${pingLabel}`;
  activeEl.hidden = false;
}

function render() {
  if (!listEl) return;
  const nodes = nodesFromSource();
  if (!nodes.length) {
    listEl.innerHTML = `<div class="drawer__section"><span>0 узлов</span></div>
      <div style="padding:18px 12px;color:var(--text-lo);font-size:12px;text-align:center;">Подписка пуста или не выбрана.</div>`;
    if (activeEl) activeEl.hidden = true;
    return;
  }
  const clashData = lastSnapshot;
  const selectorTag = pickSelectorNow(clashData);
  const effectiveTag = pickEffectiveNode(clashData);

  const q = searchQuery.trim().toLowerCase();
  const filtered = q ? nodes.filter(n =>
    String(n.name || "").toLowerCase().includes(q) ||
    String(n.host || "").toLowerCase().includes(q)
  ) : nodes;

  const sorted = [...filtered].sort((a, b) => {
    const da = lastDelay(clashData?.proxies?.[a.clashTag]);
    const db = lastDelay(clashData?.proxies?.[b.clashTag]);
    const aa = da > 0 ? da : 99999;
    const bb = db > 0 ? db : 99999;
    return aa - bb;
  });

  const aliveCount = nodes.filter(n => {
    const d = lastDelay(clashData?.proxies?.[n.clashTag]);
    return d > 0 && d < 65000;
  }).length;

  let html = `<div class="drawer__section"><span>${filtered.length} ${filtered.length === 1 ? "узел" : "узлов"} · ${aliveCount} активных</span><span>PING</span></div>`;
  if (nodes.length >= 2 && !q) {
    html += autoCardHtml(selectorTag === "auto", effectiveTag, nodes, clashData);
  }
  for (const n of sorted) {
    const delay = lastDelay(clashData?.proxies?.[n.clashTag]);
    const grade = gradeDelay(delay);
    const isActive = (n.clashTag === selectorTag && selectorTag !== "auto");
    html += srvCardHtml(n, isActive, delay, grade);
  }
  listEl.innerHTML = html;
  renderActiveLabel(selectorTag, effectiveTag, nodes, clashData);
}

async function refresh() {
  try { lastSnapshot = await getProxies(); } catch {}
  render();
}

async function handleClick(card) {
  if (switchInFlight) return;
  const tag = card.dataset.tag;
  if (!tag) return;
  switchInFlight = true;
  if (drawer) drawer.dataset.busy = "true";
  // Spinner в карточке
  const pingEl = card.querySelector(".srv__ping");
  if (pingEl) pingEl.dataset.spinning = "true";
  try {
    await selectProxy("proxy", tag);
    onToastCb?.(tag === "auto" ? "Режим Авто" : "Сервер переключён", "success", 1200);
    // Эмитим event — main.js синхронизирует hero/loc/IP
    window.dispatchEvent(new CustomEvent("ninety:node-changed", { detail: { tag, node: null } }));
    // Подождём короткий буфер чтобы clash подтянул нового effective + refresh
    await new Promise(r => setTimeout(r, 600));
    await refresh();
    // Закрываем drawer спустя 200мс после успеха
    setTimeout(close, 200);
  } catch (e) {
    onToastCb?.(`Не удалось переключить: ${e?.message || e}`, "error", 2500);
    if (pingEl) delete pingEl.dataset.spinning;
  } finally {
    switchInFlight = false;
    if (drawer) delete drawer.dataset.busy;
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(refresh, 4000);
}
function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export function open({ connected = false } = {}) {
  if (!bg || !drawer) return;
  if (drawer) drawer.dataset.connected = connected ? "true" : "false";
  isOpen = true;
  bg.dataset.open = "true";
  drawer.dataset.open = "true";
  searchQuery = "";
  if (searchEl) searchEl.value = "";
  refresh();
  startPoll();
  setTimeout(() => searchEl?.focus(), 220);
}

export function close() {
  if (!bg || !drawer) return;
  isOpen = false;
  bg.dataset.open = "false";
  drawer.dataset.open = "false";
  stopPoll();
}

export function mountServerDrawer({ onToast } = {}) {
  bg = $("drawer-bg");
  drawer = $("server-drawer");
  listEl = $("drawer-list");
  searchEl = $("drawer-search");
  titleEl = $("drawer-title");
  activeEl = $("drawer-active");
  activeText = $("drawer-active-text");
  closeBtn = $("drawer-close");
  onToastCb = onToast;

  if (!drawer) return;

  bg?.addEventListener("click", close);
  closeBtn?.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) close();
  });
  searchEl?.addEventListener("input", () => {
    searchQuery = searchEl.value || "";
    render();
  });
  listEl?.addEventListener("click", (e) => {
    const card = e.target.closest(".srv");
    if (!card) return;
    handleClick(card);
  });
}
