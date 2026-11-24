// Ninety · DPI bypass — the section screen + the chip on the home screen.
// The UI is connected to the winws engine through
// the dpi_* Rust commands (see src-tauri/src/dpi.rs). State and persistence are real.
//
// Public API:
//   mountDpiView({ onToast, switchView, ensureElevated }) — attach to the DOM
//   prepareDpiVpnMode(mode) — fail-closed preparation before entering TUN
//   setDpiVpnMode(mode, { reevaluate }) — sync the VPN mode (TUN→pause)
//   setVpnNodesProvider(fn) — source of the addresses of all nodes in the running config
//   refreshVpnNodeExclusion() — rewrite the node exclusion (after connecting)
//   excludeVpnNode(host) / clearVpnNodeExclusion() — compatible wrappers

import { loadOptions, getOptionsSnapshot } from "/lib/options.js";
import { escapeAttr, escapeHtml as esc } from "/lib/esc.js";
import { a11ySwitchAll } from "/lib/switch-a11y.js";
import { t, getLang } from "/lib/i18n/index.js";
import { openConfirmModal } from "/lib/confirm-modal.js";
import { normalizeIp } from "/lib/routing-rules.js";
import { runtimeProbeProxyPort } from "/lib/runtime-lifecycle.js";
import { STORAGE_KEYS } from "/lib/storage-policy.js";
import { localizedInvoke, localizeBackendText } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));
const tauriListen = window.__TAURI__?.event?.listen;

// Discord split routing allows keeping winws in TUN: it desyncs
// direct Discord on the real interface (low-ping voice).
function splitDiscordAllowedInTun() {
  try {
    const options = getOptionsSnapshot();
    return !options?.privacy?.strictTunnel
      && !!options?.route?.tunSplitDiscord;
  }
  catch { return false; }
}
function splitDiscordActive() {
  return S.vpnMode === "tun" && splitDiscordAllowedInTun();
}

/* ═══════════ ICONS (inner SVG, Lucide 1.5px style) ═══════════ */
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
  plus:     '<path d="M12 5v14"/><path d="M5 12h14"/>',
  chevronUp:   '<path d="m6 15 6-6 6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  pencil:   '<path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/><path d="m15 5 4 4"/>',
};
function ic(name, size = 16, stroke = 1.5) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${I[name] || ""}</svg>`;
}

/* ═══════════ DATA ═══════════ */
// The real list comes from dpi_strategies() (the engine's strategies.json).
// A fallback for web preview / a read error.
const DEFAULT_STRATEGY = "ALT11";
let STRATEGIES = [{ id: "alt11", name: DEFAULT_STRATEGY, desc: "Самый стойкий профиль." }];
// Strategy descriptions are channel data (in Russian), they DON'T go through t(). For
// a non-Russian interface we hide them, leaving only the strategy name (option B).
const stratDesc = (d) => (getLang() === "ru" && d ? esc(d) : "");
// Exact lookup — without a fallback: it's needed to tell "the strategy vanished from
// the set" from "found". stratByName with a fallback is kept for places that need
// a guaranteed valid object.
const stratExact = (n) =>
  STRATEGIES.find((s) => s.name === n) || STRATEGIES.find((s) => s.id === n) || null;
const stratByName = (n) => stratExact(n) || STRATEGIES[0];
// The user's own strategies come after the built-in set (custom: true). They are
// the user's experiments, so auto-tuning doesn't measure them.
const autopickCount = () => STRATEGIES.filter((s) => !s.experimental && !s.custom).length;
const builtinStrategies = () => STRATEGIES.filter((s) => !s.custom);
const customStrategies = () => STRATEGIES.filter((s) => s.custom);
// Mirror of custom::MAX_CUSTOM_STRATEGIES: the backend refuses a fourth one anyway,
// the UI only explains it before the user types a whole strategy.
export const MAX_CUSTOM_STRATEGIES = 3;

// A custom strategy has no channel description: say what it is built on, or why
// it won't start as stored (its base left the set, the text no longer passes).
function strategyDesc(s) {
  if (!s?.custom) return stratDesc(s?.desc);
  if (s.problem) return esc(t("dpi.custom.broken"));
  // The user's own description is shown in any interface language: they wrote it.
  if (s.desc) return esc(s.desc);
  const base = s.base ? builtinStrategies().find((b) => b.id === s.base) : null;
  return esc(base ? t("dpi.custom.descFrom", { base: base.name }) : t("dpi.custom.descEmpty"));
}

// Which strategy to mark as recommended and on what basis.
// measured=true is the result of auto-tuning on the user's network; false is
// the default profile the app ships with. A name from past
// measurements is checked against the current set: the channel may have renamed or removed it.
export function recommendedStrategy(strategies, stored) {
  const list = Array.isArray(strategies) ? strategies : [];
  const measured = list.find((s) => s.name === stored);
  if (measured) return { name: measured.name, measured: true };
  return { name: DEFAULT_STRATEGY, measured: false };
}

// kicker is decorative English (not localized); title/desc go through t() at runtime.
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

/* ═══════════ STATE (persisted in localStorage) ═══════════ */
// Key names come from the storage policy: it decides what goes into the backup and what
// "clear data" wipes, and a literal of our own would silently drift away from it.
const LS = {
  enabled: STORAGE_KEYS.dpiEnabled,
  strategy: STORAGE_KEYS.dpiStrategy,
  gameFilter: STORAGE_KEYS.dpiGameFilter,
  ipset: STORAGE_KEYS.dpiIpset,
  monkey: STORAGE_KEYS.dpiMonkey,
  recommended: STORAGE_KEYS.dpiRecommended,
};
const lsGet = (k, d) => { const v = localStorage.getItem(k); return v == null ? d : v; };
// Bypass scope. The value goes into dpi_start and into t("dpi.scope.<id>"),
// so a foreign string (an old backup, a manual edit) is reduced to a safe mode
// rather than dragged into winws arguments and translation keys.
const SCOPES = ["auto", "any", "loaded", "off"];

// Default bypass scope. A clean install gets "Blocked only":
// it doesn't touch sites that open anyway, and Discord and YouTube are in
// the hostlists and get bypassed on the first try regardless of the mode.
//
// An installation that has already used the bypass (there's a trace in ninety.dpi.*) keeps
// its previous mode — "All sites". The person set up a working configuration for
// the old default and didn't ask for a change; silently switching them to a mode where
// a blocked site opens only on the second or third try is not allowed.
// We record the choice right away so it isn't replayed on future default changes.
function initialScope() {
  const saved = localStorage.getItem(LS.ipset);
  if (saved != null) return SCOPES.includes(saved) ? saved : "any";
  const usedBefore = localStorage.getItem(LS.enabled) != null || localStorage.getItem(LS.strategy) != null;
  const scope = usedBefore ? "any" : "auto";
  try { localStorage.setItem(LS.ipset, scope); } catch { /* private mode — just work with the default */ }
  return scope;
}

const S = {
  base: "off",          // off | starting | running | error
  vpnMode: "systemProxy",
  strategy: lsGet(LS.strategy, DEFAULT_STRATEGY),
  gameFilter: lsGet(LS.gameFilter, "off"),
  ipset: initialScope(),
  monkey: lsGet(LS.monkey, "false") === "true",
  // Winner of the last auto-tuning. Empty — no measurements yet.
  recommended: lsGet(LS.recommended, ""),
  hasUpdate: false,
  lastError: "",
  versions: { app: "—", engine: "winws", strategies: "—" },
  domains: null,
  hosts: { applied: false, entries: 0, busy: false },
  ipsetList: { count: null, busy: false },
  ipsetOpen: false,
  // Autolist of blocked domains ("Blocked only" mode):
  // domains=null — not read yet, [] — winws hasn't found anything yet.
  auto: { domains: null, busy: false, acting: "" },
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
  updating: null,       // id of the row currently being updated
};
let dpiOperationEpoch = 0;
let dpiAutopickEpoch = 0;
// id of the winws session returned by the last successful dpi_start. A
// dpi:exited event of another (old) session doesn't touch the state.
let dpiRuntimeGeneration = null;

// In TUN all traffic goes through the tunnel → the engine is actually stopped (pauseEngineForTun),
// but if DPI is logically enabled (LS.enabled) we show "Paused", not "Off":
// it will be restored on leaving TUN. Outside TUN — the actual engine state.
function effState() {
  if (S.base === "error") return "error";
  // In split Discord the engine actually runs in TUN too → return the real S.base.
  if (S.vpnMode === "tun" && !splitDiscordActive() && lsGet(LS.enabled, "false") === "true") return "paused";
  return S.base;
}

let toast = () => {};
let goView = () => {};
let ensureElevated = async () => true; // from main.js; true = we can continue (we're elevated)

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
    const isFinal = p.stage === "final";
    autopick = `<div class="dpi-autopick__prog">
        <div class="dpi-autopick__prog-top"><span class="dpi-autopick__prog-now">${t(isFinal ? "dpi.autopick.checkingFinal" : "dpi.autopick.checking", { name: esc(p.name || "…") })}</span></div>
        <div class="dpi-bar"><span class="dpi-bar__fill" style="width:${pct}%"></span></div>
        <div class="dpi-autopick__candidate">${t(isFinal ? "dpi.autopick.progFinal" : "dpi.autopick.progLine", { i: p.i, total })}</div>
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

  // Bypass scope: one option = a title + a human explanation
  // of what exactly it does. Three-word segments didn't explain that, and the difference
  // between the modes determines whether the bypass will break non-blocked sites.
  const scopeOpt = (id, recommended) => `
        <button class="dpi-scope__opt" data-on="${S.ipset === id}" data-dpi-ipset="${id}"
                role="radio" aria-checked="${S.ipset === id}">
          <span class="dpi-scope__mark"></span>
          <span class="dpi-scope__txt">
            <span class="dpi-scope__t">${t("dpi.scope." + id)}${recommended ? `<em class="dpi-scope__rec">${t("dpi.scope.recommended")}</em>` : ""}</span>
            <span class="dpi-scope__d">${t("dpi.scope.hint" + id[0].toUpperCase() + id.slice(1))}</span>
          </span>
        </button>`;
  const autoDomains = S.auto.domains;
  const autoCount = autoDomains == null
    ? "…"
    : autoDomains.length
      ? autoDomains.length.toLocaleString("ru-RU") + " " + t("dpi.scope.autoUnit")
      : t("dpi.scope.autoNone");
  const autoItem = (d) => `
              <li class="dpi-scope__item">
                <span class="dpi-scope__dom" title="${escapeAttr(d)}">${esc(d)}</span>
                <span class="dpi-scope__acts">
                  <button class="dpi-scope__act" data-dpi-auto-exclude="${escapeAttr(d)}"
                          title="${escapeAttr(t("dpi.scope.autoExcludeHint"))}" ${S.auto.acting ? "disabled" : ""}>${t("dpi.scope.autoExclude")}</button>
                  <button class="dpi-scope__act" data-dpi-auto-forget="${escapeAttr(d)}"
                          title="${escapeAttr(t("dpi.scope.autoForgetHint"))}" ${S.auto.acting ? "disabled" : ""}>${t("dpi.scope.autoForget")}</button>
                </span>
              </li>`;
  const autoPanel = S.ipset !== "auto" ? "" : `
            <div class="dpi-scope__auto">
              <div class="dpi-scope__auto-head">
                <div class="dpi-scope__auto-info">
                  <span class="dpi-scope__auto-t">${t("dpi.scope.autoFound")}</span>
                  <span class="dpi-scope__auto-c">${autoCount}</span>
                </div>
                ${autoDomains && autoDomains.length ? `<div class="dpi-scope__auto-btns">
                  <button class="btn btn--sm" data-dpi-auto-clear ${S.auto.busy ? "disabled" : ""}>${ic("trash", 13)} ${t("dpi.scope.autoClear")}</button>
                </div>` : ""}
              </div>
              <div class="dpi-scope__auto-note">${t("dpi.scope.autoNote")}</div>
              ${autoDomains && autoDomains.length ? `<ul class="dpi-scope__list">${autoDomains.map(autoItem).join("")}</ul>` : ""}
            </div>`;
  // The IP list panel is visible in all modes: the base is pulled from the signed channel and
  // updated in advance, not at the moment the mode is switched. In modes where the list
  // doesn't take part, we honestly say so in the line below rather than hiding the button.
  const ipsetPanel = `
            <div class="dpi-ipset__upd" data-idle="${S.ipset !== "loaded"}">
              <div class="dpi-ipset__upd-info">
                <span class="dpi-ipset__upd-t">${t("dpi.scope.listLabel")}</span>
                <span class="dpi-ipset__upd-c">${S.ipsetList.count == null ? "—" : S.ipsetList.count.toLocaleString("ru-RU") + " " + t("dpi.scope.unit")}</span>
                ${S.ipset === "loaded" ? "" : `<span class="dpi-ipset__upd-idle">${t("dpi.scope.listIdle")}</span>`}
              </div>
              <button class="btn btn--sm" data-dpi-ipset-update ${S.ipsetList.busy ? "disabled" : ""}>${ic("download", 13)} ${S.ipsetList.busy ? "…" : t("dpi.scope.update")}</button>
            </div>`;
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
            <div class="dpi-card__btns">
              ${cur.custom ? `<button class="btn btn--sm" data-dpi-custom-edit="${escapeAttr(cur.id)}">${ic("pencil", 13)} ${t("dpi.custom.edit")}</button>` : ""}
              <button class="btn btn--sm" data-dpi-drawer>${ic("sliders", 13)} ${t("dpi.strategy.drawerBtn")}</button>
            </div>
          </div>
          <div class="dpi-strategy">
            <div class="dpi-strategy__row">
              <span class="dpi-strategy__name">${esc(cur.name)}</span>
              ${cur.custom ? `<span class="dpi-strategy__tag" data-kind="custom">${t("dpi.custom.tag")}</span>` : ""}
              ${cur.custom && cur.experimental ? `<span class="dpi-strategy__tag" data-kind="custom">${t("dpi.custom.tagExperimental")}</span>` : ""}
              ${cur.name === rec.name ? `<span class="dpi-strategy__tag">${t(rec.measured ? "dpi.strategy.recTagMeasured" : "dpi.strategy.recTag")}</span>` : ""}
            </div>
            <div class="dpi-strategy__desc">${strategyDesc(cur)}</div>
          </div>
        </article>

        <article class="dpi-card dpi-autopick">
          <div class="dpi-card__head">
            <div class="dpi-card__label">${ic("target", 13)}${t("dpi.autopick.cardLabel")}</div>
            ${p.phase === "running" ? `<span class="dpi-autopick__prog-count">${p.i} / ${p.total || autopickCount()}</span>` : ""}
          </div>
          ${autopick}
        </article>

        <article class="dpi-card dpi-ipset dpi-scope" data-open="${S.ipsetOpen}">
          <div class="dpi-ipset__head" data-dpi-ipset-toggle>
            <div class="dpi-row__lbl"><div class="dpi-row__t">${t("dpi.scope.label")}</div><div class="dpi-row__d">${t("dpi.scope.desc")}</div></div>
            <span class="dpi-scope__now">${t("dpi.scope." + S.ipset)}</span>
            <span class="dpi-ipset__chev">${ic("chevron", 16)}</span>
          </div>
          <div class="dpi-ipset__body"><div class="dpi-ipset__inner"><div class="dpi-ipset__pad">
            <div class="dpi-scope__opts" role="radiogroup" aria-label="${escapeAttr(t("dpi.scope.label"))}">
              ${scopeOpt("auto", true)}${scopeOpt("any")}${scopeOpt("loaded")}${scopeOpt("off")}
            </div>
            ${autoPanel}${ipsetPanel}
          </div></div></div>
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
            // System proxy sends browser traffic through sing-box, and sites routed to the VPN
            // never reach winws on the real interface: "independent of the VPN" misled here.
            : S.vpnMode === "systemProxy"
              ? t("dpi.vpn.descSystemProxy")
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
        <span class="dpi-chip__name">${esc(t("nav.dpi"))}</span>
        <span class="dpi-chip__status">${chipStatus()[st]}</span>
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

