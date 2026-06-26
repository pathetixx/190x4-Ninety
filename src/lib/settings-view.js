// Ninety · Settings view — 6 разделов навигатором, как в Hiddify.
// Не SPA-роутер: внутренний state хранится в this view (sectionKey).

import {
  loadOptions, saveOptions, updateOption,
  REGIONS, IPV6_MODES, TUN_STACKS, LOG_LEVELS, MUX_PROTOCOLS,
} from "/lib/options.js";
import { BUILD_INFO } from "/lib/build-info.js";
import { availableLangs, getLang, setLang, t } from "/lib/i18n/index.js";
import { mountRoutingRules } from "/lib/routing-view.js";
import { escapeAttr } from "/lib/esc.js";

// Label-карты строятся в рантайме: t() зависит от текущего языка, замораживать
// на import нельзя. SECTIONS держит только key+icon; title/hint берём через t().
const warpModeLabels  = () => ({ direct: t("settings.enums.warpMode.direct"), chain: t("settings.enums.warpMode.chain") });
const warpNoiseLabels = () => ({
  off: t("settings.enums.warpNoise.off"), default: t("settings.enums.warpNoise.default"),
  aggressive: t("settings.enums.warpNoise.aggressive"), custom: t("settings.enums.warpNoise.custom"),
});

const SECTIONS = [
  { key: "general",    icon: iconGeneral },
  { key: "appearance", icon: iconTheme },
  { key: "routing",    icon: iconRouting },
  { key: "dns",        icon: iconDns },
  { key: "inbound",    icon: iconInbound },
  { key: "tls-tricks", icon: iconTls },
  { key: "mux",        icon: iconMux },
  { key: "warp",       icon: iconWarp },
  { key: "quality",    icon: iconBroadcast },
  { key: "about",      icon: iconInfo },
];

const secTitle = (key) => t(`settings.sec.${key}.title`);
const secHint  = (key) => t(`settings.sec.${key}.hint`);

const THEMES = [
  { id: "kurogane",  name: "Kurogane",  kicker: "NEON · RED",  accent: "#DE5772", glow: "rgba(192,48,74,0.35)" },
  { id: "cyan",      name: "Cyan",      kicker: "SECURED · CYAN", accent: "#6CF2F2", glow: "rgba(31,214,214,0.45)" },
  { id: "synthwave", name: "Synthwave", kicker: "VIOLET WAVE", accent: "#E0A6FF", glow: "rgba(199,125,255,0.35)" },
  { id: "matrix",    name: "Matrix",    kicker: "EMERALD",     accent: "#5CEE92", glow: "rgba(43,214,106,0.35)" },
  { id: "mono",      name: "Mono",      kicker: "MONOCHROME",  accent: "#FFFFFF", glow: "rgba(255,255,255,0.25)" },
  { id: "command",   name: "Command Center", kicker: "CMD · CRIMSON", accent: "#FF3355", glow: "rgba(255,45,70,0.45)" },
];

const regionLabels = () => ({
  other: t("settings.enums.region.other"), ru: t("settings.enums.region.ru"), cn: t("settings.enums.region.cn"),
  ir: t("settings.enums.region.ir"), tr: t("settings.enums.region.tr"), by: t("settings.enums.region.by"),
});

const ipv6Labels = () => ({
  disable: t("settings.enums.ipv6.disable"), enable: t("settings.enums.ipv6.enable"),
  prefer: t("settings.enums.ipv6.prefer"), only: t("settings.enums.ipv6.only"),
});

const tunStackLabels = () => ({
  mixed: t("settings.enums.tunStack.mixed"), gvisor: t("settings.enums.tunStack.gvisor"), system: t("settings.enums.tunStack.system"),
});

// Уровни логов — литеральные имена sing-box, не переводятся.
const LOG_LABELS = {
  trace: "trace", debug: "debug", info: "info", warn: "warn", error: "error",
};

const muxProtocolLabels = () => ({
  h2mux: t("settings.enums.mux.h2mux"), smux: t("settings.enums.mux.smux"), yamux: t("settings.enums.mux.yamux"),
});

let currentSection = null; // null = menu
let currentSubsection = null; // вложенный уровень внутри секции (напр. routing→routing-rules)

