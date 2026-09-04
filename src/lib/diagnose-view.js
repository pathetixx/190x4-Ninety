// Ninety · экран «Диагностика» — UI.
//
// Собирает три проверки в одну картину: матрица доступности (каждая цель
// пробуется напрямую и через туннель), трасса до сервера и утечки. Сверху —
// вердикт одной фразой с кнопкой-действием; справа, третьей вкладкой, живёт
// лента инцидентов (её пишет incident-log.js, независимо от этого экрана).
//
// Разделение ответственности: правила вывода — в diagnose-verdict.js, наборы
// целей — в probe-sets.js, замеры — в Rust (diagnose.rs). Здесь только DOM,
// состояние прогона и перевод результатов в человеческие подписи.
//
// Точка входа: mountDiagnoseView(root, deps) → { run, refreshFeed, destroy }.

import {
  buildVerdict, countFindings, matchesDirectRule, verdictFacts,
} from "/lib/diagnose-verdict.js";
import {
  buildProbeSet, normalizePinned, resolveRegionPack, targetsById, REGION_PACKS,
} from "/lib/probe-sets.js";
import { groupIncidents, degradedMs, incidentLog } from "/lib/incident-log.js";
import { escapeHtml as esc } from "/lib/esc.js";
import { t, getLang } from "/lib/i18n/index.js";
import { countryName } from "/lib/country-names.js";
import { relativeTime } from "/lib/relative-time.js";

const TABS = ["trace", "leaks", "feed"];
// Выбранная вкладка переживает уход с экрана: человек, который вчера смотрел
// ленту инцидентов, завтра открывает экран ради неё же.
const TAB_KEY = "ninety.diagnose.tab";

function loadTab() {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    return TABS.includes(stored) ? stored : TABS[0];
  } catch {
    return TABS[0];
  }
}

function saveTab(tab) {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch { /* приватное окно/заблокированные site data — не повод падать */ }
}

const el = (tag, cls, html) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
};

const I = {
  shield: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c5-2.2 8-5.5 8-10V5l-8-3-8 3v7c0 4.5 3 7.8 8 10z"/><path d="M12 8.5v4"/><path d="M12 16h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c5-2.2 8-5.5 8-10V5l-8-3-8 3v7c0 4.5 3 7.8 8 10z"/><path d="m8.6 11.8 2.3 2.4 4.5-4.6"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
};

// Бэкенд отдаёт стабильные коды, а не готовый текст: подпись собираем здесь,
// на языке интерфейса. Незнакомый код показываем как есть — техническая строка
// полезнее пустого места.
function errText(err) {
  const code = String(err?.message || err || "").trim();
  if (!code) return "";
  const key = `dg.err.${code}`;
  const text = t(key);
  return text === key ? code : text;
}

// Состояние пробы → класс пилюли. Всё, что не «открылось» и не «ответ сервиса»,
// показываем как ошибку: пользователю не нужен зоопарк оттенков.
function pillClass(state) {
  if (state === "ok") return "dg-pill--ok";
  if (state === "http") return "dg-pill--warn";
  if (state === "skipped") return "";
  return "dg-pill--err";
}

function pillText(outcome) {
  if (!outcome || !outcome.state) return "—";
  if (outcome.state === "http" && outcome.httpStatus) return String(outcome.httpStatus);
  return t(`dg.state.${outcome.state}`);
}

// Короткий вывод по строке матрицы — тот же язык, что и в вердикте.
function rowVerdict(row, direct2 = false) {
  const direct = row.direct?.state;
  const tunnel = row.tunnel?.state;
  // Адрес, который правило отправляет мимо туннеля: колонка «через Ninety»
  // меряет прямое соединение, и «работает везде» здесь ничего не объясняет.
  if (direct2 && tunnel === "ok") return t("dg.row.byRule");
  if (direct === "skipped" && tunnel === "ok") return t("dg.row.tunnelOk");
  if (tunnel === "ok" && direct !== "ok" && direct !== "skipped") return t("dg.row.rescued");
  if (direct === "ok" && tunnel !== "ok" && tunnel !== "skipped") {
    return row.tunnel?.httpStatus >= 400 ? t("dg.row.refused") : t("dg.row.tunnelBreaks");
  }
  if (direct === "ok" && tunnel === "ok") return t("dg.row.fine");
  if (tunnel === "skipped") return t("dg.row.tunnelOff");
  return t("dg.row.down");
}

