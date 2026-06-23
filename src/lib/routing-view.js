// Ninety · Подраздел «Правила маршрутизации» — UI (порт из Claude Design handoff).
// Гибкие пользовательские правила поверх регионального: домен / IP / процесс →
// Через VPN / Напрямую / Блок. Источник истины формы правила и валидация —
// routing-rules.js; сериализация в sing-box — singbox.js::customRulesToSingbox;
// хранилище — options.route.customRules. Живой пикер процессов и монитор
// соединений берут данные из бэкенда (clash-api.js / netproc).
//
// Точка входа: mountRoutingRules(rootEl, { onChange }) — строит весь rr-блок
// внутри rootEl. onChange("route.customRules") дёргает реконнект (как другие
// route-настройки), если соединение активно.

import { loadOptions, updateOption } from "/lib/options.js";
import {
  TYPE_LABELS, MATCH_LABELS, ACTION_LABELS,
  newRule, normalizeValue, isValidValue, sanitizeRule,
} from "/lib/routing-rules.js";
import { listNetworkProcesses, getConnections } from "/lib/clash-api.js";
import { toast } from "/lib/toast.js";
import { escapeHtml as esc } from "/lib/esc.js";

const REGION_SHORT = { ru: "Россия", cn: "Китай", ir: "Иран", tr: "Турция", by: "Беларусь" };

/* ── иконки (Lucide-стиль, currentColor) ── */
const I = {
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="2.4"/><circle cx="18" cy="5" r="2.4"/><path d="M8.4 19H16a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h2.6"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>',
  net: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M6.5 10v3.5h11M17.5 14v-1.5"/></svg>',
  app: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>',
  priority: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v7a4 4 0 0 0 4 4h11"/><path d="m15 11 4 4-4 4"/></svg>',
  vpn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V5Z"/></svg>',
  direct: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  block: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8" stroke-linecap="round"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
};
const TYPE_ICON = { domain: I.globe, ip: I.net, process: I.app };
const ACTION_ICON = { proxy: I.vpn, direct: I.direct, block: I.block };

/* ── helpers ── */
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
// Русское склонение: plural(n,"правило","правила","правил")
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Глобальный реестр живых mount'ов — при повторном mount (re-render секции
// Настроек) гасим прежние интервалы монитора, чтобы не плодить поллинг.
let activeInstance = null;