export function mountSettings(root, opts = {}) {
  if (!root) return;
  const onChange = opts.onChange || (() => {});
  const onRender = opts.onRender || (() => {});
  // Живой инстанс под-экрана «Правила маршрутизации» — чтобы погасить его
  // монитор-таймер при уходе назад.
  let routingRulesInstance = null;
  function render() {
    if (!currentSection) {
      root.innerHTML = renderMenu();
      bindMenu(root);
    } else if (currentSection === "routing" && currentSubsection === "routing-rules") {
      root.innerHTML = renderRoutingRulesSub();
      bindRoutingRulesSub(root, onChange);
    } else {
      const sec = SECTIONS.find(s => s.key === currentSection);
      root.innerHTML = renderSection(sec);
      bindSection(root, sec, onChange);
    }
    onRender(currentSection);
  }

  // Под-экран «Правила маршрутизации»: settings-head (с back → назад в
  // «Маршрутизация») + точка монтирования rr-блока.
  function renderRoutingRulesSub() {
    return `
    <header class="settings-head">
      <button class="settings-back" data-back-sub type="button" aria-label="${t("settings.back")}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <h2 class="settings-head__title">${t("settings.routingRulesTitle")}</h2>
    </header>
    <div id="rr-rules-mount"></div>
  `;
  }
  function bindRoutingRulesSub(el, onChange) {
    el.querySelector("[data-back-sub]")?.addEventListener("click", () => {
      if (routingRulesInstance) { routingRulesInstance.destroy?.(); routingRulesInstance = null; }
      currentSubsection = null;
      render();
    });
    const mount = el.querySelector("#rr-rules-mount");
    if (mount) routingRulesInstance = mountRoutingRules(mount, { onChange, hideTitle: true });
  }
  function bindMenu(el) {
    el.querySelectorAll("[data-section]").forEach(item => {
      item.addEventListener("click", () => {
        currentSection = item.dataset.section;
        currentSubsection = null;
        render();
      });
    });
  }
  function bindSection(el, sec, onChange) {
    el.querySelector("[data-back]")?.addEventListener("click", () => {
      currentSection = null;
      render();
    });
    // <input>/<select> с data-opt — старая логика (change/blur → value)
    el.querySelectorAll("input[data-opt], select[data-opt]").forEach(input => {
      const path = input.dataset.opt;
      const handler = async () => {
        const value = readInput(input);
        updateOption(path, value);
        if (input.dataset.action === "autostart") {
          try {
            const invoke = window.__TAURI__?.core?.invoke;
            const cmd = value ? "plugin:autostart|enable" : "plugin:autostart|disable";
            if (invoke) await invoke(cmd);
          } catch (e) { console.warn("autostart toggle failed", e); }
        }
        onChange(path, value);
        if (input.dataset.affectsView) render();
      };
      input.addEventListener("change", handler);
      if (input.type === "number" || input.type === "text" || input.type === "url") {
        input.addEventListener("blur", handler);
      }
    });
    // .switch[data-on][data-opt] — новый toggle (click переключает)
    el.querySelectorAll(".switch[data-opt]").forEach(sw => {
      const path = sw.dataset.opt;
      sw.addEventListener("click", async () => {
        const newVal = sw.dataset.on !== "true";
        sw.dataset.on = String(newVal);
        updateOption(path, newVal);
        if (sw.dataset.action === "autostart") {
          try {
            const invoke = window.__TAURI__?.core?.invoke;
            const cmd = newVal ? "plugin:autostart|enable" : "plugin:autostart|disable";
            if (invoke) await invoke(cmd);
          } catch (e) { console.warn("autostart toggle failed", e); }
        }
        onChange(path, newVal);
        if (sw.dataset.affectsView) render();
      });
    });
    el.querySelectorAll("[data-action='check-updates']").forEach(btn => {
      btn.addEventListener("click", () => window.__ninetyUpdateCheck?.());
    });
    bindAlwaysAdmin(el, sec);
    bindWarpSection(el, sec, onChange);
    bindAppearanceSection(el, sec);
    bindAboutSection(el, sec);
    bindRoutingSection(el, sec, onChange);
  }

  // Секция «Маршрутизация»: строка-ссылка в под-экран «Правила маршрутизации».
  // Сам rr-блок монтируется отдельным под-экраном (routing-view.js).
  function bindRoutingSection(el, sec) {
    if (sec.key !== "routing") return;
    el.querySelector("[data-subsection='routing-rules']")?.addEventListener("click", () => {
      currentSubsection = "routing-rules";
      render();
    });
  }

  // Секция «О программе»: подставляем версию приложения и открываем репозиторий
  // в системном браузере (через shell-плагин; Tauri перехватывает обычную
  // навигацию, поэтому внешние ссылки только так).
  async function bindAboutSection(el, sec) {
    if (sec.key !== "about") return;
    // Версия — авторитетно из рантайма (tauri.conf), подставляем и в паспорт,
    // и в чип идентичности. build-info даёт лишь дев-фолбэк до загрузки.
    try {
      const v = await window.__TAURI__?.app?.getVersion?.();
      if (v) {
        const specVer = el.querySelector("#about-version");
        if (specVer) specVer.textContent = v;
        const chip = el.querySelector("#about-version-chip");
        if (chip) chip.textContent = `v${v}`;
      }
    } catch {}
    el.querySelector("#about-repo")?.addEventListener("click", () => openExternal(REPO_URL));
    el.querySelector("#about-license")?.addEventListener("click", () => openExternal(LICENSE_URL));
  }

  function openExternal(url) {
    try {
      const open = window.__TAURI__?.shell?.open;
      if (open) { open(url); return; }
    } catch {}
    try { window.open(url, "_blank"); } catch {}
  }

  // Тумблер «Всегда запускать от администратора» (секция Общие). Состояние
  // живёт не в options-localStorage, а в маркер-файле на стороне Rust
  // (is_always_admin/set_always_admin) — поэтому биндим отдельно от generic
  // switch'ей. При включении на следующих стартах Ninety сам перезапустится
  // с UAC (см. setup() в lib.rs) — нужно для TUN без ручного запроса прав.
  async function bindAlwaysAdmin(el, sec) {
    if (sec.key !== "general") return;
    const invoke = window.__TAURI__?.core?.invoke;
    const sw = el.querySelector("#always-admin-switch");
    if (!invoke || !sw) return;
    try {
      const on = await invoke("is_always_admin");
      sw.dataset.on = String(!!on);
    } catch {}
    sw.addEventListener("click", async () => {
      const newVal = sw.dataset.on !== "true";
      sw.dataset.on = String(newVal);
      try {
        await invoke("set_always_admin", { enable: newVal });
      } catch (e) {
        sw.dataset.on = String(!newVal); // откат при ошибке
        alert(t("settings.general.adminSaveErr", { err: e?.message || e }));
      }
    });
  }

  function bindAppearanceSection(el, sec) {
    if (sec.key !== "appearance") return;
    el.querySelector("#settings-lang")?.addEventListener("change", async (e) => {
      await setLang(e.target.value);
      render(); // обновить подписи раздела на новом языке
    });
    el.querySelectorAll(".theme-card[data-theme]").forEach(card => {
      card.addEventListener("click", () => {
        const id = card.dataset.theme;
        // главный setter в main.js пишет localStorage + меняет data-theme на корне
        window.__ninetySetTheme?.(id);
        el.querySelectorAll(".theme-card[data-theme]").forEach(c => {
          c.dataset.on = String(c.dataset.theme === id);
        });
      });
    });
  }

  async function bindWarpSection(el, sec, onChange) {
    if (sec.key !== "warp") return;
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;

    const statusEl = el.querySelector("#warp-status");
    const ipv4El = el.querySelector("#warp-ipv4");
    const licenseInput = el.querySelector("#warp-license-input");
    const registerBtn = el.querySelector("[data-action='warp-register']");
    const resetBtn = el.querySelector("[data-action='warp-reset']");

    const formatStatus = (info) => {
      if (!info) return { status: t("settings.warp.statusUnreg"), ipv4: "—", license: "" };
      const plus = info.warp_plus ? " · WARP+" : "";
      const type = info.account_type ? `${info.account_type}${plus}` : (info.warp_plus ? "WARP+" : "free");
      return {
        status: t("settings.warp.statusActive", { type }),
        ipv4: info.local_ipv4 || "—",
        license: info.license || "",
      };
    };

    const refresh = async () => {
      try {
        const info = await invoke("warp_status");
        const v = formatStatus(info);
        if (statusEl) statusEl.textContent = v.status;
        if (ipv4El) ipv4El.textContent = v.ipv4;
        if (licenseInput) licenseInput.value = v.license;
      } catch (e) {
        if (statusEl) statusEl.textContent = t("settings.warp.statusErr", { err: e?.message || e });
      }
    };

    registerBtn?.addEventListener("click", async () => {
      const orig = registerBtn.textContent;
      registerBtn.disabled = true;
      registerBtn.textContent = t("settings.warp.registering");
      try {
        const license = licenseInput?.value?.trim() || null;
        await invoke("warp_register", { license });
        await refresh();
        onChange("warp.registered", true);
      } catch (e) {
        alert(t("settings.warp.registerErr", { err: e?.message || e }));
      } finally {
        registerBtn.disabled = false;
        registerBtn.textContent = orig;
      }
    });

    resetBtn?.addEventListener("click", async () => {
      if (!confirm(t("settings.warp.resetConfirm"))) return;
      const orig = resetBtn.textContent;
      resetBtn.disabled = true;
      resetBtn.textContent = t("settings.warp.resetting");
      try {
        await invoke("warp_reset");
        await refresh();
        onChange("warp.registered", false);
      } catch (e) {
        alert(t("settings.warp.resetErr", { err: e?.message || e }));
      } finally {
        resetBtn.disabled = false;
        resetBtn.textContent = orig;
      }
    });

    const scanBtn = el.querySelector("[data-action='warp-scan']");
    const scanResults = el.querySelector("#warp-scan-results");
    const scanStatus = el.querySelector("#warp-scan-status");
    const scanList = el.querySelector("#warp-scan-list");

    scanBtn?.addEventListener("click", async () => {
      const orig = scanBtn.textContent;
      scanBtn.disabled = true;
      scanBtn.textContent = t("settings.warp.scanning");
      if (scanResults) scanResults.hidden = false;
      const deep = !!loadOptions().warp?.deepScan;
      // mode=auto: WG handshake если warp.json есть, иначе TCP. Backend сам определит.
      if (scanStatus) scanStatus.textContent = deep
        ? t("settings.warp.scanStatusDeep")
        : t("settings.warp.scanStatusNormal");
      if (scanList) scanList.innerHTML = "";
      try {
        const results = await invoke("warp_scan_endpoints", { topN: 10, deep, mode: "auto" });
        if (!Array.isArray(results) || results.length === 0) {
          if (scanStatus) scanStatus.textContent = t("settings.warp.scanNone");
          return;
        }
        const method = results[0]?.method === "wg" ? "WG-handshake" : "TCP-ping";
        if (scanStatus) scanStatus.textContent = t("settings.warp.scanTop", { n: results.length, method });
        if (scanList) scanList.innerHTML = results.map(r => `
          <div class="setting-row">
            <span class="setting-row__icon">${iconTarget()}</span>
            <span class="setting-row__main">
              <span class="setting-row__label">${r.ip}:${r.port}</span>
              <span class="setting-row__hint">${t("settings.warp.scanRowHint", { ms: r.latency_ms, method: r.method })}</span>
            </span>
            <span class="setting-row__control">
              <button class="btn btn--sm" data-scan-pick="${r.ip}:${r.port}" type="button">${t("settings.warp.applyBtn")}</button>
            </span>
          </div>
        `).join("");
      } catch (e) {
        if (scanStatus) scanStatus.textContent = t("settings.warp.scanErr", { err: e?.message || e });
      } finally {
        scanBtn.disabled = false;
        scanBtn.textContent = orig;
      }
    });

    scanList?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-scan-pick]");
      if (!btn) return;
      const endpoint = btn.dataset.scanPick;
      updateOption("warp.endpoint", endpoint);
      // Перерисуем — input выше получит новое значение
      onChange("warp.endpoint", endpoint);
      render();
    });

    // История ротаций — читается из localStorage, обновляется по событию.
    const historyList = el.querySelector("#warp-history-list");
    const historyCount = el.querySelector("#warp-history-count");
    const renderHistory = () => {
      let items = [];
      try { items = JSON.parse(localStorage.getItem("ninety.warp.history") || "[]"); } catch {}
      if (historyCount) historyCount.textContent = items.length ? t("settings.warp.histCount", { n: items.length }) : t("settings.warp.histEmpty");
      if (!historyList) return;
      if (!items.length) { historyList.innerHTML = ""; return; }
      historyList.innerHTML = items.map(it => {
        const d = new Date(it.ts);
        const ts = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")} ${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}`;
        return `<div class="setting-row">
          <span class="setting-row__icon">${iconRemote()}</span>
          <span class="setting-row__main">
            <span class="setting-row__label">${it.to}</span>
            <span class="setting-row__hint">${t("settings.warp.histRowHint", { ts, newDelay: it.newDelay, old: it.oldDelay || "—", from: it.from })}</span>
          </span>
        </div>`;
      }).join("");
    };
    renderHistory();
    const hHandler = () => renderHistory();
    window.addEventListener("ninety:warp-rotation", hHandler);
    // При перерисовке секции (back→warp снова) bindWarpSection вызывается заново —
    // старый listener останется, но он идемпотентен; cleanup опускаем для простоты.

    refresh();
  }

  render();

  return {
    refresh: render,
    goMenu: () => { currentSection = null; render(); },
  };
}

