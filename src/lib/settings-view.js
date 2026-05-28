// Ninety · Settings view — 6 разделов навигатором, как в Hiddify.
// Не SPA-роутер: внутренний state хранится в this view (sectionKey).

import {
  loadOptions, saveOptions, updateOption,
  REGIONS, IPV6_MODES, TUN_STACKS, LOG_LEVELS, BALANCER_STRATEGIES,
  URL_HANDLER_SCHEMES,
} from "/lib/options.js";

const SCHEME_LABELS = {
  vless: "vless://", vmess: "vmess://", ss: "ss://", trojan: "trojan://",
  hysteria2: "hysteria2://", hy2: "hy2://", tuic: "tuic://", sub: "sub://",
};

const WARP_MODE_LABELS = {
  direct: "Только WARP (без других прокси)",
  chain:  "WARP поверх активного прокси (chain)",
};

const WARP_NOISE_LABELS = {
  off:        "Off — обычный WireGuard",
  default:    "Default — лёгкая обфускация (1-3 пакета)",
  aggressive: "Aggressive — больше шума (3-8 пакетов)",
  custom:     "Custom — параметры ниже",
};

const SECTIONS = [
  { key: "general",    title: "Общие",        icon: iconGeneral,    hint: "Логи, тест соединения, интервалы" },
  { key: "appearance", title: "Оформление",   icon: iconTheme,      hint: "Темы: Kurogane / Synthwave / Matrix / Mono" },
  { key: "routing",    title: "Маршрутизация", icon: iconRouting,    hint: "Регион, обход LAN, блокировка рекламы" },
  { key: "dns",        title: "DNS",           icon: iconDns,        hint: "Remote / Direct DNS, fake-DNS" },
  { key: "inbound",    title: "Входящие",      icon: iconInbound,    hint: "Mixed-порт, MTU, TUN-стек" },
  { key: "tunnel",     title: "Туннель",       icon: iconTunnel,     hint: "Windows Service для TUN-режима" },
  { key: "tls-tricks", title: "Трюки TLS",     icon: iconTls,        hint: "Фрагментация ClientHello, padding" },
  { key: "warp",       title: "WARP",          icon: iconWarp,       hint: "Cloudflare WARP — outbound и chain" },
];

const THEMES = [
  { id: "kurogane",  name: "Kurogane",  kicker: "NEON · RED",  accent: "#DE5772", glow: "rgba(192,48,74,0.35)" },
  { id: "synthwave", name: "Synthwave", kicker: "VIOLET WAVE", accent: "#E0A6FF", glow: "rgba(199,125,255,0.35)" },
  { id: "matrix",    name: "Matrix",    kicker: "EMERALD",     accent: "#5CEE92", glow: "rgba(43,214,106,0.35)" },
  { id: "mono",      name: "Mono",      kicker: "MONOCHROME",  accent: "#FFFFFF", glow: "rgba(255,255,255,0.25)" },
];

const TUNNEL_STATE_LABELS = {
  not_installed: "Не установлен",
  stopped:       "Остановлен",
  start_pending: "Запускается…",
  stop_pending:  "Останавливается…",
  running:       "Работает",
  paused:        "Приостановлен",
  other:         "Неизвестно",
};

const REGION_LABELS = {
  other: "Не выбран",
  ru: "Россия (ru)",
  cn: "Китай (cn)",
  ir: "Иран (ir)",
  tr: "Турция (tr)",
  by: "Беларусь (by)",
};

const IPV6_LABELS = {
  disable: "Отключить",
  enable:  "Включить (prefer IPv4)",
  prefer:  "Предпочитать IPv6",
  only:    "Только IPv6",
};

const TUN_STACK_LABELS = {
  mixed:  "Mixed (рекомендуется)",
  gvisor: "gVisor (изолированный)",
  system: "System (нативный)",
};

const BALANCER_LABELS = {
  "round-robin":         "Round robin",
  "consistent-hashing":  "Consistent hashing",
  "sticky-sessions":     "Sticky sessions",
};

const LOG_LABELS = {
  trace: "trace", debug: "debug", info: "info", warn: "warn", error: "error",
};

let currentSection = null; // null = menu

