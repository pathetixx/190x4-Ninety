// Ninety · tray: building the payload for the context menu (Rust set_tray_menu)
// and handling events from it. Split out of main.js. Everything main owns
// (the state machine, the effective node, the pending update, connect/changeMode)
// comes in via initTray(ctx) — the module doesn't hold these states itself.
//
//   initTray(ctx)  — once at startup, BEFORE the first syncTrayMenu.
//   syncTrayMenu() — rebuild the menu/icon/tooltip for the current state;
//                    called from main on every sneeze (connect, mode/node change,
//                    language change, a found update). An unchanged payload
//                    is skipped; { force: true } applies it anyway.

import { t } from "/lib/i18n/index.js";
import { toast } from "/lib/toast.js";
import { getActiveSource, getMode, nodeTag } from "/lib/singbox.js";
import { selectProxy } from "/lib/clash-api.js";
import { toggleDpi } from "/lib/dpi-view.js";
import { flagIsoFromName as isoFromNodeName } from "/lib/flags.js";
import { rememberProxySelection } from "/lib/proxy-selection.js";
import { getFavourites } from "/lib/favourites.js";
import { buildTrayServerMenu } from "/lib/tray-servers.js";
import { countryName } from "/lib/country-names.js";
import { getProbeHistory } from "/lib/delay-history.js";
import { liveDelays, medianOf } from "/lib/node-ranking.js";
import { createLatestRunner } from "/lib/async-control.js";
import { STORAGE_KEYS } from "/lib/storage-policy.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// Context from main.js: getters of the live state + actions.
//   getState()           — "idle" | "connecting" | "connected"
//   getEffectiveTag()    — the clash tag of the actual node (or null)
//   getUpdateVersion()   — the pending update version for the "Update" item (or null)
//   onSetMode(mode)      — changing the connection mode (= changeMode)
//   onToggleVpn()        — connect/disconnect (= a click on the hero disc)
//   onUpdateClick()      — a click on "Update to vX" (= flushPendingUpdate)
//   onTrayActivity()     — hover/right click on the icon (= finish the OTA check)
//   onOpenServers()      — "All servers…" from the menu (= open the Servers screen)
//   isUpdateBusy()       — OTA downloading/installing; network actions are blocked
//   isStrictPrivacy()     — the strict runtime has no selector and requires a reconnect
//   onServerSelected(tag, node, { reconnect }) — a successful server selection:
//                          main updates the hero or reconnects the strict runtime
let ctx = null;

// The server list is only for a subscription with >=2 nodes (for a single config
// and single-node subs the clash tag is always "proxy", there's nothing to switch).
// The full list lives on the Servers screen, the menu gets a slice (tray-servers.js).
// Latency is taken from already made measurements: the menu measures nothing itself.
// The median, not the last value — a single outlier must not move a node
// to the top of the list.
function delayOf(source, tag) {
  try {
    const live = liveDelays(getProbeHistory(source, tag));
    if (!live.length) return null;
    return Math.round(medianOf(live));
  } catch { return null; }
}

// Providers' node names can have half-screen decorations; in the menu the name
// is truncated so the row stays readable together with the latency.
function serverLabel(name, delay) {
  const base = String(name || "").slice(0, 40);
  return delay ? `${base}  ·  ${delay} ${t("units.ms")}` : base;
}

function buildTrayServers() {
  const src = getActiveSource();
  if (!src || src.kind !== "sub" || !Array.isArray(src.nodes) || src.nodes.length < 2) {
    return buildTrayServerMenu([]);
  }
  const effective = ctx?.getEffectiveTag() ?? null;
  let favs;
  try { favs = getFavourites(src); } catch { /* favorites unavailable — the selection will do without them */ }
  const entries = src.nodes.map((n, i) => {
    const tag = nodeTag(i, n);
    const iso = isoFromNodeName(n.name) || isoFromNodeName(n.host) || null;
    const delay = delayOf(src, tag);
    return {
      id: tag,
      label: serverLabel(n.name || n.host || tag, delay),
      selected: tag === effective,
      iso,
      delay,
    };
  });
  return buildTrayServerMenu(entries, {
    favourites: favs,
    countryLabel: countryName,
    otherLabel: t("tray.otherCountry"),
  });
}

