// Ninety · DPI-обход (DPI bypass) — экран раздела + чип на главной.
// UI подключён к движку winws через
// Rust-команды dpi_* (см. src-tauri/src/dpi.rs). State и persistence реальные.
//
// Публичное API:
//   mountDpiView({ onToast, switchView, ensureElevated }) — навесить на DOM
//   prepareDpiVpnMode(mode) — fail-closed подготовка перед входом в TUN
//   setDpiVpnMode(mode, { reevaluate }) — синхронизировать режим VPN (TUN→пауза)
//   excludeVpnNode(host) — внести сервер активной ноды в exclude winws

import { loadOptions } from "/lib/options.js";
import { escapeAttr, escapeHtml as esc } from "/lib/esc.js";
import { a11ySwitchAll } from "/lib/switch-a11y.js";
import { t, getLang } from "/lib/i18n/index.js";
import { openConfirmModal } from "/lib/confirm-modal.js";
import { normalizeIp } from "/lib/routing-rules.js";
import { runtimeProbeProxyPort } from "/lib/runtime-lifecycle.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));
const tauriListen = window.__TAURI__?.event?.listen;

// Split-routing Discord разрешает оставить winws в TUN: он десинхрит
// direct-Discord на реальном интерфейсе (голос low-ping).
function splitDiscordAllowedInTun() {
  try {
    const options = loadOptions();
    return !options?.privacy?.strictTunnel
      && !!options?.route?.tunSplitDiscord;
  }
  catch { return false; }
}
function splitDiscordActive() {
  return S.vpnMode === "tun" && splitDiscordAllowedInTun();
}

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
  sliders:  '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
  trash:    '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 15H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
};
function ic(name, size = 16, stroke = 1.5) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${I[name] || ""}</svg>`;
}

/* ═══════════ DATA ═══════════ */
// Реальный список приходит из dpi_strategies() (strategies.json движка).
// Фолбэк — на случай web-preview / ошибки чтения.
const DEFAULT_STRATEGY = "ALT11";
let STRATEGIES = [{ id: "alt11", name: DEFAULT_STRATEGY, desc: "Самый стойкий профиль." }];
// Описания стратегий — данные из канала (по-русски), через t() НЕ идут. Для
// не-русского интерфейса прячем их, оставляя только имя стратегии (вариант B).
const stratDesc = (d) => (getLang() === "ru" && d ? esc(d) : "");
// Точный поиск — без фолбэка: он нужен, чтобы отличить «стратегия исчезла из
// набора» от «нашлась». stratByName с фолбэком оставлен для мест, где нужен
// гарантированно валидный объект.
const stratExact = (n) =>
  STRATEGIES.find((s) => s.name === n) || STRATEGIES.find((s) => s.id === n) || null;
const stratByName = (n) => stratExact(n) || STRATEGIES[0];
const autopickCount = () => STRATEGIES.filter((s) => !s.experimental).length;

// Какую стратегию помечать как рекомендованную и на каком основании.
// measured=true — это результат авто-подбора на сети пользователя; false —
// профиль по умолчанию, с которым приложение поставляется. Имя из прошлых
// замеров проверяем по текущему набору: канал мог его переименовать или убрать.
export function recommendedStrategy(strategies, stored) {
  const list = Array.isArray(strategies) ? strategies : [];
  const measured = list.find((s) => s.name === stored);
  if (measured) return { name: measured.name, measured: true };
  return { name: DEFAULT_STRATEGY, measured: false };
}

// kicker — декоративный английский (не локализуем); title/desc — через t() в рантайме.
const MASTER = {
  off:      { kicker: () => "OFF · STAND-BY",     icon: "dpi",
              title: () => t("dpi.master.offTitle"),      desc: () => t("dpi.master.offDesc") },
  starting: { kicker: () => "STARTING · WINWS",   icon: "dpi",
              title: () => t("dpi.master.startingTitle"), desc: (s) => t("dpi.master.startingDesc", { strat: esc(s) }) },
  running:  { kicker: (s) => "RUNNING · " + s,    icon: "dpi",
              title: () => t("dpi.master.runningTitle"),  desc: () => t("dpi.master.runningDesc") },
  error:    { kicker: () => "ERROR · DRIVER",     icon: "alert",
              title: () => t("dpi.master.errorTitle"),    desc: () => t("dpi.master.errorDesc") },
  paused:   { kicker: () => "PAUSED · TUN",       icon: "pause",
              title: () => t("dpi.master.pausedTitle"),   desc: () => t("dpi.master.pausedDesc") },
};

const modeTxt = () => ({ proxy: t("dpi.modeTxt.proxy"), systemProxy: t("dpi.modeTxt.systemProxy"), tun: t("dpi.modeTxt.tun") });
const chipStatus = () => ({ off: t("dpi.chip.off"), starting: t("dpi.chip.starting"), running: t("dpi.chip.running"), error: t("dpi.chip.error"), paused: t("dpi.chip.paused") });

/* ═══════════ STATE (persisted в localStorage) ═══════════ */
const LS = {
  enabled: "ninety.dpi.enabled",
  strategy: "ninety.dpi.strategy",
  gameFilter: "ninety.dpi.gameFilter",
  ipset: "ninety.dpi.ipset",
  monkey: "ninety.dpi.monkey",
  recommended: "ninety.dpi.recommended",
};
const lsGet = (k, d) => { const v = localStorage.getItem(k); return v == null ? d : v; };

const S = {
  base: "off",          // off | starting | running | error
  vpnMode: "systemProxy",
  strategy: lsGet(LS.strategy, DEFAULT_STRATEGY),
  gameFilter: lsGet(LS.gameFilter, "off"),
  ipset: lsGet(LS.ipset, "any"),
  monkey: lsGet(LS.monkey, "false") === "true",
  // Победитель последнего авто-подбора. Пусто — замеров ещё не было.
  recommended: lsGet(LS.recommended, ""),
  hasUpdate: false,
  lastError: "",
  versions: { app: "—", engine: "winws", strategies: "—" },
  domains: null,
  hosts: { applied: false, entries: 0, busy: false },
  ipsetList: { count: null, busy: false },
  ipsetOpen: false,
  fakes: {
    options: [],
    discord: null,
    game: null,
    discordSupported: false,
    gameSupported: false,
    busy: null,
  },
  cacheBusy: false,
  updateCheck: "idle", // idle | checking | ok | error
  updateError: "",
  autopick: { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" },
  updating: null,       // id строки, которая сейчас обновляется
};
let dpiOperationEpoch = 0;
let dpiAutopickEpoch = 0;

// В TUN весь трафик идёт через туннель → движок реально остановлен (pauseEngineForTun),
// но если DPI логически включён (LS.enabled) — показываем «На паузе», а не «Выключен»:
// при выходе из TUN он восстановится. Вне TUN — реальное состояние движка.
function effState() {
  if (S.base === "error") return "error";
  // В split-Discord движок реально работает и в TUN → отдаём реальное S.base.
  if (S.vpnMode === "tun" && !splitDiscordActive() && lsGet(LS.enabled, "false") === "true") return "paused";
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
  const rec = recommendedStrategy(STRATEGIES, S.recommended);
  const p = S.autopick;
  const dataBusy = p.phase === "running" || S.updating != null || S.fakes.busy != null;

  let banner = "";
  if (st === "paused") {
    banner = `<div class="dpi-banner" data-kind="paused">
      <span class="dpi-banner__icon">${ic("info", 16)}</span>
      <div>${t("dpi.banner.paused")}</div>
    </div>`;
  } else if (st === "error") {
    const reason = S.lastError
      ? esc(S.lastError.length > 400 ? S.lastError.slice(-400) : S.lastError)
      : t("dpi.banner.errorFallback");
    banner = `<div class="dpi-banner" data-kind="error">
      <span class="dpi-banner__icon">${ic("alert", 16)}</span>
      <div><b>${t("dpi.banner.errorTitle")}</b> <span style="white-space:pre-wrap;font-family:var(--font-mono);font-size:11px">${reason}</span></div>
      <button class="btn btn--sm dpi-banner__action" data-dpi-logs>${ic("terminal", 13)} ${t("dpi.banner.openLogs")}</button>
    </div>`;
  }

  let autopick = "";
  if (p.phase === "idle") {
    autopick = `<div class="dpi-autopick__lead">${t("dpi.autopick.lead", { n: autopickCount() })}</div>
      <div class="dpi-autopick__actions"><button class="btn btn--primary btn--sm" data-dpi-pick-start ${dataBusy || S.vpnMode === "tun" ? "disabled" : ""}>${ic("target", 13)} ${t("dpi.autopick.start")}</button></div>`;
  } else if (p.phase === "running") {
    const total = p.total || autopickCount();
    const pct = total ? (p.i / total * 100).toFixed(1) : 0;
    autopick = `<div class="dpi-autopick__prog">
        <div class="dpi-autopick__prog-top"><span class="dpi-autopick__prog-now">${t("dpi.autopick.checking", { name: esc(p.name || "…") })}</span></div>
        <div class="dpi-bar"><span class="dpi-bar__fill" style="width:${pct}%"></span></div>
        <div class="dpi-autopick__candidate">${t("dpi.autopick.progLine", { i: p.i, total })}</div>
        <div class="dpi-autopick__actions"><button class="btn btn--sm" data-dpi-pick-cancel>${t("dpi.editor.cancel")}</button></div>
      </div>`;
  } else if (p.phase === "done") {
    autopick = `<div class="dpi-result">
        <span class="dpi-result__icon">${ic("check", 18)}</span>
        <div class="dpi-result__main"><div class="dpi-result__label">${t("dpi.autopick.recommended")}</div><div class="dpi-result__name">${esc(p.best || "—")}</div></div>
        <div class="dpi-result__meta">${esc(p.meta || "")}</div>
      </div>
      <div class="dpi-autopick__actions">
        ${p.best ? `<button class="btn btn--primary btn--sm" data-dpi-pick-apply="${escapeAttr(p.best)}">${ic("check", 13)} ${esc(t("dpi.autopick.apply", { name: p.best }))}</button>` : ""}
        <button class="btn btn--sm" data-dpi-pick-start>${t("dpi.autopick.again")}</button>
      </div>`;
  }

  const UPD = [
    { id: "app", name: t("dpi.updates.appName"), ver: `Ninety ${S.versions.app}`, icon: "box", upd: false },
    { id: "engine", name: t("dpi.updates.engineName"), ver: S.versions.engine, icon: "cpu", upd: false, note: t("dpi.updates.engineNote") },
    { id: "strategies", name: t("dpi.updates.strategiesName"), ver: `v${S.versions.strategies}`, icon: "list", upd: S.hasUpdate },
  ];
  const updRows = UPD.map((row) => {
    const isUpd = S.updating === row.id;
    let right;
    if (row.id === "strategies" && S.updateCheck === "checking") {
      right = `<span class="dpi-pill" data-kind="idle">${t("dpi.updates.pillChecking")}</span>`;
    } else if (row.id === "strategies" && S.updateCheck === "error") {
      right = `<span class="dpi-pill" data-kind="update" title="${escapeAttr(S.updateError)}">${t("dpi.updates.pillUnknown")}</span>
        <button class="btn btn--sm" data-dpi-update-check>${t("dpi.updates.btnRetry")}</button>`;
    } else if (row.upd) {
      right = `<span class="dpi-pill" data-kind="update">${t("dpi.updates.pillUpdate")}</span>
        <button class="btn btn--sm btn--primary" data-dpi-update="${escapeAttr(row.id)}" ${dataBusy ? "disabled" : ""}>${isUpd ? "…" : esc(t("dpi.updates.btnUpdate"))}</button>`;
    } else {
      right = `<span class="dpi-pill" data-kind="ok">${row.note || t("dpi.updates.pillOk")}</span>`;
    }
    return `<div class="dpi-upd-row" data-updating="${isUpd}">
        <span class="dpi-upd-row__icon">${ic(row.icon, 15)}</span>
        <div class="dpi-upd-row__main"><span class="dpi-upd-row__name">${row.name}</span><span class="dpi-upd-row__ver">${esc(row.ver)}</span></div>
        <div class="dpi-upd-row__right">${right}</div>
        <span class="dpi-upd-row__bar"></span>
      </div>`;
  }).join("");

  const ipsetHint = { any: t("dpi.ipset.hintAny"), loaded: t("dpi.ipset.hintLoaded"), off: t("dpi.ipset.hintOff") }[S.ipset];
  const domainsTxt = S.domains == null ? "…" : S.domains.toLocaleString("ru-RU");
  const fakeOptions = (kind) => {
    const current = S.fakes[kind];
    const options = S.fakes.options.map((file) =>
      `<option value="${escapeAttr(file)}" ${file === current ? "selected" : ""}>${esc(file)}</option>`).join("");
    const fallback = current
      ? ""
      : `<option value="" selected disabled>${t("dpi.fakes.default")}</option>`;
    return fallback + options;
  };
  const fakeDisabled = (kind) =>
    !S.fakes[`${kind}Supported`] || !S.fakes.options.length || dataBusy;

  body.innerHTML = `
    ${banner}
    <article class="dpi-master" data-state="${st}">
      <div class="dpi-master__glow"></div>
      <div class="dpi-master__icon">${ic(m.icon, 24)}</div>
      <div class="dpi-master__main">
        <div class="dpi-master__kicker"><span class="dpi-master__dot"></span><span>${esc(m.kicker(S.strategy))}</span></div>
        <h3 class="dpi-master__title">${m.title()}</h3>
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
            <div class="dpi-card__label">${ic("shield", 13)}${t("dpi.strategy.label")}</div>
            <button class="btn btn--sm" data-dpi-drawer>${ic("sliders", 13)} ${t("dpi.strategy.drawerBtn")}</button>
          </div>
          <div class="dpi-strategy">
            <div class="dpi-strategy__row">
              <span class="dpi-strategy__name">${esc(cur.name)}</span>
              ${cur.name === rec.name ? `<span class="dpi-strategy__tag">${t(rec.measured ? "dpi.strategy.recTagMeasured" : "dpi.strategy.recTag")}</span>` : ""}
            </div>
            <div class="dpi-strategy__desc">${stratDesc(cur.desc)}</div>
          </div>
        </article>

        <article class="dpi-card dpi-autopick">
          <div class="dpi-card__head">
            <div class="dpi-card__label">${ic("target", 13)}${t("dpi.autopick.cardLabel")}</div>
            ${p.phase === "running" ? `<span class="dpi-autopick__prog-count">${p.i} / ${p.total || autopickCount()}</span>` : ""}
          </div>
          ${autopick}
        </article>

        <article class="dpi-card">
          <div class="dpi-row">
            <div class="dpi-row__lbl">
              <div class="dpi-row__t">${t("dpi.game.title")}</div>
              <div class="dpi-row__d">${t("dpi.game.desc")}</div>
            </div>
            <div class="seg">
              <button class="seg__btn" data-on="${S.gameFilter === "off"}" data-dpi-game="off">${t("dpi.game.off")}</button>
              <button class="seg__btn" data-on="${S.gameFilter === "tcpudp"}" data-dpi-game="tcpudp">${t("dpi.game.tcpudp")}</button>
            </div>
          </div>
        </article>

        <article class="dpi-card dpi-fakes">
          <div class="dpi-card__head">
            <div class="dpi-card__label">${ic("sliders", 13)}${t("dpi.fakes.label")}</div>
          </div>
          <div class="dpi-row__d" style="max-width:none">${t("dpi.fakes.desc")}</div>
          <label class="dpi-fake-row">
            <span class="dpi-fake-row__label">${t("dpi.fakes.discord")}</span>
            <select class="dpi-fake-select" data-dpi-fake="discord" ${fakeDisabled("discord") ? "disabled" : ""}>
              ${fakeOptions("discord")}
            </select>
          </label>
          <label class="dpi-fake-row">
            <span class="dpi-fake-row__label">${t("dpi.fakes.game")}</span>
            <select class="dpi-fake-select" data-dpi-fake="game" ${fakeDisabled("game") ? "disabled" : ""}>
              ${fakeOptions("game")}
            </select>
          </label>
          ${(!S.fakes.discordSupported || !S.fakes.gameSupported)
            ? `<div class="dpi-fakes__hint">${t("dpi.fakes.unavailable")}</div>`
            : ""}
        </article>

        <article class="dpi-card dpi-hosts">
          <div class="dpi-card__head">
            <div class="dpi-card__label">${ic("box", 13)}${t("dpi.hosts.label")}</div>
            <span class="dpi-pill" data-kind="${S.hosts.applied ? "ok" : "idle"}">${S.hosts.applied ? t("dpi.hosts.applied") : t("dpi.hosts.notApplied")}</span>
          </div>
          <div class="dpi-row__d" style="max-width:none">${t("dpi.hosts.desc")}</div>
          <div class="dpi-hosts__row">
            <div class="dpi-hosts__stat"><span class="dpi-hosts__num tnum">${S.hosts.applied ? S.hosts.entries.toLocaleString("ru-RU") : "—"}</span><span class="dpi-hosts__unit">${S.hosts.applied ? t("dpi.hosts.unitActive") : t("dpi.hosts.unitInactive")}</span></div>
            <div class="dpi-hosts__actions">
              <button class="btn btn--sm btn--primary" data-dpi-hosts-apply ${S.hosts.busy ? "disabled" : ""}>${S.hosts.busy ? "…" : S.hosts.applied ? t("dpi.hosts.update") : t("dpi.hosts.apply")}</button>
              ${S.hosts.applied ? `<button class="btn btn--sm" data-dpi-hosts-clear ${S.hosts.busy ? "disabled" : ""}>${t("dpi.hosts.clear")}</button>` : ""}
            </div>
          </div>
        </article>
      </div>

      <div class="dpi-col">
        <article class="dpi-card dpi-vpn">
          <div class="dpi-card__head">
            <div class="dpi-card__label">${ic("link", 13)}${t("dpi.vpn.label")}</div>
            <div class="dpi-vpn__mode" data-tun="${S.vpnMode === "tun"}"><span class="dpi-vpn__mode-dot"></span>${modeTxt()[S.vpnMode] || modeTxt().systemProxy}</div>
          </div>
          <div class="dpi-row__d" style="max-width:none">${S.vpnMode === "tun"
            ? t("dpi.vpn.descTun")
            : t("dpi.vpn.descOther")}</div>
        </article>

        <article class="dpi-card">
          <div class="dpi-card__head"><div class="dpi-card__label">${ic("list", 13)}${t("dpi.domains.label")}</div></div>
          <div class="dpi-domains__count"><span class="dpi-domains__num tnum">${domainsTxt}</span><span class="dpi-domains__unit">${t("dpi.domains.unit")}</span></div>
          <div class="dpi-domains__actions">
            <button class="btn btn--sm" data-dpi-domains="user">${t("dpi.domains.user")}</button>
            <button class="btn btn--sm" data-dpi-domains="exclude">${t("dpi.domains.exclude")}</button>
          </div>
        </article>

        <article class="dpi-card dpi-updates">
          <div class="dpi-card__head"><div class="dpi-card__label">${ic("download", 13)}${t("dpi.updates.label")}</div></div>
          <div class="dpi-upd">${updRows}</div>
        </article>

        <article class="dpi-card dpi-cache">
          <div class="dpi-card__head">
            <div class="dpi-card__label">${ic("trash", 13)}${t("dpi.cache.label")}</div>
          </div>
          <div class="dpi-row__d" style="max-width:none">${t("dpi.cache.desc")}</div>
          <div class="dpi-cache__actions">
            <button class="btn btn--sm" data-dpi-cache-clear ${S.cacheBusy ? "disabled" : ""}>
              ${ic("trash", 13)} ${S.cacheBusy ? t("dpi.cache.busy") : t("dpi.cache.button")}
            </button>
          </div>
        </article>

        <article class="dpi-card dpi-ipset" data-open="${S.ipsetOpen}">
          <div class="dpi-ipset__head" data-dpi-ipset-toggle>
            <div class="dpi-row__lbl"><div class="dpi-row__t">${t("dpi.ipset.label")}</div><div class="dpi-row__d">${t("dpi.ipset.desc")}</div></div>
            <span class="dpi-ipset__chev">${ic("chevron", 16)}</span>
          </div>
          <div class="dpi-ipset__body"><div class="dpi-ipset__inner"><div class="dpi-ipset__pad">
            <div class="seg">
              <button class="seg__btn" data-on="${S.ipset === "any"}" data-dpi-ipset="any">${t("dpi.ipset.any")}</button>
              <button class="seg__btn" data-on="${S.ipset === "loaded"}" data-dpi-ipset="loaded">${t("dpi.ipset.loaded")}</button>
              <button class="seg__btn" data-on="${S.ipset === "off"}" data-dpi-ipset="off">${t("dpi.ipset.off")}</button>
            </div>
            <div class="dpi-row__d" style="max-width:none">${ipsetHint}</div>
            <div class="dpi-ipset__upd">
              <div class="dpi-ipset__upd-info">
                <span class="dpi-ipset__upd-t">${t("dpi.ipset.listLabel")}</span>
                <span class="dpi-ipset__upd-c">${S.ipsetList.count == null ? "—" : S.ipsetList.count.toLocaleString("ru-RU") + " " + t("dpi.ipset.unit")}</span>
              </div>
              <button class="btn btn--sm" data-dpi-ipset-update ${S.ipsetList.busy ? "disabled" : ""}>${ic("download", 13)} ${S.ipsetList.busy ? "…" : t("dpi.ipset.update")}</button>
            </div>
          </div></div></div>
        </article>

        <article class="dpi-card">
          <div class="dpi-row">
            <div class="dpi-row__lbl">
              <div class="dpi-row__t">${t("dpi.monkey.title")}</div>
              <div class="dpi-row__d">${t("dpi.monkey.desc")}</div>
            </div>
            <span class="switch" data-on="${S.monkey}" data-dpi-monkey role="switch" aria-checked="${S.monkey}"></span>
          </div>
        </article>
      </div>
    </div>`;
  a11ySwitchAll(body);
}

function renderChip() {
  const slot = document.getElementById("dpi-chip-slot");
  if (!slot) return;
  const st = effState();
  const switchOn = st === "running" || st === "starting";
  slot.innerHTML = `<button class="dpi-chip" data-state="${escapeAttr(st)}" data-dpi-open title="${escapeAttr(t("dpi.chip.open"))}">
      <span class="dpi-chip__icon">${ic("dpi", 16)}</span>
      <span class="dpi-chip__txt">
        <span class="dpi-chip__status">DPI · ${chipStatus()[st]}</span>
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