export function mountSettings(root, opts = {}) {
  if (!root) return;
  const onChange = opts.onChange || (() => {});
  const onRender = opts.onRender || (() => {});
  function render() {
    if (!currentSection) {
      root.innerHTML = renderMenu();
      bindMenu(root);
    } else {
      const sec = SECTIONS.find(s => s.key === currentSection);
      root.innerHTML = renderSection(sec);
      bindSection(root, sec, onChange);
    }
    onRender(currentSection);
  }
  function bindMenu(el) {
    el.querySelectorAll("[data-section]").forEach(item => {
      item.addEventListener("click", () => {
        currentSection = item.dataset.section;
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
    bindSchemeToggles(el, onChange);
    bindTunnelSection(el, sec);
    bindWarpSection(el, sec, onChange);
    bindAppearanceSection(el, sec);
  }

  function bindAppearanceSection(el, sec) {
    if (sec.key !== "appearance") return;
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

  function bindSchemeToggles(el, onChange) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;
    el.querySelectorAll(".switch[data-scheme]").forEach(sw => {
      sw.addEventListener("click", async () => {
        const scheme = sw.dataset.scheme;
        const was = sw.dataset.on === "true";
        const want = !was;
        const cmd = want ? "register_url_handler" : "unregister_url_handler";
        try {
          await invoke(cmd, { scheme });
          sw.dataset.on = String(want);
          const opts = loadOptions();
          const cur = new Set(opts.general?.urlSchemes || []);
          if (want) cur.add(scheme); else cur.delete(scheme);
          updateOption("general.urlSchemes", [...cur]);
          onChange(`general.urlSchemes.${scheme}`, want);
        } catch (e) {
          alert(`${want ? "Регистрация" : "Удаление"} ${scheme}:// не удалось: ${e?.message || e}`);
        }
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
      if (!info) return { status: "Не зарегистрирован", ipv4: "—", license: "" };
      const plus = info.warp_plus ? " · WARP+" : "";
      const type = info.account_type ? `${info.account_type}${plus}` : (info.warp_plus ? "WARP+" : "free");
      return {
        status: `Активна (${type})`,
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
        if (statusEl) statusEl.textContent = `Ошибка: ${e?.message || e}`;
      }
    };

    registerBtn?.addEventListener("click", async () => {
      const orig = registerBtn.textContent;
      registerBtn.disabled = true;
      registerBtn.textContent = "Регистрирую…";
      try {
        const license = licenseInput?.value?.trim() || null;
        await invoke("warp_register", { license });
        await refresh();
        onChange("warp.registered", true);
      } catch (e) {
        alert(`Регистрация WARP не удалось: ${e?.message || e}`);
      } finally {
        registerBtn.disabled = false;
        registerBtn.textContent = orig;
      }
    });

    resetBtn?.addEventListener("click", async () => {
      if (!confirm("Удалить регистрацию WARP? Локальные ключи будут стёрты.")) return;
      const orig = resetBtn.textContent;
      resetBtn.disabled = true;
      resetBtn.textContent = "Сбрасываю…";
      try {
        await invoke("warp_reset");
        await refresh();
        onChange("warp.registered", false);
      } catch (e) {
        alert(`Сброс WARP не удалось: ${e?.message || e}`);
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
      scanBtn.textContent = "Сканирую…";
      if (scanResults) scanResults.hidden = false;
      const deep = !!loadOptions().warp?.deepScan;
      // mode=auto: WG handshake если warp.json есть, иначе TCP. Backend сам определит.
      if (scanStatus) scanStatus.textContent = deep
        ? "Глубокое сканирование CF WARP-пула (~15-25с)…"
        : "Пробую CF WARP endpoints…";
      if (scanList) scanList.innerHTML = "";
      try {
        const results = await invoke("warp_scan_endpoints", { topN: 10, deep, mode: "auto" });
        if (!Array.isArray(results) || results.length === 0) {
          if (scanStatus) scanStatus.textContent = "Ничего не нашлось — все IP в семпле недоступны. Попробуйте ещё раз.";
          return;
        }
        const method = results[0]?.method === "wg" ? "WG-handshake" : "TCP-ping";
        if (scanStatus) scanStatus.textContent = `Top-${results.length} по latency (${method}). Нажмите «Применить» — endpoint выше обновится.`;
        if (scanList) scanList.innerHTML = results.map(r => `
          <div class="setting-row">
            <span class="setting-row__icon">${iconTarget()}</span>
            <span class="setting-row__main">
              <span class="setting-row__label">${r.ip}:${r.port}</span>
              <span class="setting-row__hint">${r.latency_ms} мс · ${r.method}</span>
            </span>
            <span class="setting-row__control">
              <button class="btn btn--sm" data-scan-pick="${r.ip}:${r.port}" type="button">Применить</button>
            </span>
          </div>
        `).join("");
      } catch (e) {
        if (scanStatus) scanStatus.textContent = `Ошибка сканирования: ${e?.message || e}`;
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
      if (historyCount) historyCount.textContent = items.length ? `${items.length} шт.` : "пусто";
      if (!historyList) return;
      if (!items.length) { historyList.innerHTML = ""; return; }
      historyList.innerHTML = items.map(it => {
        const d = new Date(it.ts);
        const ts = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")} ${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}`;
        return `<div class="setting-row">
          <span class="setting-row__icon">${iconRemote()}</span>
          <span class="setting-row__main">
            <span class="setting-row__label">${it.to}</span>
            <span class="setting-row__hint">${ts} · ${it.newDelay}мс (было ${it.oldDelay || "—"}, ${it.from})</span>
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

  async function bindTunnelSection(el, sec) {
    if (sec.key !== "tunnel") return;
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;

    const block = el.querySelector("#tunnel-statusblock");
    const statusEl = el.querySelector("#tunnel-svc-status");
    const dotEl = el.querySelector("#tunnel-svc-dot");
    const pidEl = el.querySelector("#tunnel-svc-pid");
    const actionsEl = el.querySelector("#tunnel-status-actions");

    // Маппинг SvcState → grade for dot (running/stopped/error/неизвестно)
    const dotState = (svc) => {
      if (svc === "running") return "running";
      if (svc === "stopped" || svc === "not_installed") return "stopped";
      if (svc === "error" || svc === "other") return "error";
      return ""; // start_pending / stop_pending / paused → нейтральный
    };
    // Какие кнопки показывать при каком state
    const visibleActions = (svc) => {
      if (svc === "not_installed") return ["tunnel-install", "tunnel-refresh"];
      if (svc === "running")       return ["tunnel-restart", "tunnel-open-log", "tunnel-uninstall", "tunnel-refresh"];
      if (svc === "stopped")       return ["tunnel-restart", "tunnel-open-log", "tunnel-uninstall", "tunnel-refresh"];
      // pending / paused / other / error — даём только refresh + uninstall
      return ["tunnel-uninstall", "tunnel-refresh"];
    };

    const refresh = async () => {
      if (statusEl) { statusEl.textContent = "Проверка…"; statusEl.dataset.state = ""; }
      if (dotEl) dotEl.dataset.state = "";
      if (pidEl) pidEl.textContent = "—";
      if (block) block.dataset.svc = "unknown";
      try {
        const full = await invoke("tunnel_full_status");
        const svc = full?.service || "other";
        if (statusEl) {
          statusEl.textContent = TUNNEL_STATE_LABELS[svc] || svc;
          statusEl.dataset.state = svc;
        }
        if (dotEl) dotEl.dataset.state = dotState(svc);
        if (pidEl) pidEl.textContent = full?.pid ? String(full.pid) : "—";
        if (block) block.dataset.svc = svc;
        const visible = new Set(visibleActions(svc));
        if (actionsEl) {
          actionsEl.querySelectorAll("[data-action]").forEach(b => {
            b.hidden = !visible.has(b.dataset.action);
          });
        }
      } catch (e) {
        if (statusEl) {
          statusEl.textContent = "Ошибка: " + (e?.message || e);
          statusEl.dataset.state = "error";
        }
        if (dotEl) dotEl.dataset.state = "error";
      }
    };

    const runAction = async (btn, cmd, label, errLabel) => {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = label;
      try {
        await invoke(cmd);
        await refresh();
      } catch (e) {
        alert(`${errLabel} не удалось: ${e?.message || e}`);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    };

    actionsEl?.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-action]");
      if (!b) return;
      switch (b.dataset.action) {
        case "tunnel-install":   return runAction(b, "tunnel_service_install",   "Устанавливаю…", "Установка");
        case "tunnel-uninstall": return runAction(b, "tunnel_service_uninstall", "Удаляю…",       "Удаление");
        case "tunnel-restart":   return runAction(b, "tunnel_service_restart",   "Перезапуск…",   "Перезапуск");
        case "tunnel-refresh":   return refresh();
        case "tunnel-open-log": {
          try { await invoke("open_log_dir"); }
          catch (err) { alert(`Открыть лог не удалось: ${err?.message || err}`); }
          return;
        }
      }
    });

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
      <h2 class="settings-head__title">Настройки</h2>
    </header>
    <div class="settings-menu">
      ${SECTIONS.map(s => `
        <button class="settings-menu__item" data-section="${s.key}" type="button">
          <span class="settings-menu__icon">${s.icon()}</span>
          <span class="settings-menu__body">
            <span class="settings-menu__title">${s.title}</span>
            <span class="settings-menu__hint">${s.hint}</span>
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
      <button class="settings-back" data-back type="button" aria-label="Назад">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <h2 class="settings-head__title">${sec.title}</h2>
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
    case "tunnel":     return renderTunnel(o);
    case "tls-tricks": return renderTlsTricks(o);
    case "warp":       return renderWarp(o);
  }
  return "";
}

function renderAppearance() {
  const current = localStorage.getItem("ninety.theme") || "kurogane";
  const cards = THEMES.map(t => `
    <div class="theme-card" data-theme="${t.id}" data-on="${current === t.id}"
         style="--theme-accent:${t.accent};--theme-glow:${t.glow};">
      <div class="theme-card__check">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>
      </div>
      <div class="theme-card__top">
        <span class="theme-card__dot"></span>
        <span class="theme-card__kicker">${t.kicker}</span>
      </div>
      <div class="theme-card__name">${t.name}</div>
      <div class="theme-card__swatches">
        <span style="opacity:1"></span>
        <span style="opacity:0.7"></span>
        <span style="opacity:0.45"></span>
        <span style="opacity:0.22"></span>
      </div>
    </div>
  `).join("");
  return `
    <div class="settings-banner">
      Палитра неизменна — меняется только акцентный цвет. Выбор сохраняется автоматически.
    </div>
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

function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
  const registered = new Set(g.urlSchemes || []);
  const schemeRows = URL_HANDLER_SCHEMES.map(s => row(
    iconUrl(),
    SCHEME_LABELS[s] || s,
    `Ninety будет открываться при клике по ${SCHEME_LABELS[s] || s + "://"} ссылкам`,
    `<span class="switch" data-scheme="${s}" data-on="${registered.has(s) ? "true" : "false"}"></span>`,
  )).join("");
  return `
    <div class="settings-section">
      ${row(iconRocket(), "Запускать при входе в систему", "Ninety будет автоматически стартовать при логине в Windows", toggle("general.autostart", g.autostart, { action: "autostart" }))}
      ${row(iconEyeOff(), "Запускать свернутым", "На старте окно сразу прячется в трей — иконка остаётся справа внизу", toggle("general.startMinimized", g.startMinimized))}
    </div>
    <div class="settings-banner">
      Обработка ссылок: только Ninety. Не включайте схемы, которые уже использует другой VPN-клиент — последний победитель регистрации перетянет ассоциацию на себя.
    </div>
    <div class="settings-section">
      ${schemeRows}
    </div>
    <div class="settings-section">
      ${row(iconUrl(), "URL для теста соединения", "Любой HTTP/HTTPS endpoint, проверяющий доступ", inputText("urlTest.connectionTestUrl", o.urlTest.connectionTestUrl, "url"))}
      ${row(iconClock(), "Интервал теста (сек)", "Как часто sing-box проверяет outbound", inputText("urlTest.intervalSec", o.urlTest.intervalSec, "number", 'min="30" max="3600"'))}
      ${row(iconLog(), "Уровень логов", "Подробность лога sing-box", select("log.level", o.log.level, LOG_LEVELS, LOG_LABELS))}
      ${row(iconLog(), "Метка времени в логах", "Префикс времени перед каждой строкой sing-box лога", toggle("log.timestamp", o.log.timestamp !== false))}
      ${row(iconLog(), "Полностью отключить логи", "sing-box не пишет ни одной строки — диагностика станет невозможна. Включайте только для прод-сценария.", toggle("log.disabled", !!o.log.disabled))}
    </div>
    <div class="settings-section">
      ${row(iconUpdate(), "Версия Ninety", "Текущая установленная версия", `<span class="settings-version" id="settings-version">—</span>`)}
      ${row(iconUpdate(), "Проверить обновления", "Скачать и установить новую версию с GitHub", `<button class="btn btn--sm" data-action="check-updates" type="button">Проверить</button>`)}
    </div>
  `;
}

function renderRouting(o) {
  return `
    <div class="settings-section">
      ${row(iconPin(), "Регион", "Локальный трафик региона идёт напрямую через geosite/geoip rule_sets от hiddify-geo (обновление каждые 5 дней через прокси)", select("region", o.region, REGIONS, REGION_LABELS, true))}
      ${row(iconBalancer(), "Стратегия Balancer", "Используется при множественных нодах (alpha7)", select("route.balancerStrategy", o.route.balancerStrategy, BALANCER_STRATEGIES, BALANCER_LABELS))}
      ${row(iconShield(), "Блокировать рекламу", "Domain/IP списки рекламы и malware из hiddify-geo", toggle("blockAds", o.blockAds))}
      ${row(iconLan(), "Обход LAN", "Локальные адреса (10.x, 192.168.x и т.п.) идут напрямую", toggle("route.bypassLan", o.route.bypassLan))}
      ${row(iconTarget(), "Определять адрес назначения", "Резолвить домен в IP перед маршрутизацией", toggle("route.resolveDestination", o.route.resolveDestination))}
      ${row(iconIpv6(), "Маршрут IPv6", "Стратегия выбора IPv4/IPv6", select("route.ipv6Mode", o.route.ipv6Mode, IPV6_MODES, IPV6_LABELS))}
    </div>
  `;
}

function renderDns(o) {
  return `
    <div class="settings-section">
      ${row(iconRemote(), "Remote DNS", "DNS для трафика через прокси (DoH/DoT/UDP)", inputText("dns.remoteAddress", o.dns.remoteAddress, "text"))}
      ${row(iconDirect(), "Direct DNS", "DNS для прямого трафика (для region и bypass)", inputText("dns.directAddress", o.dns.directAddress, "text"))}
      ${row(iconCache(), "Независимый DNS-кэш", "Раздельный кэш для remote и direct", toggle("dns.independentCache", o.dns.independentCache))}
      ${row(iconMask(), "Fake-DNS", "Возвращать поддельный IP, маппинг в памяти. Полезно при TUN", toggle("dns.enableFakeDns", o.dns.enableFakeDns))}
    </div>
  `;
}

function renderInbound(o) {
  return `
    <div class="settings-section">
      ${row(iconPort(), "Mixed port", "Локальный SOCKS+HTTP порт для системного прокси", inputText("inbound.mixedPort", o.inbound.mixedPort, "number", 'min="1024" max="65535"'))}
      ${row(iconMtu(), "MTU TUN", "Максимальный размер пакета", inputText("inbound.mtu", o.inbound.mtu, "number", 'min="576" max="9000"'))}
      ${row(iconStack(), "TUN стек", "Реализация TUN-стека", select("inbound.tunStack", o.inbound.tunStack, TUN_STACKS, TUN_STACK_LABELS))}
      ${row(iconLock(), "Строгая маршрутизация", "Блокировать утечки трафика мимо TUN", toggle("inbound.strictRoute", o.inbound.strictRoute))}
      ${row(iconBroadcast(), "Принимать с LAN", "Mixed inbound будет слушать 0.0.0.0 вместо 127.0.0.1", toggle("inbound.allowConnectionFromLan", o.inbound.allowConnectionFromLan))}
    </div>
  `;
}

function renderTlsTricks(o) {
  return `
    <div class="settings-banner">
      Трюки TLS работают через форк <code>hiddify-sing-box</code> (собран с <code>with_awg</code> + <code>badlinkname</code>). Включённые опции пишутся в <code>experimental.tls_tricks</code> и применяются ко всем outbound с TLS-handshake.
    </div>
    <div class="settings-section">
      ${row(iconScissors(), "Фрагментация ClientHello", "Бьёт TLS handshake на куски — обход DPI", toggle("tlsTricks.enableFragment", o.tlsTricks.enableFragment))}
      ${rangeRow("Размер фрагмента (байт)", "Диапазон случайной длины каждого фрагмента", "tlsTricks.fragmentSize.from", o.tlsTricks.fragmentSize.from, "tlsTricks.fragmentSize.to", o.tlsTricks.fragmentSize.to)}
      ${rangeRow("Задержка между фрагментами (мс)", "Случайный sleep между отправкой кусков", "tlsTricks.fragmentSleep.from", o.tlsTricks.fragmentSleep.from, "tlsTricks.fragmentSleep.to", o.tlsTricks.fragmentSleep.to)}
      ${row(iconCase(), "Mixed SNI case", "Перемешивает регистр в SNI", toggle("tlsTricks.mixedSniCase", o.tlsTricks.mixedSniCase))}
      ${row(iconPad(), "TLS padding", "Добавляет padding в ClientHello", toggle("tlsTricks.enablePadding", o.tlsTricks.enablePadding))}
      ${rangeRow("Размер padding (байт)", "Диапазон длины", "tlsTricks.paddingSize.from", o.tlsTricks.paddingSize.from, "tlsTricks.paddingSize.to", o.tlsTricks.paddingSize.to)}
    </div>
  `;
}

function renderWarp(o) {
  const w = o.warp || {};
  const groupHead = (title, hint) => `
    <div class="set-group__head">
      <div class="set-group__title">${title}</div>
      ${hint ? `<div class="set-group__hint">${hint}</div>` : ""}
    </div>`;
  return `
    <div class="settings-banner">
      Cloudflare WARP регистрирует WireGuard-устройство в Cloudflare. Бесплатный WARP — без лицензии (просто «Зарегистрировать»). WARP+ — введите 26-символьный ключ из приложения «1.1.1.1». Ключи и токен хранятся локально в <code>app_config_dir/warp.json</code>.
    </div>

    <!-- 1. Базовые: enabled + mode -->
    <div class="set-group">
      ${groupHead("Подключение", "Где включить WARP и какой режим использовать.")}
      ${row(iconWarp(), "Включить WARP",
        "Подмешать WARP в конфиг sing-box. Активирует выбранный режим (direct/chain).",
        toggle("warp.enabled", w.enabled))}
      ${row(iconBalancer(), "Режим WARP",
        "<b>Direct</b> — единственный outbound (трафик через WARP, без вашего прокси). <b>Chain</b> — поверх активного прокси (proxy → WARP → internet).",
        select("warp.mode", w.mode || "direct", ["direct", "chain"], WARP_MODE_LABELS))}
    </div>

    <!-- 2. Регистрация: license + register/reset + status/ipv4 -->
    <div class="set-group">
      ${groupHead("Регистрация", "Создаёт WireGuard device на стороне Cloudflare. Без регистрации WARP не подключится.")}
      <div class="warp-status-row">
        <div>
          <div class="warp-status-row__t" id="warp-status">Проверка…</div>
          <div class="warp-status-row__sub">WG IPv4: <span id="warp-ipv4">—</span></div>
        </div>
        <span class="kicker kicker--mid">CLOUDFLARE</span>
      </div>
      ${row(iconLock(), "Лицензия WARP+ (опционально)",
        "26 символов из приложения «1.1.1.1» → Settings → Account → Key. Оставьте пусто для бесплатного WARP.",
        `<input class="settings-input" type="text" id="warp-license-input" value="" maxlength="26" placeholder="xxxxxxxx-xxxxxxxx-xxxxxxxx" autocomplete="off" spellcheck="false"/>`)}
      <div class="set-row">
        <div class="set-row__lbl">
          <div class="set-row__t">Управление регистрацией</div>
          <div class="set-row__d">«Зарегистрировать» создаёт пару и обновляет device в CF. «Сбросить» удаляет device и стирает локальный warp.json.</div>
        </div>
        <div class="set-row__ctl">
          <button class="btn btn--sm" data-action="warp-register" type="button">Зарегистрировать</button>
          <button class="btn btn--sm btn--danger" data-action="warp-reset" type="button">Сбросить</button>
        </div>
      </div>
    </div>

    <!-- 3. Endpoint + scanner: endpoint, MTU, scan -->
    <div class="set-group">
      ${groupHead("Endpoint", "Куда подключаться. Сканер ищет быстрый IP в публичных подсетях CF.")}
      ${row(iconRemote(), "Endpoint",
        "WARP сервер: <code>engage.cloudflareclient.com:2408</code> по умолчанию. Можно <code>auto4</code>/<code>auto6</code>/<code>auto</code> — sing-box выберет случайный clean-IP.",
        inputText("warp.endpoint", w.endpoint || "engage.cloudflareclient.com:2408", "text"))}
      ${row(iconMtu(), "MTU",
        "Максимальный размер WG-пакета. CF рекомендует 1280.",
        inputText("warp.mtu", w.mtu || 1280, "number", 'min="576" max="1500"'))}
      ${row(iconTarget(), "Найти лучший CF endpoint",
        "Сканирует CF WARP-пул через WG-handshake (если есть warp.json) или TCP-ping. top-10 по latency, «Применить» подставит в поле Endpoint.",
        `<button class="btn btn--sm" data-action="warp-scan" type="button">Сканировать</button>`)}
      ${row(iconCache(), "Глубокое сканирование",
        "Расширенный набор подсетей CF (~22 вместо 8) и больше IP на подсеть. Дольше (~15-25с), шанс найти лучший endpoint выше.",
        toggle("warp.deepScan", !!w.deepScan))}
      <div class="settings-section" id="warp-scan-results" hidden style="margin: 6px 0 0;">
        <div class="settings-banner" id="warp-scan-status">Сканирую…</div>
        <div id="warp-scan-list"></div>
      </div>
    </div>

    <!-- 4. Маскировка: AmneziaWG noise -->
    <div class="set-group">
      ${groupHead("Маскировка (AmneziaWG)", "Junk-пакеты перед WG-хендшейком — обход ML-DPI, который ловит WG-сигнатуру (актуально для РФ-ТСПУ с апреля 2026).")}
      ${row(iconScissors(), "Профиль обфускации",
        "Готовый набор (off/default/aggressive) или custom — параметры ниже. Работает только в форке sing-box (собран с <code>with_awg</code>).",
        select("warp.noisePreset", w.noisePreset || "off", ["off", "default", "aggressive", "custom"], WARP_NOISE_LABELS, true))}
      ${(w.noisePreset === "custom") ? renderWarpCustomNoise(w.customNoise || {}) : ""}
    </div>

    <!-- 5. Авто-ротация -->
    <div class="set-group">
      ${groupHead("Авто-ротация endpoint", "Когда задержка текущего endpoint выше порога — Ninety автоматически пересканирует и переключится на лучший. Используется при connected.")}
      ${row(iconClock(), "Авто-ротация endpoint",
        "Раз в N минут опрашиваем delay текущего WARP-узла через clash-API. Если он выше порога — запускаем scan и применяем лучший (auto-reconnect). Бьёт ровно один раз пока endpoint не нормализуется.",
        toggle("warp.autoRescan", !!w.autoRescan))}
      ${row(iconClock(), "Интервал опроса (мин)",
        "Как часто проверять latency. Слишком часто = лишний трафик и шум в логах.",
        inputText("warp.autoRescanIntervalMin", w.autoRescanIntervalMin ?? 30, "number", 'min="5" max="360"'))}
      ${row(iconTarget(), "Порог latency (мс)",
        "Если delay текущего endpoint превышает порог (или равен 0 — таймаут) — триггер scan.",
        inputText("warp.autoRescanThresholdMs", w.autoRescanThresholdMs ?? 300, "number", 'min="100" max="5000"'))}
    </div>

    <!-- 6. История ротаций -->
    <div class="set-group">
      ${groupHead("История ротаций", "Последние авто-смены WARP endpoint — что было, что стало, на сколько мс улучшилось. Хранится локально, последние 20 записей.")}
      ${row(iconLog(), "Количество записей",
        "Сколько ротаций в локальной истории.",
        `<span class="settings-version" id="warp-history-count">—</span>`)}
      <div id="warp-history-list"></div>
    </div>
  `;
}

function renderWarpCustomNoise(cn) {
  const c = cn.count || {}, s = cn.size || {}, d = cn.delay || {};
  return `
    <div class="settings-banner">
      Custom-обфускация: количество junk-пакетов и их размер/задержка задаются вручную. Слишком крупные значения (например count 20+) увеличат время WG-handshake и могут перегрузить узкие каналы.
    </div>
    <div class="settings-section">
      ${rangeRow("Количество fake-пакетов", "Сколько мусора отправить перед реальным WG-init.", "warp.customNoise.count.from", c.from ?? 2, "warp.customNoise.count.to", c.to ?? 5)}
      ${rangeRow("Размер пакета (байт)", "Случайная длина каждого fake-пакета.", "warp.customNoise.size.from", s.from ?? 20, "warp.customNoise.size.to", s.to ?? 60)}
      ${rangeRow("Задержка между пакетами (мс)", "Случайный sleep между отправкой junk-пакетов.", "warp.customNoise.delay.from", d.from ?? 8, "warp.customNoise.delay.to", d.to ?? 20)}
    </div>
  `;
}

function renderTunnel(o) {
  // Статус подтягивается асинхронно в bindSection (bindTunnelSection).
  // .tunnel-status — единый блок: dot+state+PID+actions.
  return `
    <div class="settings-banner">
      В TUN-режиме sing-box работает не у вас, а внутри Windows Service <code>NinetyTunnelService</code> под LocalSystem. Это нужно, потому что создание TUN-интерфейса и установка маршрутов требуют прав администратора. UAC показывается ровно один раз — при первой установке сервиса.
    </div>
    <div class="tunnel-status" id="tunnel-statusblock" data-svc="unknown">
      <div class="tunnel-status__row">
        <span class="tunnel-status__dot" id="tunnel-svc-dot" data-state=""></span>
        <span class="tunnel-status__text" id="tunnel-svc-status" data-state="">Проверка…</span>
      </div>
      <div class="tunnel-status__meta">
        <span>PID sing-box: <span id="tunnel-svc-pid">—</span></span>
      </div>
      <div class="tunnel-status__actions" id="tunnel-status-actions">
        <button class="btn btn--sm" data-action="tunnel-install" type="button" hidden>Установить</button>
        <button class="btn btn--sm" data-action="tunnel-restart" type="button" hidden>Перезапустить</button>
        <button class="btn btn--sm" data-action="tunnel-open-log" type="button" hidden>Открыть лог</button>
        <button class="btn btn--sm btn--danger" data-action="tunnel-uninstall" type="button" hidden>Удалить</button>
        <button class="btn btn--sm" data-action="tunnel-refresh" type="button">Обновить</button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-banner" style="margin: 4px 0 0;">
        <b>Установить</b> — регистрирует службу в SCM (UAC, один раз). <b>Перезапустить</b> — <code>sc stop</code> + <code>sc start</code> через UAC. <b>Открыть лог</b> — папка <code>%APPDATA%</code>, где сервис пишет stdout/stderr sing-box. <b>Удалить</b> — снимает службу полностью.
      </div>
    </div>
  `;
}

// ── Иконки (Phosphor Duotone, inline SVG) ──────────────────
function svgWrap(inner) {
  return `<svg viewBox="0 0 256 256" width="20" height="20" fill="currentColor">${inner}</svg>`;
}
function iconGeneral()  { return svgWrap('<path opacity="0.25" d="M128 88a40 40 0 1 0 40 40 40 40 0 0 0-40-40Z"/><path d="M128 80a48 48 0 1 0 48 48 48.05 48.05 0 0 0-48-48Zm0 80a32 32 0 1 1 32-32 32 32 0 0 1-32 32Z"/>'); }
function iconRouting()  { return svgWrap('<path opacity="0.25" d="M192 56a32 32 0 1 1-32-32 32 32 0 0 1 32 32Z"/><path d="M232 48a24 24 0 0 0-44.46-12.45A104 104 0 0 0 88.8 224h.18a24 24 0 1 0 4.2-15.6A88 88 0 0 1 192.06 35.6 24 24 0 0 0 232 48Z"/>'); }
function iconDns()      { return svgWrap('<path opacity="0.25" d="M224 56v48H32V56a8 8 0 0 1 8-8h176a8 8 0 0 1 8 8Z"/><path d="M216 40H40a16 16 0 0 0-16 16v144a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V56a16 16 0 0 0-16-16Zm0 16v40H40V56Zm-176 56h176v40H40Zm0 88v-32h176v32Z"/>'); }
function iconInbound()  { return svgWrap('<path opacity="0.25" d="M216 48v80a8 8 0 0 1-8 8h-72v-80a8 8 0 0 1 8-8h72Z"/><path d="M208 40h-72a16 16 0 0 0-16 16v32H48a16 16 0 0 0-16 16v96a16 16 0 0 0 16 16h120a16 16 0 0 0 16-16v-32h24a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16Z"/>'); }
function iconTls()      { return svgWrap('<path opacity="0.25" d="M96 92a36 36 0 1 1-36-36 36 36 0 0 1 36 36Z"/><path d="M239.32 154.36 165.36 94.06A44 44 0 1 0 60 92a44 44 0 0 0 70.06 35.34l60.3 73.96a16 16 0 0 0 12.49 5.94 16.13 16.13 0 0 0 9.05-2.8l27.7-19.14A16 16 0 0 0 239.32 154.36ZM60 64a28 28 0 1 1-28 28 28 28 0 0 1 28-28Z"/>'); }
function iconWarp()     { return svgWrap('<path opacity="0.25" d="M248 128a72 72 0 0 1-72 72H88a64 64 0 0 1 0-128 64.13 64.13 0 0 1 6.49.32A72 72 0 0 1 248 128Z"/><path d="M176 88a87.84 87.84 0 0 0-78.7 48.6A56 56 0 1 0 88 248h88a80 80 0 0 0 0-160Z"/>'); }
function iconTunnel()   { return svgWrap('<path opacity="0.25" d="M224 136v80H32v-80a96 96 0 0 1 192 0Z"/><path d="M128 32a104.12 104.12 0 0 0-104 104v80a8 8 0 0 0 8 8h40a8 8 0 0 0 8-8 48 48 0 0 1 96 0 8 8 0 0 0 8 8h40a8 8 0 0 0 8-8v-80A104.12 104.12 0 0 0 128 32Zm88 176h-24.4a64 64 0 0 0-127.2 0H40v-72a88 88 0 0 1 176 0Z"/>'); }
function iconTheme()    { return svgWrap('<path opacity="0.25" d="M128 32a96 96 0 0 0 0 192c8 0 16-8 16-16s-8-16-16-16h-8a16 16 0 0 1 0-32h24a32 32 0 0 0 0-64h-16a16 16 0 0 1 0-32h64a16 16 0 0 0 16-16A96.11 96.11 0 0 0 128 32Z"/><circle cx="68" cy="100" r="12"/><circle cx="100" cy="68" r="12"/><circle cx="156" cy="68" r="12"/><circle cx="188" cy="100" r="12"/>'); }
function iconUrl()      { return svgWrap('<path opacity="0.25" d="M232 128a104 104 0 1 1-104-104"/><path d="M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Z"/>'); }
function iconClock()    { return svgWrap('<path opacity="0.25" d="M224 128a96 96 0 1 1-96-96 96 96 0 0 1 96 96Z"/><path d="M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Zm56 112h-56a8 8 0 0 1-8-8V72a8 8 0 0 1 16 0v48h48a8 8 0 0 1 0 16Z"/>'); }
function iconLog()      { return svgWrap('<path opacity="0.25" d="M208 88V216a8 8 0 0 1-8 8H56a8 8 0 0 1-8-8V40a8 8 0 0 1 8-8h88Z"/><path d="M213.66 82.34 157.66 26.34A8 8 0 0 0 152 24H56a16 16 0 0 0-16 16v176a16 16 0 0 0 16 16h144a16 16 0 0 0 16-16V88a8 8 0 0 0-2.34-5.66Z"/>'); }
function iconPin()      { return svgWrap('<path opacity="0.25" d="M208 104c0 64-80 128-80 128S48 168 48 104a80 80 0 0 1 160 0Z"/><path d="M128 64a40 40 0 1 0 40 40 40 40 0 0 0-40-40Z"/>'); }
function iconBalancer() { return svgWrap('<path opacity="0.25" d="M251.69 92.41 209 41.81a8 8 0 0 0-12 0L153 92.4a8 8 0 0 0 6 13.6h28V232a8 8 0 0 0 16 0V106h28a8 8 0 0 0 5.69-13.59Z"/><path d="M101.69 92.41 59 41.81a8 8 0 0 0-12 0L4 92.4a8 8 0 0 0 6 13.6h27V232a8 8 0 0 0 16 0V106h28a8 8 0 0 0 5.69-13.59Z"/>'); }
function iconShield()   { return svgWrap('<path opacity="0.25" d="M208 40v88c0 70.4-72.84 96-80 96s-80-25.6-80-96V40a8 8 0 0 1 8-8h144a8 8 0 0 1 8 8Z"/><path d="M208 32H48a16 16 0 0 0-16 16v88c0 70.42 73.41 99.41 80 102a8.55 8.55 0 0 0 6 0c6.59-2.6 80-31.58 80-102V48a16 16 0 0 0-16-16Z"/>'); }
function iconLan()      { return svgWrap('<path opacity="0.25" d="M120 32a8 8 0 0 1 0 16H64a16 16 0 0 0-16 16v64a8 8 0 0 1-16 0V64a32 32 0 0 1 32-32Z"/><path d="M218.83 161.17a4 4 0 0 0-5.66 0l-23.4 23.4-25.94-25.94a8 8 0 0 0-11.31 11.31l25.94 25.94-23.4 23.4a4 4 0 0 0 2.83 6.83H224a8 8 0 0 0 8-8v-58.34a4 4 0 0 0-6.83-2.83Z"/>'); }
function iconTarget()   { return svgWrap('<path opacity="0.25" d="M224 128a96 96 0 1 1-96-96 96 96 0 0 1 96 96Z"/><path d="M128 24a104 104 0 1 0 104 104 104.11 104.11 0 0 0-104-104Zm0 192a88 88 0 1 1 88-88 88.1 88.1 0 0 1-88 88Zm0-144a56 56 0 1 0 56 56 56 56 0 0 0-56-56Z"/>'); }
function iconIpv6()     { return svgWrap('<path opacity="0.25" d="M128 24a104 104 0 1 0 104 104A104 104 0 0 0 128 24Z"/><path d="M128 88a40 40 0 1 0 40 40 40 40 0 0 0-40-40Z"/>'); }
function iconRemote()   { return svgWrap('<path opacity="0.25" d="M232 64v128H24V64Z"/><path d="M224 48H32a16 16 0 0 0-16 16v128a16 16 0 0 0 16 16h192a16 16 0 0 0 16-16V64a16 16 0 0 0-16-16Z"/>'); }
function iconDirect()   { return svgWrap('<path opacity="0.25" d="M152 32v80h80Z"/><path d="m213.66 82.34-56-56A8 8 0 0 0 152 24H56a16 16 0 0 0-16 16v176a16 16 0 0 0 16 16h144a16 16 0 0 0 16-16V88a8 8 0 0 0-2.34-5.66Z"/>'); }
function iconCache()    { return svgWrap('<path opacity="0.25" d="M224 72v40c0 17.67-43 32-96 32S32 129.67 32 112V72c0-17.67 43-32 96-32S224 54.33 224 72Z"/><path d="M128 24c-30.62 0-57.55 8.45-77.78 24.43C42.84 56.13 32 67.74 32 80v96c0 17.67 43 32 96 32s96-14.33 96-32V80c0-12.26-10.84-23.87-18.22-31.57C185.55 32.45 158.62 24 128 24Z"/>'); }
function iconMask()     { return svgWrap('<path opacity="0.25" d="M128 24c-30.93 0-56 25.07-56 56a32 32 0 0 0 32 32h48a32 32 0 0 0 32-32c0-30.93-25.07-56-56-56Z"/><path d="M251.76 113.4A8 8 0 0 0 244 104h-12V80a72 72 0 0 0-144 0v24H24a8 8 0 0 0-7.76 9.4l16 88A8 8 0 0 0 40 208h176a8 8 0 0 0 7.87-6.6Z"/>'); }
function iconPort()     { return svgWrap('<path opacity="0.25" d="M224 56v144a8 8 0 0 1-8 8H40a8 8 0 0 1-8-8V56a8 8 0 0 1 8-8h176a8 8 0 0 1 8 8Z"/><path d="M216 40H40a16 16 0 0 0-16 16v144a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V56a16 16 0 0 0-16-16ZM160 96l-32 32-32-32Z"/>'); }
function iconMtu()      { return svgWrap('<path opacity="0.25" d="M48 56v144l160-72Z"/><path d="M218.83 116.91 70.43 28.18a14.43 14.43 0 0 0-15.18.41A14.66 14.66 0 0 0 48 41v174a14.66 14.66 0 0 0 7.25 12.42 14.45 14.45 0 0 0 15.18.4l148.4-88.72a14.74 14.74 0 0 0 0-25.19Z"/>'); }
function iconStack()    { return svgWrap('<path opacity="0.25" d="M232 128 128 192 24 128l104-64Z"/><path d="M236.21 124.65 132 60.65a8 8 0 0 0-8.42 0L19.79 124.65a8 8 0 0 0 0 13.7l104.21 64a8 8 0 0 0 8.42 0l104.21-64a8 8 0 0 0-.42-13.7Z"/>'); }
function iconLock()     { return svgWrap('<path opacity="0.25" d="M208 88V216a8 8 0 0 1-8 8H56a8 8 0 0 1-8-8V88a8 8 0 0 1 8-8h144a8 8 0 0 1 8 8Z"/><path d="M208 72h-24V56a56 56 0 0 0-112 0v16H48a16 16 0 0 0-16 16v128a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V88a16 16 0 0 0-16-16ZM88 56a40 40 0 0 1 80 0v16H88Z"/>'); }
function iconBroadcast(){ return svgWrap('<path opacity="0.25" d="M128 96a32 32 0 1 1-32 32 32 32 0 0 1 32-32Z"/><path d="M180.61 102.4a8 8 0 0 1-13.06 9.2C159.05 99.68 144 88 128 88s-31.05 11.68-39.55 23.6a8 8 0 1 1-13.06-9.2C84.46 89 105.31 72 128 72S171.54 89 180.61 102.4Z"/>'); }
function iconScissors() { return svgWrap('<path opacity="0.25" d="M86 134a30 30 0 1 0-30-30 30 30 0 0 0 30 30Z"/><path d="M222.69 121.37 162 96l60.69-25.37a8 8 0 0 0-6.16-14.77l-100.1 41.84A45.95 45.95 0 1 0 88 134a45.7 45.7 0 0 0 28.46-9.7l100.1 41.84a8 8 0 0 0 6.16-14.77Z"/>'); }
function iconCase()     { return svgWrap('<path opacity="0.25" d="M232 56v152a16 16 0 0 1-16 16H40a16 16 0 0 1-16-16V56Z"/><path d="M216 32H40a16 16 0 0 0-16 16v160a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16Z"/>'); }
function iconPad()      { return svgWrap('<path opacity="0.25" d="M224 80v96a16 16 0 0 1-16 16H48a16 16 0 0 1-16-16V80Z"/><path d="M208 64H48a16 16 0 0 0-16 16v96a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V80a16 16 0 0 0-16-16Z"/>'); }
function iconUpdate()   { return svgWrap('<path opacity="0.25" d="M128 32a96 96 0 1 0 96 96 96 96 0 0 0-96-96Z"/><path d="M197.66 113.66 145.66 165.66a8 8 0 0 1-11.32 0L82.34 113.66a8 8 0 0 1 11.32-11.32L120 128.69V72a8 8 0 0 1 16 0v56.69l26.34-26.35a8 8 0 0 1 11.32 11.32Z"/>'); }
function iconRocket()   { return svgWrap('<path opacity="0.25" d="M152 224v-48a8 8 0 0 0-3.81-6.83l-30.43-18.26 24.24-24.24L160 144l-8 80Z"/><path d="m226.27 60.94-3.74-23a8 8 0 0 0-6.51-6.51l-23-3.74A86.7 86.7 0 0 0 144.34 45.6l-15.81 19a87.8 87.8 0 0 0-66.86 25.62L33.94 119A8 8 0 0 0 36 132.94l32.4 16.2-2.65 26.46a8 8 0 0 0 2.28 6.49l27.88 27.88a8 8 0 0 0 6.49 2.28l26.46-2.65 16.2 32.4a8 8 0 0 0 13.93 2.06l28.78-27.73a87.78 87.78 0 0 0 25.62-66.86l19-15.81a86.7 86.7 0 0 0 17.88-71.72ZM168 112a16 16 0 1 1 16-16 16 16 0 0 1-16 16Z"/>'); }
function iconEyeOff()   { return svgWrap('<path opacity="0.25" d="M53.92 34.62a8 8 0 1 0-11.84 10.76L72.13 78.4C26.59 113 12.24 158.78 12.07 159.33a8 8 0 0 0 0 5.34c.32 1 8.27 24.31 32.6 48.21 32.43 31.81 71.46 48.4 112.92 48.4a155.7 155.7 0 0 0 46.31-7.16l27.32 30a8 8 0 1 0 11.84-10.76Z"/><path d="M157.59 96.41A36 36 0 0 1 159.59 159.59L106.41 100.41A36 36 0 0 1 157.59 96.41Z"/>'); }