function readInput(input) {
  if (input.type === "checkbox") return !!input.checked;
  if (input.type === "number") {
    const n = Number(input.value);
    return Number.isFinite(n) ? n : 0;
  }
  return input.value;
}

// ── Меню (главная settings) ────────────────────────────────
function renderMenu() {
  return `
    <header class="settings-head settings-head--root">
      <h2 class="settings-head__title">${t("settings.title")}</h2>
    </header>
    <div class="settings-menu">
      ${SECTIONS.map(s => `
        <button class="settings-menu__item" data-section="${s.key}" type="button">
          <span class="settings-menu__icon">${s.icon()}</span>
          <span class="settings-menu__body">
            <span class="settings-menu__title">${secTitle(s.key)}</span>
            <span class="settings-menu__hint">${secHint(s.key)}</span>
          </span>
          <span class="settings-menu__chevron">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
          </span>
        </button>
      `).join("")}
    </div>
  `;
}

// ── Подраздел ──────────────────────────────────────────────
function renderSection(sec) {
  const o = loadOptions();
  return `
    <header class="settings-head">
      <button class="settings-back" data-back type="button" aria-label="${t("settings.back")}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <h2 class="settings-head__title">${secTitle(sec.key)}</h2>
    </header>
    ${renderSectionBody(sec, o)}
  `;
}

function renderSectionBody(sec, o) {
  switch (sec.key) {
    case "general":    return renderGeneral(o);
    case "appearance": return renderAppearance(o);
    case "routing":    return renderRouting(o);
    case "dns":        return renderDns(o);
    case "inbound":    return renderInbound(o);
    case "tls-tricks": return renderTlsTricks(o);
    case "mux":        return renderMux(o);
    case "warp":       return renderWarp(o);
    case "quality":    return renderQuality(o);
    case "about":      return renderAbout(o);
  }
  return "";
}