// Живой ре-рендер при смене языка (зовётся из onLangChange в main.js).
export function rerenderDpiView() { renderAll(); }

// Сообщить остальному приложению (трею), что DPI-обход вкл/выкл изменился.
function emitDpiChanged() {
  try { window.dispatchEvent(new CustomEvent("ninety:dpi-changed")); } catch {}
}

/* ═══════════ ACTIONS (реальный движок) ═══════════ */
async function startEngine() {
  const epoch = ++dpiOperationEpoch;
  S.base = "starting";
  renderAll();
  S.lastError = "";
  try {
    await invoke("dpi_start", { strategyId: stratByName(S.strategy).id, gameFilter: S.gameFilter, ipset: S.ipset, monkey: S.monkey, logsDisabled: !!loadOptions()?.log?.disabled });
    if (epoch !== dpiOperationEpoch) return false;
    S.base = "running";
    localStorage.setItem(LS.enabled, "true");
    emitDpiChanged();
    renderAll();
    return true;
  } catch (e) {
    if (epoch !== dpiOperationEpoch) return false;
    S.base = "error";
    S.lastError = String(e?.message || e);
    toast(t("dpi.toast.startFail"), "error", 5000);
    renderAll();
    return false;
  }
}

function reportDpiRuntimeError(error) {
  S.base = "error";
  S.lastError = String(error?.message || error);
  toast(t("prof.toastErr", { err: S.lastError }), "error", 5000);
  renderAll();
}