export function mountRoutingRules(rootEl, opts = {}) {
  if (!rootEl) return null;
  // Если секцию перерисовали — глушим прошлый монитор.
  if (activeInstance) activeInstance.destroy();

  const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};
  // hideTitle: под-экран Настроек уже даёт заголовок «Правила маршрутизации» в
  // settings-head — глушим внутренний .rr-head__title, чтобы не дублировать.
  const hideTitle = !!opts.hideTitle;
  const clashPort = loadOptions().experimental?.clashApiPort || 9090;

  // ── состояние ──
  let rules = loadRules();
  let tab = "rules";
  let monitorPaused = false;
  let monConns = [];
  let monTimer = null;
  let monExpanded = new Set(); // раскрытые группы приложений (по имени процесса)
  let dragId = null;

  // модалка
  let draft = null;
  let procMode = "pick";
  let escHandler = null;

  function loadRules() {
    const r = loadOptions().route?.customRules;
    return Array.isArray(r) ? structuredCloneSafe(r) : [];
  }
  function structuredCloneSafe(v) {
    try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
  }

  // Персист + реконнект. Зовётся на любое изменение списка.
  function commit(silent) {
    updateOption("route.customRules", rules);
    onChange("route.customRules");
    if (!silent) toast("Правила обновлены", "success", 1600);
  }

  /* ── каркас блока ── */
  function buildShell() {
    rootEl.innerHTML = "";
    const block = el("div", "rr-block");

    const o = loadOptions();
    const iso = o.region && o.region !== "other" ? o.region : null;
    const baseChip = iso
      ? `<span class="rr-base"><span class="rr-base__k">База</span>` +
        `<span class="rr-base__flag"><img src="/assets/flags/${iso}.svg" alt=""></span>` +
        `<span>${esc(REGION_SHORT[iso] || iso)}</span></span>`
      : "";

    const headMain = hideTitle
      ? '<p class="rr-head__sub rr-head__sub--solo">Свои правила поверх регионального · <b>домен</b> / <b>IP</b> / <b>приложение</b></p>'
      : '<div class="rr-head__main">' +
          '<h3 class="rr-head__title">Правила маршрутизации</h3>' +
          '<p class="rr-head__sub">Свои правила поверх регионального — <b>домен</b>, <b>IP</b> или <b>приложение</b> → Через VPN, Напрямую или Блок.</p>' +
        "</div>";

    block.innerHTML =
      '<div class="rr-head rr-head--sub">' +
        headMain +
        '<button class="btn btn--primary" id="rr-addbtn" type="button">' + I.route + "Добавить правило</button>" +
      "</div>" +
      '<div class="rr-bar">' +
        '<div class="seg">' +
          '<button class="seg__btn" id="tab-rules" data-on="true" type="button">Правила</button>' +
          '<button class="seg__btn" id="tab-monitor" data-on="false" type="button">Соединения</button>' +
        "</div>" +
        '<span class="rr-bar__spring"></span>' +
        baseChip +
        '<span class="rr-count" id="rr-count"></span>' +
      "</div>" +
      '<div class="rr-priority" id="rr-priority">' + I.priority +
        "<span>Ваши правила срабатывают <b>раньше регионального</b>. Порядок сверху вниз = приоритет: применяется первое совпадение.</span></div>" +
      '<div id="rr-listhost"></div>';

    rootEl.appendChild(block);
    block.querySelector("#rr-addbtn").addEventListener("click", () => openModal(null));
    block.querySelector("#tab-rules").addEventListener("click", () => setTab("rules"));
    block.querySelector("#tab-monitor").addEventListener("click", () => setTab("monitor"));
  }

  const $ = (sel) => rootEl.querySelector(sel);

  /* ═══ СПИСОК ПРАВИЛ ═══ */
  function actionPill(action) {
    return '<span class="rr-action rr-action--' + action + '"><span class="rr-action__dot"></span>' + ACTION_LABELS[action] + "</span>";
  }
  function ruleRow(rule, idx) {
    const row = el("div", "rr-rule");
    row.dataset.id = rule.id;
    row.dataset.enabled = String(rule.enabled !== false);
    row.setAttribute("draggable", "false");

    const ord = String(idx + 1).padStart(2, "0");
    const vals = Array.isArray(rule.values) ? rule.values : [];
    const vis = vals.slice(0, 2);
    const extra = vals.length - vis.length;
    let chips = vis.map((v) => '<span class="rr-chip">' + esc(v) + "</span>").join("");
    if (extra > 0) chips += '<span class="rr-chip rr-chip--more">+' + extra + " ещё</span>";
    const matchNote = rule.type === "domain" ? '<span class="rr-match">' + (MATCH_LABELS[rule.match] || MATCH_LABELS.suffix) + "</span>" : "";

    row.innerHTML =
      '<div class="rr-grip" title="Перетащите, чтобы изменить приоритет">' + I.grip + '<span class="rr-ord">' + ord + "</span></div>" +
      '<button class="switch" data-on="' + (rule.enabled !== false) + '" data-act="toggle" type="button" aria-label="Включить правило"></button>' +
      '<span class="rr-type">' + TYPE_ICON[rule.type] + (TYPE_LABELS[rule.type] || rule.type) + "</span>" +
      '<div class="rr-values">' + chips + matchNote + "</div>" +
      actionPill(rule.action) +
      '<div class="rr-rowacts">' +
        '<button class="rr-iconbtn" data-act="edit" type="button" aria-label="Редактировать">' + I.edit + "</button>" +
        '<button class="rr-iconbtn rr-iconbtn--danger" data-act="del" type="button" aria-label="Удалить">' + I.trash + "</button>" +
      "</div>";

    row.querySelector('[data-act="toggle"]').addEventListener("click", () => {
      rule.enabled = rule.enabled === false;
      row.dataset.enabled = String(rule.enabled);
      row.querySelector('[data-act="toggle"]').dataset.on = String(rule.enabled);
      commit();
    });
    row.querySelector('[data-act="edit"]').addEventListener("click", () => openModal(rule));
    row.querySelector('[data-act="del"]').addEventListener("click", () => {
      rules = rules.filter((r) => r.id !== rule.id);
      renderRules(); commit();
    });

    // drag-reorder через grip
    const grip = row.querySelector(".rr-grip");
    grip.addEventListener("mousedown", () => row.setAttribute("draggable", "true"));
    row.addEventListener("dragstart", (e) => { dragId = rule.id; row.classList.add("is-dragging"); e.dataTransfer.effectAllowed = "move"; });
    row.addEventListener("dragend", () => {
      row.setAttribute("draggable", "false");
      row.classList.remove("is-dragging");
      rootEl.querySelectorAll(".rr-rule").forEach((r) => r.classList.remove("drop-target"));
    });
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drop-target"); });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", (e) => {
      e.preventDefault(); row.classList.remove("drop-target");
      if (!dragId || dragId === rule.id) return;
      const from = rules.findIndex((r) => r.id === dragId);
      const to = rules.findIndex((r) => r.id === rule.id);
      if (from < 0 || to < 0) return;
      const [m] = rules.splice(from, 1);
      rules.splice(to, 0, m);
      renderRules(); commit();
    });
    return row;
  }

  function renderRules() {
    const host = $("#rr-listhost");
    if (!host) return;
    host.innerHTML = "";
    $("#rr-count").textContent = rules.length + " " + plural(rules.length, "правило", "правила", "правил");
    if (!rules.length) { host.appendChild(emptyState()); return; }
    const list = el("div", "rr-list");
    rules.forEach((r, i) => list.appendChild(ruleRow(r, i)));
    host.appendChild(list);
  }

  function emptyState() {
    const e = el("div", "rr-empty");
    e.innerHTML =
      '<div class="rr-empty__icon">' + I.priority + "</div>" +
      '<div class="rr-empty__title">Пока нет своих правил</div>' +
      '<div class="rr-empty__text">Добавьте первое — например, пустить конкретный сайт напрямую, мимо VPN. Ваши правила работают поверх регионального.</div>' +
      '<button class="btn btn--primary" data-act="add" type="button">' + I.route + "Добавить правило</button>";
    e.querySelector('[data-act="add"]').addEventListener("click", () => openModal(null));
    return e;
  }

  /* ═══ МОДАЛКА ADD/EDIT ═══ */
  function openModal(existing) {
    draft = existing ? structuredCloneSafe(existing) : newRule();
    procMode = "pick";
    const back = el("div", "rr-modal");
    back.id = "rr-modal";
    back.innerHTML =
      '<div class="rr-modal__backdrop" data-act="close"></div>' +
      '<div class="rr-modal__card" role="dialog" aria-modal="true">' +
        '<div class="rr-modal__head"><div><div class="rr-modal__kicker">Правило маршрутизации</div>' +
          '<h3 class="rr-modal__title">' + (existing ? "Изменить правило" : "Новое правило") + "</h3></div>" +
          '<button class="rr-modal__close" data-act="close" type="button">' + I.x + "</button></div>" +
        '<div class="rr-modal__body" id="rr-mbody"></div>' +
        '<div class="rr-modal__foot">' +
          '<button class="btn btn--ghost" data-act="close" type="button">Отмена</button>' +
          '<button class="btn btn--primary" id="rr-save" data-act="save" type="button">' + I.check + "Сохранить</button>" +
        "</div>" +
      "</div>";
    document.body.appendChild(back);
    back.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener("click", closeModal));
    back.querySelector("#rr-save").addEventListener("click", saveDraft);
    escHandler = (e) => { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", escHandler);
    renderModalBody();
  }
  function closeModal() {
    const m = document.getElementById("rr-modal");
    if (m) m.remove();
    if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
    draft = null;
  }

  function renderModalBody() {
    const body = document.getElementById("rr-mbody");
    if (!body) return;
    body.innerHTML = "";

    // a) тип
    const typeField = el("div", "rr-field", '<div class="rr-label">Тип правила</div>');
    const seg = el("div", "rr-seg");
    ["domain", "ip", "process"].forEach((t) => {
      const b = el("button", "rr-seg__btn", TYPE_ICON[t] + "<span>" + TYPE_LABELS[t] + "</span>");
      b.type = "button";
      b.dataset.on = String(draft.type === t);
      b.addEventListener("click", () => {
        if (draft.type === t) return;
        draft.type = t; draft.values = [];
        if (t === "domain" && !draft.match) draft.match = "suffix";
        renderModalBody();
      });
      seg.appendChild(b);
    });
    typeField.appendChild(seg);
    body.appendChild(typeField);

    // b) значения по типу
    if (draft.type === "domain") body.appendChild(domainFields());
    else if (draft.type === "ip") body.appendChild(ipFields());
    else body.appendChild(processFields());

    // c) действие
    const actField = el("div", "rr-field", '<div class="rr-label">Что делать с трафиком</div>');
    const pick = el("div", "rr-actions-pick");
    ["proxy", "direct", "block"].forEach((a) => {
      const b = el("button", "rr-apick");
      b.type = "button";
      b.dataset.act = a; b.dataset.on = String(draft.action === a);
      b.innerHTML = '<span class="rr-apick__ico">' + ACTION_ICON[a] + '</span><span class="rr-apick__t">' + ACTION_LABELS[a] + "</span>";
      b.addEventListener("click", () => { draft.action = a; pick.querySelectorAll(".rr-apick").forEach((x) => { x.dataset.on = String(x.dataset.act === a); }); });
      pick.appendChild(b);
    });
    actField.appendChild(pick);
    body.appendChild(actField);

    updateSave();
  }

  function chipInput(type, placeholder) {
    const wrap = el("div", "rr-chipinput");
    const entry = el("input", "rr-chipinput__entry");
    entry.type = "text"; entry.placeholder = placeholder; entry.setAttribute("spellcheck", "false");
    const repaint = () => {
      wrap.querySelectorAll(".rr-ichip").forEach((c) => c.remove());
      draft.values.forEach((v, i) => {
        const bad = !isValidValue(type, v);
        const c = el("span", "rr-ichip" + (bad ? " is-bad" : ""), esc(v) + '<button class="rr-ichip__x" type="button" aria-label="Убрать">' + I.x + "</button>");
        c.querySelector(".rr-ichip__x").addEventListener("click", (ev) => { ev.stopPropagation(); draft.values.splice(i, 1); repaint(); updatePreview(); updateSave(); });
        wrap.insertBefore(c, entry);
      });
    };
    const commitEntry = () => {
      const raw = entry.value.trim();
      if (!raw) return;
      raw.split(/[\s,]+/).filter(Boolean).forEach((tok) => { if (!draft.values.includes(tok)) draft.values.push(tok); });
      entry.value = ""; repaint(); updatePreview(); updateSave();
    };
    entry.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitEntry(); }
      else if (e.key === "Backspace" && !entry.value && draft.values.length) { draft.values.pop(); repaint(); updatePreview(); updateSave(); }
    });
    entry.addEventListener("blur", commitEntry);
    wrap.addEventListener("click", () => entry.focus());
    wrap.appendChild(entry);
    repaint();
    return wrap;
  }

  function previewBox() { return el("div", "rr-preview"); }
  function updatePreview() {
    const p = document.querySelector("#rr-mbody .rr-preview");
    if (!p) return;
    const type = draft.type;
    if (!draft.values.length) {
      p.innerHTML = type === "domain"
        ? "Сохранится в нижнем регистре, без схемы и пути: <b>https://YouTube.com/feed</b> → <b>youtube.com</b>"
        : type === "ip"
          ? "Одиночный адрес трактуется как /32 (IPv6 — /128): <b>1.2.3.4</b> → <b>1.2.3.4/32</b>"
          : "Имя приложения нормализуется до basename + .exe: <b>C:\\…\\Telegram.exe</b> → <b>Telegram.exe</b>";
      p.classList.remove("rr-preview--warn");
      return;
    }
    const norm = draft.values.map((v) => ({ raw: v, n: normalizeValue(type, v), ok: isValidValue(type, v) }));
    const good = norm.filter((x) => x.ok);
    const bad = norm.filter((x) => !x.ok);
    let html = good.length ? "Сохранится как: " + good.map((x) => "<b>" + esc(x.n) + "</b>").join(", ") : "Нет распознанных значений";
    if (bad.length) html += '<br><span class="rr-preview--warn">Будет отброшено (не распознано): ' + bad.map((x) => esc(x.raw)).join(", ") + "</span>";
    p.innerHTML = html;
  }

  function domainFields() {
    const f = el("div", "rr-field", '<div class="rr-label">Домены</div><div class="rr-sublabel">Введите домен и нажмите Enter. Можно несколько.</div>');
    f.appendChild(chipInput("domain", "youtube.com"));
    const mlabel = el("div", "rr-label"); mlabel.style.marginTop = "4px"; mlabel.textContent = "Режим совпадения";
    f.appendChild(mlabel);
    const seg = el("div", "rr-seg");
    ["suffix", "exact", "keyword"].forEach((m) => {
      const b = el("button", "rr-seg__btn", "<span>" + MATCH_LABELS[m] + "</span>");
      b.type = "button";
      b.dataset.on = String(draft.match === m);
      b.addEventListener("click", () => { draft.match = m; seg.querySelectorAll(".rr-seg__btn").forEach((x, i) => { x.dataset.on = String(["suffix", "exact", "keyword"][i] === m); }); });
      seg.appendChild(b);
    });
    f.appendChild(seg);
    f.appendChild(previewBox());
    queueMicrotask(updatePreview);
    return f;
  }
  function ipFields() {
    const f = el("div", "rr-field", '<div class="rr-label">IP-адреса и подсети</div><div class="rr-sublabel">Один адрес или подсеть (CIDR). Можно несколько.</div>');
    f.appendChild(chipInput("ip", "1.2.3.4  или  10.0.0.0/24"));
    f.appendChild(previewBox());
    queueMicrotask(updatePreview);
    return f;
  }
  function processFields() {
    const f = el("div", "rr-field", '<div class="rr-label">Приложение</div>');
    const sw = el("div", "rr-proc-switch");
    const bPick = el("button", "rr-pickbtn", I.app + "Выбрать из запущенных"); bPick.type = "button";
    const bMan = el("button", "rr-pickbtn", I.edit + "Ввести имя вручную"); bMan.type = "button";
    const sync = () => { bPick.style.opacity = procMode === "pick" ? "1" : "0.55"; bMan.style.opacity = procMode === "manual" ? "1" : "0.55"; };
    bPick.addEventListener("click", () => { procMode = "pick"; sync(); renderProcArea(); });
    bMan.addEventListener("click", () => { procMode = "manual"; sync(); renderProcArea(); });
    sync();
    sw.appendChild(bPick); sw.appendChild(bMan);
    f.appendChild(sw);
    const area = el("div"); area.id = "rr-procarea"; f.appendChild(area);
    queueMicrotask(renderProcArea);
    return f;
  }
  function renderProcArea() {
    const area = document.getElementById("rr-procarea");
    if (!area) return;
    area.innerHTML = "";
    if (procMode === "manual") {
      area.appendChild(chipInput("process", "Telegram.exe"));
      area.appendChild(previewBox());
      queueMicrotask(updatePreview);
    } else {
      area.appendChild(processPicker());
    }
  }

  function processPicker() {
    const box = el("div", "rr-picker");
    box.innerHTML =
      '<div class="rr-picker__head"><span class="rr-picker__title"><span class="rr-picker__live"></span>Запущенные приложения с сетью</span>' +
        '<button class="rr-refresh" data-act="refresh" type="button">' + I.refresh + "Обновить</button></div>" +
      '<div class="rr-picker__scroll" id="rr-procscroll"></div>';
    const scroll = box.querySelector("#rr-procscroll");
    const refreshBtn = box.querySelector('[data-act="refresh"]');

    const stateBlock = (text) => '<div class="rr-picker__state"><div class="rr-picker__state-text">' + esc(text) + "</div></div>";
    const loading = () => { scroll.innerHTML = '<div class="rr-picker__state"><div class="rr-spinner"></div><div class="rr-picker__state-text">Снимаю список приложений…</div></div>'; };

    function paint(list) {
      scroll.innerHTML = "";
      if (!list.length) { scroll.innerHTML = stateBlock("Нет приложений с сетевой активностью"); return; }
      list.forEach((p) => {
        const item = el("div", "rr-proc");
        item.dataset.checked = String(draft.values.includes(p.name));
        item.innerHTML =
          '<span class="rr-check">' + I.check + "</span>" +
          '<span class="rr-proc__ico">' + I.app + "</span>" +
          '<span class="rr-proc__main"><span class="rr-proc__name">' + esc(p.name) + '</span><span class="rr-proc__path">' + esc(p.path || "") + "</span></span>" +
          '<span class="rr-proc__pid">PID ' + esc(p.pid) + "</span>";
        item.addEventListener("click", () => {
          const i = draft.values.indexOf(p.name);
          if (i >= 0) draft.values.splice(i, 1); else draft.values.push(p.name);
          item.dataset.checked = String(draft.values.includes(p.name));
          updateSave();
        });
        scroll.appendChild(item);
      });
    }

    // Watchdog: бэкенд-команда обязана отвечать, но если она зависнет (паника до
    // фикса / редкий ABI-сбой), промис никогда не settl-ится и спиннер висит
    // вечно. Гонка с таймаутом гарантирует, что UI всегда восстанавливается.
    const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
    function failState() {
      scroll.innerHTML = "";
      const st = el("div", "rr-picker__state");
      st.innerHTML = '<div class="rr-picker__state-text">Не удалось получить список — повторите</div>';
      const retry = el("button", "rr-refresh", I.refresh + "Повторить");
      retry.type = "button";
      retry.addEventListener("click", () => load());
      st.appendChild(retry);
      scroll.appendChild(st);
    }
    async function load(announce) {
      loading();
      let list;
      try {
        list = await Promise.race([listNetworkProcesses(), timeout(6000)]);
      } catch {
        if (box.isConnected) failState();
        return;
      }
      if (!box.isConnected) return;
      const arr = Array.isArray(list) ? list : [];
      paint(arr);
      if (announce) {
        toast("Список обновлён · " + arr.length + " " + plural(arr.length, "приложение", "приложения", "приложений"), "success", 1400);
      }
    }
    refreshBtn.addEventListener("click", () => {
      refreshBtn.classList.add("is-spinning");
      load(true).finally(() => refreshBtn.classList.remove("is-spinning"));
    });
    load();
    return box;
  }

  function updateSave() {
    const save = document.getElementById("rr-save");
    if (!save) return;
    save.disabled = !draft.values.some((v) => isValidValue(draft.type, v));
  }

  function saveDraft() {
    const { rule } = sanitizeRule(draft);
    if (!rule.values.length) return;
    const idx = rules.findIndex((r) => r.id === rule.id);
    if (idx >= 0) rules[idx] = rule; else rules.push(rule);
    closeModal();
    renderRules();
    commit();
  }

  /* ═══ МОНИТОР СОЕДИНЕНИЙ (группировка по приложению, Throne-style) ═══ */
  const UNKNOWN_KEY = " "; // ведро для соединений без определённого процесса
  function routeChip(outbound) {
    const ob = ACTION_LABELS[outbound] ? outbound : "proxy";
    return '<span class="rr-action rr-action--' + ob + '"><span class="rr-action__dot"></span>' + ACTION_LABELS[ob] + "</span>";
  }
  // Сводка маршрутов группы: по точке на каждый различный outbound.
  function routeDots(conns) {
    const set = [...new Set(conns.map((c) => (ACTION_LABELS[c.outbound] ? c.outbound : "proxy")))];
    return '<span class="rr-appgrp__dots">' +
      set.map((o) => '<span class="rr-dot rr-dot--' + o + '" title="' + ACTION_LABELS[o] + '"></span>').join("") +
      "</span>";
  }
  // Группировка соединений по имени процесса; именованные — выше, по числу
  // соединений, затем по алфавиту. Ведро UNKNOWN_KEY — соединения без процесса.
  function groupConns(conns) {
    const map = new Map();
    for (const c of conns) {
      const key = c.process || UNKNOWN_KEY;
      let g = map.get(key);
      if (!g) { g = { process: c.process || null, path: c.processPath || "", conns: [] }; map.set(key, g); }
      if (!g.path && c.processPath) g.path = c.processPath;
      g.conns.push(c);
    }
    return [...map.values()].sort((a, b) => {
      if (!!a.process !== !!b.process) return a.process ? -1 : 1;
      if (b.conns.length !== a.conns.length) return b.conns.length - a.conns.length;
      return (a.process || "").localeCompare(b.process || "");
    });
  }
  function connSubRow(c) {
    const r = el("div", "rr-csub");
    const host = c.host || c.destinationIP || "—";
    const ipLine = c.host && c.destinationIP ? '<span class="rr-csub__ip">' + esc(c.destinationIP) + "</span>" : "";
    r.innerHTML =
      '<span class="rr-csub__dest"><span class="rr-csub__host">' + esc(host) + "</span>" + ipLine + "</span>" +
      routeChip(c.outbound);
    return r;
  }
  function appGroup(g) {
    const key = g.process || UNKNOWN_KEY;
    const open = monExpanded.has(key);
    const wrap = el("div", "rr-appgrp" + (g.process ? "" : " rr-appgrp--unknown"));
    wrap.dataset.open = String(open);

    const name = g.process || "Без процесса";
    const path = g.path && g.path !== g.process ? '<span class="rr-appgrp__path">' + esc(g.path) + "</span>" : "";
    const head = el("button", "rr-appgrp__head");
    head.type = "button";
    head.innerHTML =
      '<span class="rr-appgrp__chev">' + I.chev + "</span>" +
      '<span class="rr-appgrp__ico">' + I.app + "</span>" +
      '<span class="rr-appgrp__meta"><span class="rr-appgrp__name">' + esc(name) + "</span>" + path + "</span>" +
      routeDots(g.conns) +
      '<span class="rr-appgrp__count" title="Активных соединений">' + g.conns.length + "</span>";
    head.addEventListener("click", () => {
      const nowOpen = wrap.dataset.open !== "true";
      wrap.dataset.open = String(nowOpen);
      if (nowOpen) monExpanded.add(key); else monExpanded.delete(key);
    });

    const body = el("div", "rr-appgrp__conns");
    g.conns.forEach((c) => body.appendChild(connSubRow(c)));

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }
  function renderMonitor() {
    const host = $("#rr-listhost");
    if (!host) return;
    host.innerHTML = "";
    const wrap = el("div", "rr-monitor");
    wrap.dataset.paused = String(monitorPaused);
    wrap.innerHTML =
      '<div class="rr-mon-bar">' +
        '<span class="rr-mon-live"><span class="rr-mon-live__dot"></span>' + (monitorPaused ? "Пауза" : "Обновление каждые 2 c") + "</span>" +
        '<span class="rr-bar__spring"></span>' +
        '<span class="rr-mon-count" id="rr-moncount"></span>' +
        '<button class="btn btn--sm" id="rr-pausebtn" type="button">' + (monitorPaused ? I.play + "Возобновить" : I.pause + "Пауза") + "</button>" +
      "</div>" +
      '<div class="rr-appgroups" id="rr-conns"></div>';
    host.appendChild(wrap);
    wrap.querySelector("#rr-pausebtn").addEventListener("click", () => { monitorPaused = !monitorPaused; if (monitorPaused) stopMonTimer(); else startMonTimer(); renderMonitor(); });
    paintConns();
    if (!monitorPaused) startMonTimer();
  }
  function paintConns() {
    const host = $("#rr-conns");
    if (!host) return;
    host.innerHTML = "";
    if (!monConns.length) {
      host.innerHTML = '<div class="rr-picker__state"><div class="rr-picker__state-text">Пока нет активных соединений</div></div>';
    } else {
      const groups = groupConns(monConns);
      groups.forEach((g) => host.appendChild(appGroup(g)));
    }
    const cnt = $("#rr-moncount");
    if (cnt) cnt.textContent = monConns.length + " " + plural(monConns.length, "соединение", "соединения", "соединений");
  }
  async function pollConns() {
    // Стоп, если секцию перерисовали/ушли с монитора.
    if (!rootEl.isConnected || tab !== "monitor") { stopMonTimer(); return; }
    try {
      const list = await getConnections(clashPort);
      if (!rootEl.isConnected || tab !== "monitor") return;
      monConns = Array.isArray(list) ? list : [];
      paintConns();
    } catch {
      // ядро может быть offline (idle) — просто молчим, покажем пусто
      monConns = [];
      paintConns();
    }
  }
  function startMonTimer() {
    stopMonTimer();
    pollConns();
    monTimer = setInterval(pollConns, 2000);
  }
  function stopMonTimer() { if (monTimer) { clearInterval(monTimer); monTimer = null; } }

  /* ═══ ВКЛАДКИ ═══ */
  function setTab(t) {
    tab = t;
    $("#tab-rules").dataset.on = String(t === "rules");
    $("#tab-monitor").dataset.on = String(t === "monitor");
    $("#rr-priority").hidden = t !== "rules";
    if (t === "rules") { stopMonTimer(); renderRules(); }
    else renderMonitor();
  }

  function destroy() {
    stopMonTimer();
    closeModal();
    if (activeInstance === instance) activeInstance = null;
  }

  // ── init ──
  buildShell();
  setTab("rules");

  const instance = { destroy, refresh: () => { rules = loadRules(); if (tab === "rules") renderRules(); } };
  activeInstance = instance;
  return instance;
}