function renderQuality(o) {
  const q = o.quality || {};
  return `
    <div class="settings-banner">${t("settings.quality.banner")}</div>
    <div class="settings-section">
      ${row(iconBroadcast(), t("settings.quality.watchTitle"), t("settings.quality.watchHint"), toggle("quality.enabled", q.enabled !== false))}
      ${row(iconRocket(), t("settings.quality.autoTitle"), t("settings.quality.autoHint"), toggle("quality.aggressive", !!q.aggressive))}
      ${row(iconEyeOff(), t("settings.quality.saveTitle"), t("settings.quality.saveHint"), toggle("quality.lowDataMode", !!q.lowDataMode))}
    </div>
    <div class="settings-section">
      ${row(iconTarget(), t("settings.quality.thrTitle"), t("settings.quality.thrHint"), select("quality.goodBps", String(q.goodBps ?? 1500000), ["750000", "1500000", "3000000", "6000000"], { "750000": t("settings.enums.qualityGood.750000"), "1500000": t("settings.enums.qualityGood.1500000"), "3000000": t("settings.enums.qualityGood.3000000"), "6000000": t("settings.enums.qualityGood.6000000") }))}
      ${row(iconClock(), t("settings.quality.intTitle"), t("settings.quality.intHint"), inputText("quality.idleProbeSec", q.idleProbeSec ?? 300, "number", 'min="60" max="900"'))}
    </div>
  `;
}

function renderAppearance() {
  const current = localStorage.getItem("ninety.theme") || "kurogane";
  const langOpts = availableLangs()
    .map(l => `<option value="${l.code}"${l.code === getLang() ? " selected" : ""}>${l.name}</option>`)
    .join("");
  const langRow = row(null, t("settings.language"), t("settings.languageHint"),
    `<select class="settings-select" id="settings-lang">${langOpts}</select>`);
  const cards = THEMES.map(th => `
    <div class="theme-card" data-theme="${th.id}" data-on="${current === th.id}"
         style="--theme-accent:${th.accent};--theme-glow:${th.glow};">
      <div class="theme-card__check">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>
      </div>
      <div class="theme-card__top">
        <span class="theme-card__dot"></span>
        <span class="theme-card__kicker">${th.kicker}</span>
      </div>
      <div class="theme-card__name">${th.name}</div>
      <div class="theme-card__swatches">
        <span style="opacity:1"></span>
        <span style="opacity:0.7"></span>
        <span style="opacity:0.45"></span>
        <span style="opacity:0.22"></span>
      </div>
    </div>
  `).join("");
  return `
    ${langRow}
    <div class="settings-banner">${t("settings.appearance.themeBanner")}</div>
    <div class="theme-grid">${cards}</div>
  `;
}

// helpers — новые премиум-токены (.set-row, .switch[data-on], .seg)
function row(_icon, label, hint, control) {
  // _icon более не показываем — премиум-эстетика без декоративных иконок в строках
  return `
    <div class="set-row">
      <div class="set-row__lbl">
        <div class="set-row__t">${label}</div>
        ${hint ? `<div class="set-row__d">${hint}</div>` : ""}
      </div>
      <div class="set-row__ctl">${control}</div>
    </div>
  `;
}

function toggle(path, checked, extra = {}) {
  const action = extra.action ? `data-action="${extra.action}"` : "";
  const affects = extra.affectsView ? `data-affects-view="true"` : "";
  return `<span class="switch" data-opt="${path}" data-on="${checked ? "true" : "false"}" ${action} ${affects}></span>`;
}

function select(path, value, options, labels = {}, affectsView = false) {
  const opts = options.map(v => `<option value="${v}" ${v === value ? "selected" : ""}>${labels[v] || v}</option>`).join("");
  return `<select class="settings-select" data-opt="${path}" ${affectsView ? "data-affects-view" : ""}>${opts}</select>`;
}

function inputText(path, value, type = "text", attrs = "") {
  const cls = type === "number" ? "settings-input settings-input--num" : "settings-input";
  return `<input class="${cls}" type="${type}" value="${escapeAttr(value ?? "")}" data-opt="${path}" ${attrs}/>`;
}

function rangeRow(label, hint, fromPath, fromVal, toPath, toVal) {
  return `
    <div class="set-row">
      <div class="set-row__lbl">
        <div class="set-row__t">${label}</div>
        ${hint ? `<div class="set-row__d">${hint}</div>` : ""}
      </div>
      <div class="set-row__ctl settings-range">
        <input class="settings-input settings-input--num" type="number" value="${fromVal}" data-opt="${fromPath}"/>
        <span class="settings-range__sep">—</span>
        <input class="settings-input settings-input--num" type="number" value="${toVal}" data-opt="${toPath}"/>
      </div>
    </div>
  `;
}

function settingsBtn(action, label, primary = false) {
  return `<button class="btn btn--sm${primary ? " btn--primary" : ""}" data-action="${action}" type="button">${label}</button>`;
}

// ── Разделы ────────────────────────────────────────────────
function renderGeneral(o) {
  const g = o.general || {};
  return `
    <div class="settings-section">
      ${row(iconShield(), t("settings.general.adminTitle"), t("settings.general.adminHint"), `<span class="switch" id="always-admin-switch" data-on="false"></span>`)}
      ${row(iconRocket(), t("settings.general.autostartTitle"), t("settings.general.autostartHint"), toggle("general.autostart", g.autostart, { action: "autostart" }))}
      ${row(iconEyeOff(), t("settings.general.startMinTitle"), t("settings.general.startMinHint"), toggle("general.startMinimized", g.startMinimized))}
      ${row(iconShield(), t("settings.general.wifiTitle"), t("settings.general.wifiHint"), toggle("general.autoProtectWifi", !!g.autoProtectWifi))}
      ${row(iconShield(), t("settings.general.killTitle"), t("settings.general.killHint"), toggle("general.killSwitch", !!g.killSwitch))}
    </div>
    <div class="settings-section">
      ${row(iconUrl(), t("settings.general.testUrlTitle"), t("settings.general.testUrlHint"), inputText("urlTest.connectionTestUrl", o.urlTest.connectionTestUrl, "url"))}
      ${row(iconClock(), t("settings.general.testIntTitle"), t("settings.general.testIntHint"), inputText("urlTest.intervalSec", o.urlTest.intervalSec, "number", 'min="30" max="3600"'))}
      ${row(iconLog(), t("settings.general.logLevelTitle"), t("settings.general.logLevelHint"), select("log.level", o.log.level, LOG_LEVELS, LOG_LABELS))}
      ${row(iconLog(), t("settings.general.logOffTitle"), t("settings.general.logOffHint"), toggle("log.disabled", !!o.log.disabled))}
    </div>
  `;
}