async function stopDpiRuntime({ disableDesired = false, markOff = true } = {}) {
  dpiOperationEpoch++;
  try {
    await invoke("dpi_stop");
  } catch (e) {
    reportDpiRuntimeError(e);
    return false;
  }
  if (markOff) S.base = "off";
  S.lastError = "";
  if (disableDesired) {
    localStorage.setItem(LS.enabled, "false");
    emitDpiChanged();
  }
  renderAll();
  return true;
}

async function stopEngine() {
  return stopDpiRuntime({ disableDesired: true });
}

// Пауза движка при входе в TUN: реально глушим winws, НО LS.enabled оставляем
// "true" — это «логическое желание», по которому восстановимся при выходе.
// Пауза и возврат движка идут по одной очереди. Без неё быстрый цикл
// «выключить split → включить обратно» разъезжался: resume проверяет S.base, а
// stopDpiRuntime ставит "off" только ПОСЛЕ await, поэтому второй вызов видел
// ещё живой процесс, выходил с успехом, а первый следом гасил winws — split
// оставался включённым в настройках при выключенном движке.
let dpiModeQueue = Promise.resolve(true);
function queueDpiModeChange(run) {
  const next = dpiModeQueue.then(run, run);
  dpiModeQueue = next.catch(() => false);
  return next;
}

