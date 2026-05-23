// Ninety · Proxies view (sticky grid с пингом + FAB-молния)

import { getProxies, testGroup, lastDelay, gradeDelay, pickActiveNode } from "/lib/clash-api.js";
import { getActiveSource } from "/lib/singbox.js";

function $(id) { return document.getElementById(id); }

let pollTimer = null;
let testingAll = false;
let lastClashSnapshot = null;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// Эмодзи-флаг из имени ноды (если нет — глобус).
// Hiddify-подписки обычно засовывают флаг прямо в название через regional indicator codepoints.
function extractFlag(name) {
  if (!name) return "🌐";
  // ищем первый regional-indicator pair
  const codepoints = Array.from(name).map(c => c.codePointAt(0));
  for (let i = 0; i < codepoints.length - 1; i++) {
    const a = codepoints[i];
    const b = codepoints[i + 1];
    if (a >= 0x1F1E6 && a <= 0x1F1FF && b >= 0x1F1E6 && b <= 0x1F1FF) {
      return String.fromCodePoint(a, b);
    }
  }
  return "🌐";
}

function stripFlag(name) {
  return String(name || "").replace(/(?:\p{Regional_Indicator}){2}\s*/u, "").trim();
}

function render(nodes, activeTag, clashData) {
  const grid = $("proxies-grid");
  const metaEl = $("proxies-meta");
  if (!grid) return;

  if (!nodes?.length) {
    grid.innerHTML = `<div class="profiles-empty"><div class="profiles-empty__title">Нет нод</div><div class="profiles-empty__sub">Подписка пуста или не подключена.</div></div>`;
    if (metaEl) metaEl.textContent = "—";
    return;
  }

  if (metaEl) {
    const alive = nodes.filter(n => clashData?.proxies?.[n.clashTag]?.history?.length).length;
    metaEl.textContent = `${nodes.length} нод · активна: ${activeTag || "—"}`;
  }

  grid.innerHTML = nodes.map(n => {
    const flag = extractFlag(n.name);
    const cleanName = stripFlag(n.name) || n.host;
    const isActive = n.clashTag === activeTag;
    const proxyObj = clashData?.proxies?.[n.clashTag];
    const delay = lastDelay(proxyObj);
    const grade = gradeDelay(delay);
    const delayText = delay > 0 ? `${delay}ms` : (proxyObj ? "—" : "·");
    return `
      <div class="pnode${isActive ? " pnode--active" : ""}" data-tag="${escapeHtml(n.clashTag)}">
        <div class="pnode__flag">${flag}</div>
        <div class="pnode__main">
          <div class="pnode__name">${escapeHtml(cleanName)}</div>
          <div class="pnode__sub">
            <span>${escapeHtml(n.host)}</span>
            <span class="pnode__sub-type">${escapeHtml((n.type || "tcp").toUpperCase())}</span>
          </div>
        </div>
        <div class="pnode__ping" data-grade="${grade}">${escapeHtml(delayText)}</div>
      </div>
    `;
  }).join("");
}

function nodesFromSource() {
  const src = getActiveSource();
  if (!src) return [];
  const raw = src.kind === "sub" ? src.nodes : [src.profile];
  // mainline sing-box не знает xhttp — отбрасываем такие, как и при build
  const filtered = raw.filter(n => (n.type || "tcp").toLowerCase() !== "xhttp");
  return filtered.map((n, i) => ({
    ...n,
    // Эти теги должны совпадать с тем что buildConfig в singbox.js выставляет:
    //   useUrltest=true → "node-i-<sanitized name>"
    //   useUrltest=false → "proxy"
    clashTag: filtered.length >= 2
      ? `node-${i}-${(n.name || n.host).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 24)}`
      : "proxy",
  }));
}

async function refresh() {
  try {
    const data = await getProxies();
    lastClashSnapshot = data;
    const nodes = nodesFromSource();
    const active = pickActiveNode(data) || (nodes.length === 1 ? "proxy" : null);
    render(nodes, active, data);
  } catch (e) {
    // ядро могло отключиться — рендерим без свежих данных
    const nodes = nodesFromSource();
    render(nodes, null, lastClashSnapshot);
  }
}

export function onProxiesViewEnter() {
  refresh();
  stopPoll();
  pollTimer = setInterval(refresh, 4000);
}

export function onProxiesViewLeave() {
  stopPoll();
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

export function mountProxiesView({ onToast } = {}) {
  const fab = $("proxies-fab");
  fab?.addEventListener("click", async () => {
    if (testingAll) return;
    testingAll = true;
    fab.classList.add("proxies-fab--testing");
    try {
      const nodes = nodesFromSource();
      // urltest-группа тегается "proxy" если nodes >= 2; иначе только одна нода
      if (nodes.length >= 2) {
        await testGroup("proxy");
        onToast?.("Перетестировал все ноды", "success", 1600);
      } else if (nodes.length === 1) {
        await testGroup("proxy"); // urltest endpoint можно дёрнуть и для одиночного селектора
        onToast?.("Тест пинга запущен", "info", 1400);
      }
      await refresh();
    } catch (e) {
      onToast?.(`Ошибка теста: ${e?.message || e}`, "error", 2500);
    } finally {
      testingAll = false;
      fab.classList.remove("proxies-fab--testing");
    }
  });
}