function renderRouting(o) {
  return `
    <div class="settings-section">
      ${row(iconPin(), t("settings.routing.regionTitle"), t("settings.routing.regionHint"), select("region", o.region, REGIONS, regionLabels(), true))}
      ${row(iconShield(), t("settings.routing.adsTitle"), t("settings.routing.adsHint"), toggle("blockAds", o.blockAds))}
      ${row(iconLan(), t("settings.routing.lanTitle"), t("settings.routing.lanHint"), toggle("route.bypassLan", o.route.bypassLan))}
      ${row(iconTarget(), t("settings.routing.destTitle"), t("settings.routing.destHint"), toggle("route.resolveDestination", o.route.resolveDestination))}
      ${row(iconIpv6(), t("settings.routing.ipv6Title"), t("settings.routing.ipv6Hint"), select("route.ipv6Mode", o.route.ipv6Mode, IPV6_MODES, ipv6Labels()))}
      ${row(iconRouting(), t("settings.routing.discordTitle"), t("settings.routing.discordHint"), toggle("route.tunSplitDiscord", o.route.tunSplitDiscord))}
    </div>
    <div class="settings-section">
      ${subNavRow(t("settings.routing.rulesNavTitle"), t("settings.routing.rulesNavHint"), "routing-rules")}
    </div>
  `;
}

// Строка-ссылка в под-экран (визуально как row(...), но кликабельна и с шевроном
// справа). Клик ловит bindRoutingSection по data-subsection.
function subNavRow(label, hint, subsection) {
  return `
    <button class="set-row set-row--nav" data-subsection="${subsection}" type="button">
      <div class="set-row__lbl">
        <div class="set-row__t">${label}</div>
        ${hint ? `<div class="set-row__d">${hint}</div>` : ""}
      </div>
      <span class="settings-menu__chevron">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </span>
    </button>
  `;
}

function renderDns(o) {
  return `
    <div class="settings-section">
      ${row(iconRemote(), t("settings.dns.remoteTitle"), t("settings.dns.remoteHint"), inputText("dns.remoteAddress", o.dns.remoteAddress, "text"))}
      ${row(iconDirect(), t("settings.dns.directTitle"), t("settings.dns.directHint"), inputText("dns.directAddress", o.dns.directAddress, "text"))}
      ${row(iconCache(), t("settings.dns.cacheTitle"), t("settings.dns.cacheHint"), toggle("dns.independentCache", o.dns.independentCache))}
      ${row(iconMask(), t("settings.dns.fakeTitle"), t("settings.dns.fakeHint"), toggle("dns.enableFakeDns", o.dns.enableFakeDns))}
    </div>
  `;
}

function renderInbound(o) {
  return `
    <div class="settings-section">
      ${row(iconPort(), t("settings.inbound.portTitle"), t("settings.inbound.portHint"), inputText("inbound.mixedPort", o.inbound.mixedPort, "number", 'min="1024" max="65535"'))}
      ${row(iconMtu(), t("settings.inbound.mtuTitle"), t("settings.inbound.mtuHint"), inputText("inbound.mtu", o.inbound.mtu, "number", 'min="576" max="9000"'))}
      ${row(iconStack(), t("settings.inbound.stackTitle"), t("settings.inbound.stackHint"), select("inbound.tunStack", o.inbound.tunStack, TUN_STACKS, tunStackLabels()))}
      ${row(iconLock(), t("settings.inbound.strictTitle"), t("settings.inbound.strictHint"), toggle("inbound.strictRoute", o.inbound.strictRoute))}
      ${row(iconBroadcast(), t("settings.inbound.lanTitle"), t("settings.inbound.lanHint"), toggle("inbound.allowConnectionFromLan", o.inbound.allowConnectionFromLan))}
    </div>
  `;
}

function renderTlsTricks(o) {
  return `
    <div class="settings-banner">${t("settings.tls.banner")}</div>
    <div class="settings-section">
      ${row(iconScissors(), t("settings.tls.fragTitle"), t("settings.tls.fragHint"), toggle("tlsTricks.enableFragment", o.tlsTricks.enableFragment))}
      ${row(iconScissors(), t("settings.tls.modeTitle"), t("settings.tls.modeHint"), select("tlsTricks.fragmentMode", o.tlsTricks.fragmentMode, ["record", "tcp"], { record: t("settings.enums.fragmentMode.record"), tcp: t("settings.enums.fragmentMode.tcp") }))}
      ${row(iconCase(), t("settings.tls.sniTitle"), t("settings.tls.sniHint"), toggle("tlsTricks.mixedSniCase", o.tlsTricks.mixedSniCase))}
      ${row(iconPad(), t("settings.tls.padTitle"), t("settings.tls.padHint"), toggle("tlsTricks.enablePadding", o.tlsTricks.enablePadding))}
      ${rangeRow(t("settings.tls.padSizeTitle"), t("settings.tls.padSizeHint"), "tlsTricks.paddingSize.from", o.tlsTricks.paddingSize.from, "tlsTricks.paddingSize.to", o.tlsTricks.paddingSize.to)}
    </div>
  `;
}

function renderMux(o) {
  const m = o.mux || {};
  const enabled = !!m.enable;
  return `
    <div class="settings-banner">${t("settings.mux.banner")}</div>
    <div class="settings-section">
      ${row(iconMux(), t("settings.mux.enableTitle"), t("settings.mux.enableHint"), toggle("mux.enable", enabled, { affectsView: true }))}
      ${enabled ? `
      ${row(iconMux(), t("settings.mux.protoTitle"), t("settings.mux.protoHint"), select("mux.protocol", m.protocol || "h2mux", MUX_PROTOCOLS, muxProtocolLabels()))}
      ${row(iconPort(), t("settings.mux.streamsTitle"), t("settings.mux.streamsHint"), inputText("mux.maxStreams", m.maxStreams ?? 8, "number", 'min="1" max="1024"'))}
      ${row(iconPad(), t("settings.mux.padTitle"), t("settings.mux.padHint"), toggle("mux.padding", !!m.padding))}
      ` : ""}
    </div>
  `;
}

const REPO_URL = "https://github.com/pathetixx/190x4-Ninety";
const LICENSE_URL = "https://github.com/pathetixx/190x4-Ninety/blob/main/LICENSE";

const ABOUT_PROTOCOLS = ["VLESS", "VMess", "Trojan", "Shadowsocks", "Hysteria2", "TUIC", "NaiveProxy", "TrustTunnel"];
// Режимы переиспользуют каталог главной (mode.*), чтобы не дублировать переводы.
const aboutModes = () => [t("mode.proxy"), t("mode.systemProxy"), t("mode.tun")];

function aboutSpecCell(icon, key, value) {
  return `<div class="about-spec__cell">
    <span class="about-spec__icon">${icon}</span>
    <span class="about-spec__k">${key}</span>
    <span class="about-spec__dots"></span>
    <span class="about-spec__v">${value}</span>
  </div>`;
}