async function pauseEngineForTun() {
  return stopDpiRuntime();
}

// Возврат из TUN: поднять движок, если DPI был включён до паузы. Процесс в этот
// момент уже elevated (TUN требовал прав), поэтому UAC обычно не всплывёт.
let dpiResumeInFlight = null;
async function resumeEngineAfterTun() {
  if (lsGet(LS.enabled, "false") !== "true") return true;
  if (S.base === "running" || S.base === "starting") return true;
  if (dpiResumeInFlight) return dpiResumeInFlight;
  const run = (async () => {
    const ok = await ensureElevated();
    // Пока ждали UAC, strict/split или пользовательское намерение могли
    // измениться. Повторная проверка не даёт позднему resume запустить winws
    // в обычном TUN и одновременно закрывает двойной dpi_start.
    if (!ok) return false;
    if (lsGet(LS.enabled, "false") !== "true") return true;
    if (S.base === "running" || S.base === "starting") return true;
    if (S.vpnMode === "tun" && !splitDiscordActive()) return true;
    return startEngine();
  })();
  dpiResumeInFlight = run;
  try {
    return await run;
  } finally {
    if (dpiResumeInFlight === run) dpiResumeInFlight = null;
  }
}

export async function toggleDpi() {
  // В TUN движок на паузе — тоггл меняет лишь «хотим ли DPI после выхода из TUN».
  // Исключение — split-Discord: там движок реально работает в TUN, тоггл = старт/стоп.
  if (S.vpnMode === "tun" && !splitDiscordActive()) {
    const want = lsGet(LS.enabled, "false") !== "true";
    localStorage.setItem(LS.enabled, want ? "true" : "false");
    emitDpiChanged();
    renderAll();
    toast(want ? t("dpi.toast.willEnable") : t("dpi.toast.disabled"), "info", 2200);
    return;
  }
  // После неподтверждённого stop backend сохраняет живой child, а UI находится
  // в error. Повторный клик должен ещё раз остановить его, а не запускать второй
  // winws поверх первого. Ошибка старта, напротив, не выставляет desired=true.
  if (S.base === "error" && lsGet(LS.enabled, "false") === "true") {
    await stopEngine();
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
  if (S.vpnMode === "tun" && !splitDiscordActive()) return; // в TUN без split обход на паузе
  try { if (await invoke("dpi_running")) { S.base = "running"; renderAll(); return; } } catch {}
  const ok = await ensureElevated();
  if (!ok) return;
  await startEngine();
}

// Применить смену настройки на лету: если движок запущен — перезапустить.
async function restartIfRunning() {
  if (S.base === "running" || S.base === "starting") {
    if (!(await stopDpiRuntime())) return false;
    return startEngine();
  }
  return true;
}

// Смена режима драйвера (WinDivert↔Monkey): меняется имя kernel-службы и файла
// .sys → перед стартом нового надо снять уже загруженный драйвер старого имени,
// иначе в ядре повиснут обе службы. Аппа elevated (DPI запущен) → dpi_unload_driver
// снимает WinDivert/WinDivert14/Monkey. Если выключен — просто применится при старте.
async function restartWithDriverSwap() {
  if (S.base !== "running" && S.base !== "starting") return true;
  if (!(await stopDpiRuntime())) return false;
  try {
    await invoke("dpi_unload_driver");
  } catch (e) {
    reportDpiRuntimeError(e);
    return false;
  }
  return startEngine();
}

async function setStrategy(s) {
  S.strategy = s.name;
  localStorage.setItem(LS.strategy, s.name);
  renderAll();
  await restartIfRunning();
  toast(t("dpi.toast.strategy", { name: s.name }), "info", 1600);
}

async function loadStrategies() {
  try {
    const raw = await invoke("dpi_strategies");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) STRATEGIES = arr;
    // Канал мог переименовать или убрать стратегию. Чинить надо ИМЕННО здесь и
    // сохранять в localStorage: чип и кикер печатают сырое S.strategy, а
    // dpi_start уходит с id фолбэка — иначе на экране два разных имени, а
    // запускается то, которое пользователь не выбирал. Раньше условие было
    // написано через stratByName, у которого фолбэк на STRATEGIES[0], поэтому
    // оно никогда не срабатывало.
    if (!stratExact(S.strategy)) {
      S.strategy = STRATEGIES[0].name;
      try { localStorage.setItem(LS.strategy, S.strategy); } catch {}
    }
  } catch {}
}