export function mountDiagnoseView(root, {
  invoke,
  getGeneration = () => null,
  isConnected = () => false,
  allowDirect = () => true,
  getNodeEndpoint = () => null,
  getOptions = () => ({}),
  saveOption = () => {},
  onToast = () => {},
  onAction = () => {},
  onFindings = () => {},
  log = incidentLog,
} = {}) {
  if (!root) return { run: () => {}, refreshFeed: () => {}, destroy: () => {} };

  let packMenu = null;
  const state = {
    running: false,
    reach: [],
    trace: null,
    traceError: null,
    leaks: null,
    leaksError: null,
    probe: null,
    probeError: null,
    tab: loadTab(),
    ranAt: 0,
  };

  root.innerHTML = "";
  const wrap = el("div", "dg");
  const verdictBox = el("div");
  const grid = el("div", "dg-grid");
  const leftCard = el("div", "dg-card dg-mx");
  const rightCard = el("div", "dg-card dg-tr");
  grid.append(leftCard, rightCard);
  wrap.append(verdictBox, grid);
  root.appendChild(wrap);

  // ── Настройки экрана ────────────────────────────────────
  function options() {
    const opts = getOptions() || {};
    return opts.diagnose || { regionPack: "", pinned: [] };
  }

  function regionPack() {
    return resolveRegionPack({
      stored: options().regionPack,
      region: (getOptions() || {}).region,
      lang: getLang(),
    });
  }

  function pinned() {
    return Array.isArray(options().pinned) ? options().pinned : [];
  }

  function targets() {
    return buildProbeSet({ regionPack: regionPack(), pinned: pinned() });
  }

  // ── Прогон ──────────────────────────────────────────────
  async function run() {
    if (state.running) return;
    state.running = true;
    render();

    const generation = Number(getGeneration()) || null;
    const includeDirect = !!allowDirect();
    const set = targets();

    try {
      state.reach = await invoke("diagnose_reach", {
        expectedGeneration: generation,
        targets: set.map(({ id, url }) => ({ id, url })),
        includeDirect,
      });
    } catch (err) {
      state.reach = [];
      onToast(t("dg.err.reach", { err: errText(err) }), "error", 4000);
    }

    // Трасса имеет смысл только когда известен адрес сервера. Без активного
    // источника (или до подключения) её просто нет — это не ошибка.
    const endpoint = getNodeEndpoint();
    if (endpoint?.host) {
      try {
        state.trace = await invoke("diagnose_trace", {
          target: endpoint.host,
          port: endpoint.port || 443,
        });
        state.traceError = null;
      } catch (err) {
        state.trace = null;
        state.traceError = errText(err);
      }
    } else {
      state.trace = null;
      state.traceError = t("dg.trace.noEndpoint");
    }

    try {
      state.leaks = await invoke("diagnose_leaks", { expectedGeneration: generation });
      state.leaksError = null;
    } catch (err) {
      state.leaks = null;
      state.leaksError = errText(err);
    }

    state.ranAt = Date.now();
    state.running = false;
    render();
  }

  async function runProbe(rawTarget) {
    const target = String(rawTarget || "").trim();
    if (!target) return;
    state.probe = null;
    state.probeError = null;
    state.running = true;
    render();
    try {
      state.probe = await invoke("diagnose_probe", {
        expectedGeneration: Number(getGeneration()) || null,
        target,
        includeDirect: !!allowDirect(),
      });
    } catch (err) {
      state.probeError = errText(err);
    }
    state.running = false;
    render();
  }

  function isPinned(host) {
    const id = `pin-${String(host || "").trim()}`;
    return pinned().some((entry) => entry?.id === id);
  }

  function unpin(id) {
    const list = pinned().filter((entry) => entry?.id !== id);
    saveOption("diagnose.pinned", list);
    // Строка закреплённой цели больше не относится к набору — убираем и её.
    state.reach = state.reach.filter((row) => row.id !== id);
    onToast(t("dg.probe.unpinnedToast", { host: id.replace(/^pin-/, "") }), "info", 2200);
    render();
  }

  function pinProbe() {
    const probe = state.probe;
    if (!probe) return;
    const entry = normalizePinned({ id: `pin-${probe.host}`, name: probe.host, url: probe.url });
    if (!entry) return;
    const list = pinned().filter((item) => item.id !== entry.id);
    saveOption("diagnose.pinned", [...list, entry]);
    onToast(t("dg.probe.pinnedToast", { host: probe.host }), "success", 2200);
    render();
  }

  // ── Отчёт в буфер ───────────────────────────────────────
  // Обезличенный: адреса нод и внешний IP маскируем — отчёт уезжает в чат
  // поддержки, а там ему не место рядом с настоящим адресом сервера.
  function mask(value) {
    const text = String(value || "");
    if (!text) return "—";
    return text.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, "$1.***.***.$4");
  }

  function report() {
    const verdict = currentVerdict();
    const lines = [
      `Ninety · ${t("dg.title")}`,
      `${t("dg.verdict.kicker")}: ${t(`dg.v.${verdict.kind}.title`, verdict.params)}`,
      "",
      t("dg.reach.title"),
      ...state.reach.map((row) => `  ${row.id}: ${pillText(row.direct)} / ${pillText(row.tunnel)}`),
    ];
    if (state.trace) {
      lines.push("", `${t("dg.tabs.trace")} → ${mask(state.trace.resolvedIp)}:${state.trace.port}`);
      for (const hop of state.trace.hops || []) {
        lines.push(`  ${hop.ttl}. ${mask(hop.address) || "* * *"} ${hop.rttMs ?? "—"}ms icmp=${hop.icmp} tcp=${hop.tcp}`);
      }
      const tcp = state.trace.tcp || {};
      lines.push(`  ${t("dg.tabs.trace")}/tcp: ${tcp.state || "—"} ${tcp.ms ?? "—"}ms`);
      lines.push(`  control: ${state.trace.control?.state || "—"}`);
    }
    if (state.leaks) {
      lines.push("", t("dg.tabs.leaks"));
      for (const [key, value] of Object.entries(state.leaks)) {
        lines.push(`  ${key}: ${value?.state} ${mask(value?.detail)}`);
      }
    }
    return lines.join("\n");
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report());
      onToast(t("dg.copied"), "success", 2000);
    } catch (err) {
      onToast(t("dg.copyErr", { err: String(err) }), "error", 4000);
    }
  }

  function currentVerdict() {
    return buildVerdict({
      reach: state.reach,
      trace: state.trace,
      leaks: state.leaks,
      connected: !!isConnected(),
    });
  }

  // ── Рендер: вердикт ─────────────────────────────────────
  function renderVerdict() {
    const verdict = currentVerdict();
    const ok = verdict.severity === "ok";
    const card = el("div", `dg-verdict${ok ? " dg-verdict--ok" : ""}`);

    const icon = el("div", "dg-verdict__ic", ok ? I.check : I.shield);
    const main = el("div");
    main.appendChild(el("div", "dg-verdict__kicker", esc(t("dg.verdict.kicker"))));
    main.appendChild(el("h3", "dg-verdict__title", esc(t(`dg.v.${verdict.kind}.title`, verdict.params))));
    main.appendChild(el("div", "dg-verdict__text", t(`dg.v.${verdict.kind}.text`, verdict.params)));

    // Кнопка здесь — только действие по вердикту («включить обход», «сменить
    // сервер», «пустить напрямую»). Глобальные «Проверить» и «Скопировать
    // отчёт» живут в шапке экрана и не дублируются.
    const cta = el("div", "dg-verdict__cta");
    if (verdict.action) {
      const primary = el("button", "btn btn--primary", esc(t(`dg.action.${verdict.action}`)));
      primary.type = "button";
      primary.disabled = state.running;
      primary.addEventListener("click", () => {
        if (verdict.action === "run") run();
        else onAction(verdict.action, verdict.params);
      });
      cta.appendChild(primary);
    }

    const facts = el("div", "dg-facts");
    for (const fact of verdictFacts({ trace: state.trace, leaks: state.leaks, reach: state.reach })) {
      const cell = el("div", "dg-fact");
      cell.appendChild(el("div", "dg-fact__k", esc(t(`dg.fact.${fact.key}`))));
      const stateClass = fact.state === "err" ? " is-err" : fact.state === "warn" ? " is-warn" : "";
      // Голое число без единицы («41») в плитке фактов не читается.
      const value = fact.key === "trace" && fact.value
        ? `${fact.value} ${t("units.ms")}`
        : fact.value || t(`dg.factState.${fact.state}`);
      cell.appendChild(el("div", `dg-fact__v${stateClass}`, `<i></i>${esc(value)}`));
      facts.appendChild(cell);
    }

    card.append(icon, main, cta);
    if (facts.childElementCount) card.appendChild(facts);
    verdictBox.innerHTML = "";
    verdictBox.appendChild(card);
  }

  // ── Рендер: матрица ─────────────────────────────────────
  function renderMatrix() {
    leftCard.innerHTML = "";
    const head = el("div", "dg-card__head");
    head.appendChild(el("div", "dg-card__title", esc(t("dg.reach.title"))));

    head.appendChild(state.running ? el("div", "dg-spinner") : regionPackSelect());
    leftCard.appendChild(head);

    // Поле ручной проверки — над заголовками колонок: это вход, а не строка.
    const probeRow = el("div", "dg-probe");
    const field = el("label", "dg-probe__field", I.search);
    const input = el("input");
    input.type = "text";
    input.spellcheck = false;
    input.placeholder = t("dg.probe.placeholder");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runProbe(input.value);
    });
    field.appendChild(input);
    const probeBtn = el("button", "btn btn--sm btn--primary", esc(t("dg.probe.run")));
    probeBtn.type = "button";
    probeBtn.disabled = state.running;
    probeBtn.addEventListener("click", () => runProbe(input.value));
    probeRow.append(field, probeBtn);
    leftCard.appendChild(probeRow);

    const cols = el("div", "dg-mx__cols",
      `<span>${esc(t("dg.reach.colService"))}</span><span>${esc(t("dg.reach.colDirect"))}</span>` +
      `<span>${esc(t("dg.reach.colTunnel"))}</span><span></span><span></span>`);
    leftCard.appendChild(cols);

    if (state.probe) leftCard.append(...probeBlock());
    if (state.probeError) {
      leftCard.appendChild(el("div", "dg-empty", `<div class="dg-empty__text">${esc(state.probeError)}</div>`));
    }

    if (!state.reach.length) {
      leftCard.appendChild(el("div", "dg-empty",
        `<div class="dg-empty__title">${esc(t("dg.reach.emptyTitle"))}</div>` +
        `<div class="dg-empty__text">${esc(t("dg.reach.emptyText"))}</div>`));
      return;
    }

    // Подписи берём из общего каталога, а не из текущего набора: смена пакета
    // между прогоном и отрисовкой оставляла строки без имени.
    const known = targetsById(pinned());
    for (const row of state.reach) {
      const meta = known.get(row.id) || { name: row.id, scope: "global" };
      const line = el("div", "dg-row");
      const name = el("div");
      name.appendChild(el("div", "dg-row__name", esc(meta.name)));
      const badge = meta.scope === "region" && meta.region
        ? `<span class="dg-badge">${esc(meta.region.toUpperCase())}</span>`
        : meta.scope === "pinned" ? `<span class="dg-badge">${esc(t("dg.reach.pinnedBadge"))}</span>` : "";
      name.appendChild(el("div", "dg-row__host", badge + esc(hostOf(row.url))));
      line.appendChild(name);
      line.appendChild(el("div", `dg-pill ${pillClass(row.direct?.state)}`, esc(pillText(row.direct))));
      line.appendChild(el("div", `dg-pill ${pillClass(row.tunnel?.state)}`, esc(pillText(row.tunnel))));
      const opts = getOptions() || {};
      const viaRule = matchesDirectRule({
        host: hostOf(row.url),
        region: opts.region,
        customRules: opts.route?.customRules,
      });
      line.appendChild(el("div", "dg-row__verdict",
        `<span class="dg-row__txt">${esc(rowVerdict(row, viaRule))}</span>`));

      const actionCell = el("div", "dg-row__acts");
      if (meta.scope === "pinned") {
        const off = el("button", "dg-unpin", I.x);
        off.type = "button";
        off.title = t("dg.row.unpin");
        off.setAttribute("aria-label", t("dg.row.unpin"));
        off.addEventListener("click", () => unpin(row.id));
        actionCell.appendChild(off);
      }
      const needsRule = row.direct?.state === "ok" && row.tunnel?.state !== "ok" && row.tunnel?.state !== "skipped";
      if (needsRule) {
        const btn = el("button", "dg-act", esc(t("dg.row.ruleDirect")) + I.arrow);
        btn.type = "button";
        btn.addEventListener("click", () => onAction("ruleDirect", { domain: hostOf(row.url) }));
        actionCell.appendChild(btn);
      }
      line.appendChild(actionCell);
      leftCard.appendChild(line);
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return String(url || "");
    }
  }

  // Ручная проверка: строка + пошаговый разбор.
  function probeBlock() {
    const probe = state.probe;
    const row = el("div", "dg-row dg-row--own");
    const name = el("div");
    name.appendChild(el("div", "dg-row__name", esc(probe.host)));
    name.appendChild(el("div", "dg-row__host",
      `<span class="dg-badge">${esc(t("dg.probe.badge"))}</span>:${probe.port}`));
    row.appendChild(name);

    const directState = probe.direct?.httpState || "skipped";
    const tunnelState = probe.tunnel?.httpState || "skipped";
    row.appendChild(el("div", `dg-pill ${pillClass(directState)}`,
      esc(probe.direct?.httpStatus ? String(probe.direct.httpStatus) : t(`dg.state.${directState}`))));
    row.appendChild(el("div", `dg-pill ${pillClass(tunnelState)}`,
      esc(probe.tunnel?.httpStatus ? String(probe.tunnel.httpStatus) : t(`dg.state.${tunnelState}`))));
    row.appendChild(el("div", "dg-row__verdict",
      `<span class="dg-row__txt">${esc(probeVerdict(probe))}</span>`));
    row.appendChild(el("div"));

    const det = el("div", "dg-det");
    const gridEl = el("div", "dg-det__grid");
    gridEl.innerHTML =
      `<div class="dg-det__h"></div><div class="dg-det__h">${esc(t("dg.reach.colDirect"))}</div>` +
      `<div class="dg-det__h">${esc(t("dg.reach.colTunnel"))}</div>`;
    for (const stage of ["dns", "tcp", "http"]) {
      gridEl.appendChild(el("div", "dg-det__k", esc(t(`dg.probe.stage.${stage}`))));
      gridEl.appendChild(stageCell(probe.direct, stage));
      gridEl.appendChild(stageCell(probe.tunnel, stage, true));
    }
    det.appendChild(gridEl);

    const foot = el("div", "dg-det__foot");
    foot.appendChild(el("div", "dg-det__note", probeNote(probe)));
    const acts = el("div", "dg-det__acts");
    const pinnedAlready = isPinned(probe.host);
    const pinBtn = el("button", "dg-ghost", esc(pinnedAlready ? t("dg.probe.unpin") : t("dg.probe.pin")));
    pinBtn.type = "button";
    pinBtn.addEventListener("click", () => (pinnedAlready ? unpin(`pin-${probe.host}`) : pinProbe()));
    const ruleBtn = el("button", "dg-act", esc(t("dg.probe.rule")) + I.arrow);
    ruleBtn.type = "button";
    ruleBtn.addEventListener("click", () => onAction("ruleTunnel", { domain: probe.host }));
    acts.append(pinBtn, ruleBtn);
    foot.appendChild(acts);
    det.appendChild(foot);

    return [row, det];
  }

  function stageCell(stages, stage, tunnelSide = false) {
    const cell = el("div", "dg-det__v");
    if (!stages) return Object.assign(cell, { innerHTML: "<i></i><span>—</span>" });
    if (stage === "dns") {
      const list = stages.dns || [];
      const bad = !list.length;
      cell.className = `dg-det__v${bad ? " is-err" : ""}`;
      cell.innerHTML = `<i></i><span>${esc(list.join(", ") || stages.dnsError || "—")}</span>`;
      return cell;
    }
    if (stage === "tcp") {
      if (tunnelSide) {
        cell.className = "dg-det__v is-off";
        cell.innerHTML = `<i></i><span>${esc(t("dg.probe.viaCore"))}</span>`;
        return cell;
      }
      const bad = stages.tcpMs == null;
      cell.className = `dg-det__v${bad ? " is-err" : ""}`;
      cell.innerHTML = `<i></i><span>${esc(bad ? stages.tcpError || "—" : `${stages.tcpMs} ${t("units.ms")}`)}</span>`;
      return cell;
    }
    const status = stages.httpStatus;
    const bad = stages.httpState && stages.httpState !== "ok";
    cell.className = `dg-det__v${bad ? " is-err" : ""}`;
    const value = status ? `${status} · ${stages.httpMs ?? "—"} ${t("units.ms")}` : t(`dg.state.${stages.httpState || "skipped"}`);
    cell.innerHTML = `<i></i><span>${esc(value)}</span>`;
    return cell;
  }

  function probeVerdict(probe) {
    const directDns = probe.direct?.dns?.length || 0;
    const tunnelDns = probe.tunnel?.dns?.length || 0;
    if (directDns && tunnelDns) {
      const same = probe.direct.dns.some((ip) => probe.tunnel.dns.includes(ip));
      if (!same) return t("dg.probe.dnsMismatch");
    }
    if (probe.direct?.httpState === "ok" && probe.tunnel?.httpState !== "ok") return t("dg.row.tunnelBreaks");
    if (probe.tunnel?.httpState === "ok" && probe.direct?.httpState !== "ok") return t("dg.row.rescued");
    if (probe.tunnel?.httpState === "ok") return t("dg.row.fine");
    return t("dg.row.down");
  }

  function probeNote(probe) {
    if (probe.tunnel?.httpState === "ok" && probe.direct?.httpState !== "ok") return t("dg.probe.noteRescued");
    if (probe.direct?.httpState === "ok" && probe.tunnel?.httpState !== "ok") return t("dg.probe.noteTunnelBreaks");
    if (probe.tunnel?.httpState === "ok") return t("dg.probe.noteFine");
    return t("dg.probe.noteDown");
  }

  // Выбор странового пакета. Свой попап, а не нативный <select>: WebView2
  // рисует системный список, который не поддаётся стилизации и рядом с тёмным
  // интерфейсом выглядит чужеродно. Заодно в списке видно название страны, а не
  // только код.
  function regionPackSelect() {
    const current = regionPack();
    const btn = el("button", "dg-pack");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML =
      '<span class="dg-pack__txt">' +
      esc(current ? current.toUpperCase() : t("dg.reach.globalOnly")) +
      '<i class="dg-pack__dot"></i>' + esc(String(targets().length)) +
      '</span>' +
      '<svg class="dg-pack__chev" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      openPackMenu(btn, current);
    });
    return btn;
  }

  function closePackMenu() {
    packMenu?.remove();
    packMenu = null;
    document.removeEventListener("click", onPackOutside, true);
    document.removeEventListener("keydown", onPackKey, true);
  }

  function onPackOutside(event) {
    if (packMenu && !packMenu.contains(event.target)) closePackMenu();
  }

  function onPackKey(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePackMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(packMenu?.querySelectorAll(".dg-packmenu__item") || [])];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  }

  function openPackMenu(anchor, current) {
    if (packMenu) {
      closePackMenu();
      return;
    }
    const menu = el("div", "dg-packmenu");
    menu.setAttribute("role", "listbox");
    const entries = [
      { code: "", label: t("dg.reach.globalOnly") },
      ...REGION_PACKS.map((code) => ({ code, label: countryName(code) || code.toUpperCase() })),
    ];
    for (const entry of entries) {
      const item = el("button", "dg-packmenu__item");
      item.type = "button";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(entry.code === current));
      if (entry.code === current) item.dataset.on = "true";
      item.innerHTML =
        '<span class="dg-packmenu__name">' + esc(entry.label) + "</span>" +
        (entry.code ? '<span class="dg-packmenu__code">' + esc(entry.code.toUpperCase()) + "</span>" : "");
      item.addEventListener("click", () => {
        closePackMenu();
        if (entry.code !== current) {
          // Результаты прошлого прогона относятся к прежнему набору: оставлять
          // их рядом с новым списком целей — значит показывать чужую матрицу.
          state.reach = [];
          state.ranAt = 0;
        }
        saveOption("diagnose.regionPack", entry.code);
        render();
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    // Попап держим в пределах окна: у правого края он иначе уезжает за экран.
    const width = menu.getBoundingClientRect().width;
    const left = Math.min(rect.right - width, window.innerWidth - width - 8);
    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, left))}px`;
    packMenu = menu;
    anchor.setAttribute("aria-expanded", "true");
    menu.querySelector('[data-on="true"]')?.focus();
    document.addEventListener("click", onPackOutside, true);
    document.addEventListener("keydown", onPackKey, true);
  }

  // ── Рендер: правая колонка ──────────────────────────────
  function renderSide() {
    rightCard.innerHTML = "";
    const head = el("div", "dg-card__head");
    const tabs = el("div", "dg-tabs");
    for (const tab of TABS) {
      const btn = el("button", `dg-tab${state.tab === tab ? " dg-tab--on" : ""}`, esc(t(`dg.tabs.${tab}`)));
      btn.type = "button";
      btn.addEventListener("click", () => {
        state.tab = tab;
        saveTab(tab);
        renderSide();
      });
      tabs.appendChild(btn);
    }
    head.appendChild(tabs);
    head.appendChild(el("div", "dg-card__meta", esc(sideMeta())));
    rightCard.appendChild(head);

    if (state.tab === "trace") renderTrace();
    else if (state.tab === "leaks") renderLeaks();
    else renderFeed();
  }

  function sideMeta() {
    if (state.tab === "trace" && state.trace) return `${state.trace.resolvedIp} · :${state.trace.port}`;
    if (state.tab === "feed") return "";
    const endpoint = getNodeEndpoint();
    return endpoint?.host ? endpoint.host : "";
  }

  function renderTrace() {
    if (!state.trace) {
      rightCard.appendChild(el("div", "dg-empty",
        `<div class="dg-empty__text">${esc(state.traceError || t("dg.trace.noEndpoint"))}</div>`));
      return;
    }
    const cols = el("div", "dg-tr__cols",
      `<span>#</span><span>${esc(t("dg.trace.node"))}</span><span>ICMP</span>`);
    rightCard.appendChild(cols);

    for (const hop of state.trace.hops || []) {
      const silent = hop.icmp !== "reply" && hop.icmp !== "expired";
      const line = el("div", `dg-hop${silent ? " dg-hop--dead" : ""}${hop.address ? "" : " dg-hop--void"}`);
      line.appendChild(el("div", "dg-hop__n", String(hop.ttl)));
      line.appendChild(el("div", "dg-hop__ip", esc(hop.address || "* * *")));
      line.appendChild(el("div", "dg-hop__rtt", hop.rttMs != null ? `${hop.rttMs} ${t("units.ms")}` : "—"));
      rightCard.appendChild(line);
    }

    // Соединение на порт — отдельной плашкой под хопами: путь и соединение это
    // разные вопросы, и ответы на них не обязаны совпадать.
    const tcp = state.trace.tcp || {};
    const control = state.trace.control || {};
    const tcpLine = state.trace.tcpOpen
      ? t("dg.trace.tcpOpen", { ms: tcp.ms ?? "—", port: state.trace.port })
      : tcp.state === "refused"
        ? t("dg.trace.tcpRefused", { port: state.trace.port })
        : t("dg.trace.tcpSilent", { port: state.trace.port });
    rightCard.appendChild(el("div", state.trace.tcpOpen ? "dg-tr__tcp" : "dg-break",
      (state.trace.tcpOpen ? "" : I.bolt) + esc(tcpLine)));

    const note = state.trace.tcpOpen
      ? t("dg.trace.noteOpen")
      : control.state === "open"
        ? (state.trace.icmpReached ? t("dg.trace.noteFiltered") : t("dg.trace.noteUnreachable"))
        : t("dg.trace.noteLocalNetwork");
    rightCard.appendChild(el("div", "dg-tr__note", note));
  }

  function renderLeaks() {
    if (!state.leaks) {
      rightCard.appendChild(el("div", "dg-empty",
        `<div class="dg-empty__text">${esc(state.leaksError || t("dg.leaks.unavailable"))}</div>`));
      return;
    }
    const order = [
      ["dnsInTunnel", state.leaks.dnsInTunnel],
      ["dnsAnswerMatch", state.leaks.dnsAnswerMatch],
      ["externalIp", state.leaks.externalIp],
      ["ipv6Open", state.leaks.ipv6Open],
    ];
    for (const [key, check] of order) {
      const line = el("div", "dg-leak");
      const main = el("div");
      main.appendChild(el("div", "dg-leak__t", esc(t(`dg.leaks.${key}`))));
      main.appendChild(el("div", "dg-leak__d", esc(check?.detail || "")));
      line.appendChild(main);
      const stateClass = check?.state === "warn" ? " is-warn" : check?.state === "skipped" ? " is-off" : "";
      line.appendChild(el("div", `dg-leak__v${stateClass}`,
        `<i></i>${esc(t(`dg.leaks.state.${check?.state || "skipped"}`))}`));
      rightCard.appendChild(line);
    }
    rightCard.appendChild(el("div", "dg-tr__note", t("dg.leaks.note")));
  }

  function renderFeed() {
    const groups = groupIncidents(log.list());
    if (!groups.length) {
      rightCard.appendChild(el("div", "dg-empty",
        `<div class="dg-empty__title">${esc(t("dg.feed.emptyTitle"))}</div>` +
        `<div class="dg-empty__text">${esc(t("dg.feed.emptyText"))}</div>`));
      return;
    }

    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const minutes = Math.round(degradedMs(groups, { since: weekAgo }) / 60000);
    rightCard.appendChild(el("div", "dg-feed__summary",
      t("dg.feed.summary", { minutes, count: groups.length })));

    const feed = el("div", "dg-feed");
    for (const group of groups.slice(0, 40)) {
      const item = el("div", "dg-inc");
      const head = el("div", "dg-inc__head");
      head.appendChild(el("span", `dg-inc__dot dg-inc__dot--${group.severity}`));
      head.appendChild(el("span", "dg-inc__title", esc(incidentTitle(group))));
      head.appendChild(el("span", "dg-inc__time", esc(relativeTime(group.startTs))));
      item.appendChild(head);

      const steps = el("ul", "dg-inc__steps");
      for (const event of group.events.slice(1)) {
        steps.appendChild(el("li", "dg-inc__step", esc(incidentText(event))));
      }
      if (steps.childElementCount) item.appendChild(steps);

      item.appendChild(el("div", "dg-inc__foot", esc(
        group.ongoing
          ? t("dg.feed.ongoing")
          : group.resolved
            ? t("dg.feed.resolvedIn", { duration: humanDuration(group.durationMs) })
            : t("dg.feed.unresolved"),
      )));
      feed.appendChild(item);
    }
    rightCard.appendChild(feed);
  }

  function incidentTitle(group) {
    return incidentText(group.events[0]);
  }

  function incidentText(event) {
    // Ключ подписи = вид события; параметры подставляются каталогом. Незнакомый
    // вид (запись осталась от прошлой версии) показываем как есть, а не пустой
    // строкой — иначе история выглядела бы дырявой.
    const key = `dg.feed.kind.${event.kind}`;
    const text = t(key, event.params || {});
    return text === key ? event.kind : text;
  }

  function humanDuration(ms) {
    const seconds = Math.max(1, Math.round((ms || 0) / 1000));
    if (seconds < 90) return `${seconds} ${t("units.sec")}`;
    return `${Math.round(seconds / 60)} ${t("units.min")}`;
  }

  function render() {
    renderVerdict();
    renderMatrix();
    renderSide();
    // Счётчик находок в меню: до первого прогона его быть не должно, иначе
    // «0» выглядит как утверждение «всё проверено и всё хорошо».
    onFindings(state.ranAt ? countFindings(state) : null);
  }

  const unsubscribe = log.subscribe(() => {
    if (state.tab === "feed") renderSide();
  });

  render();

  return {
    run,
    copyReport,
    isRunning: () => state.running,
    hasRun: () => !!state.ranAt,
    refreshFeed: () => {
      if (state.tab === "feed") renderSide();
    },
    destroy: () => {
      closePackMenu();
      unsubscribe();
      root.innerHTML = "";
    },
  };
}