// Паспорт сборки. Версия — из рантайма (bindAboutSection подставит в #about-*),
// остальное — из build-info.js (commit/date/core/channel запекает CI).
function renderAbout() {
  const b = BUILD_INFO;
  const ver = b.version || "—";
  const protos = ABOUT_PROTOCOLS.map(p => `<span class="about-chip">${p}</span>`).join("");
  const modes = aboutModes().map(m => `<span class="about-chip about-chip--mode">${m}</span>`).join("");
  return `
    <div class="about__col">
      <section class="about-id">
        <div class="about-id__mark"><img src="/assets/ninety-mark.png" alt="Ninety"></div>
        <span class="about-id__badge">190×4</span>
        <h1 class="about-id__name">Ninety</h1>
        <div class="about-id__ver">
          <span class="about-id__chip" id="about-version-chip">v${ver}</span>
          <span class="about-id__sep"></span>
          <span class="about-id__channel">${b.channel}</span>
        </div>
        <p class="about-id__tag">${t("settings.about.tag")}</p>
      </section>

      <p class="about-desc">${t("settings.about.desc")}</p>

      <div class="about-tags">
        <div class="about-tags__group">
          <div class="about-tags__label">${t("settings.about.protocols")}</div>
          <div class="about-tags__row">${protos}</div>
        </div>
        <div class="about-tags__group">
          <div class="about-tags__label">${t("settings.about.modes")}</div>
          <div class="about-tags__row">${modes}</div>
        </div>
      </div>

      <section class="about-spec">
        <div class="about-spec__head">${t("settings.about.specHead")}</div>
        <div class="about-spec__grid">
          ${aboutSpecCell(aboutIconBox(), t("settings.about.specVersion"), `<span id="about-version">${ver}</span>`)}
          ${aboutSpecCell(aboutIconCpu(), t("settings.about.specBuild"), b.commit)}
          ${aboutSpecCell(aboutIconBox(), t("settings.about.specCore"), b.core)}
          ${aboutSpecCell(aboutIconCpu(), t("settings.about.specPlatform"), b.platform)}
          ${aboutSpecCell(aboutIconBolt(), t("settings.about.specChannel"), b.channel)}
          ${aboutSpecCell(aboutIconRefresh(), t("settings.about.specUpdated"), b.date)}
        </div>
      </section>

      <section class="about-links">
        <button class="about-link" id="about-repo" type="button">
          <span class="about-link__icon">${aboutIconGithub()}</span>
          <span class="about-link__main">
            <span class="about-link__t">${t("settings.about.repoTitle")}</span>
            <span class="about-link__d">${t("settings.about.repoDesc")}</span>
          </span>
          <span class="about-link__cta btn btn--sm">${t("settings.about.open")}${aboutIconExternal()}</span>
        </button>

        <button class="about-link" data-action="check-updates" type="button">
          <span class="about-link__icon about-link__icon--ok">${aboutIconDownload()}</span>
          <span class="about-link__main">
            <span class="about-link__t">${t("settings.about.updTitle")}</span>
            <span class="about-link__d">
              <span class="about-link__status"><span class="about-link__dot"></span>${t("settings.about.updStatus")}</span>
            </span>
          </span>
          <span class="about-link__cta btn btn--sm">${aboutIconRefresh()}${t("settings.about.check")}</span>
        </button>

        <button class="about-link" id="about-license" type="button">
          <span class="about-link__icon">${aboutIconScale()}</span>
          <span class="about-link__main">
            <span class="about-link__t">${t("settings.about.licTitle")}</span>
            <span class="about-link__d">${t("settings.about.licDesc")}</span>
          </span>
          <span class="about-link__lic">MIT</span>
        </button>
      </section>

      <footer class="about-foot">
        <span class="about-foot__rule"></span>
        <span class="about-foot__txt">${t("settings.about.footTxt")}</span>
        <span class="about-foot__made">${aboutIconHeart()}${t("settings.about.footMade")}</span>
      </footer>
    </div>
  `;
}

// Иконки экрана «О программе» — lucide-style, 1.5px stroke, currentColor.
function aboutSvg(size, body) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
function aboutIconBox() { return aboutSvg(13, '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'); }
function aboutIconCpu() { return aboutSvg(13, '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>'); }
function aboutIconBolt() { return aboutSvg(13, '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'); }
function aboutIconRefresh() { return aboutSvg(12, '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>'); }
function aboutIconGithub() { return aboutSvg(17, '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>'); }
function aboutIconExternal() { return aboutSvg(12, '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'); }
function aboutIconDownload() { return aboutSvg(17, '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'); }
function aboutIconScale() { return aboutSvg(17, '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>'); }
function aboutIconHeart() { return aboutSvg(11, '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>'); }

