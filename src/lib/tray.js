// Ninety · трей: сборка payload'а для контекстного меню (Rust set_tray_menu)
// и обработка событий из него. Выделен из main.js. Всё, чем владеет main
// (state-машина, эффективная нода, отложенный апдейт, connect/changeMode),
// приходит через initTray(ctx) — модуль сам эти состояния не держит.
//
//   initTray(ctx)  — один раз на старте, ДО первого syncTrayMenu.
//   syncTrayMenu() — пересобрать меню/иконку/tooltip под текущее состояние;
//                    зовётся из main на каждый чих (connect, смена режима/ноды,
//                    смена языка, найденный апдейт).

import { t } from "/lib/i18n/index.js";
import { toast } from "/lib/toast.js";
import { getActiveSource, getMode, nodeTag } from "/lib/singbox.js";
import { selectProxy } from "/lib/clash-api.js";
import { toggleDpi } from "/lib/dpi-view.js";
import { flagIsoFromName as isoFromNodeName } from "/lib/flags.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// Контекст из main.js: геттеры живого состояния + действия.
//   getState()           — "idle" | "connecting" | "connected"
//   getEffectiveTag()    — clash-тэг фактической ноды (или null)
//   getUpdateVersion()   — версия отложенного апдейта для пункта «Обновить» (или null)
//   onSetMode(mode)      — смена режима подключения (= changeMode)
//   onToggleVpn()        — подключить/отключить (= клик по hero-диску)
//   onUpdateClick()      — клик «Обновить до vX» (= flushPendingUpdate)
//   onServerSelected(tag, node) — успешный выбор сервера: main обновляет
//                          эффективную ноду и hero/локацию
let ctx = null;

// Список серверов — только для подписки с >=2 нодами (у одиночного конфига
// и сабов из одной ноды clash-тэг всегда "proxy", переключать нечего).
function buildTrayServers() {
  const src = getActiveSource();
  if (!src || src.kind !== "sub" || !Array.isArray(src.nodes) || src.nodes.length < 2) return [];
  const effective = ctx?.getEffectiveTag() ?? null;
  return src.nodes.map((n, i) => {
    const tag = nodeTag(i, n);
    const iso = isoFromNodeName(n.name) || isoFromNodeName(n.host) || null;
    return { id: tag, label: (n.name || n.host || tag).slice(0, 48), selected: tag === effective, iso };
  });
}

let trayMenuBusy = false;
export async function syncTrayMenu() {
  if (!ctx || trayMenuBusy) return;
  trayMenuBusy = true;
  try {
    let dpiActive = false;
    try { dpiActive = localStorage.getItem("ninety.dpi.enabled") === "true"; } catch {}
    await invoke("set_tray_menu", {
      payload: {
        connected: ctx.getState() === "connected", mode: getMode(),
        servers: buildTrayServers(), dpiActive,
        updateVersion: ctx.getUpdateVersion() || null,
        // Строки меню/tooltip — на языке интерфейса (Rust держит русский
        // фолбэк только до первого вызова). Пересборка на смену языка —
        // syncTrayMenu в onLangChange.
        labels: {
          show: t("tray.show"),
          connect: t("tray.connect"),
          disconnect: t("tray.disconnect"),
          modeTitle: t("home.modeToggle"),
          modeProxy: t("mode.proxy"),
          modeSystem: t("mode.systemProxy"),
          modeTun: t("mode.tun"),
          server: t("tray.server"),
          noServers: t("tray.noServers"),
          dpiTitle: t("dpi.title"),
          dpiStatusOn: t("tray.dpiStatusOn"),
          dpiStatusOff: t("tray.dpiStatusOff"),
          dpiEnable: t("tray.dpiEnable"),
          dpiDisable: t("tray.dpiDisable"),
          quit: t("tray.quit"),
          updateTo: t("tray.updateTo"),
          tipOff: t("tray.tipOff"),
          tipConnected: t("tray.tipConnected"),
        },
      },
    });
  } catch (e) {
    console.warn("syncTrayMenu failed", e);
  } finally {
    trayMenuBusy = false;
  }
}

// События из Rust-меню трея: смена режима и выбор сервера (только при VPN on).
export function initTray(context) {
  ctx = context;
  (async () => {
    const ev = window.__TAURI__?.event;
    if (!ev?.listen) return;
    try {
      await ev.listen("tray:set-mode", (e) => {
        if (typeof e?.payload === "string") ctx.onSetMode(e.payload);
      });
      // Подключиться/Отключиться из трея — тот же путь, что клик по hero-диску.
      await ev.listen("tray:toggle-vpn", () => { ctx.onToggleVpn(); });
      // «Обновить до vX» из трея → окно уже показано Rust-обработчиком, открываем модалку.
      await ev.listen("tray:update", () => { ctx.onUpdateClick(); });
      // DPI-обход вкл/выкл из трея — тот же toggleDpi, что в UI; затем рефреш меню.
      await ev.listen("tray:toggle-dpi", async () => {
        try { await toggleDpi(); } catch (err) { console.warn("tray dpi toggle failed", err); }
        syncTrayMenu();
      });
      await ev.listen("tray:select-server", async (e) => {
        const tag = e?.payload;
        if (!tag || ctx.getState() !== "connected") return;
        try {
          await selectProxy("proxy", tag);
          const src = getActiveSource();
          const node = src?.kind === "sub" ? (src.nodes.find((n, i) => nodeTag(i, n) === tag) || null) : null;
          ctx.onServerSelected(tag, node);
          toast(t("conn.serverSwitched"), "success", 1200);
          syncTrayMenu();
        } catch (err) {
          toast(t("conn.switchErr", { err: err?.message || err }), "error", 2500);
        }
      });
    } catch (e) { console.warn("tray listeners failed", e); }
  })();
}