async function loadVersions() {
  try { S.versions = await invoke("dpi_versions"); } catch {}
}
async function loadDomains() {
  try { S.domains = await invoke("dpi_domains_count"); } catch { S.domains = 0; }
}
async function loadFakePayloads() {
  try {
    const r = await invoke("dpi_fake_payloads");
    S.fakes.options = Array.isArray(r?.options) ? r.options : [];
    S.fakes.discord = r?.discord || null;
    S.fakes.game = r?.game || null;
    S.fakes.discordSupported = !!r?.discord_supported;
    S.fakes.gameSupported = !!r?.game_supported;
  } catch {
    S.fakes.options = [];
    S.fakes.discordSupported = false;
    S.fakes.gameSupported = false;
  }
}

let updateCheckPromise = null;
let lastUpdateCheckAt = 0;
async function checkUpdate(force = false) {
  // port>0 при активном VPN (proxy/systemProxy) → проверка версии канала идёт
  // через туннель: version.txt на github, из РФ напрямую режется ТСПУ.
  if (updateCheckPromise) return updateCheckPromise;
  if (!force && lastUpdateCheckAt && Date.now() - lastUpdateCheckAt < 60_000) return;
  S.updateCheck = "checking";
  S.updateError = "";
  renderAll();
  const run = (async () => {
    try {
      const r = await invoke("dpi_check_update", { port: await listFetchPort() });
      S.hasUpdate = !!r?.available;
      S.updateCheck = "ok";
    } catch (e) {
      S.hasUpdate = false;
      S.updateCheck = "error";
      S.updateError = String(e?.message || e);
    }
  })();
  updateCheckPromise = run;
  try {
    await run;
  } finally {
    if (updateCheckPromise === run) updateCheckPromise = null;
    lastUpdateCheckAt = Date.now();
    renderAll();
  }
}

async function setActiveFake(kind, file) {
  if (!file || S.fakes.busy || S.autopick.phase === "running" || S.updating) return;
  S.fakes.busy = kind;
  renderBody();
  try {
    await invoke("dpi_set_active_fake", { kind, file });
    S.fakes[kind] = file;
    await restartIfRunning();
    toast(t("dpi.fakes.toastDone"), "info", 2000);
  } catch (e) {
    await loadFakePayloads();
    toast(t("dpi.fakes.toastErr", { err: e?.message || e }), "error", 4000);
  }
  S.fakes.busy = null;
  renderAll();
}