function renderWarp(o) {
  const w = o.warp || {};
  const groupHead = (title, hint) => `
    <div class="set-group__head">
      <div class="set-group__title">${title}</div>
      ${hint ? `<div class="set-group__hint">${hint}</div>` : ""}
    </div>`;
  return `
    <div class="settings-banner">${t("settings.warp.banner")}</div>

    <!-- 1. Базовые: enabled + mode -->
    <div class="set-group">
      ${groupHead(t("settings.warp.grpConn"), t("settings.warp.grpConnHint"))}
      ${row(iconWarp(), t("settings.warp.enableTitle"),
        t("settings.warp.enableHint"),
        toggle("warp.enabled", w.enabled))}
      ${row(iconBalancer(), t("settings.warp.modeTitle"),
        t("settings.warp.modeHint"),
        select("warp.mode", w.mode || "direct", ["direct", "chain"], warpModeLabels()))}
    </div>

    <!-- 2. Регистрация: license + register/reset + status/ipv4 -->
    <div class="set-group">
      ${groupHead(t("settings.warp.grpReg"), t("settings.warp.grpRegHint"))}
      <div class="warp-status-row">
        <div>
          <div class="warp-status-row__t" id="warp-status">${t("settings.warp.statusChecking")}</div>
          <div class="warp-status-row__sub">WG IPv4: <span id="warp-ipv4">—</span></div>
        </div>
        <span class="kicker kicker--mid">CLOUDFLARE</span>
      </div>
      ${row(iconLock(), t("settings.warp.licTitle"),
        t("settings.warp.licHint"),
        `<input class="settings-input" type="text" id="warp-license-input" value="" maxlength="26" placeholder="xxxxxxxx-xxxxxxxx-xxxxxxxx" autocomplete="off" spellcheck="false"/>`)}
      <div class="set-row">
        <div class="set-row__lbl">
          <div class="set-row__t">${t("settings.warp.manageTitle")}</div>
          <div class="set-row__d">${t("settings.warp.manageHint")}</div>
        </div>
        <div class="set-row__ctl">
          <button class="btn btn--sm" data-action="warp-register" type="button">${t("settings.warp.register")}</button>
          <button class="btn btn--sm btn--danger" data-action="warp-reset" type="button">${t("settings.warp.reset")}</button>
        </div>
      </div>
    </div>

    <!-- 3. Endpoint + scanner: endpoint, MTU, scan -->
    <div class="set-group">
      ${groupHead(t("settings.warp.grpEndpoint"), t("settings.warp.grpEndpointHint"))}
      ${row(iconRemote(), t("settings.warp.endpointTitle"),
        t("settings.warp.endpointHint"),
        inputText("warp.endpoint", w.endpoint || "engage.cloudflareclient.com:2408", "text"))}
      ${row(iconMtu(), t("settings.warp.mtuTitle"),
        t("settings.warp.mtuHint"),
        inputText("warp.mtu", w.mtu || 1280, "number", 'min="576" max="1500"'))}
      ${row(iconTarget(), t("settings.warp.scanTitle"),
        t("settings.warp.scanHint"),
        `<button class="btn btn--sm" data-action="warp-scan" type="button">${t("settings.warp.scan")}</button>`)}
      ${row(iconCache(), t("settings.warp.deepTitle"),
        t("settings.warp.deepHint"),
        toggle("warp.deepScan", !!w.deepScan))}
      <div class="settings-section" id="warp-scan-results" hidden style="margin: 6px 0 0;">
        <div class="settings-banner" id="warp-scan-status">${t("settings.warp.scanInit")}</div>
        <div id="warp-scan-list"></div>
      </div>
    </div>

    <!-- 4. Маскировка: AmneziaWG noise -->
    <div class="set-group">
      ${groupHead(t("settings.warp.grpMask"), t("settings.warp.grpMaskHint"))}
      ${row(iconScissors(), t("settings.warp.noiseTitle"),
        t("settings.warp.noiseHint"),
        select("warp.noisePreset", w.noisePreset || "off", ["off", "default", "aggressive", "custom"], warpNoiseLabels(), true))}
      ${(w.noisePreset === "custom") ? renderWarpCustomNoise(w.customNoise || {}) : ""}
    </div>

    <!-- 5. Авто-ротация -->
    <div class="set-group">
      ${groupHead(t("settings.warp.grpRot"), t("settings.warp.grpRotHint"))}
      ${row(iconClock(), t("settings.warp.rotTitle"),
        t("settings.warp.rotHint"),
        toggle("warp.autoRescan", !!w.autoRescan))}
      ${row(iconClock(), t("settings.warp.rotIntTitle"),
        t("settings.warp.rotIntHint"),
        inputText("warp.autoRescanIntervalMin", w.autoRescanIntervalMin ?? 30, "number", 'min="5" max="360"'))}
      ${row(iconTarget(), t("settings.warp.rotThrTitle"),
        t("settings.warp.rotThrHint"),
        inputText("warp.autoRescanThresholdMs", w.autoRescanThresholdMs ?? 300, "number", 'min="100" max="5000"'))}
    </div>

    <!-- 6. История ротаций -->
    <div class="set-group">
      ${groupHead(t("settings.warp.grpHist"), t("settings.warp.grpHistHint"))}
      ${row(iconLog(), t("settings.warp.histCountTitle"),
        t("settings.warp.histCountHint"),
        `<span class="settings-version" id="warp-history-count">—</span>`)}
      <div id="warp-history-list"></div>
    </div>
  `;
}

function renderWarpCustomNoise(cn) {
  const c = cn.count || {}, s = cn.size || {}, d = cn.delay || {};
  return `
    <div class="settings-banner">${t("settings.warp.customBanner")}</div>
    <div class="settings-section">
      ${rangeRow(t("settings.warp.customCountTitle"), t("settings.warp.customCountHint"), "warp.customNoise.count.from", c.from ?? 2, "warp.customNoise.count.to", c.to ?? 5)}
      ${rangeRow(t("settings.warp.customSizeTitle"), t("settings.warp.customSizeHint"), "warp.customNoise.size.from", s.from ?? 20, "warp.customNoise.size.to", s.to ?? 60)}
      ${rangeRow(t("settings.warp.customDelayTitle"), t("settings.warp.customDelayHint"), "warp.customNoise.delay.from", d.from ?? 8, "warp.customNoise.delay.to", d.to ?? 20)}
    </div>
  `;
}

// ── Иконки: тонкая линия, 24×24, stroke 1.5 — единый стиль с sidebar/titlebar ──
function svgWrap(inner) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

// — Section icons (главный список Настроек) —
function iconGeneral()  { return svgWrap('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="15" cy="6" r="2.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="2.2" fill="currentColor" stroke="none"/><circle cx="17" cy="18" r="2.2" fill="currentColor" stroke="none"/>'); }
function iconTheme()    { return svgWrap('<circle cx="12" cy="12" r="9"/><path d="M12 3 a9 9 0 0 1 0 18 Z" fill="currentColor" stroke="none"/>'); }
function iconRouting()  { return svgWrap('<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M6 8.2 V10 a3 3 0 0 0 3 3 h6 a3 3 0 0 0 3 -3 V8.2"/><path d="M12 13 V15.8"/>'); }
function iconDns()      { return svgWrap('<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><circle cx="7" cy="7.5" r="0.7" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="0.7" fill="currentColor" stroke="none"/><line x1="11" y1="7.5" x2="17" y2="7.5"/><line x1="11" y1="16.5" x2="17" y2="16.5"/>'); }
function iconInbound()  { return svgWrap('<path d="M3 13 V18 a2 2 0 0 0 2 2 h14 a2 2 0 0 0 2 -2 V13 l-3.4 -6.3 a2 2 0 0 0 -1.8 -1.05 H8.2 a2 2 0 0 0 -1.8 1.05 Z"/><path d="M3 13 h5 l1.5 2.5 h5 L16 13 h5"/>'); }
function iconTls()      { return svgWrap('<path d="M14 3 L15.4 8 L20 9.5 L15.4 11 L14 16 L12.6 11 L8 9.5 L12.6 8 Z"/><path d="M6.5 15 L7.2 17 L9 17.8 L7.2 18.6 L6.5 20.8 L5.8 18.6 L4 17.8 L5.8 17 Z"/>'); }
function iconWarp()     { return svgWrap('<path d="M8 17 H17 a4 4 0 0 0 0 -8 a5.2 5.2 0 0 0 -9.7 -1.2 A3.8 3.8 0 0 0 8 17 Z"/><line x1="2" y1="20" x2="6" y2="20"/><line x1="3" y1="16" x2="5" y2="16"/>'); }
function iconInfo()     { return svgWrap('<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/>'); }

