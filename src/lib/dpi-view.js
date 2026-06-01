// Ninety · DPI-обход (DPI bypass) — экран раздела + чип на главной.
// UI из design_handoff_dpi (Claude Design), подключён к движку winws через
// Rust-команды dpi_* (см. src-tauri/src/dpi.rs). State и persistence реальные.
//
// Публичное API:
//   mountDpiView({ onToast, switchView, ensureElevated }) — навесить на DOM
//   setDpiVpnMode(mode)  — синхронизировать режим VPN (TUN→пауза)
//   excludeVpnNode(host) — внести сервер активной ноды в exclude winws

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));
const tauriListen = window.__TAURI__?.event?.listen;

/* ═══════════ ICONS (inner SVG, стиль Lucide 1.5px) ═══════════ */
const I = {
  dpi:      '<path d="M12 22c5-2.2 8-5.5 8-10V5l-8-3-8 3v7c0 4.5 3 7.8 8 10z"/><path d="M12.8 7 9.8 12.2h2.5L11 16"/>',
  shield:   '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  info:     '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert:    '<path d="M10.3 4 2.7 17a1.5 1.5 0 0 0 1.3 2.3h16a1.5 1.5 0 0 0 1.3-2.3L13.7 4a1.5 1.5 0 0 0-2.6 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  pause:    '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  target:   '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  list:     '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  cpu:      '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2"/><path d="M15 2v2"/><path d="M9 20v2"/><path d="M15 20v2"/><path d="M2 9h2"/><path d="M2 15h2"/><path d="M20 9h2"/><path d="M20 15h2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/>',
  box:      '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  link:     '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  refresh:  '<path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/>',
  check:    '<path d="m5 12 5 5L20 7"/>',
  chevron:  '<path d="m9 6 6 6-6 6"/>',
  close:    '<path d="m6 6 12 12"/><path d="m18 6-12 12"/>',
  search:   '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
};
function ic(name, size = 16, stroke = 1.5) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${I[name] || ""}</svg>`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ═══════════ DATA ═══════════ */
// Реальный список приходит из dpi_strategies() (strategies.json движка).
// Фолбэк — на случай web-preview / ошибки чтения.
let STRATEGIES = [{ id: "alt11", name: "ALT11", desc: "Самый стойкий профиль." }];
const stratByName = (n) =>
  STRATEGIES.find((s) => s.name === n) || STRATEGIES.find((s) => s.id === n) || STRATEGIES[0];

const MASTER = {
  off:      { kicker: () => "OFF · STAND-BY",     title: "Обход выключен", icon: "dpi",
              desc: () => "Запросы к заблокированным сервисам идут напрямую. Включите обход — откроются голос, мессенджеры и стриминг." },
  starting: { kicker: () => "STARTING · WINWS",   title: "Запускается…",   icon: "dpi",
              desc: (s) => `Поднимаю движок и применяю стратегию <b>${esc(s)}</b>.` },
  running:  { kicker: (s) => "RUNNING · " + s,    title: "Обход активен",  icon: "dpi",
              desc: () => "Трафик к доменам из списка идёт в обход DPI. Работает параллельно с VPN." },
  error:    { kicker: () => "ERROR · DRIVER",     title: "Ошибка запуска", icon: "alert",
              desc: () => 'Не удалось поднять движок <b>winws</b>. Нужны права администратора или занят драйвер — детали в <a href="#" data-dpi-logs>логах</a>.' },
  paused:   { kicker: () => "PAUSED · TUN",       title: "На паузе",       icon: "pause",
              desc: () => "VPN в режиме TUN — весь трафик уже идёт через туннель, обход не требуется." },
};

const MODE_TXT = { proxy: "ПРОКСИ", systemProxy: "СИСТЕМНЫЙ ПРОКСИ", tun: "VPN · TUN" };
const CHIP_STATUS = { off: "Выкл", starting: "Запуск", running: "Вкл", error: "Ошибка", paused: "Пауза" };

/* ═══════════ STATE (persisted в localStorage) ═══════════ */
const LS = {
  enabled: "ninety.dpi.enabled",
  strategy: "ninety.dpi.strategy",
  gameFilter: "ninety.dpi.gameFilter",
  ipset: "ninety.dpi.ipset",
};
const lsGet = (k, d) => { const v = localStorage.getItem(k); return v == null ? d : v; };

const S = {
  base: "off",          // off | starting | running | error
  vpnMode: "systemProxy",
  strategy: lsGet(LS.strategy, "ALT11"),
  gameFilter: lsGet(LS.gameFilter, "off"),
  ipset: lsGet(LS.ipset, "any"),
  hasUpdate: false,
  lastError: "",
  versions: { app: "—", engine: "winws", strategies: "—" },
  domains: null,
  ipsetOpen: false,
  autopick: { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" },
  updating: null,       // id строки, которая сейчас обновляется
};

// В TUN весь трафик идёт через туннель → движок реально остановлен (pauseEngineForTun),
// но если DPI логически включён (LS.enabled) — показываем «На паузе», а не «Выключен»:
// при выходе из TUN он восстановится. Вне TUN — реальное состояние движка.
function effState() {
  if (S.vpnMode === "tun" && lsGet(LS.enabled, "false") === "true") return "paused";
  return S.base;
}

let toast = () => {};
let goView = () => {};
let ensureElevated = async () => true; // из main.js; true = можно продолжать (мы elevated)

/* ═══════════ RENDER: SCREEN BODY ═══════════ */
function renderBody() {
  const body = document.getElementById("dpi-body");
  if (!body) return;
  const st = effState();
  const m = MASTER[st] || MASTER.off;
  const switchOn = st === "running" || st === "starting";
  const cur = stratByName(S.strategy);
  const p = S.autopick;

  let banner = "";
  if (st === "paused") {
    banner = `<div class="dpi-banner" data-kind="paused">
      <span class="dpi-banner__icon">${ic("info", 16)}</span>
      <div><b>DPI-обход на паузе:</b> в режиме TUN весь трафик идёт через VPN, обход не требуется. При выходе из TUN обход восстановится автоматически.</div>
    </div>`;
  } else if (st === "error") {
    const reason = S.lastError
      ? esc(S.lastError.length > 400 ? S.lastError.slice(-400) : S.lastError)
      : "Нужны права администратора, либо занят драйвер WinDivert / порт.";
    banner = `<div class="dpi-banner" data-kind="error">
      <span class="dpi-banner__icon">${ic("alert", 16)}</span>
      <div><b>Движок winws не запустился.</b> <span style="white-space:pre-wrap;font-family:var(--font-mono);font-size:11px">${reason}</span></div>
      <button class="btn btn--sm dpi-banner__action" data-dpi-logs>${ic("terminal", 13)} Открыть логи</button>
    </div>`;
  }

  let autopick = "";
  if (p.phase === "idle") {
    autopick = `<div class="dpi-autopick__lead">Прогоним <b>все ${STRATEGIES.length} стратегий</b> на вашем интернете и выберем ту, что реально открывает заблокированные сервисы. <b>Запускать при выключенном VPN.</b></div>
      <div class="dpi-autopick__actions"><button class="btn btn--primary btn--sm" data-dpi-pick-start>${ic("target", 13)} Подобрать под мой интернет</button></div>`;
  } else if (p.phase === "running") {
    const total = p.total || STRATEGIES.length;
    const pct = total ? (p.i / total * 100).toFixed(1) : 0;
    autopick = `<div class="dpi-autopick__prog">
        <div class="dpi-autopick__prog-top"><span class="dpi-autopick__prog-now">Проверяю стратегию <b>${esc(p.name || "…")}</b></span></div>
        <div class="dpi-bar"><span class="dpi-bar__fill" style="width:${pct}%"></span></div>
        <div class="dpi-autopick__candidate">тест соединения · TLS-handshake · ping&nbsp;&nbsp;<b>${p.i}</b> из ${total}</div>
      </div>`;
  } else if (p.phase === "done") {
    autopick = `<div class="dpi-result">
        <span class="dpi-result__icon">${ic("check", 18)}</span>
        <div class="dpi-result__main"><div class="dpi-result__label">Рекомендуется</div><div class="dpi-result__name">${esc(p.best || "—")}</div></div>
        <div class="dpi-result__meta">${esc(p.meta || "")}</div>
      </div>
      <div class="dpi-autopick__actions">
        ${p.best ? `<button class="btn btn--primary btn--sm" data-dpi-pick-apply="${esc(p.best)}">${ic("check", 13)} Применить ${esc(p.best)}</button>` : ""}
        <button class="btn btn--sm" data-dpi-pick-start>Заново</button>
      </div>`;
  }

  const UPD = [
    { id: "app", name: "Приложение", ver: `Ninety ${S.versions.app}`, icon: "box", upd: false },
    { id: "engine", name: "Движок обхода", ver: S.versions.engine, icon: "cpu", upd: false },
    { id: "strategies", name: "Набор стратегий", ver: `lists ${S.versions.strategies}`, icon: "list", upd: S.hasUpdate },
  ];
  const updRows = UPD.map((row) => {
    const isUpd = S.updating === row.id;
    const right = row.upd
      ? `<span class="dpi-pill" data-kind="update">обновление</span>
         <button class="btn btn--sm btn--primary" data-dpi-update="${row.id}" ${isUpd ? "disabled" : ""}>${isUpd ? "…" : "Обновить"}</button>`
      : `<span class="dpi-pill" data-kind="ok">актуально</span>`;
    return `<div class="dpi-upd-row" data-updating="${isUpd}">
        <span class="dpi-upd-row__icon">${ic(row.icon, 15)}</span>
        <div class="dpi-upd-row__main"><span class="dpi-upd-row__name">${row.name}</span><span class="dpi-upd-row__ver">${esc(row.ver)}</span></div>
        <div class="dpi-upd-row__right">${right}</div>
        <span class="dpi-upd-row__bar"></span>
      </div>`;
  }).join("");

  const ipsetHint = { any: "Обход применяется к любому IP по совпадению домена. Рекомендуется.",
    loaded: "Обход только для IP из загруженного набора (ipset-all).",
    off: "IP-фильтрация выключена — решает только список доменов." }[S.ipset];
  const domainsTxt = S.domains == null ? "…" : S.domains.toLocaleString("ru-RU");

  body.innerHTML = `
    ${banner}
    <article class="dpi-master" data-state="${st}">
      <div class="dpi-master__glow"></div>
      <div class="dpi-master__icon">${ic(m.icon, 24)}</div>
      <div class="dpi-master__main">
        <div class="dpi-master__kicker"><span class="dpi-master__dot"></span><span>${esc(m.kicker(S.strategy))}</span></div>
        <h3 class="dpi-master__title">${m.title}</h3>
        <p class="dpi-master__desc">${m.desc(S.strategy)}</p>
      </div>
      <div class="dpi-master__toggle">
        <div class="switch switch--lg" data-on="${switchOn}" data-dpi-toggle role="switch" aria-checked="${switchOn}"></div>
      </div>
      <div class="dpi-master__progress"></div>
    </article>

    <div class="dpi-grid">
      <div class="dpi-col">
        <article class="dpi-card">
          <div class="dpi-card__head">
            <div class="dpi-card__label">${ic("shield", 13)}Текущая стратегия</div>
            <button class="btn btn--sm" data-dpi-drawer>${ic("refresh", 13)} Сменить</button>
          </div>
          <div class="dpi-strategy">
            <div class="dpi-strategy__row">
              <span class="dpi-strategy__name">${esc(cur.name)}</span>
              ${S.strategy === "ALT11" ? '<span class="dpi-strategy__tag">рекоменд.</span>' : ""}
            </div>
            <div class="dpi-strategy__desc">${esc(cur.desc || "")}</div>
          </div>
        </article>

        <article class="dpi-card dpi-autopick">
          <div class="dpi-card__head">
            <div class="dpi-card__label">${ic("target", 13)}Авто-подбор стратегии</div>
            ${p.phase === "running" ? `<span class="dpi-autopick__prog-count">${p.i} / ${p.total || STRATEGIES.length}</span>` : ""}
          </div>
          ${autopick}
        </article>

        <article class="dpi-card">
          <div class="dpi-row">
            <div class="dpi-row__lbl">
              <div class="dpi-row__t">Игровой фильтр</div>
              <div class="dpi-row__d">Доп. обход для игр (Fortnite, Valorant) — фильтрует и TCP, и UDP. Для обычного веба не нужен.</div>
            </div>
            <div class="seg">
              <button class="seg__btn" data-on="${S.gameFilter === "off"}" data-dpi-game="off">Выкл</button>
              <button class="seg__btn" data-on="${S.gameFilter === "tcpudp"}" data-dpi-game="tcpudp">TCP + UDP</button>
            </div>
          </div>
        </article>
      </div>

      <div class="dpi-col">
        <article class="dpi-card dpi-vpn">
          <div class="dpi-card__head">
            <div class="dpi-card__label">${ic("link", 13)}Связь с VPN</div>
            <div class="dpi-vpn__mode" data-tun="${S.vpnMode === "tun"}"><span class="dpi-vpn__mode-dot"></span>${MODE_TXT[S.vpnMode] || MODE_TXT.systemProxy}</div>
          </div>
          <div class="dpi-row__d" style="max-width:none">${S.vpnMode === "tun"
            ? "VPN в режиме TUN перехватывает весь трафик — обход автоматически встаёт на паузу."
            : "Обход независим от VPN: работает поверх системного прокси, даже если VPN выключен. Сервер активной ноды авто-добавляется в исключения."}</div>
        </article>

        <article class="dpi-card">
          <div class="dpi-card__head"><div class="dpi-card__label">${ic("list", 13)}Списки доменов</div></div>
          <div class="dpi-domains__count"><span class="dpi-domains__num tnum">${domainsTxt}</span><span class="dpi-domains__unit">доменов обходится</span></div>
          <div class="dpi-domains__actions">
            <button class="btn btn--sm" data-dpi-domains="user">Мои домены</button>
            <button class="btn btn--sm" data-dpi-domains="exclude">Исключения</button>
          </div>
        </article>

        <article class="dpi-card dpi-updates">
          <div class="dpi-card__head"><div class="dpi-card__label">${ic("download", 13)}Обновления</div></div>
          <div class="dpi-upd">${updRows}</div>
        </article>

        <article class="dpi-card dpi-ipset" data-open="${S.ipsetOpen}">
          <div class="dpi-ipset__head" data-dpi-ipset-toggle>
            <div class="dpi-row__lbl"><div class="dpi-row__t">Режим IPSet</div><div class="dpi-row__d">Для продвинутых: фильтрация по IP-множествам</div></div>
            <span class="dpi-ipset__chev">${ic("chevron", 16)}</span>
          </div>
          <div class="dpi-ipset__body"><div class="dpi-ipset__inner"><div class="dpi-ipset__pad">
            <div class="seg">
              <button class="seg__btn" data-on="${S.ipset === "any"}" data-dpi-ipset="any">Любой</button>
              <button class="seg__btn" data-on="${S.ipset === "loaded"}" data-dpi-ipset="loaded">Загружен</button>
              <button class="seg__btn" data-on="${S.ipset === "off"}" data-dpi-ipset="off">Выкл</button>
            </div>
            <div class="dpi-row__d" style="max-width:none">${ipsetHint}</div>
          </div></div></div>
        </article>
      </div>
    </div>`;
}

function renderChip() {
  const slot = document.getElementById("dpi-chip-slot");
  if (!slot) return;
  const st = effState();
  const switchOn = st === "running" || st === "starting";
  slot.innerHTML = `<button class="dpi-chip" data-state="${st}" data-dpi-open title="Открыть DPI-обход">
      <span class="dpi-chip__icon">${ic("dpi", 16)}</span>
      <span class="dpi-chip__txt">
        <span class="dpi-chip__status">DPI · ${CHIP_STATUS[st]}</span>
        <span class="dpi-chip__strat">${esc(S.strategy)}</span>
      </span>
      <span class="dpi-chip__sep"></span>
      <span class="switch" data-on="${switchOn}" data-dpi-toggle role="switch" aria-checked="${switchOn}"></span>
    </button>`;
}

function renderBadge() {
  const b = document.getElementById("dpi-nav-badge");
  if (b) b.hidden = !S.hasUpdate;
}

function renderAll() { renderBody(); renderChip(); renderBadge(); }

/* ═══════════ ACTIONS (реальный движок) ═══════════ */
async function startEngine() {
  S.base = "starting";
  renderAll();
  S.lastError = "";
  try {
    await invoke("dpi_start", { strategyId: stratByName(S.strategy).id, gameFilter: S.gameFilter, ipset: S.ipset });
    S.base = "running";
    localStorage.setItem(LS.enabled, "true");
  } catch (e) {
    S.base = "error";
    S.lastError = String(e?.message || e);
    toast(`DPI-обход не запустился — см. детали в карточке`, "error", 5000);
  }
  renderAll();
}

async function stopEngine() {
  try { await invoke("dpi_stop"); } catch {}
  S.base = "off";
  localStorage.setItem(LS.enabled, "false");
  renderAll();
}

// Пауза движка при входе в TUN: реально глушим winws, НО LS.enabled оставляем
// "true" — это «логическое желание», по которому восстановимся при выходе.
async function pauseEngineForTun() {
  try { await invoke("dpi_stop"); } catch {}
  S.base = "off";        // движок реально остановлен; effState даст "paused" по LS.enabled
  renderAll();
}

// Возврат из TUN: поднять движок, если DPI был включён до паузы. Процесс в этот
// момент уже elevated (TUN требовал прав), поэтому UAC обычно не всплывёт.
async function resumeEngineAfterTun() {
  if (lsGet(LS.enabled, "false") !== "true") return;
  if (S.base === "running" || S.base === "starting") return;
  const ok = await ensureElevated();
  if (!ok) return;
  await startEngine();
}

async function toggleDpi() {
  // В TUN движок на паузе — тоггл меняет лишь «хотим ли DPI после выхода из TUN».
  if (S.vpnMode === "tun") {
    const want = lsGet(LS.enabled, "false") !== "true";
    localStorage.setItem(LS.enabled, want ? "true" : "false");
    renderAll();
    toast(want ? "DPI включится после выхода из TUN" : "DPI-обход выключен", "info", 2200);
    return;
  }
  if (S.base === "running" || S.base === "starting") { await stopEngine(); return; }
  // включение требует админ-прав (winws грузит драйвер). Та же инфра, что у TUN.
  const ok = await ensureElevated();
  if (!ok) return; // идёт перезапуск с UAC или отказ — текущий процесс не продолжает
  await startEngine();
}

// Автозапуск DPI при старте приложения (Windows-логин), если был включён.
// Вызывается из main.js только в should_autoconnect-ветке. Процесс к этому
// моменту уже elevated (см. единый автозапуск в main.js) → стартуем без confirm.
export async function autostartDpiIfEnabled() {
  if (lsGet(LS.enabled, "false") !== "true") return;
  if (S.vpnMode === "tun") return; // в TUN обход не нужен — останется на паузе
  try { if (await invoke("dpi_running")) { S.base = "running"; renderAll(); return; } } catch {}
  const ok = await ensureElevated();
  if (!ok) return;
  await startEngine();
}

// Применить смену настройки на лету: если движок запущен — перезапустить.
async function restartIfRunning() {
  if (S.base === "running" || S.base === "starting") {
    try { await invoke("dpi_stop"); } catch {}
    await startEngine();
  }
}

async function setStrategy(s) {
  S.strategy = s.name;
  localStorage.setItem(LS.strategy, s.name);
  renderAll();
  await restartIfRunning();
  toast(`Стратегия: ${s.name}`, "info", 1600);
}

async function loadStrategies() {
  try {
    const raw = await invoke("dpi_strategies");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) STRATEGIES = arr;
    if (!stratByName(S.strategy)) S.strategy = STRATEGIES[0].name;
  } catch {}
}

async function loadVersions() {
  try { S.versions = await invoke("dpi_versions"); } catch {}
}
async function loadDomains() {
  try { S.domains = await invoke("dpi_domains_count"); } catch { S.domains = 0; }
}
async function checkUpdate() {
  try { const r = await invoke("dpi_check_update"); S.hasUpdate = !!r?.available; } catch {}
}

async function runUpdate(id) {
  if (id !== "strategies") return;
  S.updating = id;
  renderBody();
  try {
    const ver = await invoke("dpi_update_strategies");
    if (ver) S.versions.strategies = ver;
    S.hasUpdate = false;
    await loadDomains();
    await restartIfRunning(); // применить свежие списки
    toast("Списки обновлены", "info", 1800);
  } catch (e) {
    toast(`Обновление не удалось: ${e?.message || e}`, "error", 3500);
  }
  S.updating = null;
  renderAll();
}

/* ── Авто-подбор ── */
async function pickStart() {
  S.autopick = { phase: "running", i: 0, total: STRATEGIES.length, name: "", best: null, meta: "" };
  renderBody();
  const ok = await ensureElevated();
  if (!ok) { S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" }; return; }
  try {
    const r = await invoke("dpi_autotest", {});
    if (r?.best_id) {
      const best = STRATEGIES.find((s) => s.id === r.best_id);
      S.autopick = {
        phase: "done", i: r.total, total: r.total,
        best: best?.name || r.best_name,
        meta: `${r.passed} из ${r.total} прошли · лучшая задержка ${r.latency_ms} мс`,
      };
    } else {
      S.autopick = { phase: "done", i: r?.total || 0, total: r?.total || 0, best: null, meta: "Ни одна стратегия не прошла — проверьте, что VPN выключен." };
    }
  } catch (e) {
    S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" };
    toast(`Авто-подбор: ${e?.message || e}`, "error", 3500);
  }
  renderAll();
}

async function pickApply(name) {
  const s = stratByName(name);
  S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" };
  await setStrategy(s);
  // если движок был выключен — включим с выбранной стратегией
  if (S.base === "off" || S.base === "error") await toggleDpi();
}

/* ═══════════ STRATEGY DRAWER (динамический) ═══════════ */
let drawerEl = null;
function openDrawer() {
  if (drawerEl) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="drawer-bg" data-dpi-drawer-bg></div>
    <aside class="drawer" role="dialog" aria-label="Стратегии обхода">
      <div class="drawer__head">
        <div><div class="drawer__kicker">PICK A STRATEGY · WINWS</div><div class="drawer__title">Стратегии обхода</div></div>
        <button class="drawer__close" data-dpi-drawer-close aria-label="Закрыть">${ic("close", 16)}</button>
      </div>
      <div class="drawer__search">${ic("search", 14)}<input type="text" id="dpi-strat-search" placeholder="Поиск: ALT11, fake tls…" autocomplete="off"></div>
      <div class="drawer__list" id="dpi-strat-list"></div>
    </aside>`;
  drawerEl = wrap;
  document.body.appendChild(wrap);
  renderStratList("");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    wrap.querySelector(".drawer-bg").dataset.open = "true";
    wrap.querySelector(".drawer").dataset.open = "true";
  }));
  wrap.querySelector("#dpi-strat-search").addEventListener("input", (e) => renderStratList(e.target.value));
  setTimeout(() => wrap.querySelector("#dpi-strat-search")?.focus(), 320);
}
function closeDrawer() {
  if (!drawerEl) return;
  const w = drawerEl;
  drawerEl = null;
  w.querySelector(".drawer-bg").dataset.open = "false";
  w.querySelector(".drawer").dataset.open = "false";
  setTimeout(() => w.remove(), 340);
}
function renderStratList(query) {
  const list = drawerEl?.querySelector("#dpi-strat-list");
  if (!list) return;
  const q = (query || "").toLowerCase();
  const cur = stratByName(S.strategy);
  const filtered = STRATEGIES.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.desc || "").toLowerCase().includes(q));
  list.innerHTML = `<div class="drawer__section"><span>${filtered.length} стратегий</span><span>АКТИВНАЯ ПОМЕЧЕНА</span></div>` +
    filtered.map((s) => `<div class="strat" data-active="${s.id === cur.id}" data-dpi-strat="${s.id}">
        <div class="strat__main"><div class="strat__name">${esc(s.name)}</div><div class="strat__desc">${esc(s.desc || "")}</div></div>
        <span class="strat__check">${ic("check", 11, 2.5)}</span>
      </div>`).join("");
}