async function clearDiscordCache() {
  if (S.cacheBusy) return;
  const ok = await openConfirmModal({
    title: t("dpi.cache.confirmTitle"),
    message: t("dpi.cache.confirmMessage"),
    confirmLabel: t("dpi.cache.confirmButton"),
    cancelLabel: t("dpi.editor.cancel"),
    danger: true,
  });
  if (!ok) return;
  S.cacheBusy = true;
  renderBody();
  try {
    const r = await invoke("discord_cache_clear");
    if ((r?.clients_found || 0) === 0) {
      toast(t("dpi.cache.toastNone"), "info", 2200);
    } else {
      toast(t("dpi.cache.toastDone", { n: r?.dirs_removed || 0 }), "info", 2600);
    }
  } catch (e) {
    toast(t("dpi.cache.toastErr", { err: e?.message || e }), "error", 4500);
  }
  S.cacheBusy = false;
  renderAll();
}
async function loadHosts() {
  try { const r = await invoke("dpi_hosts_status"); S.hosts.applied = !!r?.applied; S.hosts.entries = r?.entries || 0; } catch {}
}
async function loadIpsetCount() {
  try { S.ipsetList.count = await invoke("dpi_ipset_count"); } catch { S.ipsetList.count = null; }
}

// Порт для загрузки списков (hosts/ipset): mixed-inbound (трафик через обход),
// если VPN активен в proxy/systemProxy; 0 = прямой запрос (TUN — трафик и так в
// туннеле, либо VPN выключен). Прямой запрос к github raw из РФ режется ТСПУ,
// поэтому при активном обходе тянем через прокси; Rust сам падает на direct, если
// прокси молчит.
async function listFetchPort() {
  if (S.vpnMode === "tun") return 0;
  // Порт берём у ЖИВОГО runtime, а не из настроек: `inbound.mixedPort` меняют
  // без реконнекта, и тогда запрос уходил в порт, которого ядро не слушает —
  // оставался только прямой путь, ровно тот, который и режут.
  try { return runtimeProbeProxyPort(await invoke("runtime_snapshot")); }
  catch { return 0; }
}

/* ── Файл hosts (правка системного hosts — нужны админ-права) ── */
async function applyHosts() {
  const ok = await ensureElevated();
  if (!ok) return; // идёт перезапуск с UAC или отказ
  S.hosts.busy = true; renderBody();
  try {
    const r = await invoke("dpi_hosts_apply", { port: await listFetchPort() });
    S.hosts.applied = true; S.hosts.entries = r?.entries || 0;
    toast(t("dpi.hosts.toastApplied", { n: S.hosts.entries.toLocaleString("ru-RU") }), "info", 2400);
  } catch (e) {
    toast(t("dpi.hosts.toastErr", { err: e?.message || e }), "error", 4500);
  }
  S.hosts.busy = false; renderBody();
}
async function clearHosts() {
  const ok = await ensureElevated();
  if (!ok) return;
  S.hosts.busy = true; renderBody();
  try {
    await invoke("dpi_hosts_clear");
    S.hosts.applied = false; S.hosts.entries = 0;
    toast(t("dpi.hosts.toastCleared"), "info", 1800);
  } catch (e) {
    toast(t("dpi.hosts.toastErr", { err: e?.message || e }), "error", 4500);
  }
  S.hosts.busy = false; renderBody();
}

/* ── Обновление базы ipset (пишется в app_data — без админ-прав) ── */
async function updateIpset() {
  S.ipsetList.busy = true; renderBody();
  try {
    const n = await invoke("dpi_update_ipset", { port: await listFetchPort() });
    S.ipsetList.count = n;
    toast(t("dpi.ipset.toastDone", { n: n.toLocaleString("ru-RU") }), "info", 2400);
    if (S.ipset === "loaded") await restartIfRunning(); // применить свежий набор к winws
  } catch (e) {
    toast(t("dpi.ipset.toastErr", { err: e?.message || e }), "error", 4500);
  }
  S.ipsetList.busy = false; renderBody();
}

async function runUpdate(id) {
  if (id !== "strategies" || S.autopick.phase === "running" || S.fakes.busy) return;
  S.updating = id;
  renderBody();
  try {
    // Канал данных: стратегии + списки + .bin одним подписанным бандлом
    // (подпись проверяется в Rust до применения). Версия — тег Flowseal.
    // port>0 при активном VPN → бандл тянется через туннель (github + ТСПУ).
    const r = await invoke("dpi_sync_channel", { port: await listFetchPort() });
    if (r?.version) S.versions.strategies = r.version;
    S.hasUpdate = false;
    S.updateCheck = "ok";
    await loadStrategies(); // перечитать обновлённые определения стратегий
    await loadFakePayloads();
    await loadVersions();
    await loadDomains();
    await restartIfRunning(); // применить свежий набор к запущенному winws
    const reset = Array.isArray(r?.fake_selection_reset)
      ? r.fake_selection_reset.filter((kind) => kind === "discord" || kind === "game")
      : [];
    if (reset.length) {
      const slots = reset.map((kind) => t(`dpi.fakes.${kind}`)).join(", ");
      toast(t("dpi.fakes.toastReset", { slots }), "info", 3600);
    } else {
      toast(t("dpi.updates.toastDone"), "info", 1800);
    }
  } catch (e) {
    toast(t("dpi.updates.toastErr", { err: e?.message || e }), "error", 3500);
  }
  S.updating = null;
  renderAll();
}

/* ── Авто-подбор ── */
// Прогон физически глушит текущий winws и поднимает по одному на стратегию.
// Пока он идёт, движок выключен — состояние возвращаем сами, иначе чип врёт, а
// «Применить» не перезапустит движок, считая его живым.
let autopickResume = false;

async function restoreEngineAfterAutopick() {
  if (!autopickResume) return;
  autopickResume = false;
  S.base = "off";
  await startEngine();
}