// — Row icons (внутри set-row, banner, sub-section) —
function iconUrl()       { return svgWrap('<path d="M10 14 a4 4 0 0 1 0 -5.66 l3 -3 a4 4 0 0 1 5.66 5.66 l-1.5 1.5"/><path d="M14 10 a4 4 0 0 1 0 5.66 l-3 3 a4 4 0 0 1 -5.66 -5.66 l1.5 -1.5"/>'); }
function iconClock()     { return svgWrap('<circle cx="12" cy="12" r="9"/><path d="M12 7 V12 L15.5 14"/>'); }
function iconLog()       { return svgWrap('<path d="M14 3 H6 a2 2 0 0 0 -2 2 V19 a2 2 0 0 0 2 2 H18 a2 2 0 0 0 2 -2 V9 Z"/><path d="M14 3 V9 H20"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>'); }
function iconPin()       { return svgWrap('<path d="M19 11 c0 5.5 -7 11 -7 11 s-7 -5.5 -7 -11 a7 7 0 0 1 14 0 Z"/><circle cx="12" cy="11" r="2.5"/>'); }
function iconBalancer()  { return svgWrap('<line x1="12" y1="3" x2="12" y2="9"/><path d="M5 21 V14 a3 3 0 0 1 3 -3 h8 a3 3 0 0 1 3 3 V21"/><line x1="12" y1="11" x2="12" y2="21"/><circle cx="12" cy="9" r="1.4" fill="currentColor" stroke="none"/>'); }
function iconMux()       { return svgWrap('<line x1="3" y1="6" x2="9" y2="6"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="3" y1="18" x2="9" y2="18"/><path d="M9 6 C 13 6 13 12 16 12"/><path d="M9 12 H16"/><path d="M9 18 C 13 18 13 12 16 12"/><line x1="16" y1="12" x2="21" y2="12"/><circle cx="17" cy="12" r="1.4" fill="currentColor" stroke="none"/>'); }
function iconShield()    { return svgWrap('<path d="M12 3 L4 6 V12 c0 4.5 3.5 8 8 9 c4.5 -1 8 -4.5 8 -9 V6 Z"/>'); }
function iconLan()       { return svgWrap('<rect x="3" y="3" width="6" height="5" rx="1"/><rect x="15" y="3" width="6" height="5" rx="1"/><rect x="9" y="16" width="6" height="5" rx="1"/><path d="M6 8 V11 H18 V8"/><path d="M12 11 V16"/>'); }
function iconTarget()    { return svgWrap('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>'); }
function iconIpv6()      { return svgWrap('<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3 C 8.5 7 8.5 17 12 21"/><path d="M12 3 C 15.5 7 15.5 17 12 21"/>'); }
function iconRemote()    { return svgWrap('<rect x="3" y="4" width="18" height="12" rx="1.5"/><line x1="8" y1="20" x2="16" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/>'); }
function iconDirect()    { return svgWrap('<line x1="3" y1="12" x2="16" y2="12"/><path d="M13 8 L17 12 L13 16"/><line x1="20" y1="5" x2="20" y2="19"/>'); }
function iconCache()     { return svgWrap('<ellipse cx="12" cy="5" rx="8" ry="2.5"/><path d="M4 5 V19 c0 1.4 3.6 2.5 8 2.5 s8 -1.1 8 -2.5 V5"/><path d="M20 12 c0 1.4 -3.6 2.5 -8 2.5 s-8 -1.1 -8 -2.5"/>'); }
function iconMask()      { return svgWrap('<path d="M3 9 a2 2 0 0 1 2 -2 c1.5 0 2.5 0.8 7 0.8 s5.5 -0.8 7 -0.8 a2 2 0 0 1 2 2 V14 a3 3 0 0 1 -3 3 c-1.8 0 -2.7 -1.5 -6 -1.5 s-4.2 1.5 -6 1.5 a3 3 0 0 1 -3 -3 Z"/><circle cx="8.5" cy="11.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="11.5" r="1.2" fill="currentColor" stroke="none"/>'); }
function iconPort()      { return svgWrap('<rect x="2" y="8" width="13" height="8" rx="1"/><path d="M15 10 H20 V14 H15"/><line x1="6" y1="11" x2="6" y2="13"/><line x1="9" y1="11" x2="9" y2="13"/>'); }
function iconMtu()       { return svgWrap('<rect x="3" y="9" width="18" height="8" rx="1"/><path d="M7 9 V12"/><path d="M11 9 V13"/><path d="M15 9 V12"/><path d="M19 9 V13"/>'); }
function iconStack()     { return svgWrap('<path d="M12 3 L21 8 L12 13 L3 8 Z"/><path d="M3 12 L12 17 L21 12"/><path d="M3 16 L12 21 L21 16"/>'); }
function iconLock()      { return svgWrap('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11 V7 a4 4 0 0 1 8 0 V11"/>'); }
function iconBroadcast() { return svgWrap('<path d="M4 9 a11 11 0 0 1 16 0"/><path d="M7 12 a7 7 0 0 1 10 0"/><path d="M10 15 a3 3 0 0 1 4 0"/><circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none"/>'); }
function iconScissors()  { return svgWrap('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.5" y2="15.5"/><line x1="20" y1="20" x2="14" y2="14"/><line x1="8.5" y1="8.5" x2="11.5" y2="11.5"/>'); }
function iconCase()      { return svgWrap('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7 V5 a2 2 0 0 1 2 -2 h2 a2 2 0 0 1 2 2 V7"/><line x1="3" y1="13" x2="21" y2="13"/>'); }
function iconPad()       { return svgWrap('<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>'); }
function iconUpdate()    { return svgWrap('<path d="M3 12 a9 9 0 0 1 15.5 -6.4 L21 8"/><path d="M21 3 V8 H16"/><path d="M21 12 a9 9 0 0 1 -15.5 6.4 L3 16"/><path d="M3 21 V16 H8"/>'); }
function iconRocket()    { return svgWrap('<path d="M14 4 a8 8 0 0 1 6 -2 a8 8 0 0 1 -2 6 L11 15 L9 13 Z"/><path d="M9 13 L5 17"/><path d="M5 15 L9 19 L7 21 L4 21 a1 1 0 0 1 -1 -1 L3 17 Z"/><circle cx="15" cy="9" r="1.5"/>'); }
function iconEyeOff()    { return svgWrap('<line x1="3" y1="3" x2="21" y2="21"/><path d="M10 6.5 c0.7 -0.1 1.3 -0.2 2 -0.2 c6 0 9 5.7 9 5.7 c0 0 -1 1.8 -2.5 3.5"/><path d="M6 7.5 C 3.5 9.2 3 12 3 12 c0 0 3 5.7 9 5.7 c1.3 0 2.5 -0.3 3.5 -0.7"/><path d="M9.5 9.5 a3 3 0 0 0 4.2 4.2"/>'); }