// Live re-render on language change (called from onLangChange in main.js).
export function rerenderDpiView() { renderAll(); }

// Tell the rest of the app (the tray) that DPI bypass on/off has changed.
function emitDpiChanged() {
  try { window.dispatchEvent(new CustomEvent("ninety:dpi-changed")); } catch {}
}

/* ═══════════ ACTIONS (real engine) ═══════════ */
async function startEngine() {
  const epoch = ++dpiOperationEpoch;
  S.base = "starting";
  renderAll();
  S.lastError = "";
  // Before every winws launch — a fresh set of the running config's nodes, with
  // domains resolved: the IP exclusion is the only thing that really protects
  // encrypted traffic to the server. A failure here doesn't block the launch.
  await syncVpnNodeExclusion({ resolve: true });
  if (epoch !== dpiOperationEpoch) return false;
  try {
    const session = await invoke("dpi_start", { strategyId: stratByName(S.strategy).id, gameFilter: S.gameFilter, ipset: S.ipset, monkey: S.monkey, logsDisabled: !!loadOptions()?.log?.disabled });
    if (epoch !== dpiOperationEpoch) return false;
    dpiRuntimeGeneration = Number.isSafeInteger(session) ? session : null;
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

// winws died on its own mid-session (the dpi:exited event from the Rust watchdog).
// Planned stop/restart don't produce the event; an old session and an engine that's already off or
// restarting ignore it. We don't touch the "DPI enabled" wish:
// it's a failure, not the user's decision — the error banner leads to the logs.
function onDpiExited(payload) {
  if (S.base !== "running") return;
  const generation = Number(payload?.generation);
  if (dpiRuntimeGeneration != null && generation !== dpiRuntimeGeneration) return;
  dpiRuntimeGeneration = null;
  S.base = "error";
  S.lastError = String(localizeBackendText(payload?.message) || "");
  toast(S.lastError || t("dpi.banner.errorFallback"), "error", 6000);
  emitDpiChanged();
  renderAll();
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
  dpiRuntimeGeneration = null;
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

// Engine pause on entering TUN: we actually kill winws, BUT keep LS.enabled
// "true" — it's the "logical wish" by which we'll recover on exit.
// Pausing and resuming the engine go through one queue. Without it, a quick cycle of
// "turn split off → turn it back on" got out of sync: resume checks S.base, while
// stopDpiRuntime sets "off" only AFTER the await, so the second call saw
// a still live process and returned success, and the first then killed winws — split
// stayed enabled in settings with the engine off.
let dpiModeQueue = Promise.resolve(true);
function queueDpiModeChange(run) {
  const next = dpiModeQueue.then(run, run);
  dpiModeQueue = next.catch(() => false);
  return next;
}

async function pauseEngineForTun() {
  return stopDpiRuntime();
}

// Returning from TUN: bring the engine up if DPI was enabled before the pause. The process at this
// point is already elevated (TUN required rights), so UAC usually won't pop up.
let dpiResumeInFlight = null;
async function resumeEngineAfterTun() {
  if (lsGet(LS.enabled, "false") !== "true") return true;
  if (S.base === "running" || S.base === "starting") return true;
  // Auto-tuning owns the engine itself: dpi_start on top of it would fail with "busy".
  // restoreEngineAfterAutopick will bring the engine back, according to the current mode.
  if (S.autopick.phase === "running") { autopickResume = true; return true; }
  if (dpiResumeInFlight) return dpiResumeInFlight;
  const run = (async () => {
    const ok = await ensureElevated();
    // While we waited for UAC, strict/split or the user's intent may have
    // changed. A repeated check keeps a late resume from launching winws
    // in regular TUN and at the same time prevents a double dpi_start.
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
  // In TUN the engine is paused — the toggle only changes "do we want DPI after leaving TUN".
  // The exception is split Discord: there the engine actually runs in TUN, the toggle = start/stop.
  if (S.vpnMode === "tun" && !splitDiscordActive()) {
    const want = lsGet(LS.enabled, "false") !== "true";
    localStorage.setItem(LS.enabled, want ? "true" : "false");
    emitDpiChanged();
    renderAll();
    toast(want ? t("dpi.toast.willEnable") : t("dpi.toast.disabled"), "info", 2200);
    return;
  }
  // After an unconfirmed stop the backend keeps the live child, and the UI is
  // in error. A repeated click must stop it once more, not launch a second
  // winws on top of the first. A start error, on the other hand, doesn't set desired=true.
  if (S.base === "error" && lsGet(LS.enabled, "false") === "true") {
    await stopEngine();
    return;
  }
  if (S.base === "running" || S.base === "starting") { await stopEngine(); return; }
  // enabling requires admin rights (winws loads a driver). The same infra as TUN.
  const ok = await ensureElevated();
  if (!ok) return; // a restart with UAC or a refusal is in progress — the current process doesn't continue
  await startEngine();
}

// DPI autostart at app start (Windows login), if it was enabled.
// Called from main.js only in the should_autoconnect branch. By this point the process
// is already elevated (see the unified autostart in main.js) → start without confirm.
export async function autostartDpiIfEnabled() {
  if (lsGet(LS.enabled, "false") !== "true") return;
  if (S.vpnMode === "tun" && !splitDiscordActive()) return; // in TUN without split the bypass is paused
  try { if (await invoke("dpi_running")) { S.base = "running"; renderAll(); return; } } catch {}
  const ok = await ensureElevated();
  if (!ok) return;
  await startEngine();
}

// Apply a settings change on the fly: if the engine is running — restart it.
async function restartIfRunning() {
  if (S.base === "running" || S.base === "starting") {
    if (!(await stopDpiRuntime())) return false;
    return startEngine();
  }
  return true;
}

// Driver mode change (WinDivert↔Monkey): the kernel service name and the
// .sys file name change → before starting the new one, the already loaded driver with the old name must be removed,
// otherwise both services would hang in the kernel. The app is elevated (DPI is running) → dpi_unload_driver
// removes WinDivert/WinDivert14/Monkey. If it's off, it simply applies at start.
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
    // The channel may have renamed or removed the strategy. The fix must happen EXACTLY here and
    // be saved to localStorage: the chip and kicker print the raw S.strategy, while
    // dpi_start goes out with the fallback's id — otherwise there are two different names on screen, and
    // what launches is something the user didn't pick. Previously the condition was
    // written via stratByName, which falls back to STRATEGIES[0], so
    // it never fired.
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
  // port>0 with an active VPN (proxy/systemProxy) → the channel version check goes
  // through the tunnel: version.txt is on GitHub, which TSPU cuts from Russia when accessed directly.
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


/* ── Autolist of blocked domains ("Blocked only" mode) ── */
// winws maintains the file itself, so we reread the list on every visit to the section
// and after every edit: between renders it may have grown without our involvement.
async function loadAutoDomains() {
  try { S.auto.domains = await invoke("dpi_auto_domains"); }
  catch { S.auto.domains = null; }
}

// "Forget" = remove from the autolist. The bypass no longer applies to the domain, but
// if it really is blocked, winws will find it again — for a final
// refusal there's "to exclusions".
async function forgetAutoDomain(domain) {
  S.auto.acting = domain; renderBody();
  try {
    S.auto.domains = await invoke("dpi_auto_forget", { domain });
    toast(t("dpi.scope.autoToastForget", { d: domain }), "info", 2000);
  } catch (e) {
    toast(t("dpi.scope.autoToastErr", { err: e?.message || e }), "error", 3500);
  }
  S.auto.acting = ""; renderBody();
}

// "To exclusions" = append the domain to the user exclusion list and remove it
// from the autolist: winws won't put it there again (hostlist-exclude suppresses both
// detection and bypass). An engine restart isn't needed — hostlists are reread on their own.
async function excludeAutoDomain(domain) {
  S.auto.acting = domain; renderBody();
  try {
    const current = await invoke("dpi_read_list", { kind: "exclude" });
    const has = current.split(/\r?\n/).some((line) => line.trim().toLowerCase() === domain.toLowerCase());
    if (!has) {
      const body = current.length && !current.endsWith("\n") ? current + "\n" + domain : current + domain;
      await invoke("dpi_write_list", { kind: "exclude", content: body });
    }
    S.auto.domains = await invoke("dpi_auto_forget", { domain });
    await loadDomains();
    toast(t("dpi.scope.autoToastExclude", { d: domain }), "info", 2400);
  } catch (e) {
    toast(t("dpi.scope.autoToastErr", { err: e?.message || e }), "error", 3500);
  }
  S.auto.acting = ""; renderBody();
}

async function clearAutoDomains() {
  S.auto.busy = true; renderBody();
  try {
    await invoke("dpi_auto_clear");
    S.auto.domains = [];
    toast(t("dpi.scope.autoToastClear"), "info", 1800);
  } catch (e) {
    toast(t("dpi.scope.autoToastErr", { err: e?.message || e }), "error", 3500);
  }
  S.auto.busy = false; renderBody();
}

// Port for downloading lists (hosts/ipset): the live runtime's inbound is mixed-in, and in TUN
// probe-in on the same port; Ninety.exe itself goes direct in TUN via the bypass rule.
// 0 = a direct request, when the VPN is off. A direct request to GitHub raw from Russia is cut by
// TSPU, so with an active bypass we fetch through the proxy; Rust itself falls back to direct
// if the proxy is silent.
async function listFetchPort() {
  // The port is taken from the LIVE runtime, not from settings: `inbound.mixedPort` is changed
  // without a reconnect, and then the request went to a port the core doesn't listen on —
  // only the direct path remained, exactly the one that gets cut.
  try { return runtimeProbeProxyPort(await invoke("runtime_snapshot")); }
  catch { return 0; }
}

/* ── hosts file (editing the system hosts — admin rights needed) ── */
async function applyHosts() {
  const ok = await ensureElevated();
  if (!ok) return; // a restart with UAC or a refusal is in progress
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

/* ── ipset base update (written to app_data — no admin rights) ── */
async function updateIpset() {
  S.ipsetList.busy = true; renderBody();
  try {
    const n = await invoke("dpi_update_ipset", { port: await listFetchPort() });
    S.ipsetList.count = n;
    toast(t("dpi.scope.toastDone", { n: n.toLocaleString("ru-RU") }), "info", 2400);
    if (S.ipset === "loaded") await restartIfRunning(); // apply the fresh set to winws
  } catch (e) {
    toast(t("dpi.scope.toastErr", { err: e?.message || e }), "error", 4500);
  }
  S.ipsetList.busy = false; renderBody();
}

async function runUpdate(id) {
  if (id !== "strategies" || S.autopick.phase === "running" || S.fakes.busy) return;
  S.updating = id;
  renderBody();
  try {
    // Data channel: strategies + lists + .bin in one signed bundle
    // (the signature is verified in Rust before applying). The version is a Flowseal tag.
    // port>0 with an active VPN → the bundle is pulled through the tunnel (GitHub + TSPU).
    const r = await invoke("dpi_sync_channel", { port: await listFetchPort() });
    if (r?.version) S.versions.strategies = r.version;
    S.hasUpdate = false;
    S.updateCheck = "ok";
    await loadStrategies(); // reread the updated strategy definitions
    await loadFakePayloads();
    await loadVersions();
    await loadDomains();
    await loadIpsetCount(); // the ipset base arrives in the same bundle — the counter may have changed
    await restartIfRunning(); // apply the fresh set to the running winws
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

/* ── Auto-tuning ── */
// The run physically kills the current winws and brings one up per strategy.
// While it runs, the engine is off — we restore the state ourselves, otherwise the chip lies, and
// "Apply" won't restart the engine, thinking it's alive.
let autopickResume = false;

async function restoreEngineAfterAutopick() {
  if (!autopickResume) return;
  autopickResume = false;
  S.base = "off";
  // The decision goes through the same queue as VPN mode switches. While tuning was running, the VPN may have
  // gone into TUN: setDpiVpnMode then saw the engine off, and there was nothing to
  // pause. So the same rules apply here as on a regular
  // TUN entry: without split Discord we don't bring winws up, the TUN pause stays.
  await queueDpiModeChange(async () => {
    if (lsGet(LS.enabled, "false") !== "true") return true;
    if (S.base === "running" || S.base === "starting") return true;
    if (S.vpnMode === "tun" && !splitDiscordActive()) { renderAll(); return true; }
    return startEngine();
  });
}

async function pickStart() {
  if (S.autopick.phase === "running" || S.updating || S.fakes.busy) return;
  // In TUN the probes go into the tunnel: every single strategy would "pass", and
  // the recommendation would be random. Measuring is only possible on the real interface.
  if (S.vpnMode === "tun") { toast(t("dpi.autopick.toastTun"), "warn", 5200); return; }
  const epoch = ++dpiAutopickEpoch;
  autopickResume = S.base === "running" || S.base === "starting";
  if (autopickResume) S.base = "off";
  S.autopick = { phase: "running", stage: "screen", i: 0, total: autopickCount(), name: "", best: null, meta: "" };
  renderAll();
  const ok = await ensureElevated();
  if (!ok || epoch !== dpiAutopickEpoch) { S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" }; autopickResume = false; return; }
  // Tuning brings winws up once per strategy — nodes are excluded the same way
  // as before a regular launch.
  await syncVpnNodeExclusion({ resolve: true });
  if (epoch !== dpiAutopickEpoch) return;
  try {
    // The current strategy keeps its place when a rival is faster only within noise.
    const r = await invoke("dpi_autotest", { monkey: S.monkey, logsDisabled: !!loadOptions()?.log?.disabled, current: S.strategy });
    if (epoch !== dpiAutopickEpoch) return;
    // An engine that didn't come up because of a race for the driver isn't "the strategy doesn't
    // work". We count it separately and report it separately, otherwise the number lies.
    const engineNote = r?.engine_failed
      ? " · " + t("dpi.autopick.metaEngine", { n: r.engine_failed })
      : "";
    const videoNote = r?.video === "failed" ? " · " + t("dpi.autopick.metaVideoFail") : "";
    const keptNote = r?.kept_current ? " · " + t("dpi.autopick.metaKept") : "";
    if (r?.best_id) {
      const best = STRATEGIES.find((s) => s.id === r.best_id);
      // A measurement beats the default: from now on the "recommended" badge is on
      // what actually opened on this network, not on the out-of-the-box profile.
      S.recommended = best?.name || r.best_name || "";
      localStorage.setItem(LS.recommended, S.recommended);
      // passed — how many strategies opened ALL checks. If there are none, but
      // there is a recommendation, it's partial, and writing "0 of 20 passed" is not allowed.
      const meta = r.passed > 0
        ? t("dpi.autopick.metaOk", { passed: r.passed, total: r.total, ms: r.latency_ms })
        : t("dpi.autopick.metaPartial", { covered: r.best_targets, targets: r.targets });
      S.autopick = {
        phase: "done", i: r.total, total: r.total,
        best: best?.name || r.best_name,
        meta: meta + videoNote + keptNote + engineNote,
      };
    } else {
      // The run found nothing — the previous recommendation is no longer confirmed,
      // it must not stay on the card. We return to the default profile.
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
  // Stop not confirmed — winws may still be alive, bringing up a second one is not allowed.
  if (!(await stopDpiRuntime({ markOff: false }))) { autopickResume = false; return; }
  S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" };
  await restoreEngineAfterAutopick();
  renderAll();
}

async function pickApply(name) {
  const s = stratByName(name);
  S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" };
  await setStrategy(s);
  // If the engine isn't running — bring it up with the selected strategy. Exactly
  // bring it up, not "toggle": toggleDpi in the error state with desired=true
  // treats a click as "stop the stuck process", and "Apply" after
  // auto-tuning turned the bypass off instead of starting it.
  if (S.base === "off" || S.base === "error") {
    if (S.vpnMode === "tun" && !splitDiscordActive()) {
      // In TUN the engine is paused — record the intent, as toggleDpi does.
      localStorage.setItem(LS.enabled, "true");
      emitDpiChanged();
      renderAll();
      toast(t("dpi.toast.willEnable"), "info", 2200);
      return;
    }
    if (S.base === "error" && lsGet(LS.enabled, "false") === "true") {
      // The previous stop wasn't confirmed — first stop it properly, then
      // start again with the new strategy.
      if (!(await stopDpiRuntime())) return;
    }
    const ok = await ensureElevated();
    if (!ok) return;
    await startEngine();
  }
}

/* ═══════════ STRATEGY DRAWER (dynamic) ═══════════ */
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
  const matches = (s) => !q || s.name.toLowerCase().includes(q) || (s.desc || "").toLowerCase().includes(q);
  const builtins = builtinStrategies().filter(matches);
  const customs = customStrategies().filter(matches);
  const total = customStrategies().length;
  const full = total >= MAX_CUSTOM_STRATEGIES;
  const row = (s) => `<div class="strat" data-active="${s.id === cur.id}" data-custom="${!!s.custom}" data-broken="${!!s.problem}" data-dpi-strat="${escapeAttr(s.id)}">
        <div class="strat__main"><div class="strat__name">${esc(s.name)}${s.custom && s.experimental ? ` <span class="strat__tag">${t("dpi.custom.tagExperimental")}</span>` : ""}</div><div class="strat__desc">${strategyDesc(s)}</div></div>
        ${s.custom ? `<button class="strat__edit" data-dpi-custom-edit="${escapeAttr(s.id)}" title="${escapeAttr(t("dpi.custom.edit"))}" aria-label="${escapeAttr(t("dpi.custom.edit"))}">${ic("pencil", 13)}</button>` : ""}
        <span class="strat__check">${ic("check", 11, 2.5)}</span>
      </div>`;
  // "My strategies" go first: the user comes back to them more often than to the
  // twenty built-in ones. While searching, an empty block isn't shown.
  const custom = q && !customs.length ? "" : `<div class="drawer__section"><span>${t("dpi.custom.section")}</span><span>${t("dpi.custom.count", { n: total, max: MAX_CUSTOM_STRATEGIES })}</span></div>
    ${customs.map(row).join("")}
    ${q ? "" : `<button class="strat-add" data-dpi-custom-new ${full ? "disabled" : ""}>${ic("plus", 14)} ${t("dpi.custom.add")}</button>
    ${full ? `<div class="strat-add__note">${t("dpi.custom.limit", { max: MAX_CUSTOM_STRATEGIES })}</div>` : ""}`}`;
  list.innerHTML = custom +
    `<div class="drawer__section"><span>${t("dpi.drawer.count", { n: builtins.length })}</span><span>${t("dpi.drawer.activeMarked")}</span></div>` +
    builtins.map(row).join("");
}

/* ═══════════ CUSTOM STRATEGY EDITOR (dynamic) ═══════════ */
// A custom strategy is a full winws profile list in the built-in format. The
// editor shows it by section: start from a built-in strategy and change only
// the sections that need it, so a tweak for one game never means retyping the
// profiles that keep sites, video and voice working. Rust owns parsing and the
// allowlist (dpi_custom_check); here text is only split into sections and labelled.
let customEl = null;
let CE = null;
let customCheckTimer = 0;
let customCheckSeq = 0;

// A rough split for labels and section boundaries; the real parsing is in Rust.
export function splitTokens(text) {
  // A token may carry quoted parts in the middle (--hostlist="%LISTS%x.txt"),
  // as in a .bat line; the quotes are dropped like the Rust tokenizer does.
  return (String(text || "").match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) || [])
    .map((token) => token.replace(/["']/g, ""));
}
const isWf = (arg) => arg.startsWith("--wf-tcp=") || arg.startsWith("--wf-udp=");

// Flat winws args → section texts (one argument per line). Interception is
// assembled from the filters, so built-in --wf-* lines are not carried over.
export function argsToSections(args, { dropWf = true } = {}) {
  const sections = [[]];
  for (const arg of args || []) {
    if (arg === "--new") sections.push([]);
    else if (!dropWf || !isWf(arg)) sections[sections.length - 1].push(arg);
  }
  return sections.map((section) => section.join("\n"));
}
const sameSection = (a, b) => splitTokens(a).join(" ") === splitTokens(b).join(" ");
const builtinSections = (id) => {
  const base = builtinStrategies().find((s) => s.id === id);
  return base ? argsToSections(base.args) : [];
};

// Short label of a section from its filters: "TCP 80,443 · list-general".
export function sectionLabel(text) {
  const args = splitTokens(text);
  const values = (flag) => args.filter((a) => a.startsWith(flag + "=")).map((a) => a.slice(flag.length + 1));
  const ports = (list) => list.join(",").replace(/%GameFilter(?:TCP|UDP)?%/g, t("dpi.custom.slotGame"));
  const parts = [];
  const tcp = values("--filter-tcp");
  const udp = values("--filter-udp");
  if (tcp.length) parts.push("TCP " + ports(tcp));
  if (udp.length) parts.push("UDP " + ports(udp));
  if (!parts.length) parts.push(t("dpi.custom.slotAll"));
  const l7 = values("--filter-l7");
  if (l7.length) parts.push(l7.join(","));
  const lists = values("--hostlist").map((v) => v.replace(/^%LISTS%/, "").replace(/\.txt$/, ""));
  const domains = values("--hostlist-domains");
  if (lists.length) parts.push(lists.join(" + "));
  else if (domains.length) parts.push(domains.join(","));
  else if (values("--ipset").length || values("--ipset-ip").length) parts.push("ipset");
  return parts.join(" · ");
}

// Which built-in strategy imported sections were made from: the one sharing the
// most identical sections, if at least half of them match.
export function guessBase(sections, strategies) {
  let best = null;
  let bestHits = 0;
  for (const s of strategies || []) {
    const base = argsToSections(s.args);
    const hits = sections.filter((text) => base.some((b) => sameSection(b, text))).length;
    if (hits > bestHits) { best = s; bestHits = hits; }
  }
  return best && bestHits * 2 >= sections.length ? best.id : "";
}

// Sections with the built-in section each one came from: an identical one first,
// then the same position. null — a section the base doesn't have.
function withOrigins(texts, baseId) {
  const base = baseId ? builtinSections(baseId) : [];
  const used = new Set();
  const origins = texts.map((text) => {
    const same = base.findIndex((b, i) => !used.has(i) && sameSection(b, text));
    if (same >= 0) { used.add(same); return same; }
    return null;
  });
  return texts.map((text, i) => {
    let origin = origins[i];
    if (origin == null && i < base.length && !used.has(i)) { origin = i; used.add(i); }
    return { text, origin };
  });
}

function sectionState(slot) {
  if (slot.origin == null) return "new";
  const base = builtinSections(CE.base)[slot.origin];
  return base != null && sameSection(base, slot.text) ? "same" : "changed";
}

function composeCustomText() {
  return CE.mode === "text" ? CE.text : CE.slots.map((s) => s.text.trim()).join("\n--new\n");
}

function defaultCustomBase() {
  const cur = stratExact(S.strategy);
  if (cur && !cur.custom) return cur.id;
  return (stratExact(DEFAULT_STRATEGY) || builtinStrategies()[0])?.id || "";
}

function customBaseOptions() {
  const builtins = builtinStrategies();
  return `<option value="" ${CE.base ? "" : "selected"}>${esc(t("dpi.custom.baseNone"))}</option>` +
    builtins.map((s) => `<option value="${escapeAttr(s.id)}" ${s.id === CE.base ? "selected" : ""}>${esc(s.name)}</option>`).join("");
}

function openCustomEditor(id = null) {
  if (customEl) return;
  const existing = id ? customStrategies().find((s) => s.id === id) : null;
  if (id && !existing) return;
  if (!existing && customStrategies().length >= MAX_CUSTOM_STRATEGIES) {
    toast(t("dpi.custom.limit", { max: MAX_CUSTOM_STRATEGIES }), "warn", 3500);
    return;
  }
  closeDrawer();
  const base = existing ? (existing.base || "") : defaultCustomBase();
  const texts = existing ? argsToSections(existing.args, { dropWf: false }) : builtinSections(base);
  CE = {
    id: existing?.id || null,
    name: existing?.name || "",
    desc: existing?.desc || "",
    experimental: !!existing?.experimental,
    base,
    slots: withOrigins(texts.length ? texts : [""], base),
    mode: "slots",
    text: "",
    report: null,
    verify: null,
    saving: false,
  };
  const title = t(existing ? "dpi.custom.titleEdit" : "dpi.custom.titleNew");
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="drawer-bg" data-dpi-custom-bg></div>
    <aside class="drawer drawer--editor drawer--custom" role="dialog" aria-label="${escapeAttr(title)}">
      <div class="drawer__head">
        <div><div class="drawer__kicker">CUSTOM STRATEGY · WINWS</div><div class="drawer__title">${esc(title)}</div></div>
        <button class="drawer__close" data-dpi-custom-close aria-label="${escapeAttr(t("dpi.editor.close"))}">${ic("close", 16)}</button>
      </div>
      <div class="dpi-editor dpi-custom">
        <div class="dpi-custom__grid">
          <label class="dpi-custom__field">
            <span class="dpi-custom__label">${t("dpi.custom.name")}</span>
            <input type="text" class="dpi-custom__input" id="dpi-custom-name" maxlength="40" autocomplete="off" spellcheck="false"
              placeholder="${escapeAttr(t("dpi.custom.namePlaceholder"))}" value="${escapeAttr(CE.name)}">
          </label>
          <label class="dpi-custom__field">
            <span class="dpi-custom__label">${t("dpi.custom.base")}</span>
            <select class="dpi-fake-select dpi-custom__select" id="dpi-custom-base">${customBaseOptions()}</select>
          </label>
        </div>
        <label class="dpi-custom__field">
          <span class="dpi-custom__label">${t("dpi.custom.desc")}</span>
          <input type="text" class="dpi-custom__input" id="dpi-custom-desc" maxlength="300" autocomplete="off"
            placeholder="${escapeAttr(t("dpi.custom.descPlaceholder"))}" value="${escapeAttr(CE.desc)}">
        </label>
        <label class="dpi-custom__check">
          <input type="checkbox" id="dpi-custom-exp" ${CE.experimental ? "checked" : ""}>
          <span>${t("dpi.custom.experimental")}</span>
        </label>
        <div class="dpi-custom__bar">
          <div class="seg" role="tablist">
            <button class="seg__btn" data-dpi-custom-mode="slots">${t("dpi.custom.slotMode")}</button>
            <button class="seg__btn" data-dpi-custom-mode="text">${t("dpi.custom.textMode")}</button>
          </div>
          <div class="dpi-custom__tools">
            <button class="btn btn--sm" data-dpi-custom-import>${ic("download", 13)} ${t("dpi.custom.importFile")}</button>
            <button class="btn btn--sm" data-dpi-custom-export>${ic("box", 13)} ${t("dpi.custom.exportFile")}</button>
            <button class="btn btn--sm" data-dpi-custom-copy>${ic("list", 13)} ${t("dpi.custom.copyJson")}</button>
          </div>
        </div>
        <div class="dpi-editor__hint" id="dpi-custom-hint"></div>
        <div id="dpi-custom-sections"></div>
        <div class="dpi-custom__status" id="dpi-custom-status" aria-live="polite"></div>
        <div class="dpi-custom__status" id="dpi-custom-verify" aria-live="polite"></div>
        <details class="dpi-custom__preview" id="dpi-custom-preview-wrap" hidden>
          <summary>${t("dpi.custom.preview")}</summary>
          <pre class="dpi-custom__cmd" id="dpi-custom-preview"></pre>
        </details>
      </div>
      <div class="dpi-editor__foot dpi-custom__foot">
        ${existing ? `<button class="btn btn--sm dpi-custom__delete" data-dpi-custom-delete>${ic("trash", 13)} ${t("dpi.custom.delete")}</button>` : "<span></span>"}
        <div class="dpi-editor__actions">
          <button class="btn btn--sm" data-dpi-custom-verify>${ic("cpu", 13)} ${t("dpi.custom.verify")}</button>
          <button class="btn btn--sm" data-dpi-custom-close>${t("dpi.editor.cancel")}</button>
          <button class="btn btn--sm btn--primary" data-dpi-custom-save disabled>${ic("check", 13)} ${t("dpi.editor.save")}</button>
        </div>
      </div>
    </aside>`;
  customEl = wrap;
  document.body.appendChild(wrap);
  wrap.querySelector("#dpi-custom-name").addEventListener("input", (e) => { CE.name = e.target.value; updateCustomSave(); });
  wrap.querySelector("#dpi-custom-desc").addEventListener("input", (e) => { CE.desc = e.target.value; });
  wrap.querySelector("#dpi-custom-exp").addEventListener("change", (e) => { CE.experimental = e.target.checked; });
  wrap.querySelector("#dpi-custom-base").addEventListener("change", (e) => changeCustomBase(e.target.value));
  const sections = wrap.querySelector("#dpi-custom-sections");
  sections.addEventListener("input", onCustomSectionInput);
  sections.addEventListener("focusout", onCustomSectionBlur);
  renderCustomSections();
  scheduleCustomCheck(0);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    wrap.querySelector(".drawer-bg").dataset.open = "true";
    wrap.querySelector(".drawer").dataset.open = "true";
  }));
  setTimeout(() => wrap.querySelector("#dpi-custom-name")?.focus(), 320);
}

function closeCustomEditor() {
  if (!customEl) return;
  const w = customEl;
  customEl = null;
  CE = null;
  clearTimeout(customCheckTimer);
  customCheckSeq++;
  w.querySelector(".drawer-bg").dataset.open = "false";
  w.querySelector(".drawer").dataset.open = "false";
  setTimeout(() => w.remove(), 340);
}

function renderCustomSections() {
  const box = customEl?.querySelector("#dpi-custom-sections");
  if (!box) return;
  customEl.querySelectorAll("[data-dpi-custom-mode]").forEach((b) => { b.dataset.on = String(b.dataset.dpiCustomMode === CE.mode); });
  customEl.querySelector("#dpi-custom-hint").textContent = t(CE.mode === "text" ? "dpi.custom.textHint" : "dpi.custom.slotsHint");
  if (CE.mode === "text") {
    box.innerHTML = `<textarea class="dpi-editor__area dpi-custom__area dpi-custom__area--full" id="dpi-custom-text" spellcheck="false" autocomplete="off"
      placeholder="--filter-tcp=443 --dpi-desync=fake …">${esc(CE.text)}</textarea>`;
    applyCustomIssues();
    return;
  }
  const count = CE.slots.length;
  box.innerHTML = CE.slots.map((slot, i) => {
    const state = sectionState(slot);
    const lines = Math.min(12, Math.max(3, slot.text.split("\n").length + 1));
    const badge = sectionBadge(state);
    const action = (attr, icon, label, disabled = false) =>
      `<button class="dpi-slot__act" ${attr}="${i}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" ${disabled ? "disabled" : ""}>${ic(icon, 13)}</button>`;
    return `<div class="dpi-slot" data-slot="${i}" data-state="${state}">
        <div class="dpi-slot__head">
          <span class="dpi-slot__num">#${i + 1}</span>
          <span class="dpi-slot__label" data-slot-label="${i}">${esc(sectionLabel(slot.text) || t("dpi.custom.slotEmpty"))}</span>
          <span data-slot-badge="${i}">${badge}</span>
          <span class="dpi-slot__acts">
            ${action("data-slot-reset", "refresh", t("dpi.custom.slotReset"))}
            ${action("data-slot-up", "chevronUp", t("dpi.custom.slotUp"), i === 0)}
            ${action("data-slot-down", "chevronDown", t("dpi.custom.slotDown"), i === count - 1)}
            ${action("data-slot-remove", "trash", t("dpi.custom.slotRemove"), count === 1)}
          </span>
        </div>
        <textarea class="dpi-slot__area" data-slot-text="${i}" rows="${lines}" spellcheck="false" autocomplete="off">${esc(slot.text)}</textarea>
        <div class="dpi-slot__issues" data-slot-issues="${i}"></div>
      </div>`;
  }).join("") + `<button class="strat-add dpi-slot__add" data-slot-add>${ic("plus", 14)} ${t("dpi.custom.slotAdd")}</button>`;
  applyCustomIssues();
}

function sectionBadge(state) {
  return state === "same"
    ? ""
    : `<span class="dpi-slot__badge" data-state="${state}">${t(state === "new" ? "dpi.custom.slotNew" : "dpi.custom.slotChanged")}</span>`;
}

function customChanged() {
  CE.verify = null;
  renderCustomVerify();
  scheduleCustomCheck();
}

function onCustomSectionInput(e) {
  if (!CE) return;
  if (e.target.id === "dpi-custom-text") { CE.text = e.target.value; customChanged(); return; }
  const index = Number(e.target.dataset.slotText);
  if (!Number.isInteger(index) || !CE.slots[index]) return;
  CE.slots[index].text = e.target.value;
  const label = customEl.querySelector(`[data-slot-label="${index}"]`);
  if (label) label.textContent = sectionLabel(e.target.value) || t("dpi.custom.slotEmpty");
  renderCustomSectionState(index);
  customChanged();
}

// A pasted block with --new inside one section is split into sections on blur.
function onCustomSectionBlur(e) {
  if (!CE || CE.mode !== "slots") return;
  const index = Number(e.target.dataset?.slotText);
  if (!Number.isInteger(index) || !CE.slots[index]) return;
  if (!splitTokens(CE.slots[index].text).includes("--new")) return;
  const parts = argsToSections(splitTokens(CE.slots[index].text), { dropWf: false }).filter((p) => p.trim());
  CE.slots.splice(index, 1, ...parts.map((text) => ({ text, origin: null })));
  CE.slots = withOrigins(CE.slots.map((s) => s.text), CE.base);
  renderCustomSections();
  customChanged();
}

// Badge of one section, updated in place: re-rendering would replace the textarea
// being typed in. The reset button is shown by CSS for changed sections only.
function renderCustomSectionState(index) {
  const slot = CE?.slots[index];
  const card = customEl?.querySelector(`[data-slot="${index}"]`);
  if (!slot || !card) return;
  const state = sectionState(slot);
  if (card.dataset.state === state) return;
  card.dataset.state = state;
  const badge = card.querySelector(`[data-slot-badge="${index}"]`);
  if (badge) badge.innerHTML = sectionBadge(state);
}

function moveCustomSection(index, delta) {
  const to = index + delta;
  if (to < 0 || to >= CE.slots.length) return;
  const [slot] = CE.slots.splice(index, 1);
  CE.slots.splice(to, 0, slot);
  renderCustomSections();
  customChanged();
}

async function changeCustomBase(id) {
  const select = customEl?.querySelector("#dpi-custom-base");
  const touched = CE.mode === "text" ? !!CE.text.trim() : CE.slots.some((s) => s.text.trim() && sectionState(s) !== "same");
  if (touched) {
    const name = builtinStrategies().find((s) => s.id === id)?.name || t("dpi.custom.baseNone");
    const ok = await openConfirmModal({
      title: t("dpi.custom.baseConfirmTitle"),
      message: t("dpi.custom.baseConfirm", { base: name }),
      confirmLabel: t("dpi.custom.baseConfirmOk"),
      cancelLabel: t("dpi.editor.cancel"),
    });
    if (!CE) return;
    if (!ok) { if (select) select.value = CE.base; return; }
  }
  CE.base = id;
  const texts = builtinSections(id);
  CE.slots = withOrigins(texts.length ? texts : [""], id);
  CE.mode = "slots";
  renderCustomSections();
  customChanged();
}

async function setCustomMode(mode) {
  if (!CE || CE.mode === mode) return;
  if (mode === "text") {
    CE.text = composeCustomText();
    CE.mode = "text";
    renderCustomSections();
    return;
  }
  await loadCustomText(CE.text);
}

// Text, a .bat line or JSON → sections, through the Rust parser so the sections
// are exactly what would be saved. A JSON strategy also brings its name,
// description and flag, and the base it was made from is recognised.
async function loadCustomText(text, { fromFile = false } = {}) {
  let report = null;
  try { report = await invoke("dpi_custom_check", { text }); } catch (e) { toast(String(e?.message || e), "error", 4000); }
  if (!CE) return false;
  let texts;
  if (report?.ok && report.sections?.length) {
    texts = report.sections.map((args) => args.join("\n"));
    if (report.wf_extra?.length) texts[0] = [...report.wf_extra, texts[0]].join("\n");
  } else if (fromFile || !text.trim()) {
    // Nothing usable: keep the user in the full text with the errors shown.
    CE.mode = "text";
    CE.text = text;
    renderCustomSections();
    applyCustomReport(report);
    return false;
  } else {
    texts = argsToSections(splitTokens(text).filter((tok, i, all) => all.slice(0, i + 1).some((x) => x.startsWith("--"))), { dropWf: false });
  }
  const meta = report?.meta || {};
  if (meta.name && (!CE.name.trim() || fromFile)) CE.name = String(meta.name).slice(0, 40);
  if (meta.desc != null && (!CE.desc.trim() || fromFile)) CE.desc = String(meta.desc).slice(0, 300);
  if (typeof meta.experimental === "boolean") CE.experimental = meta.experimental;
  const guessed = guessBase(texts, builtinStrategies());
  if (guessed || fromFile) CE.base = guessed;
  CE.slots = withOrigins(texts, CE.base);
  CE.mode = "slots";
  const set = (sel, prop, value) => { const el = customEl?.querySelector(sel); if (el) el[prop] = value; };
  set("#dpi-custom-name", "value", CE.name);
  set("#dpi-custom-desc", "value", CE.desc);
  set("#dpi-custom-exp", "checked", CE.experimental);
  const select = customEl?.querySelector("#dpi-custom-base");
  if (select) { select.innerHTML = customBaseOptions(); select.value = CE.base; }
  renderCustomSections();
  customChanged();
  return true;
}

async function importCustomFile() {
  let text;
  try { text = await invoke("dpi_custom_import_file"); } catch (e) { toast(t("dpi.custom.importErr", { err: e?.message || e }), "error", 4500); return; }
  if (text == null || !CE) return;
  if (await loadCustomText(text, { fromFile: true })) toast(t("dpi.custom.imported", { name: CE.name || "—" }), "info", 2400);
}

// The strategy in the built-in format: the same shape winws strategies ship in,
// with the full interception, ready to share or import back.
function customJson() {
  const name = CE.name.trim() || "custom";
  const strategy = {
    id: CE.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "custom",
    name,
    desc: CE.desc.trim(),
    experimental: CE.experimental,
    args: CE.report?.args || [],
  };
  return JSON.stringify(strategy, null, 2);
}

async function exportCustomFile() {
  if (!CE?.report?.ok) return;
  try {
    if (await invoke("dpi_custom_export_file", { json: customJson(), name: CE.name.trim() })) toast(t("dpi.custom.exported"), "info", 2000);
  } catch (e) {
    toast(t("dpi.editor.toastErr", { err: e?.message || e }), "error", 4500);
  }
}

async function copyCustomJson() {
  if (!CE?.report?.ok) return;
  try { await navigator.clipboard.writeText(customJson()); toast(t("dpi.custom.copied"), "info", 1800); }
  catch (e) { toast(t("dpi.editor.toastErr", { err: e?.message || e }), "error", 3500); }
}

function scheduleCustomCheck(delay = 300) {
  clearTimeout(customCheckTimer);
  customCheckTimer = setTimeout(runCustomCheck, delay);
}

async function runCustomCheck() {
  if (!CE) return;
  const seq = ++customCheckSeq;
  const text = composeCustomText();
  if (!text.trim()) { applyCustomReport(null); return; }
  try {
    const report = await invoke("dpi_custom_check", { text });
    if (seq !== customCheckSeq || !CE) return;
    applyCustomReport(report);
  } catch (e) {
    if (seq !== customCheckSeq || !CE) return;
    applyCustomReport({ ok: false, issues: [], failure: String(e?.message || e) });
  }
}

function issueHtml(issue, withSection) {
  const text = t("dpi.custom.issue." + issue.code, { arg: issue.arg || "" });
  const shown = withSection && Number.isInteger(issue.section) ? t("dpi.custom.inSection", { n: issue.section + 1, text }) : text;
  const warn = issue.level === "warn";
  return `<div class="dpi-custom__issue" data-level="${warn ? "warn" : "error"}">${ic(warn ? "info" : "alert", 13)}<span>${esc(shown)}</span></div>`;
}

function applyCustomReport(report) {
  if (!CE) return;
  CE.report = report;
  applyCustomIssues();
  const previewWrap = customEl?.querySelector("#dpi-custom-preview-wrap");
  const preview = customEl?.querySelector("#dpi-custom-preview");
  if (previewWrap && preview) {
    previewWrap.hidden = !report?.ok;
    preview.textContent = report?.ok ? report.args.join(" ").split(" --new ").join("\n--new ") : "";
  }
  updateCustomSave();
}

// Section issues go under their section; the rest (and every issue in the
// full-text mode) into the common status block.
function applyCustomIssues() {
  const status = customEl?.querySelector("#dpi-custom-status");
  if (!status || !CE) return;
  const report = CE.report;
  const issues = report?.issues || [];
  const bySlot = CE.mode === "slots" && (report?.ok ? report.sections.length === CE.slots.length : true);
  customEl.querySelectorAll("[data-slot-issues]").forEach((box) => { box.innerHTML = ""; });
  customEl.querySelectorAll("[data-slot]").forEach((card) => { card.dataset.error = "false"; });
  const common = [];
  for (const issue of issues) {
    const box = bySlot && Number.isInteger(issue.section) ? customEl.querySelector(`[data-slot-issues="${issue.section}"]`) : null;
    if (box) {
      box.insertAdjacentHTML("beforeend", issueHtml(issue, false));
      if (issue.level !== "warn") box.closest("[data-slot]").dataset.error = "true";
    } else {
      common.push(issue);
    }
  }
  const head = report?.ok
    ? `<div class="dpi-custom__ok">${ic("check", 13)}<span>${esc(t("dpi.custom.checkOk", { n: report.sections.length }))}</span></div>`
    : "";
  const failure = report?.failure ? `<div class="dpi-custom__issue" data-level="error">${ic("alert", 13)}<span>${esc(report.failure)}</span></div>` : "";
  status.innerHTML = head + failure +
    common.filter((i) => i.level !== "warn").map((i) => issueHtml(i, true)).join("") +
    common.filter((i) => i.level === "warn").map((i) => issueHtml(i, true)).join("");
}

function renderCustomVerify() {
  const box = customEl?.querySelector("#dpi-custom-verify");
  if (!box || !CE) return;
  const v = CE.verify;
  const btn = customEl.querySelector("[data-dpi-custom-verify]");
  if (btn) btn.disabled = !CE.report?.ok || v?.status === "running";
  if (!v) { box.innerHTML = ""; return; }
  const line = (level, icon, text) => `<div class="dpi-custom__issue" data-level="${level}">${ic(icon, 13)}<span>${text}</span></div>`;
  const note = (key) => `<div class="dpi-custom__note">${esc(t(key))}</div>`;
  let html;
  if (v.status === "running") html = note("dpi.custom.verifying");
  else if (v.status === "ok") html = `<div class="dpi-custom__ok">${ic("cpu", 13)}<span>${esc(t("dpi.custom.verifyOk"))}</span></div>`;
  else if (v.status === "failed") html = line("error", "alert", `${esc(t("dpi.custom.verifyFailed"))}<pre class="dpi-custom__out">${esc(v.output || "")}</pre>`);
  else if (v.status === "needsAdmin") html = note("dpi.custom.verifyAdmin");
  else html = note("dpi.custom.verifySkipped");
  if (v.warnings?.length) {
    html += line("warn", "info", `${esc(t("dpi.custom.verifyWarnings"))}<pre class="dpi-custom__out">${esc(v.warnings.join("\n"))}</pre>`);
  }
  box.innerHTML = html;
}

async function verifyCustom() {
  if (!CE?.report?.ok || CE.verify?.status === "running") return CE?.verify;
  const text = composeCustomText();
  CE.verify = { status: "running", forText: text };
  renderCustomVerify();
  let result;
  try {
    result = await invoke("dpi_custom_verify", { text, gameFilter: S.gameFilter, ipset: S.ipset });
  } catch (e) {
    result = { status: "failed", output: String(e?.message || e), warnings: [] };
  }
  if (!CE || CE.verify?.forText !== text) return null;
  CE.verify = { ...result, forText: text };
  renderCustomVerify();
  updateCustomSave();
  return CE.verify;
}

function updateCustomSave() {
  const btn = customEl?.querySelector("[data-dpi-custom-save]");
  if (!btn || !CE) return;
  btn.disabled = CE.saving || !CE.report?.ok || !CE.name.trim() || CE.verify?.status === "running";
  for (const sel of ["[data-dpi-custom-export]", "[data-dpi-custom-copy]"]) {
    const b = customEl.querySelector(sel);
    if (b) b.disabled = !CE.report?.ok;
  }
  const verifyBtn = customEl.querySelector("[data-dpi-custom-verify]");
  if (verifyBtn) verifyBtn.disabled = !CE.report?.ok || CE.verify?.status === "running";
}

async function saveCustomEditor() {
  if (!CE || CE.saving || !CE.report?.ok || !CE.name.trim()) return;
  const text = composeCustomText();
  // winws checks the parameters itself before anything is saved; without
  // administrator rights the check is skipped and happens at launch.
  const verified = CE.verify?.forText === text ? CE.verify : await verifyCustom();
  if (!CE) return;
  if (verified?.status === "failed") { toast(t("dpi.custom.verifyFailed"), "error", 4000); return; }
  CE.saving = true;
  updateCustomSave();
  const editing = CE.id;
  const wasActive = !!editing && stratExact(S.strategy)?.id === editing;
  try {
    const saved = await invoke("dpi_custom_save", {
      id: editing, name: CE.name, desc: CE.desc, experimental: CE.experimental, base: CE.base || null, text,
    });
    closeCustomEditor();
    // The selection is kept by name: follow a rename of the active strategy before
    // loadStrategies would treat the old name as vanished and fall back.
    if (wasActive) {
      S.strategy = saved.name;
      try { localStorage.setItem(LS.strategy, saved.name); } catch {}
    }
    await loadStrategies();
    renderAll();
    if (!editing) {
      // A new strategy is applied right away: "added it and it works".
      await setStrategy(stratByName(saved.id));
    } else {
      if (wasActive) await restartIfRunning();
      toast(t("dpi.custom.toastSaved", { name: saved.name }), "info", 2000);
    }
  } catch (e) {
    if (CE) {
      CE.saving = false;
      updateCustomSave();
    }
    toast(t("dpi.editor.toastErr", { err: e?.message || e }), "error", 4500);
  }
}

async function deleteCustomEditor() {
  if (!CE?.id || CE.saving) return;
  const id = CE.id;
  const name = customStrategies().find((s) => s.id === id)?.name || CE.name;
  const ok = await openConfirmModal({
    title: t("dpi.custom.deleteTitle"),
    message: t("dpi.custom.confirmDelete", { name }),
    confirmLabel: t("dpi.custom.delete"),
    cancelLabel: t("dpi.editor.cancel"),
    danger: true,
  });
  if (!ok || CE?.id !== id) return;
  try {
    await invoke("dpi_custom_delete", { id });
    const wasActive = stratExact(S.strategy)?.id === id;
    closeCustomEditor();
    if (wasActive) {
      S.strategy = (stratExact(DEFAULT_STRATEGY) || builtinStrategies()[0] || STRATEGIES[0]).name;
      try { localStorage.setItem(LS.strategy, S.strategy); } catch {}
    }
    await loadStrategies();
    renderAll();
    if (wasActive) await restartIfRunning();
    toast(t("dpi.custom.toastDeleted", { name }), "info", 2200);
  } catch (e) {
    toast(t("prof.toastErr", { err: e?.message || e }), "error", 4500);
  }
}

// Clicks inside the custom editor. true — handled.
function onCustomEditorClick(target) {
  if (!CE) return false;
  const slotAction = (attr) => {
    const el = target.closest(`[${attr}]`);
    return el ? Number(el.getAttribute(attr)) : null;
  };
  let i;
  if ((i = slotAction("data-slot-up")) != null) { moveCustomSection(i, -1); return true; }
  if ((i = slotAction("data-slot-down")) != null) { moveCustomSection(i, 1); return true; }
  if ((i = slotAction("data-slot-remove")) != null) {
    if (CE.slots.length > 1) { CE.slots.splice(i, 1); renderCustomSections(); customChanged(); }
    return true;
  }
  if ((i = slotAction("data-slot-reset")) != null) {
    const base = builtinSections(CE.base)[CE.slots[i]?.origin];
    if (base != null) { CE.slots[i].text = base; renderCustomSections(); customChanged(); }
    return true;
  }
  if (target.closest("[data-slot-add]")) {
    CE.slots.push({ text: "", origin: null });
    renderCustomSections();
    customEl.querySelector(`[data-slot-text="${CE.slots.length - 1}"]`)?.focus();
    return true;
  }
  const mode = target.closest("[data-dpi-custom-mode]");
  if (mode) { setCustomMode(mode.dataset.dpiCustomMode); return true; }
  if (target.closest("[data-dpi-custom-import]")) { importCustomFile(); return true; }
  if (target.closest("[data-dpi-custom-export]")) { exportCustomFile(); return true; }
  if (target.closest("[data-dpi-custom-copy]")) { copyCustomJson(); return true; }
  if (target.closest("[data-dpi-custom-verify]")) { verifyCustom(); return true; }
  if (target.closest("[data-dpi-custom-save]")) { saveCustomEditor(); return true; }
  if (target.closest("[data-dpi-custom-delete]")) { deleteCustomEditor(); return true; }
  if (target.closest("[data-dpi-custom-close]") || target.closest("[data-dpi-custom-bg]")) { closeCustomEditor(); return true; }
  return false;
}

/* ═══════════ DOMAIN LIST EDITOR (dynamic) ═══════════ */
let editorEl = null;
// kicker is decorative English; title/hint go through t(). file is the name on disk.
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
  let content;
  // We don't open the editor without contents: an empty field and "Save" would wipe
  // a list that simply couldn't be read.
  try {
    content = await invoke("dpi_read_list", { kind });
  } catch (e) {
    toast(e?.message || String(e), "error", 5000);
    return;
  }
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
    const r = await invoke("dpi_write_list", { kind, content: area.value });
    await loadDomains();
    closeListEditor();
    await restartIfRunning(); // apply the fresh list to the engine
    if (r?.ignoredIps) toast(t("dpi.editor.toastIpsIgnored", { n: r.ignoredIps }), "warn", 6000);
    else if (r?.movedIps) toast(t("dpi.editor.toastIpsMoved", { n: r.movedIps }), "info", 3000);
    else toast(kind === "exclude" ? t("dpi.editor.toastExclude") : t("dpi.editor.toastUser"), "info", 1800);
  } catch (e) {
    toast(t("dpi.editor.toastErr", { err: e?.message || e }), "error", 3500);
  }
}

/* ═══════════ EVENT DELEGATION ═══════════ */
function onClick(e) {
  const target = e.target;
  if (target.closest("[data-dpi-toggle]")) { e.preventDefault(); e.stopPropagation(); toggleDpi(); return; }
  if (target.closest("[data-dpi-open]")) { goView("dpi"); return; }
  if (target.closest("[data-dpi-drawer]")) { openDrawer(); return; }
  if (target.closest("[data-dpi-drawer-close]") || target.closest("[data-dpi-drawer-bg]")) { closeDrawer(); return; }
  // The edit button sits inside the strategy row: it must win over row selection.
  const customEdit = target.closest("[data-dpi-custom-edit]");
  if (customEdit) { e.stopPropagation(); openCustomEditor(customEdit.dataset.dpiCustomEdit); return; }
  if (target.closest("[data-dpi-custom-new]")) { openCustomEditor(null); return; }
  if (onCustomEditorClick(target)) return;
  const strat = target.closest("[data-dpi-strat]");
  if (strat) { setStrategy(stratByName(strat.dataset.dpiStrat)); closeDrawer(); return; }
  if (target.closest("[data-dpi-logs]")) { e.preventDefault(); invoke("open_log_dir").catch(() => goView("logs")); return; }
  if (target.closest("[data-dpi-pick-start]")) { pickStart(); return; }
  if (target.closest("[data-dpi-pick-cancel]")) { pickCancel(); return; }
  const apply = target.closest("[data-dpi-pick-apply]");
  if (apply) { pickApply(apply.dataset.dpiPickApply); return; }
  const game = target.closest("[data-dpi-game]");
  if (game) { S.gameFilter = game.dataset.dpiGame; localStorage.setItem(LS.gameFilter, S.gameFilter); renderBody(); restartIfRunning(); return; }
  const ips = target.closest("[data-dpi-ipset]");
  if (ips) {
    S.ipset = ips.dataset.dpiIpset;
    localStorage.setItem(LS.ipset, S.ipset);
    renderBody();
    // The auto-bypass list may have grown while the mode was different: we show
    // the current one, not the one read on entering the section.
    if (S.ipset === "auto") loadAutoDomains().then(renderBody);
    restartIfRunning();
    return;
  }
  const autoForget = target.closest("[data-dpi-auto-forget]");
  if (autoForget) { forgetAutoDomain(autoForget.dataset.dpiAutoForget); return; }
  const autoExclude = target.closest("[data-dpi-auto-exclude]");
  if (autoExclude) { excludeAutoDomain(autoExclude.dataset.dpiAutoExclude); return; }
  if (target.closest("[data-dpi-auto-clear]")) { clearAutoDomains(); return; }
  if (target.closest("[data-dpi-ipset-toggle]")) { S.ipsetOpen = !S.ipsetOpen; renderBody(); return; }
  if (target.closest("[data-dpi-monkey]")) {
    S.monkey = !S.monkey;
    localStorage.setItem(LS.monkey, S.monkey ? "true" : "false");
    renderBody();
    restartWithDriverSwap();
    toast(S.monkey ? t("dpi.monkey.toastOn") : t("dpi.monkey.toastOff"), "info", 2400);
    return;
  }
  const upd = target.closest("[data-dpi-update]");
  if (upd) { runUpdate(upd.dataset.dpiUpdate); return; }
  if (target.closest("[data-dpi-update-check]")) { checkUpdate(true); return; }
  if (target.closest("[data-dpi-cache-clear]")) { clearDiscordCache(); return; }
  const dom = target.closest("[data-dpi-domains]");
  if (dom) { openListEditor(dom.dataset.dpiDomains); return; }
  if (target.closest("[data-dpi-hosts-apply]")) { applyHosts(); return; }
  if (target.closest("[data-dpi-hosts-clear]")) { clearHosts(); return; }
  if (target.closest("[data-dpi-ipset-update]")) { updateIpset(); return; }
  if (target.closest("[data-dpi-editor-close]") || target.closest("[data-dpi-editor-bg]")) { closeListEditor(); return; }
  const save = target.closest("[data-dpi-editor-save]");
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
    // Auto-tuning sets "off" even before stopping winws and waits for UAC and DNS:
    // in this window entering TUN stopped nothing, and the test winws ran
    // on top of TUN, while the probes measured the tunnel. We cancel tuning together with the engine;
    // an enabled bypass will be restored by resumeEngineAfterTun on leaving TUN.
    if (S.autopick.phase === "running") {
      dpiAutopickEpoch++;
      autopickResume = false;
      S.autopick = { phase: "idle", i: 0, total: 0, name: "", best: null, meta: "" };
      const stopped = await stopDpiRuntime({ markOff: false });
      renderAll();
      return stopped;
    }
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
  // Actual engine pause/resume by VPN mode (the risk from the spike: in TUN all
  // traffic is in the tunnel, otherwise winws chews on encrypted VLESS).
  if (mode === "tun") {
    // split Discord: keep winws running (it desyncs direct Discord in TUN).
    // A repeated call with the same TUN is needed when strict is turned off: the saved
    // split becomes active again and must actually bring winws back.
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

// ── Excluding VPN nodes from winws ──
// The main risk from the spike: winws mangles encrypted traffic to our own
// server. ALL nodes of the running config are excluded (not just the first one): in
// an auto-select group the core may switch to any of them. The set is provided by a provider from
// main.js; Rust writes it as one batch and resolves domains itself, but only
// when winws is running or about to start (resolve: true) — otherwise DNS would be
// awaited in vain on every connection.
let vpnNodesProvider = null;
// Host from the old excludeVpnNode(host): taken into account together with the provider.
let legacyEndpointHost = null;
let activeEndpointRevision = 0;
let activeEndpointQueue = Promise.resolve();

export function setVpnNodesProvider(fn) {
  vpnNodesProvider = typeof fn === "function" ? fn : null;
}

// For WARP the address is stored as "ip:port", while the exclusion needs only the host: such
// a string failed the Rust check, and the previous node's exclusion stayed.
function endpointHost(host) {
  const s = String(host).trim();
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(s) || /^([^:\s]+):\d+$/.exec(s);
  return m ? m[1] : s;
}

async function collectVpnNodes() {
  const ips = [];
  const domains = [];
  // Telling "address or name" apart uses the same validator as the routing
  // rules. The old check (/^[0-9a-fA-F:.]+$/ + the presence of a dot)
  // declared any domain made of hex letters an IP address: abc.def, dead.cf, de.ad.
  const add = (raw) => {
    if (raw == null || raw === "") return;
    const host = endpointHost(raw);
    if (!host) return;
    const target = normalizeIp(host) ? ips : domains;
    if (!target.includes(host)) target.push(host);
  };
  // The actual node goes first: Rust resolves a limited number of names, and it must not
  // end up past that threshold on a large subscription.
  add(legacyEndpointHost);
  let provided;
  try { provided = await vpnNodesProvider?.(); } catch { provided = null; }
  for (const value of Array.isArray(provided?.ips) ? provided.ips : []) add(value);
  for (const value of Array.isArray(provided?.domains) ? provided.domains : []) add(value);
  return { ips, domains };
}

// Send the current set of nodes. Requests go one after another, and an outdated one (overtaken
// by a newer one) isn't sent to Rust; Rust additionally discards the response of
// a request that got its DNS after a newer one.
function syncVpnNodeExclusion({ resolve = false, clear = false } = {}) {
  const revision = ++activeEndpointRevision;
  const apply = async () => {
    if (revision !== activeEndpointRevision) return false;
    const nodes = clear ? { ips: [], domains: [] } : await collectVpnNodes();
    if (revision !== activeEndpointRevision) return false;
    await invoke("dpi_set_active_vpn_endpoint", { ...nodes, resolve: !!resolve && nodes.domains.length > 0 });
    return revision === activeEndpointRevision;
  };
  activeEndpointQueue = activeEndpointQueue.then(apply, apply);
  return activeEndpointQueue.catch(() => false);
}

// After connecting or switching the source. While winws isn't running (off or
// paused for TUN), domains aren't resolved: only literals go out, and resolving
// happens before the engine launches.
export function refreshVpnNodeExclusion() {
  // During auto-tuning the state is "off", but the test winws are running:
  // without resolving, the batch would erase already found node IPs.
  return syncVpnNodeExclusion({
    resolve: S.base === "running" || S.base === "starting" || S.autopick.phase === "running",
  });
}

// Compatible wrapper: the active node's host supplements the provider's set.
export function excludeVpnNode(host) {
  if (!host) return Promise.resolve(false);
  legacyEndpointHost = endpointHost(host);
  return refreshVpnNodeExclusion();
}

export function clearVpnNodeExclusion() {
  legacyEndpointHost = null;
  return syncVpnNodeExclusion({ clear: true });
}

export function onDpiViewEnter() {
  checkUpdate().catch(() => {});
}

export async function mountDpiView({ onToast, switchView, ensureElevated: ee } = {}) {
  if (typeof onToast === "function") toast = onToast;
  if (typeof switchView === "function") goView = switchView;
  if (typeof ee === "function") ensureElevated = ee;

  // Delegation on document (not #app-root): the drawer is appended to document.body
  // outside #app-root, so its clicks — close/backdrop/strategy selection — must
  // be caught at the document level.
  document.addEventListener("click", onClick);
  document.addEventListener("change", onChange);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // The confirm dialog (deleting a strategy) handles its own Escape and listens
    // after us: without this check one key press closed the drawer under it too.
    if (document.querySelector(".confirm-modal")) return;
    if (customEl) closeCustomEditor();
    else if (editorEl) closeListEditor();
    else if (drawerEl) closeDrawer();
  });

  // Auto-tuning progress (event from Rust dpi_autotest).
  if (tauriListen) {
    tauriListen("dpi:autotest", (ev) => {
      const d = ev?.payload || {};
      if (S.autopick.phase === "running") {
        S.autopick.i = d.i || S.autopick.i;
        S.autopick.total = d.total || S.autopick.total;
        S.autopick.name = d.name || S.autopick.name;
        // "final" — re-measuring the best candidates, with its own counter.
        S.autopick.stage = d.stage || S.autopick.stage;
        renderBody();
      }
    }).catch(() => {});
    // winws crashed on its own mid-session — the Rust watchdog reports it immediately.
    tauriListen("dpi:exited", (ev) => onDpiExited(ev?.payload)).catch(() => {});
  }

  renderAll();
  await loadStrategies();
  // Actual engine state after the app restarts (UI on top of a live
  // winws). We sync both ways: alive → running + fix LS.enabled;
  // dead but locally considered running → reset to off (so the chip doesn't lie).
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
    loadAutoDomains(),
  ]);
  renderAll();
}