async function pickStart() {
  if (S.autopick.phase === "running" || S.updating || S.fakes.busy) return;
  // В TUN пробы уходят в туннель: «прошли» получат все стратегии подряд, а
  // рекомендация будет случайной. Мерить можно только на реальном интерфейсе.
  if (S.vpnMode === "tun") { toast(t("dpi.autopick.toastTun"), "warn", 5200); return; }
  const epoch = ++dpiAutopickEpoch;
  autopickResume = S.base === "running" || S.base === "starting";
  if (autopickResume) S.base = "off";
  S.autopick = { phase: "running", i: 0, total: autopickCount(), name: "", best: null, meta: "" };
  renderAll();
  const ok = await ensureElevated();
  if (!ok || epoch !== dpiAutopickEpoch) { S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" }; autopickResume = false; return; }
  try {
    const r = await invoke("dpi_autotest", { monkey: S.monkey, logsDisabled: !!loadOptions()?.log?.disabled });
    if (epoch !== dpiAutopickEpoch) return;
    // Движок, не поднявшийся из-за гонки за драйвер, — это не «стратегия не
    // работает». Считаем отдельно и говорим отдельно, иначе цифра врёт.
    const engineNote = r?.engine_failed
      ? " · " + t("dpi.autopick.metaEngine", { n: r.engine_failed })
      : "";
    if (r?.best_id) {
      const best = STRATEGIES.find((s) => s.id === r.best_id);
      // Замер важнее дефолта: бейдж «рекоменд.» с этого момента стоит на том,
      // что реально открылось на этой сети, а не на профиле из коробки.
      S.recommended = best?.name || r.best_name || "";
      localStorage.setItem(LS.recommended, S.recommended);
      // passed — сколько стратегий открыли ВСЕ проверки. Если таких нет, но
      // рекомендация есть, она частичная, и написать «0 из 20 прошли» нельзя.
      const meta = r.passed > 0
        ? t("dpi.autopick.metaOk", { passed: r.passed, total: r.total, ms: r.latency_ms })
        : t("dpi.autopick.metaPartial", { covered: r.best_targets, targets: r.targets });
      S.autopick = {
        phase: "done", i: r.total, total: r.total,
        best: best?.name || r.best_name,
        meta: meta + engineNote,
      };
    } else {
      // Прогон не нашёл ничего — прошлая рекомендация больше не подтверждена,
      // держать её на карточке нельзя. Возвращаемся к профилю по умолчанию.
      S.recommended = "";
      localStorage.removeItem(LS.recommended);
      S.autopick = { phase: "done", i: r?.total || 0, total: r?.total || 0, best: null, meta: t("dpi.autopick.metaNone") + engineNote };
    }
  } catch (e) {
    if (epoch !== dpiAutopickEpoch) return;
    S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" };
    toast(t("dpi.autopick.toastErr", { err: e?.message || e }), "error", 3500);
  }
  await restoreEngineAfterAutopick();
  renderAll();
}

async function pickCancel() {
  dpiAutopickEpoch++;
  // Стоп не подтверждён — winws может быть ещё жив, поднимать второй нельзя.
  if (!(await stopDpiRuntime({ markOff: false }))) { autopickResume = false; return; }
  S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" };
  await restoreEngineAfterAutopick();
  renderAll();
}

async function pickApply(name) {
  const s = stratByName(name);
  S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" };
  await setStrategy(s);
  // Если движок не работает — поднимаем его с выбранной стратегией. Именно
  // поднимаем, а не «переключаем»: toggleDpi в состоянии error при desired=true
  // трактует клик как «останови застрявший процесс», и «Применить» после
  // авто-подбора выключало обход вместо запуска.
  if (S.base === "off" || S.base === "error") {
    if (S.vpnMode === "tun" && !splitDiscordActive()) {
      // В TUN движок на паузе — фиксируем намерение, как это делает toggleDpi.
      localStorage.setItem(LS.enabled, "true");
      emitDpiChanged();
      renderAll();
      toast(t("dpi.toast.willEnable"), "info", 2200);
      return;
    }
    if (S.base === "error" && lsGet(LS.enabled, "false") === "true") {
      // Прошлый stop не подтвердился — сначала честно останавливаем, потом
      // стартуем заново уже с новой стратегией.
      if (!(await stopDpiRuntime())) return;
    }
    const ok = await ensureElevated();
    if (!ok) return;
    await startEngine();
  }
}

/* ═══════════ STRATEGY DRAWER (динамический) ═══════════ */
let drawerEl = null;
function openDrawer() {
  if (drawerEl) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="drawer-bg" data-dpi-drawer-bg></div>
    <aside class="drawer" role="dialog" aria-label="${escapeAttr(t("dpi.drawer.aria"))}">
      <div class="drawer__head">
        <div><div class="drawer__kicker">PICK A STRATEGY · WINWS</div><div class="drawer__title">${t("dpi.drawer.title")}</div></div>
        <button class="drawer__close" data-dpi-drawer-close aria-label="${escapeAttr(t("dpi.drawer.close"))}">${ic("close", 16)}</button>
      </div>
      <div class="drawer__search">${ic("search", 14)}<input type="text" id="dpi-strat-search" placeholder="${escapeAttr(t("dpi.drawer.search"))}" autocomplete="off"></div>
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
  list.innerHTML = `<div class="drawer__section"><span>${t("dpi.drawer.count", { n: filtered.length })}</span><span>${t("dpi.drawer.activeMarked")}</span></div>` +
    filtered.map((s) => `<div class="strat" data-active="${s.id === cur.id}" data-dpi-strat="${escapeAttr(s.id)}">
        <div class="strat__main"><div class="strat__name">${esc(s.name)}</div><div class="strat__desc">${stratDesc(s.desc)}</div></div>
        <span class="strat__check">${ic("check", 11, 2.5)}</span>
      </div>`).join("");
}

/* ═══════════ DOMAIN LIST EDITOR (динамический) ═══════════ */
let editorEl = null;
// kicker — декоративный английский; title/hint — через t(). file — имя на диске.
function editorMeta(kind) {
  const map = {
    user:    { kicker: "MY DOMAINS · HOSTLIST", title: t("dpi.editor.userTitle"),
               hint: t("dpi.editor.userHint"), file: "list-general-user.txt" },
    exclude: { kicker: "EXCLUDE · BYPASS WINWS", title: t("dpi.editor.excludeTitle"),
               hint: t("dpi.editor.excludeHint"), file: "list-exclude-user.txt" },
  };
  return map[kind] || map.user;
}

async function openListEditor(kind) {
  if (editorEl) return;
  const meta = editorMeta(kind);
  let content = "";
  try { content = await invoke("dpi_read_list", { kind }); } catch {}
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="drawer-bg" data-dpi-editor-bg></div>
    <aside class="drawer drawer--editor" role="dialog" aria-label="${esc(meta.title)}">
      <div class="drawer__head">
        <div><div class="drawer__kicker">${esc(meta.kicker)}</div><div class="drawer__title">${esc(meta.title)}</div></div>
        <button class="drawer__close" data-dpi-editor-close aria-label="${escapeAttr(t("dpi.editor.close"))}">${ic("close", 16)}</button>
      </div>
      <div class="dpi-editor">
        <div class="dpi-editor__hint">${esc(meta.hint)}</div>
        <textarea class="dpi-editor__area" id="dpi-editor-area" spellcheck="false" autocomplete="off"
          placeholder="discord.com&#10;gateway.discord.gg&#10;youtube.com">${esc(content)}</textarea>
        <div class="dpi-editor__foot">
          <span class="dpi-editor__file">${esc(meta.file)}</span>
          <div class="dpi-editor__actions">
            <button class="btn btn--sm" data-dpi-editor-close>${t("dpi.editor.cancel")}</button>
            <button class="btn btn--sm btn--primary" data-dpi-editor-save="${escapeAttr(kind)}">${ic("check", 13)} ${t("dpi.editor.save")}</button>
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
    toast(kind === "exclude" ? t("dpi.editor.toastExclude") : t("dpi.editor.toastUser"), "info", 1800);
  } catch (e) {
    toast(t("dpi.editor.toastErr", { err: e?.message || e }), "error", 3500);
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
  if (t.closest("[data-dpi-pick-cancel]")) { pickCancel(); return; }
  const apply = t.closest("[data-dpi-pick-apply]");
  if (apply) { pickApply(apply.dataset.dpiPickApply); return; }
  const game = t.closest("[data-dpi-game]");
  if (game) { S.gameFilter = game.dataset.dpiGame; localStorage.setItem(LS.gameFilter, S.gameFilter); renderBody(); restartIfRunning(); return; }
  const ips = t.closest("[data-dpi-ipset]");
  if (ips) { S.ipset = ips.dataset.dpiIpset; localStorage.setItem(LS.ipset, S.ipset); renderBody(); restartIfRunning(); return; }
  if (t.closest("[data-dpi-ipset-toggle]")) { S.ipsetOpen = !S.ipsetOpen; renderBody(); return; }
  if (t.closest("[data-dpi-monkey]")) {
    S.monkey = !S.monkey;
    localStorage.setItem(LS.monkey, S.monkey ? "true" : "false");
    renderBody();
    restartWithDriverSwap();
    toast(S.monkey ? t("dpi.monkey.toastOn") : t("dpi.monkey.toastOff"), "info", 2400);
    return;
  }
  const upd = t.closest("[data-dpi-update]");
  if (upd) { runUpdate(upd.dataset.dpiUpdate); return; }
  if (t.closest("[data-dpi-update-check]")) { checkUpdate(true); return; }
  if (t.closest("[data-dpi-cache-clear]")) { clearDiscordCache(); return; }
  const dom = t.closest("[data-dpi-domains]");
  if (dom) { openListEditor(dom.dataset.dpiDomains); return; }
  if (t.closest("[data-dpi-hosts-apply]")) { applyHosts(); return; }
  if (t.closest("[data-dpi-hosts-clear]")) { clearHosts(); return; }
  if (t.closest("[data-dpi-ipset-update]")) { updateIpset(); return; }
  if (t.closest("[data-dpi-editor-close]") || t.closest("[data-dpi-editor-bg]")) { closeListEditor(); return; }
  const save = t.closest("[data-dpi-editor-save]");
  if (save) { saveListEditor(save.dataset.dpiEditorSave); return; }
}

function onChange(e) {
  const select = e.target.closest?.("[data-dpi-fake]");
  if (!select) return;
  setActiveFake(select.dataset.dpiFake, select.value);
}

/* ═══════════ PUBLIC API ═══════════ */
export function prepareDpiVpnMode(mode) {
  return queueDpiModeChange(async () => {
    if (mode !== "tun" || splitDiscordAllowedInTun()) return true;
    if (!["running", "starting", "error"].includes(S.base)) return true;
    return pauseEngineForTun();
  });
}

export function setDpiVpnMode(mode, options = {}) {
  return queueDpiModeChange(() => applyDpiVpnMode(mode, options));
}

async function applyDpiVpnMode(mode, { reevaluate = false } = {}) {
  if (!mode) return false;
  const prev = S.vpnMode;
  S.vpnMode = mode;
  renderAll();
  // Реальная пауза/возврат движка по режиму VPN (риск из спайка: в TUN весь
  // трафик в туннеле, winws иначе жуёт зашифрованный VLESS).
  if (mode === "tun") {
    // split-Discord: оставляем winws работать (десинхрит direct-Discord в TUN).
    // Повторный вызов с тем же TUN нужен при выключении strict: сохранённый
    // split снова становится активным и должен реально вернуть winws.
    if (reevaluate && splitDiscordActive()) {
      return resumeEngineAfterTun();
    } else if (["running", "starting", "error"].includes(S.base)) {
      return pauseEngineForTun();
    }
  } else if (prev === "tun") {
    return resumeEngineAfterTun();
  }
  return true;
}

// Внести сервер активной VPN-ноды в exclude winws (главный риск из спайка —
// иначе winws корёжит зашифрованный VLESS к серверу). host = домен или IP.
let activeEndpointRevision = 0;
let activeEndpointQueue = Promise.resolve();
function setActiveVpnEndpoint(host) {
  const revision = ++activeEndpointRevision;
  // Различение «адрес или имя» — через тот же валидатор, что у правил
  // маршрутизации. Прежняя проверка (/^[0-9a-fA-F:.]+$/ + наличие точки)
  // объявляла IP-адресом любой домен из hex-букв: abc.def, dead.cf, de.ad.
  // Такой «IP» не проходил normalize_ipset_entry в Rust, команда падала
  // целиком (оба файла пишутся только после нормализации обоих значений), и в
  // списках оставалось исключение ПРЕДЫДУЩЕЙ ноды — winws продолжал жевать
  // зашифрованный трафик к текущему серверу, а исключение выглядело активным.
  const isIp = !!host && !!normalizeIp(host);
  const args = !host ? { ip: null, domain: null }
    : isIp ? { ip: host, domain: null } : { ip: null, domain: host };
  const apply = async () => {
    if (revision !== activeEndpointRevision) return false;
    await invoke("dpi_set_active_vpn_endpoint", args);
    return revision === activeEndpointRevision;
  };
  activeEndpointQueue = activeEndpointQueue.then(apply, apply);
  return activeEndpointQueue.catch(() => false);
}

export function excludeVpnNode(host) {
  if (!host) return Promise.resolve(false);
  return setActiveVpnEndpoint(host);
}

export function clearVpnNodeExclusion() {
  return setActiveVpnEndpoint(null);
}

export function onDpiViewEnter() {
  checkUpdate().catch(() => {});
}

export async function mountDpiView({ onToast, switchView, ensureElevated: ee } = {}) {
  if (typeof onToast === "function") toast = onToast;
  if (typeof switchView === "function") goView = switchView;
  if (typeof ee === "function") ensureElevated = ee;

  // Делегирование на document (не #app-root): дравер добавляется в document.body
  // вне #app-root, поэтому его клики — закрытие/фон/выбор стратегии — должны
  // ловиться на уровне документа.
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
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
  await Promise.all([
    loadVersions(),
    loadDomains(),
    loadFakePayloads(),
    checkUpdate(),
    loadHosts(),
    loadIpsetCount(),
  ]);
  renderAll();
}