/* ═══════════ DOMAIN LIST EDITOR (динамический) ═══════════ */
let editorEl = null;
const EDITOR_META = {
  user:    { kicker: "MY DOMAINS · HOSTLIST", title: "Мои домены",
             hint: "Домены (по одному в строке), которые принудительно идут в обход DPI. Поддомены добавляйте отдельно. Строки с # — комментарии.",
             file: "list-general-user.txt" },
  exclude: { kicker: "EXCLUDE · BYPASS WINWS", title: "Исключения",
             hint: "Домены, которые winws НЕ трогает (например, банки или сервисы, ломающиеся от обхода). Сервер активной VPN-ноды добавляется сюда автоматически.",
             file: "list-exclude-user.txt" },
};

async function openListEditor(kind) {
  if (editorEl) return;
  const meta = EDITOR_META[kind] || EDITOR_META.user;
  let content = "";
  try { content = await invoke("dpi_read_list", { kind }); } catch {}
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="drawer-bg" data-dpi-editor-bg></div>
    <aside class="drawer drawer--editor" role="dialog" aria-label="${esc(meta.title)}">
      <div class="drawer__head">
        <div><div class="drawer__kicker">${esc(meta.kicker)}</div><div class="drawer__title">${esc(meta.title)}</div></div>
        <button class="drawer__close" data-dpi-editor-close aria-label="Закрыть">${ic("close", 16)}</button>
      </div>
      <div class="dpi-editor">
        <div class="dpi-editor__hint">${esc(meta.hint)}</div>
        <textarea class="dpi-editor__area" id="dpi-editor-area" spellcheck="false" autocomplete="off"
          placeholder="discord.com&#10;gateway.discord.gg&#10;youtube.com">${esc(content)}</textarea>
        <div class="dpi-editor__foot">
          <span class="dpi-editor__file">${esc(meta.file)}</span>
          <div class="dpi-editor__actions">
            <button class="btn btn--sm" data-dpi-editor-close>Отмена</button>
            <button class="btn btn--sm btn--primary" data-dpi-editor-save="${esc(kind)}">${ic("check", 13)} Сохранить</button>
          </div>
        </div>
      </div>
    </aside>`;
  editorEl = wrap;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    wrap.querySelector(".drawer-bg").dataset.open = "true";
    wrap.querySelector(".drawer").dataset.open = "true";
  }));
  setTimeout(() => wrap.querySelector("#dpi-editor-area")?.focus(), 320);
}

function closeListEditor() {
  if (!editorEl) return;
  const w = editorEl;
  editorEl = null;
  w.querySelector(".drawer-bg").dataset.open = "false";
  w.querySelector(".drawer").dataset.open = "false";
  setTimeout(() => w.remove(), 340);
}

async function saveListEditor(kind) {
  const area = editorEl?.querySelector("#dpi-editor-area");
  if (!area) return;
  try {
    await invoke("dpi_write_list", { kind, content: area.value });
    await loadDomains();
    closeListEditor();
    await restartIfRunning(); // применить свежий список к движку
    toast(kind === "exclude" ? "Исключения сохранены" : "Список доменов сохранён", "info", 1800);
  } catch (e) {
    toast(`Не удалось сохранить: ${e?.message || e}`, "error", 3500);
  }
}

/* ═══════════ EVENT DELEGATION ═══════════ */
function onClick(e) {
  const t = e.target;
  if (t.closest("[data-dpi-toggle]")) { e.preventDefault(); e.stopPropagation(); toggleDpi(); return; }
  if (t.closest("[data-dpi-open]")) { goView("dpi"); return; }
  if (t.closest("[data-dpi-drawer]")) { openDrawer(); return; }
  if (t.closest("[data-dpi-drawer-close]") || t.closest("[data-dpi-drawer-bg]")) { closeDrawer(); return; }
  const strat = t.closest("[data-dpi-strat]");
  if (strat) { setStrategy(stratByName(strat.dataset.dpiStrat)); closeDrawer(); return; }
  if (t.closest("[data-dpi-logs]")) { e.preventDefault(); invoke("open_log_dir").catch(() => goView("logs")); return; }
  if (t.closest("[data-dpi-pick-start]")) { pickStart(); return; }
  const apply = t.closest("[data-dpi-pick-apply]");
  if (apply) { pickApply(apply.dataset.dpiPickApply); return; }
  const game = t.closest("[data-dpi-game]");
  if (game) { S.gameFilter = game.dataset.dpiGame; localStorage.setItem(LS.gameFilter, S.gameFilter); renderBody(); restartIfRunning(); return; }
  const ips = t.closest("[data-dpi-ipset]");
  if (ips) { S.ipset = ips.dataset.dpiIpset; localStorage.setItem(LS.ipset, S.ipset); renderBody(); restartIfRunning(); return; }
  if (t.closest("[data-dpi-ipset-toggle]")) { S.ipsetOpen = !S.ipsetOpen; renderBody(); return; }
  const upd = t.closest("[data-dpi-update]");
  if (upd) { runUpdate(upd.dataset.dpiUpdate); return; }
  const dom = t.closest("[data-dpi-domains]");
  if (dom) { openListEditor(dom.dataset.dpiDomains); return; }
  if (t.closest("[data-dpi-editor-close]") || t.closest("[data-dpi-editor-bg]")) { closeListEditor(); return; }
  const save = t.closest("[data-dpi-editor-save]");
  if (save) { saveListEditor(save.dataset.dpiEditorSave); return; }
}

/* ═══════════ PUBLIC API ═══════════ */
export function setDpiVpnMode(mode) {
  if (!mode || mode === S.vpnMode) return;
  const prev = S.vpnMode;
  S.vpnMode = mode;
  renderAll();
  // Реальная пауза/возврат движка по режиму VPN (риск из спайка: в TUN весь
  // трафик в туннеле, winws иначе жуёт зашифрованный VLESS).
  if (mode === "tun") {
    if (S.base === "running" || S.base === "starting") pauseEngineForTun();
  } else if (prev === "tun") {
    resumeEngineAfterTun();
  }
}

// Внести сервер активной VPN-ноды в exclude winws (главный риск из спайка —
// иначе winws корёжит зашифрованный VLESS к серверу). host = домен или IP.
export function excludeVpnNode(host) {
  if (!host) return;
  const isIp = /^[0-9a-fA-F:.]+$/.test(host) && (host.includes(".") || host.includes(":"));
  const args = isIp ? { ip: host, domain: null } : { ip: null, domain: host };
  invoke("dpi_set_node_exclude", args).catch(() => {});
}

export async function mountDpiView({ onToast, switchView, ensureElevated: ee } = {}) {
  if (typeof onToast === "function") toast = onToast;
  if (typeof switchView === "function") goView = switchView;
  if (typeof ee === "function") ensureElevated = ee;

  // Делегирование на document (не #app-root): дравер добавляется в document.body
  // вне #app-root, поэтому его клики — закрытие/фон/выбор стратегии — должны
  // ловиться на уровне документа.
  document.addEventListener("click", onClick);
  document.getElementById("dpi-strategies-btn")?.addEventListener("click", openDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (editorEl) closeListEditor();
    else if (drawerEl) closeDrawer();
  });

  // Прогресс авто-подбора (событие из Rust dpi_autotest).
  if (tauriListen) {
    tauriListen("dpi:autotest", (ev) => {
      const d = ev?.payload || {};
      if (S.autopick.phase === "running") {
        S.autopick.i = d.i || S.autopick.i;
        S.autopick.total = d.total || S.autopick.total;
        S.autopick.name = d.name || S.autopick.name;
        renderBody();
      }
    }).catch(() => {});
  }

  renderAll();
  await loadStrategies();
  // Реальное состояние движка после перезапуска приложения (UI поверх живого
  // winws). Синхронизируем в обе стороны: жив → running + чиним LS.enabled;
  // мёртв, но локально считались running → сбрасываем в off (чип не врёт).
  try {
    if (await invoke("dpi_running")) {
      S.base = "running";
      localStorage.setItem(LS.enabled, "true");
    } else if (S.base === "running" || S.base === "starting") {
      S.base = "off";
    }
  } catch {}
  await Promise.all([loadVersions(), loadDomains(), checkUpdate()]);
  renderAll();
}
