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
import { rememberProxySelection } from "/lib/proxy-selection.js";
import { getFavourites } from "/lib/favourites.js";
import { pickTrayServers } from "/lib/tray-servers.js";
import { createLatestRunner } from "/lib/async-control.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// Контекст из main.js: геттеры живого состояния + действия.
//   getState()           — "idle" | "connecting" | "connected"
//   getEffectiveTag()    — clash-тэг фактической ноды (или null)
//   getUpdateVersion()   — версия отложенного апдейта для пункта «Обновить» (или null)
//   onSetMode(mode)      — смена режима подключения (= changeMode)
//   onToggleVpn()        — подключить/отключить (= клик по hero-диску)
//   onUpdateClick()      — клик «Обновить до vX» (= flushPendingUpdate)
//   onTrayActivity()     — наведение/ПКМ по значку (= дочекать OTA)
//   isUpdateBusy()       — скачивание/установка OTA; сетевые действия блокируются
//   isStrictPrivacy()     — строгий runtime не имеет selector и требует reconnect
//   onServerSelected(tag, node, { reconnect }) — успешный выбор сервера:
//                          main обновляет hero либо переподключает строгий runtime
let ctx = null;

// Список серверов — только для подписки с >=2 нодами (у одиночного конфига
// и сабов из одной ноды clash-тэг всегда "proxy", переключать нечего).
// Полный список живёт на экране Серверы, в меню уходит срез (tray-servers.js).
function buildTrayServers() {
  const src = getActiveSource();
  if (!src || src.kind !== "sub" || !Array.isArray(src.nodes) || src.nodes.length < 2) return [];
  const effective = ctx?.getEffectiveTag() ?? null;
  let favs;
  try { favs = getFavourites(src); } catch { /* избранное недоступно — отбор обойдётся */ }
  const entries = src.nodes.map((n, i) => {
    const tag = nodeTag(i, n);
    const iso = isoFromNodeName(n.name) || isoFromNodeName(n.host) || null;
    return { id: tag, label: (n.name || n.host || tag).slice(0, 48), selected: tag === effective, iso };
  });
  return pickTrayServers(entries, favs);
}

// Последний УСПЕШНО применённый payload. Трей пересобирается на каждый чих —
// смену ноды балансером в том числе, — а payload при этом чаще всего тот же.
// Пропуск неизменившегося убирает лишние пересборки меню на сотни иконок.
// Сбрасывается при ошибке: следующий вызов обязан попробовать снова, иначе
// одна осечка заморозила бы значок до перезапуска.
let lastTrayPayload = null;

const trayMenuSync = createLatestRunner(async () => {
  if (!ctx) return;
  try {
    let dpiActive = false;
    try { dpiActive = localStorage.getItem("ninety.dpi.enabled") === "true"; } catch {}
    const payload = {
      connected: ctx.getState() === "connected", mode: getMode(),
      servers: buildTrayServers(), dpiActive,
      updateVersion: ctx.getUpdateVersion() || null,
      updateBusy: ctx.isUpdateBusy?.() === true,
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
        tipUpdate: t("tray.tipUpdate"),
      },
    };
    const signature = JSON.stringify(payload);
    if (signature === lastTrayPayload) return;
    await invoke("set_tray_menu", { payload });
    lastTrayPayload = signature;
  } catch (e) {
    lastTrayPayload = null;
    console.warn("syncTrayMenu failed", e);
  }
});

export function syncTrayMenu() {
  if (!ctx) return Promise.resolve();
  return trayMenuSync.request();
}

// События из Rust-меню трея: смена режима и выбор сервера (только при VPN on).
export function initTray(context) {
  ctx = context;
  (async () => {
    const ev = window.__TAURI__?.event;
    if (!ev?.listen) return;
    try {
      await ev.listen("tray:set-mode", (e) => {
        if (ctx.isUpdateBusy?.()) return;
        if (typeof e?.payload === "string") ctx.onSetMode(e.payload);
      });
      // Подключиться/Отключиться из трея — тот же путь, что клик по hero-диску.
      await ev.listen("tray:toggle-vpn", () => {
        if (!ctx.isUpdateBusy?.()) ctx.onToggleVpn();
      });
      // «Обновить до vX» из трея → окно уже показано Rust-обработчиком, открываем модалку.
      await ev.listen("tray:update", () => {
        if (!ctx.isUpdateBusy?.()) ctx.onUpdateClick();
      });
      // Наведение/ПКМ по значку: пользователь смотрит на трей прямо сейчас.
      // Свёрнутое окно узнаёт об апдейте только по расписанию, поэтому просим
      // main дочекать OTA — к следующему открытию меню пункт «Обновить» и
      // метка на значке будут на месте.
      await ev.listen("tray:activity", () => {
        ctx.onTrayActivity?.();
        // Пользователь смотрит на значок прямо сейчас — самый подходящий
        // момент вернуть его в согласие с состоянием, если предыдущая
        // пересборка почему-либо не доехала.
        syncTrayMenu();
      });
      // DPI-обход вкл/выкл из трея — тот же toggleDpi, что в UI; затем рефреш меню.
      await ev.listen("tray:toggle-dpi", async () => {
        if (ctx.isUpdateBusy?.()) return;
        try { await toggleDpi(); } catch (err) { console.warn("tray dpi toggle failed", err); }
        syncTrayMenu();
      });
      await ev.listen("tray:select-server", async (e) => {
        if (ctx.isUpdateBusy?.()) return;
        const tag = e?.payload;
        if (!tag || ctx.getState() !== "connected") return;
        try {
          const src = getActiveSource();
          const node = src?.kind === "sub" ? (src.nodes.find((n, i) => nodeTag(i, n) === tag) || null) : null;
          if (!node) return;
          const strict = ctx.isStrictPrivacy?.() === true;
          if (!strict) {
            const selected = await selectProxy("proxy", tag);
            if (selected?.stale) return;
          }
          rememberProxySelection(src, tag);
          ctx.onServerSelected(tag, node, { reconnect: strict });
          toast(
            strict ? t("conn.applyingSettings") : t("conn.serverSwitched"),
            strict ? "info" : "success",
            strict ? 1800 : 1200,
          );
          syncTrayMenu();
        } catch (err) {
          toast(t("conn.switchErr", { err: err?.message || err }), "error", 2500);
        }
      });
    } catch (e) { console.warn("tray listeners failed", e); }
  })();
}