// The last SUCCESSFULLY applied payload. The tray is rebuilt on every sneeze —
// including a node switch by the balancer — while the payload is most often the same.
// Skipping an unchanged one removes extra rebuilds of a menu with hundreds of icons.
// Reset on error: the next call must try again, otherwise
// one misfire would freeze the icon until a restart.
let lastTrayPayload = null;

// A menu rebuild postponed because the tray menu is open. The interval is large
// on purpose: while the menu is open, there's no point building the payload, and the built menu
// will only be seen by the user on the next opening anyway.
const MENU_BUSY_RETRY_MS = 1500;
let deferredRetry = null;

const trayMenuSync = createLatestRunner(async () => {
  if (!ctx) return;
  try {
    let dpiActive = false;
    try { dpiActive = localStorage.getItem(STORAGE_KEYS.dpiEnabled) === "true"; } catch {}
    const trayServers = buildTrayServers();
    const payload = {
      connected: ctx.getState() === "connected", mode: getMode(),
      servers: trayServers, dpiActive,
      updateVersion: ctx.getUpdateVersion() || null,
      updateBusy: ctx.isUpdateBusy?.() === true,
      // Menu/tooltip strings are in the interface language (Rust keeps a Russian
      // fallback only until the first call). The rebuild on a language change is
      // syncTrayMenu in onLangChange.
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
        favourites: t("tray.favourites"),
        fast: t("tray.fast"),
        allServers: t("tray.allServers"),
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
    const outcome = await invoke("set_tray_menu", { payload });
    // The menu is open right now — Rust updated the icon and tooltip but left
    // the menu itself: replacing it would collapse it under the cursor. We don't remember
    // the payload and come back to it when the user closes the menu.
    if (outcome?.applied === false) {
      lastTrayPayload = null;
      clearTimeout(deferredRetry);
      deferredRetry = setTimeout(() => trayMenuSync.request(), MENU_BUSY_RETRY_MS);
      return;
    }
    lastTrayPayload = signature;
  } catch (e) {
    lastTrayPayload = null;
    console.warn("syncTrayMenu failed", e);
  }
});

// force — apply the payload even if it doesn't differ from the previous one. Needed
// where we don't trust the state of the icon itself (the user is looking at
// the tray, the window got focus back): dedup would otherwise decide there's nothing to do and
// leave the icon the way the failure left it.
export function syncTrayMenu({ force = false } = {}) {
  if (!ctx) return Promise.resolve();
  if (force) lastTrayPayload = null;
  return trayMenuSync.request();
}

// Events from the Rust tray menu: mode change and server selection (only with VPN on).
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
      // Connect/Disconnect from the tray — the same path as a click on the hero disc.
      await ev.listen("tray:toggle-vpn", () => {
        if (!ctx.isUpdateBusy?.()) ctx.onToggleVpn();
      });
      // "Update to vX" from the tray → the window is already shown by the Rust handler, we open the modal.
      await ev.listen("tray:update", () => {
        if (!ctx.isUpdateBusy?.()) ctx.onUpdateClick();
      });
      // Hover/right click on the icon: the user is looking at the tray right now.
      // A minimized window learns about an update only on schedule, so we ask
      // main to finish the OTA check — by the next menu opening the "Update" item and
      // the badge on the icon will be in place.
      await ev.listen("tray:activity", () => {
        ctx.onTrayActivity?.();
        // The user is looking at the icon right now — a good moment
        // to bring it in line with the state. Without force: if the payload is the same,
        // there's nothing to rebuild, and an extra set_tray_menu risks landing exactly
        // on an open menu.
        syncTrayMenu();
      });
      // DPI bypass on/off from the tray — the same toggleDpi as in the UI; then a menu refresh.
      await ev.listen("tray:toggle-dpi", async () => {
        if (ctx.isUpdateBusy?.()) return;
        try { await toggleDpi(); } catch (err) { console.warn("tray dpi toggle failed", err); }
        syncTrayMenu();
      });
      // "All servers…": the full list and search live on the Servers screen.
      await ev.listen("tray:open-servers", () => {
        ctx.onOpenServers?.();
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
