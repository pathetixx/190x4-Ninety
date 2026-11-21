import {
  buildConfig,
  bridgeNeeds,
  loadProfiles,
  getActiveProfileId,
  setActiveProfileId,
  removeProfile,
  removeAllProfiles,
  getMode,
  setMode,
  setSessionMode,
  getActiveKind,
  setActiveKind,
  getActiveSource,
  nodeTag,
  subscriptionSource,
} from "/lib/singbox.js";
import {
  loadSubscriptions,
  getActiveSubscriptionId,
  setActiveSubscriptionId,
  refreshSubscription,
  refreshAllSubscriptions,
  removeSubscription,
  subscriptionDaysLeft,
  subscriptionUsedBytes,
  subscriptionLimitBytes,
  formatBytes as fmtTraffic,
  relativeTime,
  setSubscriptionProxy,
  setSubscriptionTunnelTransit,
} from "/lib/subscriptions.js";
import { loadOptions, getOptionsSnapshot, saveOptions, takeLegacyLanCredentials, updateOption } from "/lib/options.js";
import { backupForUpdate, backupNow, backupSoon, restoreIfEmpty } from "/lib/state-backup.js";
import { mountSettings } from "/lib/settings-view.js";
import { pathNeedsRestart } from "/lib/restart-policy.js";
import { a11ySwitch } from "/lib/switch-a11y.js";
import { escapeAttr, escapeHtml } from "/lib/esc.js";
import { openConfirmModal } from "/lib/confirm-modal.js";
import { usableNodes } from "/lib/node-validation.js";
import { clearNodeQuarantine, matchCoreOutboundRejection, quarantineNode } from "/lib/node-quarantine.js";
import { isAvailable as updaterAvailable, checkForUpdate } from "/lib/updater.js";
import { openUpdateModal, resumeRuntimeReady, shouldSkip as updateShouldSkip } from "/lib/update-modal.js";
import { planUpdateNotice, UPDATE_NOTICE } from "/lib/update-notice.js";
import { mountAddModal, openAddModal } from "/lib/add-modal.js";
import { openEditSubscription, openEditProfile } from "/lib/edit-modal.js";
import { handleHwidSignal } from "/lib/hwid-prompt.js";
import { copySubscriptionUrl, copyWireguardConf, copyOpenvpnConf, exportSingboxJson, openQRModal } from "/lib/share.js";
import { mountProxiesView, nodesFromSource, onProxiesViewEnter, onProxiesViewLeave, rerenderProxiesView, resetProxiesViewForSourceChange, snapshotMatchesSource } from "/lib/proxies-view.js";
import {
  applyActiveSourceTransaction,
  createSourceSwitchController,
  sameSourceRef,
} from "/lib/source-activation.js";
import { mountDpiView, prepareDpiVpnMode, setDpiVpnMode, excludeVpnNode, clearVpnNodeExclusion, autostartDpiIfEnabled, rerenderDpiView, onDpiViewEnter, setVpnNodesProvider } from "/lib/dpi-view.js";
import { configureLogsRuntime, mountLogsView, onLogsViewEnter, onLogsViewLeave, rerenderLogsView } from "/lib/logs-view.js";
import { initTray, syncTrayMenu } from "/lib/tray.js";
import { startClashStream, stopClashStream, formatRate } from "/lib/clash-stream.js";
import { createConnectionAttemptGate } from "/lib/connection-attempt.js";
import { createCoreStartBarrier } from "/lib/connection-start-barrier.js";
import { createRuntimeIdleGate } from "/lib/runtime-idle-gate.js";
import { completeSuccessfulConnect, runReconnectAttempt } from "/lib/connect-network-result.js";
import { waitForMatchingSourceTopology } from "/lib/source-switch-readiness.js";
import { runtimeEndpointMatchesGeneration, runtimeSnapshotReadyForMode } from "/lib/runtime-lifecycle.js";
import { awaitMeasuredLeader, cancelPendingSelections, configureClashRuntime, configureProbeUrl, gradeDelay, pickEffectiveNode, getProxies, lastDelay, selectProxy, refreshEffectiveDelay, testNode } from "/lib/clash-api.js";
import { fetchPublicIp, maskIp, bindIpReveal } from "/lib/ip-info.js";
import { notify } from "/lib/notify.js";
import { toast } from "/lib/toast.js";
import { FLAGS_BASE, flagIsoFromName as isoFromNodeName, stripFlag } from "/lib/flags.js";
import { configureTrafficRuntime, startMeter, stopMeter, getMeasured, resetMeasured, sourceKeyOf } from "/lib/traffic-meter.js";
import { clearProfileStorage, STORAGE_KEYS } from "/lib/storage-policy.js";
import {
  clearProfileStore,
  initializeProfileStore,
} from "/lib/profile-store.js";
import { createQualityEngine } from "/lib/quality-engine.js";
import { bus } from "/lib/bus.js";
import { groupIncidents, incidentLog } from "/lib/incident-log.js";
import { forwardingAliases, forwardingProblem } from "/lib/forwarding.js";
import { createChannelIncidentRecorder } from "/lib/channel-incidents.js";
import { mountDiagnoseView } from "/lib/diagnose-view.js";
import { newRule, sanitizeRule } from "/lib/routing-rules.js";
import { openQualityScope } from "/lib/quality-scope.js";
import { parseDeepLink } from "/lib/deeplink.js";
import {
  applyKillSwitch,
  maybeWarnKillSwitchProxy,
  snapshotConfirmsOrdinaryKillSwitch,
  snapshotConfirmsStrictKillSwitch,
} from "/lib/kill-switch.js";
import { initWifiGuard, forgetWifiAutoRestore } from "/lib/wifi-guard.js";
import { initPerfProbe } from "/lib/perf-probe.js";
import { initWarpRescan } from "/lib/warp-rescan.js";
import { initHealthWatchdog } from "/lib/health-watchdog.js";
import { initTitlebar } from "/lib/titlebar.js";
import { initPopovers } from "/lib/popovers.js";
import { ensureWorkingDirectDns, startDnsGuard, stopDnsGuard } from "/lib/dns-guard.js";
import { initI18n, onLangChange, applyDom, t, tn } from "/lib/i18n/index.js";
import { detectRegion } from "/lib/i18n/region-detect.js";
import { applyLinkHandlers } from "/lib/link-handlers.js";
import { DEFAULT_THEME_ID, isThemeId } from "/lib/themes.js";
import { initContrast } from "/lib/contrast.js";
import { applyCalmHud, CALM_HUD_EVENT, isCalmHud } from "/lib/calm-hud.js";
import { createRuntimeIdentityController, sourceFingerprint, sourceKey } from "/lib/runtime-identity.js";
import { createSourceMutationController, planSourceDeletion } from "/lib/source-mutations.js";
import { createBootstrapCoordinator } from "/lib/bootstrap-coordinator.js";
import { createNetworkIntentArbiter, repeatedConnectionIntentAction } from "/lib/network-intent.js";
import { createLatestWinsReconnectQueue } from "/lib/reconnect-queue.js";
import { shouldShowOnboarding } from "/lib/onboarding-state.js";
import { getRememberedProxySelection, manualProxySelection, rememberProxySelection, restoreRememberedProxySelection } from "/lib/proxy-selection.js";
import { disableSystemProxy, enableSystemProxy } from "/lib/system-proxy-runtime.js";
import { startupConnectRequested, startupRuntimePlan } from "/lib/startup-runtime-policy.js";
import { persistDpiIntentForRelaunch } from "/lib/dpi-elevation-intent.js";
import {
  prepareStrictPrivacyRuntime,
  selectStrictPrivacyCandidate,
} from "/lib/strict-privacy-policy.js";
import {
  clearStrictTunnelPreviousMode,
  readStrictTunnelPreviousMode,
  rememberStrictTunnelPreviousMode,
} from "/lib/strict-privacy-mode.js";
import { createProtectedBrowserService } from "/lib/protected-browser.js";
import { activityController } from "/lib/activity-controller.js";
import { createPromotableSingleFlight } from "/lib/async-control.js";
import {
  acquireUpdateForCurrentRoute,
  closeUpdateResource,
  drainUpdateResourceCleanup,
  snapshotUpdate,
} from "/lib/update-resource.js";
import {
  installPageGuards,
  isContextMenuKey,
  openPMenu,
} from "/lib/pmenu.js";
import { localizedInvoke } from "/lib/backend-errors.js";

// ── Tauri 2 (withGlobalTauri:true) ───────────────────────────
const tauriWin = window.__TAURI__?.window?.getCurrentWindow?.()
  ?? window.__TAURI__?.window?.getCurrent?.();
const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? ((cmd, args) => {
    console.warn("Tauri invoke недоступен:", cmd, args);
    return Promise.reject(new Error("Tauri invoke недоступен (web preview)"));
  });
const protectedBrowser = createProtectedBrowserService({ invoke });

// The WebView2 page menu, reloading and history navigation are outside the app.
installPageGuards(document);

// Readers of the setting take the shared frozen snapshot: loadOptions()
// does a structuredClone of the whole tree on every call, and this predicate is called
// from renders and from checks at every connect step.
function strictPrivacyRequested() {
  return !!getOptionsSnapshot().privacy?.strictTunnel;
}

let protectedBrowserAutoLaunched = false;

async function requestProtectedBrowserLaunch(url = null, { automatic = false } = {}) {
  if (state !== "connected" || getMode() !== "tun") {
    if (!automatic || state === "connected") {
      toast(t("privacyToast.browserNeedConnection"), "warn", 4200);
    }
    return { ok: false, error: { code: "tun_not_connected" } };
  }
  const launchEpoch = networkIntentEpoch;
  const runtimeToken = runtimeIdentity.capture();
  const status = await protectedBrowser.status();
  if (!status.ok) {
    if (!automatic) toast(t("privacyToast.browserFailed"), "error", 4200);
    return status;
  }
  if (!status.data.available) {
    toast(t("privacyToast.browserMissing"), "warn", 5000);
    return { ok: false, error: { code: "browser_missing" } };
  }
  // The install check is IPC and may finish after a disconnect/reconnect.
  // Before the actual spawn we confirm the same runtime and network intent.
  if (state !== "connected"
    || getMode() !== "tun"
    || !isCurrentNetworkIntent(launchEpoch, "connected")
    || !runtimeIdentity.isCurrent(runtimeToken)) {
    if (!automatic) toast(t("privacyToast.browserNeedConnection"), "warn", 4200);
    return { ok: false, error: { code: "stale_tun_runtime" } };
  }
  const result = await protectedBrowser.launch(url ? { url } : undefined);
  if (!result.ok) {
    toast(t("privacyToast.browserFailed"), "error", 5000);
  } else if (!automatic) {
    toast(t("privacyToast.browserLaunched"), "success", 2200);
  }
  return result;
}

async function openProtectedBrowserDownload() {
  if (state !== "connected" || getMode() !== "tun") {
    toast(t("privacyToast.browserNeedConnection"), "warn", 4200);
    return { ok: false, error: { code: "tun_not_connected" } };
  }
  const result = await protectedBrowser.openOfficialDownload();
  toast(
    t(result.ok ? "privacyToast.downloadOpened" : "privacyToast.downloadFailed"),
    result.ok ? "info" : "error",
    3500,
  );
  return result;
}

function maybeAutoLaunchProtectedBrowser() {
  if (protectedBrowserAutoLaunched || !loadOptions().privacy?.protectedBrowserAutoLaunch) return;
  protectedBrowserAutoLaunched = true;
  void requestProtectedBrowserLaunch(null, { automatic: true });
}

// ── Restoring state from the backup ──────────────────────
// The WebView2 profile (EBWebView) may have been wiped by disk cleaners/antivirus: if
// localStorage is empty and there's a snapshot in the writable config dir, we restore the keys and
// reload the webview so that all modules reread the storage from scratch
// (theme/language/options have already been read with defaults by this point).
// Portable without a password stores data in plain text and asks nothing.
// The password is needed only if the data on disk is already encrypted: without it the profile
// storage won't open, and the user would see an empty list.
async function unlockPortableSecretsForRecovery() {
  try {
    const status = await invoke("portable_secrets_status");
    if (!status?.portable || !status.locked) return;
    let message = t("portable.recoveryPrompt");
    for (;;) {
      const passphrase = window.prompt(message);
      if (passphrase == null || passphrase === "") return;
      try {
        await invoke("portable_secrets_set_passphrase", { passphrase });
        return;
      } catch (error) {
        console.warn("portable secret unlock failed", error);
        message = `${t("portable.unlockFailed")}\n\n${t("portable.recoveryPrompt")}`;
      }
    }
  } catch (error) {
    console.warn("portable secret status failed", error);
  }
}

const restoreStateOnLaunch = (async () => {
  try {
    await unlockPortableSecretsForRecovery();
    await initializeProfileStore({ invoke, storage: localStorage });
    if (await restoreIfEmpty()) {
      location.reload();
      return true;
    }
  } catch {}
  return false;
})();

// ── Theme switcher ──────────────────────────────────────────
const THEME_KEY = "ninety.theme";
const appRoot = document.getElementById("app-root");

export function getTheme() {
  const raw = localStorage.getItem(THEME_KEY);
  return isThemeId(raw) ? raw : DEFAULT_THEME_ID;
}
// data-theme is set on <html> (documentElement), NOT only on #app-root: otherwise
// portal UI outside #app-root (modals/toasts/context menus, appended to body) takes
// the :root default (kurogane) instead of the active theme. #app-root is kept in sync with the same
// value — its own [data-theme] would otherwise override inheritance for the app subtree.
function applyThemeAttr(theme) {
  document.documentElement.dataset.theme = theme;
  if (appRoot) appRoot.dataset.theme = theme;
}
export function setTheme(theme) {
  if (!isThemeId(theme)) return;
  localStorage.setItem(THEME_KEY, theme);
  applyThemeAttr(theme);
  window.dispatchEvent(new CustomEvent("ninety:theme-changed", { detail: { theme } }));
}
// Apply the saved theme right away — before the first render of everything else
applyThemeAttr(getTheme());
initContrast();
applyCalmHud();
window.__ninetySetTheme = setTheme;

// ── i18n: the language is applied BEFORE the first display (the catalog is already in memory, synchronously).
// The module script is deferred → the DOM is ready, applyDom inside initI18n finds the elements.
initI18n();

// ── Version (dynamic from Tauri) ─────────────────────────────
// IMPORTANT: DON'T put a MutationObserver on settings-root — the screen render changes
// its contents, which creates a new mutation → an endless loop → a WebView2 freeze
// when entering Settings/General (alpha14 bug).
async function fillAppVersion() {
  let v = "—";
  try {
    const app = window.__TAURI__?.app;
    if (app?.getVersion) v = await app.getVersion();
  } catch {}
  const sidebar = document.getElementById("sidebar-version");
  if (sidebar) sidebar.textContent = v === "—" ? "v—" : `v${v}`;
}
fillAppVersion();

// ── Titlebar + popovers — /lib/titlebar.js, /lib/popovers.js ──
// The window buttons and the "Mode" popover are moved into modules. closeAllPopovers stays
// available as an alias — add-sub calls it when opening the modal.
initTitlebar(tauriWin);
const { closeAll: closeAllPopovers } = initPopovers();

// ── Mode segmented control (3 modes) ───────────────────────────────
const modeSeg = document.getElementById("mode-seg");
const modeHint = document.getElementById("mode-hint");
const warpSwitch = document.getElementById("warp-switch");

// Mode hints live in the i18n catalog (mode.hint.*) — taken via t() on apply.
const MODE_KEYS = ["proxy", "systemProxy", "tun"];

function applyModeToUI(m) {
  if (modeSeg) {
    modeSeg.querySelectorAll(".seg__btn").forEach((x) => {
      const active = x.dataset.mode === m;
      x.dataset.on = active ? "true" : "false";
      x.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  if (modeHint) modeHint.innerHTML = t("mode.hint." + (MODE_KEYS.includes(m) ? m : "systemProxy"));
  // DPI bypass listens to the mode: entering TUN → pause, leaving → restore.
  void setDpiVpnMode(m);
}
// The strict policy never exists in proxy/systemProxy: we restore
// a consistent mode before the first render and the runtime bootstrap.
if (strictPrivacyRequested() && getMode() !== "tun") setMode("tun");
applyModeToUI(getMode());

// WARP switch in the popover
(function initWarpSwitch() {
  if (!warpSwitch) return;
  const opts = loadOptions();
  warpSwitch.dataset.on = String(!!opts.warp?.enabled);
  a11ySwitch(warpSwitch);
  warpSwitch.addEventListener("click", async (e) => {
    e.stopPropagation();
    const newVal = warpSwitch.dataset.on !== "true";
    updateOption("warp.enabled", newVal);
    if (state === "connected" || state === "connecting") scheduleAutoReconnect();
    updateWarpBadge();
  });
  // The whole label row is clickable, not just the toggle — like settings rows.
  const warpRow = warpSwitch.closest(".popover__warp");
  warpRow?.addEventListener("click", (e) => {
    if (warpSwitch.contains(e.target)) return;
    e.preventDefault();
    warpSwitch.click();
  });
})();

// warp.enabled is controlled from two places — the switch in the "Mode" popover and the toggle
// in Settings → WARP. Neither redraws when the option changes from outside,
// so on any write (an event from updateOption) we align both controls.
window.addEventListener("ninety:option-changed", (e) => {
  if (e.detail?.path !== "warp.enabled") return;
  const on = String(!!e.detail.value);
  if (warpSwitch) warpSwitch.dataset.on = on;
  const settingsSw = document.querySelector('#settings-root .switch[data-opt="warp.enabled"]');
  if (settingsSw) settingsSw.dataset.on = on;
});

modeSeg?.addEventListener("click", async (e) => {
  const b = e.target.closest(".seg__btn");
  if (!b) return;
  await changeMode(b.dataset.mode);
});

// A single connection mode change — from the segment on the home screen AND from the tray menu.
// auto=true — the switch was made by Wi-Fi auto-protection (see /lib/wifi-guard.js);
// the user's manual choice cancels its auto-restore of the previous mode.
async function changeMode(requested, { auto = false, reconnect = true } = {}) {
  if (!["proxy", "systemProxy", "tun"].includes(requested)) return false;
  if (strictPrivacyRequested() && requested !== "tun") {
    applyModeToUI("tun");
    if (!auto) toast(t("privacyToast.modeLocked"), "warn", 4200);
    return false;
  }
  if (!auto) forgetWifiAutoRestore();
  const prevMode = getMode();
  // TUN (Throne-style) requires the whole app to run as admin.
  // If we aren't elevated, ensureElevatedForTun restarts Ninety with UAC
  // (and returns false: the current process dies, there's no point going further).
  if (requested === "tun") {
    const ok = await ensureElevatedForTun();
    if (!ok) return false;
    // Before writing the mode and reconnecting, the winws stop must be confirmed. Otherwise
    // TUN would come up on top of still active packet interception.
    if (!(await prepareDpiVpnMode(requested))) return false;
  }
  // The regular Kill Switch belongs to proxy/systemProxy, but its shield must
  // survive crossing the TUN boundary too. Before writing the new mode we confirm
  // the old policy or put block-all in place in advance for the target non-TUN mode.
  // Otherwise reconnect would already see the new mode and remove the filter before the core is ready.
  if (reconnect
    && requested !== prevMode
    && (state === "connected" || state === "connecting")
    && loadOptions().general?.killSwitch
    && (prevMode !== "tun" || requested !== "tun")) {
    const ordinaryPolicyMode = prevMode !== "tun" ? prevMode : requested;
    const barrierReady = await applyKillSwitch(false, {
      preserve: true,
      policyMode: ordinaryPolicyMode,
    });
    if (!barrierReady) {
      toast(t("privacyToast.guardLost"), "error", 0, { group: "privacy-guard" });
      return false;
    }
    strictFailClosedLatched = false;
    ordinaryFailClosedLatched = true;
  }
  setMode(requested);
  applyModeToUI(requested);
  updateHeroHint();
  syncTrayMenu();
  // The mode changes the inbound (TUN vs mixed) and the system proxy — with the VPN up
  // the config must be rebuilt. reconnectForSourceChange goes to idle itself (resetting
  // the old mode's system proxy) and comes back up. If not connected —
  // a no-op, the mode applies on the next connect.
  if (reconnect && requested !== prevMode) reconnectForSourceChange(t("conn.switchMode"));
  return true;
}

// ── Auto-protection on foreign Wi-Fi (III.3) — /lib/wifi-guard.js ──
// changeMode is injected (it closes over setMode/UI/reconnect); forgetWifiAutoRestore
// is called from changeMode on a manual mode change, cancelling the auto-restore.
initWifiGuard({ changeMode });

// ── Kill Switch (I.2) — /lib/kill-switch.js ─────────────────
// applyKillSwitch(connected) is called from setState; maybeWarnKillSwitchProxy from
// settings onChange when the option is enabled in "Proxy" mode.

// TUN brings up a network interface — for that sing-box (our child) must
// run as admin, which means the whole app too. If already elevated — fine,
// continue. Otherwise we restart Ninety as admin via UAC: the restarted
// instance reads mode=tun from localStorage. It connects only if
// connect=true (--connect): switching the mode with the VPN off must not
// bring up the tunnel. Returns: true — we can continue in the current (already admin)
// process; false — a restart is in progress OR the user declined UAC.
let elevationRelaunchPending = false;

// A restart with rights preserves whether there was a connection: a working VPN
// comes up again in the new process, a disabled one stays disabled.
function vpnSessionActive() {
  return state === "connected" || state === "connecting";
}

async function ensureElevatedForTun({ connect = vpnSessionActive() } = {}) {
  elevationRelaunchPending = false;
  const prevMode = getMode();
  let modeStoredForRelaunch = false;
  try {
    if (await invoke("is_elevated")) return true;
    const yes = confirm(t("elev.tunConfirm"));
    if (!yes) return false;
    // Remember the mode in advance — the restarted admin instance will come up in TUN.
    // Both in localStorage and in the durable backup: the DPI path does exactly the same
    // (persistDpiIntentForRelaunch), and without backupNow the intent got lost if
    // the WebView2 profile didn't survive the elevated restart.
    setMode("tun");
    modeStoredForRelaunch = true;
    await backupNow();
    const started = await invoke("relaunch_elevated", { connect });
    if (!started) {
      setMode(prevMode);
      await backupNow();
      applyModeToUI(prevMode);
      updateHeroHint();
      syncTrayMenu();
      toast(t("elev.tunCancelled"), "error", 3000);
      return false;
    }
    elevationRelaunchPending = true;
    toast(t("elev.relaunching"), "info", 2500);
    return false; // the current process is about to exit — don't continue
  } catch (e) {
    elevationRelaunchPending = false;
    if (modeStoredForRelaunch) {
      setMode(prevMode);
      void backupNow();
      applyModeToUI(prevMode);
      updateHeroHint();
      syncTrayMenu();
    }
    toast(t("elev.failed", { err: e?.message || e }), "error", 3500);
    return false;
  }
}

// DPI bypass: winws loads the WinDivert kernel driver → admin rights are needed. The same
// scheme as for TUN, but without a mode change: already elevated → continue; otherwise
// a restart with UAC (the current process will die, we return false).
async function ensureElevatedForDpi() {
  try {
    if (await invoke("is_elevated")) return true;
    const yes = confirm(t("elev.dpiConfirm"));
    if (!yes) return false;
    // On success relaunch_elevated terminates the current process right inside Rust,
    // so the intent to enable DPI must get into storage and the backup BEFORE UAC.
    const started = await persistDpiIntentForRelaunch({
      getEnabled: () => localStorage.getItem("ninety.dpi.enabled") === "true",
      setEnabled: (enabled) => localStorage.setItem("ninety.dpi.enabled", enabled ? "true" : "false"),
      backup: () => backupNow(),
      relaunch: () => invoke("relaunch_elevated", { connect: vpnSessionActive() }),
    });
    if (!started) {
      toast(t("elev.dpiCancelled"), "error", 3000);
      return false;
    }
    toast(t("elev.relaunching"), "info", 2500);
    return false; // the process is about to exit
  } catch (e) {
    toast(t("elev.failed", { err: e?.message || e }), "error", 3500);
    return false;
  }
}

// ── Add Profile Modal ──────────────────────────────────────
const profilesSummary = document.getElementById("profiles-summary");

mountAddModal({
  onCommit: async (res) => {
    // A repeated link created nothing — we say so with a warning, otherwise
    // a green toast reads as "added" and people look for a second subscription in the list.
    toast(res.message, res.duplicate ? "warn" : "success", res.duplicate ? 3600 : 2000);
    // Importing a subscription doesn't activate it: switching breaks the live connection, and
    // the source is chosen by the user. The exception is when there's no active source
    // yet: then there would be nothing to connect to (including in the wizard).
    const activate = res.source && (res.activate !== false || !getActiveSource());
    if (activate) {
      const reason = res.source.kind === "sub" ? t("conn.switchSub") : t("conn.switchProfile");
      applyActiveSource(res.source.kind, res.source.id, { reconnect: true, silent: true, reason });
    } else {
      refreshProfilesSummary();
    }
    // Wizard: after the import we move on to "connect".
    if (wizardActive && wizardStepNum === 1) {
      showOnbStep(2);
      setTimeout(() => {
        try { heroDisc?.click(); } catch {}
      }, 450);
    }
  },
});

document.getElementById("add-sub")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeAllPopovers();
  openAddModal();
});

function refreshProfilesSummary() {
  const subsList = loadSubscriptions();
  if (profilesSummary) {
    if (subsList.length) profilesSummary.textContent = String(subsList.length);
    else profilesSummary.textContent = "";
  }
  renderProfilesView();
  updateHeroForActive();
  refreshSubCardFromActive();
  syncEmptyState();
  backupSoon(); // profiles/subscriptions changed — update the backup snapshot
}

function warpOnlyEnabled() {
  const opts = loadOptions();
  return !opts.privacy?.strictTunnel
    && !!opts.warp?.enabled
    && opts.warp?.mode === "direct";
}

function hasConnectSource() {
  return !!getActiveSource() || warpOnlyEnabled();
}

function activeDisplaySource() {
  return getActiveSource() || (warpOnlyEnabled()
    ? { kind: "warp", profile: { id: "warp", proto: "wireguard", name: "WARP", host: loadOptions().warp?.endpoint || "engage.cloudflareclient.com" } }
    : null);
}

// Empty state: neither a subscription nor a config → show the onboarding wizard
// (if it isn't completed yet). The wizard also keeps onboarding visible until
// the user reaches step 4 — even if empty is already false (a subscription was added).
function syncEmptyState() {
  if (!appRoot) return;
  const sourceEmpty = loadProfiles().length === 0 && loadSubscriptions().length === 0 && !warpOnlyEnabled();
  const onboardingEmpty = shouldShowOnboarding({ sourceEmpty, done: isOnboardingDone() });
  appRoot.dataset.empty = String(onboardingEmpty);
  const onb = document.getElementById("onboarding-screen");
  if (onboardingEmpty && !wizardActive) {
    openWizardAt(wizardStepNum || 1);
    return;
  }
  appRoot.dataset.wizard = String(wizardActive);
  if (onb) onb.hidden = !(wizardActive || onboardingEmpty);
}

// ── sub-card sync with the active subscription ─────────────────────
const subName = document.querySelector(".sub-card__name");
const subExpire = document.getElementById("sub-expire");
const subExpireUnit = document.querySelector(".sub-card__expire");
const subProgressFill = document.getElementById("sub-progress-fill");
const subTraffic = document.getElementById("sub-traffic");
const subBar = document.getElementById("sub-bar");
const subUpdated = document.getElementById("sub-updated");

function refreshSubCardFromActive() {
  const src = activeDisplaySource();
  if (src?.kind === "sub") {
    const sub = src.subscription;
    if (subName) subName.textContent = sub.name?.toUpperCase() || t("home.subDefault");
    const days = subscriptionDaysLeft(sub);
    if (subExpire) subExpire.textContent = days != null ? String(days) : "—";
    if (subExpireUnit) subExpireUnit.style.display = days != null ? "" : "none";
    const used = subscriptionUsedBytes(sub);
    const limit = subscriptionLimitBytes(sub); // null = unlimited/not metered (total=0)
    if (subTraffic) {
      // Hybrid: there's a real provider limit → the used/total quota. Otherwise we show
      // our measured traffic (the provider header is unreliable/0).
      // dir="ltr" — a value with a unit reads as one whole; without isolation
      // bidi in fa/ar spreads the number and the unit to different ends of the line.
      subTraffic.innerHTML = limit != null
        ? `<span dir="ltr"><b>${fmtTraffic(used)}</b> / <b>${fmtTraffic(limit)}</b></span>`
        : `<span dir="ltr"><b>${fmtTraffic(getMeasured(`sub:${sub.id}`).total)}</b></span> · ${t("home.unlimited")}`;
    }
    // Progress bar: with a GB limit — quota usage (used/total); unlimited — the share
    // of the REMAINING TERM of the subscription. The provider doesn't give the period → self-calibration by the peak
    // of days seen (= the length of the period/last renewal): full on renewal,
    // decreasing toward the end. Without a term and without a limit there's nothing to show — hide it.
    let barPct = null;
    if (limit != null) {
      barPct = Math.min(100, (used / limit) * 100);
    } else if (days != null) {
      const key = `ninety.sub.${sub.id}.peakDays`;
      let peak = 0;
      try { peak = Number(localStorage.getItem(key)) || 0; } catch {}
      if (days > peak) { peak = days; try { localStorage.setItem(key, String(peak)); } catch {} }
      barPct = peak > 0 ? Math.max(0, Math.min(100, (days / peak) * 100)) : 100;
    }
    if (subBar) subBar.style.display = barPct != null ? "" : "none";
    if (subProgressFill) subProgressFill.style.width = barPct != null ? `${barPct.toFixed(1)}%` : "0%";
    if (subUpdated) subUpdated.textContent = relativeTime(sub.lastUpdate);
  } else if (src?.kind === "single") {
    if (subName) subName.textContent = t("home.localConfig");
    if (subExpire) subExpire.textContent = "—";
    if (subExpireUnit) subExpireUnit.style.display = "none";
    // A single profile (hysteria/naive/tt) has no quota — we show the measured traffic.
    if (subTraffic) subTraffic.innerHTML = `<span dir="ltr"><b>${fmtTraffic(getMeasured(`profile:${src.profile.id}`).total)}</b></span>`;
    if (subBar) subBar.style.display = "none";
    if (subProgressFill) subProgressFill.style.width = "0%";
    if (subUpdated) subUpdated.textContent = "—";
  } else if (src?.kind === "warp") {
    if (subName) subName.textContent = "WARP";
    if (subExpire) subExpire.textContent = "—";
    if (subExpireUnit) subExpireUnit.style.display = "none";
    if (subTraffic) subTraffic.innerHTML = `<span dir="ltr"><b>${fmtTraffic(getMeasured("warp").total)}</b></span>`;
    if (subBar) subBar.style.display = "none";
    if (subProgressFill) subProgressFill.style.width = "0%";
    if (subUpdated) subUpdated.textContent = "—";
  } else {
    if (subName) subName.textContent = t("home.noSub");
    if (subExpire) subExpire.textContent = "—";
    if (subExpireUnit) subExpireUnit.style.display = "none";
    if (subTraffic) subTraffic.textContent = "—";
    if (subBar) subBar.style.display = "none";
    if (subProgressFill) subProgressFill.style.width = "0%";
    if (subUpdated) subUpdated.textContent = "—";
  }
}

// ── Navigation ───────────────────────────────────────────────
const navItems = document.querySelectorAll(".nav__item[data-view]");
const views = document.querySelectorAll("section.screen[data-view]");

// Entering a screen isn't work for this frame. onProxiesViewEnter renders a table
// of hundreds of rows, onLogsViewEnter reads the log tail and parses it: running
// synchronously, they landed in the same frame as the first layout of the just
// shown screen, and the transition stuttered. Now the transition frame is drawn
// immediately, and the entry runs on the next one. Leaving (Leave) stays synchronous — it
// stops the timers of the screen being left, and that can't be postponed.
let pendingViewEnter = null;
let currentView = "home";

function runViewEnter(target) {
  if (currentView !== target) return;
  if (target === "logs") onLogsViewEnter();
  if (target === "proxies") onProxiesViewEnter();
  if (target === "dpi") onDpiViewEnter();
  if (target === "diagnose") onDiagnoseViewEnter();
}

// rAF doesn't arrive while the window is hidden (opening a screen from the tray), so the timer
// races the frame: whichever fires first wins, the second becomes a no-op.
function scheduleViewEnter(target) {
  if (pendingViewEnter) {
    cancelAnimationFrame(pendingViewEnter.frame);
    clearTimeout(pendingViewEnter.timer);
  }
  const fire = () => {
    if (!pendingViewEnter) return;
    cancelAnimationFrame(pendingViewEnter.frame);
    clearTimeout(pendingViewEnter.timer);
    pendingViewEnter = null;
    runViewEnter(target);
  };
  pendingViewEnter = {
    frame: requestAnimationFrame(fire),
    timer: setTimeout(fire, 120),
  };
}

// The video mask is decoded only while the home screen is visible — offscreen we zero
// the decode. In calm mode it stays on the current frame.
function syncHeroMaskPlayback() {
  if (!heroMask) return;
  if (currentView === "home" && !isCalmHud()) heroMask.play?.().catch(() => {});
  else heroMask.pause?.();
}

function switchView(target) {
  currentView = target;
  activityController.setView(target);
  navItems.forEach((n) => {
    const active = n.dataset.view === target;
    n.classList.toggle("nav__item--active", active);
    if (active) { n.setAttribute("aria-current", "page"); n.scrollIntoView({ block: "nearest" }); }
    else n.removeAttribute("aria-current");
  });
  views.forEach((v) => { v.hidden = v.dataset.view !== target; });
  syncHeroMaskPlayback();
  if (target !== "logs") onLogsViewLeave();
  if (target !== "proxies") onProxiesViewLeave();
  scheduleViewEnter(target);
}

navItems.forEach((item) => {
  item.tabIndex = 0;
  item.addEventListener("click", () => switchView(item.dataset.view));
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchView(item.dataset.view); }
  });
});

// In a short window the menu scrolls within itself; there's no scrollbar, so the edge
// beyond which items remain is marked for fading (see .nav[data-scroll]).
const navList = document.querySelector(".nav");
function syncNavScrollHint() {
  if (!navList) return;
  const up = navList.scrollTop > 1;
  const down = navList.scrollTop + navList.clientHeight < navList.scrollHeight - 1;
  const hint = up && down ? "both" : up ? "up" : down ? "down" : "";
  if (hint) navList.dataset.scroll = hint; else delete navList.dataset.scroll;
}
navList?.addEventListener("scroll", syncNavScrollHint, { passive: true });
if (navList && typeof ResizeObserver === "function") new ResizeObserver(syncNavScrollHint).observe(navList);

// The active subscription card on the home screen → open "Profiles":
// an explicit chevron button + click/Enter on the card itself.
const subCardEl = document.querySelector(".sub-card");
const subOpenBtn = document.getElementById("sub-open-profiles");
subOpenBtn?.addEventListener("click", (e) => { e.stopPropagation(); switchView("profiles"); });
subCardEl?.addEventListener("click", () => switchView("profiles"));
subCardEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchView("profiles"); }
});

// In the strict runtime only one physical outbound remains: a node switch
// saves the new pin and rebuilds the connection instead of a Clash hot switch.
mountProxiesView({
  onToast: toast,
  isStrictPrivacy: strictPrivacyRequested,
  onStrictNodeSelected: (_tag, _node) => {
    if (state === "connected" || state === "connecting") {
      reconnectForSourceChange(t("conn.applyingSettings"));
      toast(t("conn.applyingSettings"), "info", 1800);
    } else {
      toast(t("conn.serverSwitched"), "success", 1400);
    }
  },
});

// Mount DPI bypass (the screen + the chip on the home screen). We sync the VPN mode right away:
// in TUN the bypass auto-pauses (see dpi-view.js::effState).
mountDpiView({ onToast: toast, switchView, ensureElevated: ensureElevatedForDpi });

// The addresses of all servers of the active source — for excluding them from the DPI bypass.
// The Balancer pings every node of the subscription, and when only one was excluded (previously —
// nodes[0] before connecting) the checks of the others went through winws desync: "Auto"
// couldn't leave a dead node. IP or name is parsed by dpi-view; name resolution
// is there too, and only while winws is running.
function vpnNodeAddresses() {
  // The VPN is off — there's nothing to exclude: we don't resolve the saved source's names
  // and don't take its addresses out of the bypass for regular traffic.
  if (state === "idle" || state === "cleanup_error") return [];
  const src = getActiveSource();
  const nodes = src?.kind === "sub" ? (src.nodes || []) : (src?.profile ? [src.profile] : []);
  const out = [];
  const push = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return;
    // Local addresses (bridges, 127.0.0.1/0.0.0.0 placeholders) aren't needed by winws.
    const host = text.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/^([^:]+):\d+$/, "$1").toLowerCase();
    if (host === "localhost" || host === "::1" || host === "::" || host === "0.0.0.0" || host.startsWith("127.")) return;
    out.push(text);
  };
  for (const node of nodes) {
    push(node?.host);
    // TrustTunnel connects to the addresses from addresses, not to the displayed
    // host. For WireGuard addresses are the interface addresses, we leave them alone.
    if (node?.proto === "trusttunnel") {
      for (const address of Array.isArray(node.addresses) ? node.addresses : []) push(address);
    }
    for (const peer of Array.isArray(node?.peers) ? node.peers : []) push(peer?.host);
    const endpoint = node?.endpoint;
    const servers = endpoint?.servers?.length ? endpoint.servers : (endpoint ? [endpoint] : []);
    for (const server of servers) push(server?.server);
    if (node?.extra) {
      try { push(JSON.parse(node.extra)?.downloadSettings?.address); } catch {}
    }
  }
  const warp = loadOptions().warp;
  // auto/auto4/auto6 — an endpoint choice by the scanner, not an address.
  const warpHost = String(warp?.endpoint || "").replace(/:\d+$/, "");
  if (warp?.enabled && warpHost && !/^auto[46]?$/i.test(warpHost)) push(warp.endpoint);
  return out;
}
setVpnNodesProvider(() => ({ domains: vpnNodeAddresses() }));
void setDpiVpnMode(getMode());

// ── Settings view ──────────────────────────────────────────
const settingsRoot = document.getElementById("settings-root");
let settingsCtl = null;
if (settingsRoot) {
  let killSwitchToggleEpoch = 0;
  let strictTunnelToggleEpoch = 0;
  settingsCtl = mountSettings(settingsRoot, {
    onChange: async (path, value) => {
      backupSoon(); // settings changed — update the state backup snapshot
      if (path === "privacy.strictTunnel") {
        const toggleEpoch = ++strictTunnelToggleEpoch;
        const stillCurrent = () => toggleEpoch === strictTunnelToggleEpoch
          && !!loadOptions().privacy?.strictTunnel === !!value;
        if (value) {
          const previousMode = getMode();
          // The strict policy is a runtime overlay: after it's turned off we must
          // restore the user mode that was there before the forced TUN.
          // We write it before ensureElevatedForTun(), because a successful UAC relaunch
          // terminates the current process right inside the backend command.
          rememberStrictTunnelPreviousMode(previousMode);
          const modeReady = await changeMode("tun", { reconnect: false });
          if (!stillCurrent()) return;
          // On a successful UAC relaunch the current process is already exiting, and the new one
          // will read the saved strict=true. On cancel/error we explicitly roll back
          // the switcher even if the previous saved mode was already TUN.
          if (!modeReady) {
            if (elevationRelaunchPending) return;
            updateOption(path, false);
            clearStrictTunnelPreviousMode();
            strictTunnelToggleEpoch++;
            settingsCtl?.refresh();
            await applyKillSwitch(false);
            toast(t("privacyToast.enableCancelled"), "warn", 4200);
            return;
          }
          if (state === "connected" || state === "connecting") {
            // We close the window between stopping the regular runtime and starting strict:
            // the barrier is set BEFORE the reconnect, and the latch makes shutdown
            // keep it until the new TUN is ready.
            const guardReady = await applyKillSwitch(true, { phase: "preconnect" });
            if (!stillCurrent()) return;
            if (!guardReady) {
              updateOption(path, false);
              clearStrictTunnelPreviousMode();
              const rollbackEpoch = ++strictTunnelToggleEpoch;
              settingsCtl?.refresh();
              await changeMode(previousMode, { reconnect: false });
              if (rollbackEpoch !== strictTunnelToggleEpoch) return;
              strictFailClosedLatched = false;
              await applyKillSwitch(state === "connected");
              if (rollbackEpoch !== strictTunnelToggleEpoch) return;
              toast(t("conn.startFail"), "error", 5000, {
                desc: t("elev.killSwitchHint"),
              });
              return;
            }
            ordinaryFailClosedLatched = false;
            strictFailClosedLatched = true;
          }
        } else if (state === "idle") {
          // A fail-closed WFP may have remained after a crash of the previous strict session.
          const disarmed = await applyKillSwitch(false);
          if (!stillCurrent()) return;
          if (disarmed) {
            strictFailClosedLatched = false;
            ordinaryFailClosedLatched = false;
          } else {
            // The UI must not promise removed protection if the WFP lease couldn't be
            // released. We restore the setting and the guard-only retry; exiting
            // the app (dynamic session) remains a guaranteed recovery.
            updateOption(path, true);
            strictTunnelToggleEpoch++;
            ordinaryFailClosedLatched = false;
            strictFailClosedLatched = true;
            settingsCtl?.refresh();
            syncHealthWatchdogForState();
            toast(t("conn.cleanupFail"), "error", 6000, {
              desc: t("conn.cleanupFailDesc"),
            });
            return;
          }
        }
        if (!stillCurrent()) return;
        let restoredPreviousMode = false;
        if (!value) {
          const previousMode = readStrictTunnelPreviousMode();
          if (previousMode && previousMode !== getMode()) {
            restoredPreviousMode = await changeMode(previousMode);
            if (!stillCurrent()) return;
            if (!restoredPreviousMode) return;
          }
          // For a previous TUN nothing needs switching, but we still delete the stale marker:
          // the next enable must remember a fresh mode.
          clearStrictTunnelPreviousMode();
        }
        syncHealthWatchdogForState();
        // setDpiVpnMode can reevaluate the same TUN mode: when strict is turned off
        // it restores split Discord/winws according to the saved option.
        if (!(await setDpiVpnMode(getMode(), { reevaluate: true }))) return;
        if ((state === "connected" || state === "connecting") && !restoredPreviousMode) {
          scheduleAutoReconnect();
        } else {
          updateHeroHint();
        }
        settingsCtl?.refresh();
        return;
      }
      // Kill switch is a pure WFP filter, it doesn't touch the sing-box config: we apply it
      // live (arm/disarm by the current state), WITHOUT reconnecting the tunnel (previously
      // the toggle brought the VPN down and up needlessly). In "Proxy" mode — a one-time warning.
      if (path === "general.killSwitch") {
        const toggleEpoch = ++killSwitchToggleEpoch;
        maybeWarnKillSwitchProxy();
        // Without administrator rights WFP can't be raised, and a connection with protection
        // enabled fails every time. With the VPN off the check below
        // arms nothing — we say so right away rather than on the first failure.
        if (value && state !== "connected" && !(await invoke("is_elevated").catch(() => true))) {
          toast(t("elev.killSwitchHint"), "warn", 6000);
        }
        const shouldArm = state === "connected";
        const ready = await applyKillSwitch(shouldArm);
        if (toggleEpoch === killSwitchToggleEpoch && ready !== false) {
          ordinaryFailClosedLatched = !!value
            && shouldArm
            && state === "connected"
            && getMode() !== "tun";
        }
        // Arming WFP is part of the setting's contract, not fire-and-forget.
        // If the core is already up, we don't leave the switch enabled with
        // the protection actually inactive: we roll the write and the DOM back to a safe
        // state, then explicitly remove a possibly partially raised filter.
        if (toggleEpoch === killSwitchToggleEpoch && ready === false) {
          const revertedValue = !value;
          updateOption(path, revertedValue);
          settingsCtl?.refresh();
          const restored = await applyKillSwitch(state === "connected" && revertedValue);
          if (toggleEpoch === killSwitchToggleEpoch) {
            ordinaryFailClosedLatched = !!revertedValue
              && state === "connected"
              && getMode() !== "tun"
              && restored === true;
          }
          toast(t("conn.startFail"), "error", 5000, { desc: t("elev.killSwitchHint") });
        }
        if (toggleEpoch === killSwitchToggleEpoch) syncHealthWatchdogForState();
        return;
      }
      // The periodic re-scan toggles and its interval don't touch sing-box, only
      // the background JS loop. We recreate the loop right away, no reconnect needed.
      if (path === "warp.autoRescan" || path === "warp.autoRescanIntervalMin" || path === "warp.autoRescanThresholdMs") {
        startWarpRescanLoop();
        return;
      }
      // The badge with the active endpoint must react to any change of warp.*
      if (path === "warp.enabled" || path === "warp.endpoint") updateWarpBadge();
      if (path === "warp.enabled" || path === "warp.mode") {
        syncEmptyState();
        updateHeroForActive();
      }
      // Connection quality — the engine reads the options, the core isn't touched. Applied live
      // via setOptions; on/off hides/shows the "CHANNEL" indicator.
      if (path.startsWith("quality.")) {
        qualityEngine.setOptions(loadOptions().quality);
        if (activeStrictPrivacyRuntime) {
          stopQualityEngine("monitoringOff");
          showQualityChip(false);
        } else if (path === "quality.enabled" && state === "connected") {
          const enabled = loadOptions().quality?.enabled !== false;
          // Turned-off observation is the same end of a measurement session as
          // a disconnect: an open incident must get an outcome rather than hang.
          if (!enabled) channelIncidents.endSession("monitoringOff");
          showQualityChip(enabled);
        }
        return;
      }
      if (path === "route.tunSplitDiscord" && getMode() === "tun") {
        // Turning split off must confirm the winws stop before the reconnect;
        // turning it on must bring it back only after a successful start.
        if (!(await setDpiVpnMode(getMode(), { reevaluate: true }))) return;
      }
      // Geo requests affect only the IP tile — we update it without a reconnect.
      if (path === "general.disableGeoLookup" && state === "connected") void refreshPublicIp();
      if (!pathNeedsRestart(path, loadOptions(), getMode())) return;
      if (state === "connected" || state === "connecting") {
        scheduleAutoReconnect();
      }
      if (state === "idle") updateHeroHint();
    },
    onSensitiveDataClear: async () => {
      beginNetworkIntent("idle");
      connectAttempts.cancel(); // cancel a possible start_singbox in flight
      if (!(await shutdownCore())) {
        throw new Error("очистка VPN не подтверждена; данные не удалены");
      }
      try {
        await invoke("dpi_stop");
      } catch (e) {
        throw new Error(`остановка DPI не подтверждена: ${e?.message || e}`, { cause: e });
      }
      try { localStorage.setItem("ninety.dpi.enabled", "false"); } catch {}
      // The durable copy is removed FIRST. The reverse order meant that a failure between
      // steps (or a process crash) left the live copies deleted and the backup
      // untouched: the next launch restored from it the profiles and subscriptions
      // the user had just asked to erase. Now the worst outcome is
      // "not deleted entirely", and it's visible right away.
      await invoke("state_backup_clear");
      await clearProfileStore();
      clearProfileStorage();
      // Again — after deleting the live copies: between the steps a deferred
      // backupSoon may have fired and written to the backup what we're deleting.
      await invoke("state_backup_clear");
      try { sessionStorage.removeItem("ninety.restore.attempted"); } catch {}
      refreshProfilesSummary();
      rerenderDpiView();
      syncTrayMenu();
      toast(t("settings.general.clearSensitiveDone"), "success", 2400);
    },
    // The "Updates" card in "About" shows the actual state of
    // the subsystem: whether a check is running, whether a version was found, when the last successful check was.
    getUpdateStatus: () => ({
      checking: updateChecks.isRunning(),
      pendingVersion: pendingUpdate?.version || null,
      lastSuccessAt: updateLastSuccessAt || 0,
    }),
    getProtectedBrowserStatus: () => protectedBrowser.status(),
    onProtectedBrowserLaunch: () => requestProtectedBrowserLaunch(),
    onProtectedBrowserCheck: () => requestProtectedBrowserLaunch("https://mullvad.net/en/check"),
    onProtectedBrowserDownload: openProtectedBrowserDownload,
  });
}

const RECONNECT_DEBOUNCE_MS = 1200;
let pendingReconnectTimer = null;
const coreStartBarrier = createCoreStartBarrier();
const networkIntent = createNetworkIntentArbiter("idle");
let networkIntentEpoch = 0;
let activeStrictPrivacyRuntime = false;
let strictFailClosedLatched = false;
let ordinaryFailClosedLatched = false;
const runtimeIdleGate = createRuntimeIdleGate({
  getState: () => state,
  isCurrent: (epoch, desired) => networkIntent.isCurrent(epoch, desired),
});

function killSwitchMustSurviveRuntimeStop() {
  return preservedKillSwitchPolicyMode() != null;
}

function preservedKillSwitchPolicyMode() {
  const opts = loadOptions();
  if (strictFailClosedLatched && opts.privacy?.strictTunnel) return "tun";
  // The latch describes an already confirmed ordinary barrier. During a
  // proxy↔TUN transition the current saved mode may be TUN, but the old
  // block-all must still survive until the new runtime's final readiness.
  if (ordinaryFailClosedLatched && opts.general?.killSwitch) return "systemProxy";
  return null;
}

function syncHealthWatchdogForState() {
  if (state === "connected" || killSwitchMustSurviveRuntimeStop()) {
    startHealthWatchdog();
  } else {
    stopHealthWatchdog();
  }
}

// The WebView may reload after the core has died. The backend snapshot then
// reports running=false, but WFP and RuntimeRecord still confirm an active
// fail-closed policy. We restore the lost JS latch before any early
// return and leave the watchdog in guard-only mode.
function restoreFailClosedLatch(snapshot, opts = loadOptions()) {
  if (snapshotConfirmsStrictKillSwitch(snapshot, opts)) {
    ordinaryFailClosedLatched = false;
    strictFailClosedLatched = true;
    syncHealthWatchdogForState();
    return "tun";
  }
  if (snapshotConfirmsOrdinaryKillSwitch(snapshot, opts)) {
    strictFailClosedLatched = false;
    ordinaryFailClosedLatched = true;
    syncHealthWatchdogForState();
    return snapshot.mode;
  }
  return null;
}

function beginNetworkIntent(desired) {
  networkIntentEpoch = networkIntent.begin(desired);
  // A newer intent invalidates any disconnecting waiter owned by the previous
  // request.  The current request, if still relevant, will register its own
  // waiter after this point.
  runtimeIdleGate.notify();
  return networkIntentEpoch;
}

function isCurrentNetworkIntent(epoch, desired) {
  return networkIntent.isCurrent(epoch, desired);
}

function cancelPendingReconnect() {
  needsReconnect = false;
  reconnectQueue.cancel();
  runtimeIdleGate.cancel();
  if (pendingReconnectTimer) {
    clearTimeout(pendingReconnectTimer);
    pendingReconnectTimer = null;
  }
}

// A single core shutdown: system proxy → core → UI to idle. All disconnect
// paths (manual, auto-reconnect, watchdog, bridge failure, start failure)
// go through it so that the system proxy reset isn't lost in any of them.
async function shutdownCore({ finalize = true, preserveKillSwitch = false, operationToken = null } = {}) {
  if (preserveKillSwitch) {
    const guardReady = await applyKillSwitch(false, {
      preserve: true,
      policyMode: preservedKillSwitchPolicyMode(),
    });
    if (!guardReady) {
      console.error("WFP fail-closed barrier could not be preserved; runtime shutdown postponed");
      toast(t("privacyToast.guardLost"), "error", 0, { group: "privacy-guard" });
      return false;
    }
  }
  setState("disconnecting", { preserveKillSwitch });
  runtimeIdentity.invalidate();
  cancelPendingSelections();
  connectAttempts.cancel();
  let result = null;
  try { result = await invoke("stop_singbox", operationToken ? { operationToken } : {}); }
  catch (e) { console.warn("stop failed", e); }
  if (result?.timings) console.info("runtime shutdown timings", result.timings);
  const componentFailed = result && [result.singbox, result.xray, result.sidecars].includes("failed");
  const stopped = !!result && !componentFailed && result.portsReleased !== false
    && result.processesExited !== false
    && result.systemProxy !== "failed";
  if (!stopped) {
    console.error("runtime cleanup not confirmed", result);
    setState("cleanup_error", { preserveKillSwitch });
    return false;
  }
  if (finalize) setState("idle", { preserveKillSwitch });
  return true;
}

// Any already running runtime that doesn't match the saved policy
// is stopped only after the fail-closed barrier. This covers startup/a WebView reload
// in the middle of activation, when the JS latch isn't restored yet.
async function shutdownRuntimeForPolicyReplacement(snapshot = null) {
  const preserveStrict = strictPrivacyRequested();
  const opts = loadOptions();
  restoreFailClosedLatch(snapshot, opts);
  const preserveOrdinary = !preserveStrict
    && !!opts.general?.killSwitch
    && (getMode() !== "tun" || ordinaryFailClosedLatched);
  if (preserveStrict) {
    const guardReady = await applyKillSwitch(true, { phase: "preconnect" });
    if (!guardReady) {
      toast(t("privacyToast.guardLost"), "error", 0, { group: "privacy-guard" });
      return false;
    }
    ordinaryFailClosedLatched = false;
    strictFailClosedLatched = true;
  }
  if (preserveOrdinary) {
    strictFailClosedLatched = false;
    ordinaryFailClosedLatched = true;
  }
  return shutdownCore({ preserveKillSwitch: preserveStrict || preserveOrdinary });
}

function scheduleAutoReconnect() {
  if (state !== "connected" && state !== "connecting") return;
  const epoch = beginNetworkIntent("connected");
  needsReconnect = true;
  applyReconnectUI();
  if (pendingReconnectTimer) clearTimeout(pendingReconnectTimer);
  pendingReconnectTimer = setTimeout(() => performAutoReconnect(undefined, epoch), RECONNECT_DEBOUNCE_MS);
}

const reconnectQueue = createLatestWinsReconnectQueue({
  run: ({ reason, epoch, operationToken }) => performAutoReconnectOnce(reason, epoch, operationToken),
  canRun: ({ epoch }) => isCurrentNetworkIntent(epoch, "connected") && needsReconnect,
});
const reconnectCompleted = (result) => result?.status === "completed" && result.value === true;

function performAutoReconnect(reason = t("conn.applyingSettings"), parentEpoch = networkIntentEpoch, operationToken = null) {
  return reconnectQueue.enqueue({ reason, epoch: parentEpoch, operationToken });
}

async function performAutoReconnectOnce(reason, epoch, operationToken = null) {
  let reconnectToastId = null;
  let ownedOperationToken = null;
  const preserveGuard = killSwitchMustSurviveRuntimeStop();
  try {
    pendingReconnectTimer = null;
    if (!needsReconnect || !isCurrentNetworkIntent(epoch, "connected")) return false;
    if (!operationToken) {
      ownedOperationToken = await beginRuntimeOperation("qualityRemediation");
      if (!ownedOperationToken) {
        // The coordinator is busy with a higher-priority operation (usually recovery
        // by the watchdog). The user's intent hasn't gone anywhere: without
        // a retry needsReconnect stays armed, while the reconnect itself never
        // happens — a settings edit silently doesn't apply until
        // the next click.
        if (isCurrentNetworkIntent(epoch, "connected") && needsReconnect) {
          if (pendingReconnectTimer) clearTimeout(pendingReconnectTimer);
          pendingReconnectTimer = setTimeout(() => performAutoReconnect(reason, epoch), 5000);
        }
        return false;
      }
      operationToken = ownedOperationToken;
    }
    if (state === "disconnecting") {
      // shutdownCore owns the backend stop and publishes idle only after
      // processes, ports and proxy ownership are confirmed.  Waiting here is
      // event/Promise-based: a source intent is neither dropped nor retried by
      // a polling loop while the previous lifecycle owner is still unwinding.
      if (!(await runtimeIdleGate.wait(epoch, "connected"))) return false;
      if (!isCurrentNetworkIntent(epoch, "connected")) return false;
      // setState("idle") clears this UI latch as part of the ordinary stop;
      // the still-current source intent must restore it before connecting.
      needsReconnect = true;
    }
    // A newer source intent may have arrived while the previous reconnect was already
    // disconnecting. After its confirmed stop the queue wakes up in idle —
    // this is the regular starting point for the latest profile, not a reason to lose the request.
    if (state === "idle") {
      needsReconnect = false;
      applyReconnectUI();
      // The await is mandatory: without it return ends the try, finally immediately
      // releases the operation token, and connectNetwork goes into start_singbox
      // with ownership already released. Rust answers "stale or cancelled runtime
      // operation token" — on screen this is "Failed to disconnect".
      return await runReconnectAttempt(connectNetwork, { epoch, operationToken });
    }
    if (state !== "connected" && state !== "connecting") return false;
    connectAttempts.cancel(); // invalidate a possible start_singbox in flight
    reconnectToastId = toast(reason, "info", 0, { group: "conn", connecting: true });
    const nativeStartWasPending = coreStartBarrier.isPending();
    if (!(await shutdownCore({ preserveKillSwitch: preserveGuard, operationToken }))) {
      if (preserveGuard && isCurrentNetworkIntent(epoch, "connected")) {
        // This operation's token is released by finally below: the retry will get its own.
        pendingReconnectTimer = setTimeout(() => performAutoReconnect(reason, epoch), 5000);
      }
      return false;
    }
    if (!isCurrentNetworkIntent(epoch, "connected")) return false;
    // stop_singbox can't cancel an IPC start that is still in the settle
    // phase and hasn't recorded the child. We wait for it to physically finish, then
    // stop the late-started set again. Only after that does the new source start.
    if (nativeStartWasPending) {
      await coreStartBarrier.wait();
      if (!isCurrentNetworkIntent(epoch, "connected")) return false;
      if (!(await shutdownCore({ preserveKillSwitch: preserveGuard, operationToken }))) {
        if (preserveGuard && isCurrentNetworkIntent(epoch, "connected")) {
          pendingReconnectTimer = setTimeout(() => performAutoReconnect(reason, epoch), 5000);
        }
        return false;
      }
    }
    needsReconnect = false;
    applyReconnectUI();
    // The await for the same reason as in the idle branch above: operation ownership
    // must last until the end of the connection, not until the moment of return.
    return await runReconnectAttempt(connectNetwork, { epoch, operationToken });
  } finally {
    if (ownedOperationToken) await completeRuntimeOperation(ownedOperationToken);
    if (reconnectToastId) toast.dismiss(reconnectToastId);
  }
}

// ── health-watchdog — /lib/health-watchdog.js ──────────────
// Core liveness + bridge reconnect are moved into a module; here is the instance with injected
// state/reconnect/quality engine. The aliases keep the call names from setState
// (start/stopHealthWatchdog) — we don't touch them. getQualityEngine is a getter because
// qualityEngine is defined further down the file; it's called only in the runtime tick.
// ── Incident feed ───────────────────────────────────────
// Channel state transitions and incident outcomes are computed by /lib/channel-incidents.js;
// here only its "hands": the feed itself and what the main module knows.
const channelIncidents = createChannelIncidentRecorder({
  record: (kind, entry) => incidentLog.record(kind, entry),
  // An incident may also have been opened by something other than the quality engine (core death, recovery
  // failure): such an incident also ends together with the session. Parsing the feed here
  // is cheap — the end of a session is a rare event.
  isAnyIncidentOpen: () => groupIncidents(incidentLog.list())[0]?.ongoing === true,
  // A reconnect and core auto-recovery also stop the engine, but don't end
  // the session: the user's intent stays "connected", measurements
  // resume within seconds, and the incident must survive until its real outcome —
  // otherwise the successful reconnect that cured it wouldn't show as
  // a recovery. A source switch and turned-off observation end
  // observation in any case: there's no longer anything to measure the previous channel with.
  sessionSurvives: (reason) => reason === "disconnected"
    && networkIntent.desired() === "connected",
});

// A single engine stop point: the feed must learn about the end of the session before
// the engine forgets the channel state.
function stopQualityEngine(reason) {
  channelIncidents.endSession(reason);
  qualityEngine.onIdle();
}

const healthWatchdog = initHealthWatchdog({
  getState: () => state,
  isUpdateInstalling: () => updateInstalling,
  shutdownCore,
  reconnectForSourceChange: reconnectCommittedSource,
  switchView,
  getQualityEngine: () => qualityEngine,
  shouldPreserveKillSwitch: killSwitchMustSurviveRuntimeStop,
  isKillSwitchRequired: killSwitchMustSurviveRuntimeStop,
  rearmKillSwitch: () => applyKillSwitch(true, {
    phase: state === "connected" ? "connected" : "preconnect",
    policyMode: preservedKillSwitchPolicyMode(),
  }),
  reconcileKillSwitch: () => applyKillSwitch(state === "connected"),
  beginRuntimeOperation: (kind) => beginRuntimeOperation(kind),
  completeRuntimeOperation,
  // Recovery after a core crash: the user's intent is still
  // "connected" (the intent is reset only by an explicit disconnect and bootstrap),
  // so we go the same way as the reconnect on a source change.
  restoreAfterCoreDeath: async (reason, context) => {
    const restored = await reconnectCommittedSource(reason, context);
    incidentLog.record(restored ? "core.restored" : "core.restoreFailed", {
      severity: restored ? "ok" : "err",
      params: { reason: String(reason || "") },
    });
    return restored;
  },
  subscribeCoreDeath: (handler) => window.__TAURI__?.event?.listen?.("vpn:core-died", (event) => {
    incidentLog.record("core.died", {
      severity: "err",
      params: { reason: String(event?.payload?.reason || event?.payload || "").slice(0, 200) },
    });
    return handler(event);
  }),
  onConnectionStorm: (sockets) => {
    incidentLog.record("core.storm", { severity: "err", params: { count: sockets } });
  },
  recordDiagnostic: (phase, result, reason) => {
    void invoke("record_frontend_runtime_event", {
      token: null,
      phase,
      result,
      reason: reason || null,
      generation: Number(runtimeIdentity.capture()?.processGeneration) || null,
    }).catch(error => console.warn("watchdog diagnostic failed", error));
  },
});
const startHealthWatchdog = healthWatchdog.start;
const stopHealthWatchdog = healthWatchdog.stop;

// ── Connection quality engine ──────────────────────────────────
// Decoupling: the engine knows nothing about the DOM/main.js, all the "hands" are injected here.
// Ladder steps that don't exist yet (R2 exclude-node, R5 switch-transport)
// are simply not passed in actions — the engine skips them.
const qualityEngine = createQualityEngine({
  invoke,
  actions: {
    // R1 — node reselection by the balancer without a reconnect: we refresh the measurements of
    // the CANDIDATES, and the balancer itself moves to the best one within a second.
    //
    // Previously there was refreshEffectiveDelay here — measuring only the current
    // leader. On a live but slow node it had the opposite effect: the leader's fresh
    // number only cemented it, and the step ran idle.
    selectNextNode: async () => {
      const token = runtimeIdentity.capture();
      if (!token) return false;
      // With a manual choice and while the ladder keeps the node pinned in "Auto",
      // the balancer doesn't route traffic — there's no point re-measuring.
      if (manualProxySelection(getActiveSource()) || qualityAutoHoldTimer) return false;
      const nodes = qualityNodesFromSource();
      if (nodes.length < 2) return false;
      let proxies = {};
      try { proxies = (await getProxies(undefined, { token }))?.proxies || {}; } catch {}
      if (!runtimeIdentity.isCurrent(token)) return false;
      const cur = currentEffectiveTag;
      const candidates = rankByDelay(nodes.filter(n => n.clashTag && n.clashTag !== cur), proxies)
        .slice(0, QUALITY_RETEST_LIMIT)
        .map(n => n.clashTag);
      if (!candidates.length) return false;
      let measured = false;
      await Promise.all(candidates.map(async (tag) => {
        try { await testNode(tag, { timeoutMs: 4000, token }); measured = true; } catch {}
      }));
      return measured && runtimeIdentity.isCurrent(token);
    },
    // R2 — move off a specific bad node: we put the current one on cooldown and manually
    // pick the best of the remaining ones (selectProxy — it also tears down live connections
    // on the previous node). No reconnect. false (the step is skipped) if
    // there are no alternatives. A manually chosen server is changed only with the user's
    // consent; in "Auto" the pin is temporary (see holdAutoSelection).
    excludeWorstNode: async () => {
      const token = runtimeIdentity.capture();
      if (!token) return false;
      const nodes = qualityNodesFromSource();
      if (nodes.length < 2) return false;
      let proxies = {};
      try { proxies = (await getProxies(undefined, { token }))?.proxies || {}; } catch {}
      if (!runtimeIdentity.isCurrent(token)) return false;
      const now = Date.now();
      const scoped = (tag) => `${token.sourceKey}:${token.sourceRevision}:${tag}`;
      for (const [tag, exp] of qualityExcluded) if (exp <= now) qualityExcluded.delete(tag);
      const cur = currentEffectiveTag;
      if (cur && cur !== "auto") qualityExcluded.set(scoped(cur), now + QUALITY_EXCLUDE_MS);
      const avail = nodes.filter(n => n.clashTag && n.clashTag !== cur && !qualityExcluded.has(scoped(n.clashTag)));
      const pick = rankByDelay(avail, proxies)[0]?.clashTag;
      if (!pick) return false;
      return switchQualityNode(pick, token);
    },
    // R3 — disguising traffic with TLS fragmentation (reconnect). If it's off —
    // we turn it on; if it's already on — we escalate by switching the record↔tcp mode.
    applyFragmentation: async () => {
      const token = runtimeIdentity.capture();
      if (!token || !runtimeIdentity.isCurrent(token)) return false;
      // DON'T name the local variable t: shadowing the i18n function here already
      // broke R3 (a TypeError after updateOption → the settings mutated without
      // a reconnect, the ladder clicked record↔tcp idly).
      const tricks = loadOptions().tlsTricks;
      if (!tricks.enableFragment) {
        updateOption("tlsTricks.enableFragment", true);
      } else {
        updateOption("tlsTricks.fragmentMode", tricks.fragmentMode === "record" ? "tcp" : "record");
      }
      return reconnectForQualityRemediation(t("qToast.masking"));
    },
    // R4 — rescan the WARP endpoint and apply the best one (reconnect). Only
    // if WARP is enabled, otherwise the step isn't applicable → false (the engine will skip it).
    rescanWarp: async () => {
      const token = runtimeIdentity.capture();
      if (!token) return false;
      if (!loadOptions().warp.enabled) return false;
      // In a chain WARP goes through the VPN server, while the scan measures the direct path from the PC:
      // reconnecting for such an endpoint gives nothing.
      if (loadOptions().warp.mode === "chain") return false;
      try {
        // warp_scan_endpoints returns ScanResult[] with ip/port fields (scanner.rs) —
        // the old code expected endpoint/host, always got null, and the step
        // was silently skipped (R4 was dead).
        const res = await invoke("warp_scan_endpoints", { topN: 5, deep: false, mode: "auto" });
        if (!runtimeIdentity.isCurrent(token) || !loadOptions().warp.enabled) return false;
        const best = Array.isArray(res) ? res[0] : null;
        if (!best?.ip || !best?.port) return false;
        updateOption("warp.endpoint", `${best.ip}:${best.port}`);
        return reconnectForQualityRemediation(t("qToast.backup"));
      } catch { return false; }
    },
    // R5 — move to a node of a DIFFERENT transport/protocol (proto:type), the best by
    // ping: it changes the very signature of the traffic on the wire. selectProxy also moves
    // already open streams, a core reconnect isn't needed. false if there are no nodes of another
    // transport in the source.
    switchTransport: async () => {
      const token = runtimeIdentity.capture();
      if (!token) return false;
      const nodes = qualityNodesFromSource();
      if (nodes.length < 2) return false;
      const cur = currentEffectiveTag;
      const curNode = nodes.find(n => n.clashTag === cur) || currentEffectiveNode;
      const curClass = curNode ? transportClass(curNode) : null;
      let proxies = {};
      try { proxies = (await getProxies(undefined, { token }))?.proxies || {}; } catch {}
      if (!runtimeIdentity.isCurrent(token)) return false;
      const alt = nodes.filter(n => n.clashTag && n.clashTag !== cur && transportClass(n) !== curClass);
      const pick = rankByDelay(alt, proxies)[0]?.clashTag;
      if (!pick) return false;
      return switchQualityNode(pick, token);
    },
    // A hybrid gate before a reconnect step (when aggressive=false). In plain language.
    // Window in the tray → a native confirm would hang invisibly and block the ladder
    // (remediating isn't cleared while the promise hangs). Instead — an OS notification
    // and refusing the expensive step: the user will come back to the window — the next ladder
    // run will ask normally.
    confirmReconnect: async (label) => {
      if (!(await windowIsForeground())) {
        notify(t("qToast.hiddenNotifyTitle"), t("qToast.hiddenNotifyBody"));
        return false;
      }
      return askQualityConfirm(t("qToast.confirmSpeedup", { label }));
    },
    // Incident feed: a treatment step is context inside an already open
    // incident (it was opened by the state transition in onState), hence severity info.
    onRemedy: ({ step, applied, fixed }) => {
      incidentLog.record(fixed ? "quality.fixed" : "quality.remedy", {
        severity: fixed ? "ok" : "info",
        params: { step, applied: !!applied },
      });
    },
    // R6 — we give up honestly, without jargon.
    giveUp: (st) => {
      incidentLog.record("quality.gaveUp", { severity: "err", params: { state: st } });
      toast(t("qToast.giveUp"), "error", 8000, {
        group: "quality",
        desc: t("qToast.giveUpDesc"),
      });
      notify(t("qToast.giveUpNotifyTitle"), t("qToast.giveUpNotifyBody"));
    },
    // Context for learning (what was active at the moment of success).
    getContext: () => {
      const o = loadOptions();
      return {
        node: currentEffectiveNode?.name || currentEffectiveNode?.host || null,
        tlsTrick: o.tlsTricks.enableFragment ? o.tlsTricks.fragmentMode : null,
        warpEndpoint: o.warp.enabled ? o.warp.endpoint : null,
      };
    },
    // The local ISP's ASN (not the exit's): ip-info WITHOUT the proxy argument → direct. Even in
    // TUN this request goes past the tunnel (Ninety.exe's own traffic goes
    // direct via the bypass rule), so it returns exactly the local ISP — what's
    // needed for the ISP×hour learning key. Fallback "unknown".
    localAsn: async () => {
      // Privacy: this request goes DIRECTLY (past the tunnel) and would reveal
      // the real IP to the geo service. If the user disabled geo lookup, we don't go,
      // and the quality engine learns by the global profile (ASN "unknown").
      if (strictPrivacyRequested() || loadOptions().general?.disableGeoLookup) return "unknown";
      try {
        const info = await invoke("fetch_public_ip", {});
        const asn = info?.connection?.asn ?? info?.asn;
        return asn != null ? String(asn) : "unknown";
      } catch { return "unknown"; }
    },
    onState: (st) => {
      channelIncidents.observe(st);
      if (!qualityDot) return;
      setChannelState(st);
      if (qualityDot.dataset.active !== "true") qualityDot.dataset.active = "true";
    },
    // The engine stopped measuring for a known reason. Deduplication and the decision
    // "whether to write to the feed" are kept here: the engine doesn't know whether an incident is open.
    onPaused: (reason) => channelIncidents.pause(reason),
    // A skipped probe is the same measurement refusal, only its reason is technical
    // (no generation, the dataplane is busy); it means nothing to the user.
    onSkipped: () => channelIncidents.pause("probeSkipped"),
    // Each probe → into the bus; the channel oscilloscope (the expanded chip) is subscribed to it.
    onSample: (s) => bus.emit("quality:sample", s),
    toast, notify,
    log: (m) => console.info("[quality]", m),
  },
});

// ── Quality ladder helpers (R2/R5) ───────────────────────
// Cooldown of nodes rejected by R2 — so they aren't picked again right away.
const QUALITY_EXCLUDE_MS = 5 * 60_000;
// How many candidates R1 re-measures. More — the step takes longer, fewer — the higher
// the chance that all the picked ones turn out dead and the ladder steps further needlessly.
const QUALITY_RETEST_LIMIT = 8;
const qualityExcluded = new Map(); // clashTag → expiry ts
// How long a node pinned by the ladder in "Auto" mode is held, and how often
// we may ask about changing a manually chosen server.
const QUALITY_AUTO_HOLD_MS = 30 * 60_000;
const QUALITY_MANUAL_OFFER_COOLDOWN_MS = 30 * 60_000;
let qualityAutoHoldTimer = null;
let qualityManualOfferAt = 0;

// Node switching by steps R2/R5. A manually chosen server is the user's
// decision: we don't silently overwrite it, we ask. In "Auto" the app
// chooses, so we set the node right away.
async function switchQualityNode(pick, token) {
  if (manualProxySelection(getActiveSource())) return offerManualNodeSwitch(pick, token);
  try {
    const r = await selectProxy("proxy", pick, { token });
    if (r?.stale || !runtimeIdentity.isCurrent(token)) return false;
    holdAutoSelection(pick, token);
    return true;
  } catch { return false; }
}

// The quality ladder's question. An async dialog instead of window.confirm: the synchronous
// confirm stopped all the window's timers, and while it hung the watchdog didn't notice
// core death and didn't restore protection. An already open foreign dialog isn't
// closed (openConfirmModal would close it as a cancel) — we'll ask another time.
async function askQualityConfirm(message) {
  if (document.querySelector(".confirm-modal")) return false;
  const answer = await openConfirmModal({
    title: t("qEngine.notifyTitle"),
    message,
    confirmLabel: t("confirm.ok"),
    cancelLabel: t("confirm.cancel"),
  });
  return answer === true;
}

// Window in the tray → the question would hang invisibly; the ladder has already reported the slowdown
// with a notification, and we'll ask on the next run. Once every half hour, so that R2 and R5
// of the same run don't ask the same question twice.
async function offerManualNodeSwitch(pick, token) {
  if (Date.now() - qualityManualOfferAt < QUALITY_MANUAL_OFFER_COOLDOWN_MS) return false;
  if (!(await windowIsForeground())) return false;
  const manual = manualProxySelection(getActiveSource());
  qualityManualOfferAt = Date.now();
  const node = qualityNodesFromSource().find(n => n.clashTag === pick);
  if (!(await askQualityConfirm(t("qToast.confirmSwitch", { name: node ? nodeDisplayLabel(node) : pick })))) return false;
  // While the question hung, the user may have picked a server themselves or reconnected.
  if (!runtimeIdentity.isCurrent(token) || manualProxySelection(getActiveSource()) !== manual) return false;
  try {
    const r = await selectProxy("proxy", pick, { token });
    if (r?.stale || !runtimeIdentity.isCurrent(token)) return false;
    // The user agreed — now it's their choice, even after a reconnect.
    rememberProxySelection(getActiveSource(), pick);
    return true;
  } catch { return false; }
}

// The balancer picks by latency and doesn't see that the leader is being throttled on speed,
// so in "Auto" the ladder pins the node in the selector. Without restoring "Auto"
// it silently turned into a manual choice. We restore only if the selector is still
// on the same node and the user hasn't chosen anything. After a reconnect
// the timer becomes stale, and "Auto" is restored by restoreRememberedProxySelection.
const QUALITY_AUTO_RETURN_ATTEMPTS = 3;
const QUALITY_AUTO_RETURN_RETRY_MS = 60_000;
function holdAutoSelection(tag, token) {
  clearQualityAutoHold();
  const schedule = (attemptsLeft, delay) => {
    qualityAutoHoldTimer = setTimeout(async () => {
      qualityAutoHoldTimer = null;
      if (!runtimeIdentity.isCurrent(token) || manualProxySelection(getActiveSource())) return;
      try {
        // The check runs inside the selector queue, after the user's already queued
        // choices: a snapshot read in advance may be stale, and
        // the restore would overwrite a manual choice just made.
        await selectProxy("proxy", "auto", {
          token,
          closeConnections: false,
          background: true,
          shouldApply: async () => {
            if (!runtimeIdentity.isCurrent(token) || manualProxySelection(getActiveSource())) return false;
            const proxies = (await getProxies(undefined, { token, fresh: true }))?.proxies || {};
            return runtimeIdentity.isCurrent(token)
              && !manualProxySelection(getActiveSource())
              && proxies.proxy?.now === tag;
          },
        });
      } catch {
        // The Clash API temporarily didn't respond — the pin is still in effect, we'll retry.
        if (attemptsLeft > 1 && runtimeIdentity.isCurrent(token)) {
          schedule(attemptsLeft - 1, QUALITY_AUTO_RETURN_RETRY_MS);
        }
      }
    }, delay);
  };
  schedule(QUALITY_AUTO_RETURN_ATTEMPTS, QUALITY_AUTO_HOLD_MS);
}

function clearQualityAutoHold() {
  clearTimeout(qualityAutoHoldTimer);
  qualityAutoHoldTimer = null;
}
// Nodes of the active source with clash tags (a mirror of proxies-view.nodesFromSource).
function qualityNodesFromSource() {
  const src = getActiveSource();
  if (!src) return [];
  const raw = src.kind === "sub" ? (src.nodes || []) : [src.profile];
  const list = raw.filter(Boolean);
  return list.map((n, i) => ({ ...n, clashTag: list.length >= 2 ? nodeTag(i, n) : "proxy" }));
}
// The node's transport class (protocol + network). R5 looks for a node with a DIFFERENT class.
function transportClass(n) {
  return `${n?.proto || "vless"}:${n?.type || "-"}`;
}
// Sorting nodes by live ping (those without a ping go to the end).
function rankByDelay(nodes, proxies) {
  return nodes
    .map(n => ({ ...n, _d: lastDelay(proxies[n.clashTag]) }))
    .sort((a, b) => {
      const da = Number.isFinite(a._d) && a._d > 0 ? a._d : Infinity;
      const db = Number.isFinite(b._d) && b._d > 0 ? b._d : Infinity;
      return da - db;
    });
}

// ── Channel quality indicator (the "Channel" cell in the telemetry strip) ──
// The state is set by the engine via onState; the cell lives in the stats strip (secured),
// shown/hidden together with the strip. Human language, no tech jargon.
// Quality engine states that have a label. An unknown value
// would be printed into the chip as a raw catalog key, so we reduce it to "checking".
const CHANNEL_STATES = new Set(["unknown", "good", "slow", "stalled", "dead", "pressure"]);
const qChannelLabel = (st) => {
  const key = String(st).toLowerCase();
  return t("qToast.channel." + (CHANNEL_STATES.has(key) ? key : "unknown"));
};
const qualityDot = document.getElementById("tele-channel"); // #tele-channel (data-q/data-active)
const qualityState = document.getElementById("stats-channel");
let lastChannelState = "UNKNOWN";
function setChannelState(st) {
  lastChannelState = st;
  if (qualityDot) qualityDot.dataset.q = st;
  if (qualityState) qualityState.textContent = qChannelLabel(st);
}
function showQualityChip(on) {
  if (!qualityDot) return;
  if (on) setChannelState("UNKNOWN");
  qualityDot.dataset.active = on ? "true" : "false";
}
// A click on the "Channel" cell with monitoring active → the goodput probe oscilloscope.
qualityDot?.addEventListener("click", (e) => {
  if (qualityDot.dataset.active !== "true") return;
  e.stopPropagation();
  openQualityScope({
    anchor: qualityDot,
    getSamples: () => qualityEngine.getSamples(),
    goodBps: Number(loadOptions().quality?.goodBps) || 1_500_000,
  });
});

function applyReconnectUI() {
  if (!hero) return;
  if (needsReconnect && (state === "connected" || state === "connecting")) {
    hero.classList.add("hero--reconnect");
    if (heroLabel) heroLabel.textContent = t("hero.apply");
    setHeroHintText("RECONNECT · APPLY NEW SETTINGS");
  } else {
    hero.classList.remove("hero--reconnect");
  }
}

// The active source (subscription/profile) changed with the VPN up — immediately
// rebuild the config with the new nodes. Without debounce (an explicit user action),
// unlike scheduleAutoReconnect for settings edits. The reconnect goes to
// idle (resets currentEffectiveNode) → buildConfig reads a fresh getActiveSource()
// → the AUTO selector over the new nodes, they get pinged by URLTest.
function beginSourceReconnect(reason, operationToken = null) {
  if (state !== "connected" && state !== "connecting" && state !== "disconnecting") return false;
  const epoch = beginNetworkIntent("connected");
  needsReconnect = true;
  if (pendingReconnectTimer) { clearTimeout(pendingReconnectTimer); pendingReconnectTimer = null; }
  return { epoch, completion: performAutoReconnect(reason, epoch, operationToken) };
}

function reconnectForSourceChange(reason, context = {}) {
  const request = beginSourceReconnect(reason, context.operationToken || null);
  return !!request;
}

// The quality engine must get the result of the NEW session: only after
// a confirmed connect can the expensive step be counted and its effect checked.
async function reconnectForQualityRemediation(reason) {
  const operationToken = await beginRuntimeOperation("qualityRemediation");
  if (!operationToken) return false;
  try {
    if (networkIntent.desired() !== "connected" || state !== "connected") return false;
    const request = beginSourceReconnect(reason, operationToken);
    if (!request) return false;
    const connected = await request.completion;
    if (!reconnectCompleted(connected)
      || state !== "connected"
      || !isCurrentNetworkIntent(request.epoch, "connected")) return false;
    // await: otherwise finally releases the token before the check, and Rust returns
    // Cancelled on a live channel — the quality engine would consider the step
    // unconfirmed every time.
    return await verifyRuntimeOperationDataplane(operationToken);
  } catch {
    return false;
  } finally {
    await completeRuntimeOperation(operationToken);
  }
}

// A single source activation (subscription/profile). Called BOTH from the pmenu "Make
// active" AND from a click on the card body — previously the reconnect was only in pmenu,
// so a click on the card changed the active source while the VPN stayed on the old
// config. With the VPN up and an actual source change — an immediate reconnect.
let sourceSwitchController = null;

function activeSourceRef() {
  const kind = getActiveKind() === "sub" ? "sub" : "single";
  const id = kind === "sub" ? getActiveSubscriptionId() : getActiveProfileId();
  return id ? { kind, id } : null;
}

function commitActiveSource(kind, id) {
  return applyActiveSourceTransaction({ kind, id }, {
    setActiveKind,
    setActiveProfileId,
    setActiveSubscriptionId,
    resetEffectiveNode: () => {
      currentEffectiveNode = null;
      currentEffectiveTag = null;
    },
    resetProxiesView: () => { cancelPendingSelections(); resetProxiesViewForSourceChange(); },
    resetTraffic: stopMeter,
    resetQuality: () => { qualityExcluded.clear(); clearQualityAutoHold(); stopQualityEngine("sourceChanged"); },
    invalidateRuntime: () => runtimeIdentity.invalidate(),
    refreshProfiles: refreshProfilesSummary,
    syncTray: syncTrayMenu,
    getState: () => state,
    reconnectForSourceChange: () => false,
  }, { reconnect: false, silent: true });
}

async function beginRuntimeOperation(kind, source = activeSourceRef()) {
  const identitySource = kind === "sourceSwitch"
    ? sourceById(source?.kind, source?.id)
    : (getActiveSource() || activeDisplaySource());
  const identityFingerprint = sourceFingerprint(identitySource);
  try {
    if (kind === "sourceSwitch") {
      return await invoke("begin_source_switch_operation", {
        sourceFingerprint: identityFingerprint,
      });
    }
    const snapshot = await invoke("runtime_snapshot").catch(() => null);
    return await invoke("begin_frontend_runtime_operation", {
      kind,
      generation: Number(snapshot?.processGeneration) || 0,
      sourceFingerprint: identityFingerprint,
    });
  } catch (error) {
    // A coordinator refusal used to go only to console.warn — the log the
    // user opens on the "Logs" screen kept nothing, and "busy with
    // another operation" couldn't be told apart from a real start failure.
    console.warn(`unable to begin ${kind} runtime operation`, error);
    // Rust cuts reason at 80 characters and rejects anything longer.
    logSourceSwitchReconnect(
      "operation_begin",
      null,
      "refused",
      `${kind}_${safeSourceSwitchReason(error?.message || error)}`.slice(0, 80),
    );
    return null;
  }
}

async function completeRuntimeOperation(token) {
  if (!token) return false;
  try {
    return await invoke("complete_frontend_runtime_operation", { token });
  } catch {
    return false;
  }
}


async function verifyRuntimeOperationDataplane(operationToken) {
  if (!operationToken) return false;
  try {
    const snapshot = await invoke("runtime_snapshot");
    runtimeSnapshotCache = runtimeEndpointMatchesGeneration(snapshot) ? snapshot : null;
    if (!snapshot?.running || !Number(snapshot.processGeneration)) return false;
    const verdict = await invoke("verify_runtime_dataplane", {
      operationToken,
      expectedGeneration: snapshot.processGeneration,
    });
    return verdict?.status === "ready";
  } catch {
    return false;
  }
}

// The transitional WFP barrier is set by stop_singbox on any runtime switch operation, but
// it was removed only by dataplane verification — i.e. a source switch and
// quality healing. Auto-reconnect on settings and recovery by the watchdog never
// reach it, and the extra block-all lived until the VPN was disconnected: without LAN exceptions
// and without a permit for Ninety itself, on top of the already assembled policy. We remove it on
// every confirmed connection; the backend itself checks that the new runtime
// is actually ready and refuses if it isn't.
async function releaseTransitionBarrier(generation) {
  const expectedGeneration = Number(generation) || 0;
  if (!expectedGeneration) return false;
  try {
    return await invoke("release_runtime_transition_barrier", { expectedGeneration }) === true;
  } catch (error) {
    console.warn("transition barrier release failed", error);
    logSourceSwitchReconnect("transition_barrier", null, "failed", safeSourceSwitchReason(error?.message || error));
    return false;
  }
}

function safeSourceSwitchReason(reason) {
  return String(reason || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "_")
    .slice(0, 80);
}

function logSourceSwitchReconnect(phase, operationToken, result, reason = null) {
  const payload = {
    phase: safeSourceSwitchReason(phase),
    operation_id: Number(operationToken?.id) || "none",
    result: safeSourceSwitchReason(result),
  };
  const generation = Number(runtimeIdentity.capture()?.processGeneration) || 0;
  if (generation) payload.generation = generation;
  if (reason) payload.reason = safeSourceSwitchReason(reason);
  console.info("source_switch_reconnect", payload);
  void invoke("record_frontend_runtime_event", {
    token: operationToken || null,
    phase: payload.phase,
    result: payload.result,
    reason: payload.reason || null,
    generation: generation || null,
  }).catch(error => console.warn("source switch diagnostic failed", error));
}

async function confirmActiveSourceDataplane(target, { token, isCurrent }) {
  if (!token || !isCurrent() || !sameSourceRef(activeSourceRef(), target)
    || networkIntent.desired() !== "connected" || state !== "connected") {
    return { status: "cancelled" };
  }
  try {
    const snapshot = await invoke("runtime_snapshot");
    runtimeSnapshotCache = runtimeEndpointMatchesGeneration(snapshot) ? snapshot : null;
    if (!isCurrent() || !sameSourceRef(activeSourceRef(), target)) return { status: "stale" };
    if (!snapshot?.running || !Number(snapshot.processGeneration)) {
      return { status: "hardFailed", reason: "runtime_not_running" };
    }
    const targetSource = sourceById(target.kind, target.id);
    const runtimeToken = runtimeIdentity.capture();
    if (targetSource?.kind === "sub" && targetSource.nodes?.length >= 2
      && runtimeToken && runtimeIdentity.isCurrent(runtimeToken)) {
      // A fresh balancer falls back to the first node until its own health
      // check publishes delays, so one dead first node would make a healthy
      // subscription look offline to the verifier. Wait for a leader the core
      // has actually measured instead of forcing a probe run: the forced run
      // used to be cancelled by its own deadline, taking the measurements of
      // every unfinished probe down with it.
      try {
        if (!await awaitMeasuredLeader({ token: runtimeToken, timeoutMs: 8000 })) {
          logSourceSwitchReconnect("selector", token, "unverified", "balancer_not_converged");
        }
      } catch {
        logSourceSwitchReconnect("selector", token, "unverified", "balancer_not_converged");
      }
      if (!isCurrent() || !runtimeIdentity.isCurrent(runtimeToken)) {
        return { status: "stale" };
      }
    }
    logSourceSwitchReconnect("verifier", token, "started");
    const verdict = await invoke("verify_runtime_dataplane", {
      operationToken: token,
      expectedGeneration: snapshot.processGeneration,
    });
    logSourceSwitchReconnect("verifier", token, verdict?.status || "unknown", verdict?.reason);
    return verdict;
  } catch {
    logSourceSwitchReconnect("verifier", token, "failed", "monitor_error");
    return { status: "unverified", reason: "monitor_error" };
  }
}

async function reconnectCommittedSource(reason, context = {}) {
  const operationToken = context.operationToken || null;
  if (networkIntent.desired() !== "connected") {
    logSourceSwitchReconnect("target", operationToken, "failed", "network_intent_not_connected");
    return false;
  }
  if (state === "connected" || state === "connecting" || state === "disconnecting") {
    const request = beginSourceReconnect(reason, operationToken);
    if (!request) {
      logSourceSwitchReconnect("target", operationToken, "failed", "reconnect_request_unavailable");
      return false;
    }
    const result = await request.completion;
    const connected = reconnectCompleted(result);
    logSourceSwitchReconnect(
      "target",
      operationToken,
      connected ? "connected" : "failed",
      connected ? null : (result?.status === "completed" ? "connect_pipeline_false" : result?.status),
    );
    // The request was displaced by a newer reconnect: the result will come from that one, not this one.
    // Source switching needs to tell this apart from a target failure (see source-activation).
    // A waiting request gets superseded/cancelled, while one already running gets
    // completed:false when its intent was replaced by a newer "connected".
    const preempted = result?.status === "superseded" || result?.status === "cancelled"
      || (result?.status === "completed"
        && !isCurrentNetworkIntent(request.epoch, "connected")
        && networkIntent.desired() === "connected");
    if (!connected && context.onPreempted && preempted) context.onPreempted();
    return connected;
  }
  if (state !== "idle") {
    logSourceSwitchReconnect("target", operationToken, "failed", "reconnect_state_unavailable");
    return false;
  }
  const epoch = beginNetworkIntent("connected");
  const toastId = toast(reason || t("conn.applyingSettings"), "info", 0, {
    group: "conn",
    connecting: true,
  });
  try {
    const connected = await runReconnectAttempt(connectNetwork, { epoch, operationToken });
    logSourceSwitchReconnect("target", operationToken, connected ? "connected" : "failed", connected ? null : "connect_pipeline_false");
    return connected;
  } finally { if (toastId) toast.dismiss(toastId); }
}

// The coordinator is busy (a core start or a manual connect/disconnect is in progress) —
// the source choice used to be silently lost. We retry until the busy state passes;
// a newer user choice cancels waiting for the old one.
const SOURCE_BUSY_RETRIES = 12;
const SOURCE_BUSY_RETRY_MS = 500;
let sourceRequestSeq = 0;
async function applyActiveSource(kind, id, options = {}) {
  const target = { kind: kind === "sub" ? "sub" : "single", id };
  const request = ++sourceRequestSeq;
  for (let attempt = 0; ; attempt++) {
    if (sameSourceRef(activeSourceRef(), target)) {
      return { changed: false, ready: true, target };
    }
    const shouldReconnect = options.reconnect !== false
      && networkIntent.desired() === "connected";
    const isSub = target.kind === "sub";
    const result = await sourceSwitchController.activate(target, {
      reconnect: shouldReconnect,
      silent: !!options.silent,
      reason: options.reason || (isSub ? t("conn.switchSub") : t("conn.switchProfile")),
      rollbackReason: t("conn.restorePrevious"),
    });
    if (!result?.busy) return result;
    if (request !== sourceRequestSeq) return { ...result, stale: true };
    if (attempt >= SOURCE_BUSY_RETRIES) {
      if (!options.silent) toast(t("backend.vpn.starting"), "warn", 3000, { group: "conn" });
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, SOURCE_BUSY_RETRY_MS));
    if (request !== sourceRequestSeq) return { changed: false, stale: true, target };
  }
}

function activateSource(kind, id) {
  return applyActiveSource(kind, id);
}

function sourceById(kind, id) {
  if (kind === "sub") {
    const subscription = loadSubscriptions().find(s => s.id === id);
    return subscription ? subscriptionSource(subscription) : null;
  }
  const profile = loadProfiles().find(p => p.id === id);
  return profile ? { kind: "single", profile } : null;
}

const runtimeIdentity = createRuntimeIdentityController({
  getSource: activeDisplaySource,
  getMode,
  getClashPort: () => loadOptions().experimental?.clashApiPort || 9090,
});
configureClashRuntime(runtimeIdentity);
// Manual and background probes hit the same target as the balancer's health check
// inside the core — otherwise the numbers on the Servers screen aren't comparable with what
// the core picks the node by.
configureProbeUrl(() => loadOptions().urlTest?.connectionTestUrl);
configureTrafficRuntime(runtimeIdentity);

sourceSwitchController = createSourceSwitchController({
  getActiveSource: activeSourceRef,
  applySource: (source) => commitActiveSource(source.kind, source.id),
  reconnect: async (reason, context) => {
    let preempted = false;
    const connected = await reconnectCommittedSource(reason, {
      ...context,
      onPreempted: () => { preempted = true; },
    });
    return preempted ? { preempted: true } : connected;
  },
  confirm: confirmActiveSourceDataplane,
  canContinue: () => networkIntent.desired() === "connected",
  persist: () => backupNow(),
  onActivated: (source, options, operationToken) => {
    if (options?.reconnect !== false) logSourceSwitchReconnect("commit", operationToken, "committed");
    if (!options?.silent && options?.reconnect === false) {
      toast(source.kind === "sub" ? t("conn.subActivated") : t("conn.profileActivated"), "success", 1800);
    }
  },
  onRollback: (_fallback, _target, _options, operationToken) => {
    logSourceSwitchReconnect("rollback", operationToken, "committed");
    toast(t("conn.previousRestored"), "warn", 6500, {
      group: "conn",
      desc: t("conn.previousRestoredDesc"),
    });
  },
  onRollbackFailed: (_fallback, _target, _options, operationToken) => {
    logSourceSwitchReconnect("rollback", operationToken, "failed", "restore_failed");
    toast(t("conn.restoreFailed"), "error", 7500, { group: "conn", desc: t("conn.restoreFailedDesc") });
    switchView("logs");
  },
  onFailure: (_target, _options, operationToken) => {
    logSourceSwitchReconnect("target", operationToken, "failed", "verifier_hard_failed");
    toast(t("conn.switchFailed"), "error", 6000, { group: "conn", desc: t("conn.switchFailedDesc") });
    switchView("logs");
  },
  beginOperation: (target) => beginRuntimeOperation("sourceSwitch", target),
  completeOperation: (token) => invoke("complete_frontend_runtime_operation", { token }),
  cancelOperation: (token) => invoke("cancel_frontend_runtime_operation", { token }),
});

const sourceMutations = createSourceMutationController({
  getActiveSource,
  getSource: sourceById,
  getState: () => state,
  invalidateRuntime: () => runtimeIdentity.invalidate(),
  resetEffectiveNode: () => { currentEffectiveNode = null; currentEffectiveTag = null; },
  resetProxiesView: () => { cancelPendingSelections(); resetProxiesViewForSourceChange(); },
  resetTraffic: stopMeter,
  resetQuality: () => { qualityExcluded.clear(); clearQualityAutoHold(); stopQualityEngine("sourceChanged"); },
  refreshProfiles: refreshProfilesSummary,
  syncTray: syncTrayMenu,
  reconnect: reconnectForSourceChange,
});

function mutateSource(kind, id, mutation, reason, beforeFingerprint) {
  const key = `${kind === "sub" ? "sub" : "profile"}:${id}`;
  const beforeFingerprints = beforeFingerprint === undefined ? undefined : new Map([[key, beforeFingerprint]]);
  return sourceMutations.run([{ kind, id }], mutation, { reason, beforeFingerprints });
}

function mutateSources(items, mutation, reason) {
  return sourceMutations.run(items, mutation, { reason });
}

// A panel with a device limit returns a placeholder or a 404 instead of servers until it
// gets a HWID. We offer to enable sending for this subscription and immediately
// reread the list — otherwise the user is left with an empty screen.
async function offerHwidAndReload(id, signal) {
  try {
    const enabled = await handleHwidSignal({
      subId: id,
      signal,
      toast,
      onEnabled: () => mutateSource("sub", id, () => refreshSubscription(id), t("conn.applyingSettings")),
    });
    if (!enabled) return false;
    renderProfilesView();
    refreshSubCardFromActive();
    toast(t("hwid.enabled"), "success", 2200);
    return true;
  } catch (err) {
    toast(t("prof.toastErr", { err: err?.message || err }), "error", 2800);
    return false;
  }
}

async function deleteSource(kind, id) {
  // Deleting a subscription is irreversible: the panel link and accumulated measurements can't
  // be brought back, and the menu item sits next to "Update". We ask for confirmation
  // before any runtime actions.
  const name = kind === "sub"
    ? loadSubscriptions().find(s => s.id === id)?.name
    : loadProfiles().find(p => p.id === id)?.name;
  const confirmed = await openConfirmModal({
    title: kind === "sub" ? t("prof.removeSubTitle") : t("prof.removeProfileTitle"),
    message: kind === "sub"
      ? t("prof.removeSubMsg", { name: name || t("subs.subFallback") })
      : t("prof.removeProfileMsg", { name: name || "" }),
    confirmLabel: t("prof.removeConfirm"),
    cancelLabel: t("confirm.cancel"),
    danger: true,
  });
  if (!confirmed) return false;

  const plan = planSourceDeletion({
    kind, id, activeKey: sourceKey(getActiveSource()),
    subscriptions: loadSubscriptions(), profiles: loadProfiles(), state,
  });
  const { active: isActive, fallback } = plan;

  if (plan.mustStopBeforeDelete) {
    // The intent is cleared before the stop: otherwise the next source choice would bring up
    // the tunnel by itself, although the VPN is off on screen.
    beginNetworkIntent("idle");
    connectAttempts.cancel();
    const stopped = await shutdownCore();
    if (!stopped) return false;
  }

  if (kind === "sub") removeSubscription(id);
  else removeProfile(id);

  if (isActive && fallback) {
    // remove* picks a fallback within its own type. We reset this hidden
    // side effect so that applyActiveSource sees a real change and does one reconnect.
    if (fallback.kind === "sub") {
      setActiveProfileId(null);
      setActiveSubscriptionId(null);
      setActiveKind("single");
    } else {
      setActiveSubscriptionId(null);
      setActiveProfileId(null);
      setActiveKind("sub");
    }
    void applyActiveSource(fallback.kind, fallback.id, { reason: t("conn.applyingSettings") })
      .then((result) => {
        // The coordinator never freed up: the active ids were already reset above, and
        // without this step there wouldn't be a single active source left. The fallback
        // is applied without reconnecting — the runtime will pick it up on the next one.
        if (result?.busy && !result?.stale) commitActiveSource(fallback.kind, fallback.id);
      })
      .catch((error) => console.warn("fallback source activation failed", error));
  } else {
    if (isActive) {
      setActiveSubscriptionId(null);
      setActiveProfileId(null);
      setActiveKind("single");
      runtimeIdentity.invalidate();
      cancelPendingSelections();
      currentEffectiveNode = null;
      currentEffectiveTag = null;
      resetProxiesViewForSourceChange();
    }
    refreshProfilesSummary();
    syncTrayMenu();
  }
  backupSoon();
  toast(kind === "sub" ? t("prof.toastSubRemoved") : t("prof.toastProfileRemoved"), "info", 1800);
  return true;
}

// Bulk deletion of all single configs. Repeating deleteSource in a loop
// isn't possible: every step would ask for confirmation and poke the active source.
// It doesn't affect the active subscription — we delete only the group of configs.
async function deleteAllProfiles() {
  const profs = loadProfiles();
  if (!profs.length) return false;

  const confirmed = await openConfirmModal({
    title: t("prof.removeAllProfilesTitle"),
    message: t("prof.removeAllProfilesMsg", { configs: tn("prof.configsN", profs.length) }),
    confirmLabel: t("prof.removeConfirm"),
    cancelLabel: t("confirm.cancel"),
    danger: true,
  });
  if (!confirmed) return false;

  // One of the configs being deleted may have been active. We look for a fallback source among
  // the subscriptions: not a single single profile will remain after the cleanup.
  const wasActiveProfile = getActiveKind() !== "sub" && !!getActiveProfileId();
  const fallbackSub = loadSubscriptions()[0] || null;
  if (wasActiveProfile && !fallbackSub && (state === "connected" || state === "connecting")) {
    beginNetworkIntent("idle");
    connectAttempts.cancel();
    if (!(await shutdownCore())) return false;
  }

  const removed = removeAllProfiles();

  if (wasActiveProfile && fallbackSub) {
    // The same technique as in deleteSource: we reset the choice to the opposite kind
    // so that applyActiveSource sees a real change and does exactly one reconnect.
    setActiveProfileId(null);
    setActiveSubscriptionId(null);
    setActiveKind("single");
    applyActiveSource("sub", fallbackSub.id, { reason: t("conn.applyingSettings") });
  } else {
    if (wasActiveProfile) {
      setActiveSubscriptionId(null);
      setActiveProfileId(null);
      setActiveKind("single");
      runtimeIdentity.invalidate();
      cancelPendingSelections();
      currentEffectiveNode = null;
      currentEffectiveTag = null;
      resetProxiesViewForSourceChange();
    }
    refreshProfilesSummary();
    syncTrayMenu();
  }
  backupSoon();
  toast(t("prof.toastProfilesRemoved", { configs: tn("prof.configsN", removed) }), "info", 2000);
  return true;
}

// ── WARP UX (hero badge + auto-rotation + history) — /lib/warp-rescan.js ──
// The subsystem is moved into a module; here only the instance with injected state/reconnect.
// The aliases keep the old call names (updateWarpBadge/start/stopWarpRescanLoop),
// scattered across setState/onChange/warp-switch — we don't touch them.
const warpRescan = initWarpRescan({
  getState: () => state,
  scheduleAutoReconnect,
  runtime: runtimeIdentity,
});
const updateWarpBadge = warpRescan.updateBadge;
const startWarpRescanLoop = warpRescan.startLoop;
const stopWarpRescanLoop = warpRescan.stopLoop;

navItems.forEach((item) => {
  if (item.dataset.view !== "settings") return;
  item.addEventListener("click", () => {
    if (settingsCtl) settingsCtl.goMenu();
  });
});

// ── Logs view — moved to /lib/logs-view.js ────────────────
// The log needs the active node so as not to show health checker reports about
// the other nodes of the subscription. A getter, not a value: currentEffectiveTag changes
// on a server switch and is declared further down the file.
configureLogsRuntime({ getActiveNodeTag: () => currentEffectiveTag });
mountLogsView();

// Long task observer + dumping the performance snapshot with Ctrl+Alt+P.
// The counters were accumulated since the first version, but in the release build (devtools disabled)
// there was nowhere to read them, and talk about slowness went by feel.
initPerfProbe({
  onToast: (kind) => (kind === "ok"
    ? toast(t("share.copied"), "success", 1600)
    : toast(t("share.copyFailed"), "error", 2500)),
});

// ── Profiles view ──────────────────────────────────────────
const profilesView = document.querySelector('section.screen[data-view="profiles"]');
const profilesList = document.getElementById("profiles-list");

const ICON_DOTS    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>`;
const ICON_REFRESH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/></svg>`;
const ICON_EDIT    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
const ICON_TRASH   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 6h18"/><path d="m19 6-1.5 14a2 2 0 0 1-2 1.8h-7a2 2 0 0 1-2-1.8L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const ICON_CHECK   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="m5 12 5 5L20 7"/></svg>`;
const ICON_COPY    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_QR      = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14v3"/><path d="M14 20h3"/><path d="M17 17v4"/><path d="M21 21h-1"/></svg>`;
const ICON_WARN    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;
const ICON_GLOBE   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>`;

// An imported link may itself turn off TLS certificate verification
// (hysteria2 `insecure=1`, TrustTunnel `skip_verification`). This silently removes
// protection against server spoofing, so such a profile is marked in the list.
function tlsVerificationDisabled(profile) {
  return profile?.insecure === true || profile?.skipVerification === true;
}

function renderProfilesView() {
  if (!profilesList) return;
  const profsList = loadProfiles();
  const subsList = loadSubscriptions();
  const activeProfileId = getActiveProfileId();
  const activeKind = getActiveKind();
  const activeSubId = getActiveSubscriptionId();
  const summaryLine = document.getElementById("profiles-summary-line");

  if (profsList.length === 0 && subsList.length === 0) {
    if (summaryLine) summaryLine.textContent = "";
    profilesList.innerHTML = `
      <div class="n-empty">
        <span class="n-empty__i">${ICON_GLOBE}</span>
        <h3>${escapeHtml(t("prof.emptyTitle"))}</h3>
        <p>${escapeHtml(t("prof.emptySub"))}</p>
      </div>
    `;
    return;
  }

  const activeName = activeKind === "sub"
    ? (subsList.find(s => s.id === activeSubId)?.name || "—")
    : (profsList.find(p => p.id === activeProfileId)?.name || "—");
  if (summaryLine) {
    summaryLine.textContent = t("prof.summary", {
      subs: tn("prof.subsN", subsList.length),
      configs: tn("prof.configsN", profsList.length),
      active: activeName,
    });
  }

  const subRow = (s) => {
    const isActive = activeKind === "sub" && s.id === activeSubId;
    const days = subscriptionDaysLeft(s);
    const used = subscriptionUsedBytes(s);
    const limit = subscriptionLimitBytes(s); // null = unlimited (total=0)
    const updated = relativeTime(s.lastUpdate) || "—";
    // We count what will actually go into the core: a subscription saved before
    // the rejection logic may have nodes in its record that the core won't accept.
    const nodesCount = usableNodes(s.profiles).length;
    const ratio = limit ? Math.max(0, Math.min(1, used / limit)) : 0;
    const meterState = !limit ? "idle" : ratio > 0.9 ? "err" : ratio > 0.75 ? "warn" : "ok";
    const daysState = days == null ? "" : days <= 3 ? "pf__val--err" : days <= 7 ? "pf__val--warn" : "";
    return `
      <div class="n-row pf" data-active="${isActive}" data-sub-id="${escapeAttr(s.id)}" role="button" tabindex="0">
        <div class="pf__main" data-sub-activate="${escapeAttr(s.id)}">
          <div class="pf__name">
            <span class="n-primary">${escapeHtml(s.name)}</span>
            ${isActive ? `<span class="pf__tag">${escapeHtml(t("prof.badgeActive"))}</span>` : ""}
          </div>
          <div class="n-meta">${escapeHtml(s.host || hostOfUrl(s.url))}<s>·</s>${escapeHtml(tn("prof.srvN", nodesCount))}<s>·</s>${escapeHtml(updated)}</div>
        </div>
        <div class="pf__col pf__col--traffic">
          <div class="pf__val">
            <span class="n-num">${escapeHtml(fmtTraffic(used))}</span>
            <span class="pf__unit-lg">${limit != null ? `/ ${escapeHtml(fmtTraffic(limit))}` : `· ${escapeHtml(t("prof.unlimited"))}`}</span>
          </div>
          ${limit != null
            ? `<div class="n-meter pf__meter" data-state="${meterState}"><div class="n-meter__f" style="width:${(ratio * 100).toFixed(1)}%"></div></div>`
            : `<span class="n-lbl">${escapeHtml(t("prof.statTraffic"))}</span>`}
        </div>
        <div class="pf__col">
          ${days == null ? "" : `
            <div class="pf__val ${daysState}"><span class="n-num">${days}</span><span class="n-unit">${escapeHtml(t("prof.daysUnit"))}</span></div>
            <span class="n-lbl">${escapeHtml(t("prof.statExpires"))}</span>`}
        </div>
        <button class="n-icon" data-menu-sub="${escapeAttr(s.id)}" type="button" aria-haspopup="menu" aria-label="${escapeAttr(t("prof.menuAria"))}">${ICON_DOTS}</button>
      </div>`;
  };

  const cfgRow = (p) => {
    const isActive = activeKind === "single" && p.id === activeProfileId;
    const proto = (p.proto || "vless").toUpperCase();
    const security = (p.security || "tcp").toUpperCase();
    return `
      <div class="n-row pf" data-active="${isActive}" data-id="${escapeAttr(p.id)}" role="button" tabindex="0">
        <div class="pf__main" data-profile-activate="${escapeAttr(p.id)}">
          <div class="pf__name">
            <span class="n-primary">${escapeHtml(p.name)}</span>
            ${isActive ? `<span class="pf__tag">${escapeHtml(t("prof.badgeActive"))}</span>` : ""}
            ${tlsVerificationDisabled(p)
              ? `<span class="pf__warn" title="${escapeAttr(t("prof.badgeInsecureHint"))}">${ICON_WARN}${escapeHtml(t("prof.badgeInsecure"))}</span>`
              : ""}
          </div>
          <div class="n-meta">${escapeHtml(`${p.host}:${p.port}`)}<s>·</s>${escapeHtml(proto)} · ${escapeHtml(security)}</div>
        </div>
        <div class="pf__col pf__col--traffic">
          <div class="pf__val">
            <span class="n-num">${escapeHtml(fmtTraffic(getMeasured(`profile:${p.id}`).total))}</span>
          </div>
          <span class="n-lbl">${escapeHtml(t("prof.statTraffic"))}</span>
        </div>
        <div class="pf__col"></div>
        <button class="n-icon" data-menu-profile="${escapeAttr(p.id)}" type="button" aria-haspopup="menu" aria-label="${escapeAttr(t("prof.menuAria"))}">${ICON_DOTS}</button>
      </div>`;
  };

  const group = (label, n, rows, action = "") => !rows.length ? "" : `
    <div class="n-group"><span class="n-lbl">${escapeHtml(label)}</span>
      <span class="n-group__n">${n}</span><span class="n-group__line"></span>${action}</div>
    <div class="pf-list">${rows.join("")}</div>`;

  // Single configs come in batches (clipboard import, deep links), so
  // the group has a bulk delete — a per-row menu over dozens of rows is unreadable.
  const clearConfigs = `
    <button class="n-group__act" data-profiles-clear type="button"
      title="${escapeAttr(t("prof.clearConfigsHint"))}">${ICON_TRASH}<span>${escapeHtml(t("prof.clearConfigs"))}</span></button>`;

  profilesList.innerHTML =
    group(t("prof.groupSubs"), subsList.length, subsList.map(subRow)) +
    group(t("prof.groupConfigs"), profsList.length, profsList.map(cfgRow), clearConfigs);
}

// Subscription host for the meta line: the full URL carries the token and isn't needed in the list.
function hostOfUrl(url) {
  try { return new URL(url).host; } catch { return String(url || ""); }
}

// Header buttons of the profiles screen
profilesList?.addEventListener("keydown", (e) => {
  if (isContextMenuKey(e)) {
    const row = e.target.closest(".pf");
    if (!row) return;
    e.preventDefault();
    openRowMenu(row, row, { returnFocus: e.target, focusFirst: true });
    return;
  }
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest(".pf");
  if (!row || e.target.closest("button")) return;
  e.preventDefault();
  row.click();
});

document.getElementById("profiles-add")?.addEventListener("click", () => openAddModal());

// ── Onboarding wizard (import → connect → done) ───────
const ONB_STEP_KEY = "ninety.onboarding.step";
const ONB_DONE_KEY = "ninety.onboarding.done";
let wizardActive = false;
let wizardStepNum = parseInt(localStorage.getItem(ONB_STEP_KEY) || "1", 10) || 1;

function isOnboardingDone() {
  return localStorage.getItem(ONB_DONE_KEY) === "1";
}
function markOnboardingDone() {
  localStorage.setItem(ONB_DONE_KEY, "1");
  localStorage.removeItem(ONB_STEP_KEY);
}
function showOnbStep(n) {
  wizardStepNum = Math.max(1, Math.min(3, n));
  localStorage.setItem(ONB_STEP_KEY, String(wizardStepNum));
  const onb = document.getElementById("onboarding-screen");
  if (!onb) return;
  onb.dataset.step = String(wizardStepNum);
  onb.querySelectorAll(".onb-step").forEach(s => {
    s.hidden = s.dataset.step !== String(wizardStepNum);
  });
}
function openWizardAt(step = 1) {
  wizardActive = true;
  if (appRoot) appRoot.dataset.wizard = "true";
  const onb = document.getElementById("onboarding-screen");
  if (onb) onb.hidden = false;
  showOnbStep(step);
}
function closeWizard() {
  markOnboardingDone();
  wizardActive = false;
  if (appRoot) appRoot.dataset.wizard = "false";
  syncEmptyState();
}

// Delegated handlers for the wizard buttons
document.getElementById("onboarding-screen")?.addEventListener("click", async (e) => {
  const next = e.target.closest("[data-onb-next]");
  if (next) {
    const n = parseInt(next.dataset.onbNext, 10);
    if (!wizardActive) openWizardAt(n);
    else showOnbStep(n);
    return;
  }
  const back = e.target.closest("[data-onb-back]");
  if (back) { showOnbStep(parseInt(back.dataset.onbBack, 10)); return; }
  if (e.target.closest("[data-onb-skip]")) { closeWizard(); return; }
  if (e.target.closest("[data-onb-finish]")) { closeWizard(); return; }
  const importInput = document.getElementById("onb-import-url");
  if (e.target.closest("[data-onb-paste]")) {
    try { importInput.value = (await navigator.clipboard.readText() || "").trim(); } catch {}
    importInput?.focus();
    return;
  }
  const action = e.target.closest("[data-onb-action]")?.dataset.onbAction;
  if (action === "import") {
    if (!wizardActive) openWizardAt(1);
    let value = importInput?.value?.trim() || "";
    if (!value) {
      try { value = (await navigator.clipboard.readText() || "").trim(); } catch {}
    }
    openAddModal(value ? { prefillUrl: value } : undefined);
  } else if (action === "clipboard") {
    if (!wizardActive) openWizardAt(1); // just in case — fix the wizard state
    try {
      const text = await navigator.clipboard.readText();
      openAddModal({ prefillUrl: (text || "").trim() });
    } catch { openAddModal(); }
  } else if (action === "manual") {
    if (!wizardActive) openWizardAt(1);
    openAddModal();
  }
});
// First launch: the region is preselected by time zone (once; a returning user's choice isn't touched).
if (!localStorage.getItem("ninety.region.detected") && !isOnboardingDone()) {
  updateOption("region", detectRegion());
  localStorage.setItem("ninety.region.detected", "1");
}

// Live re-render on a language change: static strings of index.html + the home screen's dynamic parts.
onLangChange(() => {
  applyDom(document);
  applySidebarState();
  refreshDynamicText();
  settingsCtl?.refresh();
  syncTrayMenu(); // tray menu/tooltip — in the new language
  rerenderDpiView();
  rerenderProxiesView();
  renderProfilesView();
  refreshSubCardFromActive();
  setChannelState(lastChannelState);
  updateHeroHint();
  applyPingDisplay(lastPingDelay);
  if (state === "connected") paintSession();
  else {
    if (tfDownUnit) tfDownUnit.textContent = t("units.rateKiB");
    if (tfUpUnit) tfUpUnit.textContent = t("units.rateKiB");
  }
  rerenderLogsView(); // a no-op if the Logs screen isn't active
});

// Redraw the home screen's dynamic labels (hero status, mode hint, the mode in
// telemetry) without side effects — sessions/timers/the core aren't touched.
function refreshDynamicText() {
  if (heroLabel) {
    heroLabel.textContent =
      state === "connected"  ? t("hero.secured")
      : state === "connecting" ? t("hero.connecting")
      : state === "disconnecting" ? t("hero.disconnecting")
      : state === "cleanup_error" ? t("conn.cleanupFail")
      : t("hero.notConnected");
  }
  if (modeHint) {
    const m = getMode();
    modeHint.innerHTML = t("mode.hint." + (MODE_KEYS.includes(m) ? m : "systemProxy"));
  }
  if (statsMode && state === "connected") statsMode.textContent = modeLabel(getMode());
  updateHomeReady();
}

document.getElementById("profiles-refresh-all")?.addEventListener("click", async () => {
  try {
    const subscriptions = loadSubscriptions();
    const tx = await mutateSources(
      subscriptions.map(s => ({ kind: "sub", id: s.id })),
      refreshAllSubscriptions,
      t("conn.applyingSettings"),
    );
    const results = tx.result;
    const okCount = results.filter(r => r.ok).length;
    const failCount = results.length - okCount;
    const firstError = results.find(r => !r.ok)?.error;
    refreshSubCardFromActive();
    refreshProfilesSummary();
    if (failCount === 0) {
      toast(t("prof.subsRefreshOk"), "success", 1800);
    } else if (okCount > 0) {
      toast(t("prof.subsRefreshPartial", { ok: okCount, fail: failCount }), "warn", 3200);
    } else {
      const msg = firstError
        ? `${t("prof.subsRefreshFailed")}: ${firstError}`
        : t("prof.subsRefreshFailed");
      toast(msg, "error", 3200);
    }
  } catch (e) {
    toast(t("prof.toastErr", { err: e?.message || e }), "error", 2800);
  }
});

// The subscription and single profile menu. One entry point for "⋯", right click
// and the keyboard — the items and actions can't diverge.
function openSubscriptionMenu(anchor, id, opts) {
  return openPMenu(anchor, [
    { id: "refresh",  label: t("prof.menu.refresh"),  icon: ICON_REFRESH },
    { id: "edit",     label: t("prof.menu.edit"), icon: ICON_EDIT },
    { id: "copy",     label: t("prof.menu.copyUrl"), icon: ICON_COPY },
    { id: "qr",       label: t("prof.menu.qr"), icon: ICON_QR },
    { id: "export",   label: t("prof.menu.export"), icon: ICON_COPY },
    { id: "activate", label: t("prof.menu.activateSub"), icon: ICON_CHECK },
    { id: "reset-traffic", label: t("prof.menu.resetTraffic"), icon: ICON_REFRESH },
    { id: "remove",   label: t("prof.menu.remove"),   icon: ICON_TRASH, danger: true },
  ], { ...opts, onSelect: async (act) => {
    if (act === "edit") {
      const sub = loadSubscriptions().find(s => s.id === id);
      const before = sourceFingerprint(sourceById("sub", id));
      if (sub) openEditSubscription(sub, {
        onSaved: async (changes) => {
          // Changing HWID sending changes the panel's response itself — we reread the list,
          // otherwise the previous request's placeholder stays on screen.
          const apply = changes?.hwidChanged
            ? () => refreshSubscription(id)
            : async () => sub;
          try {
            await mutateSource("sub", id, apply, t("conn.applyingSettings"), before);
          } catch (err) {
            toast(t("prof.toastErr", { err: err?.message || err }), "error", 2800);
          }
          if (changes?.hwidChanged) {
            renderProfilesView();
            refreshSubCardFromActive();
          }
        },
        onToast: toast,
      });
      return;
    }
    if (act === "refresh") {
      try {
        // A manual update is also a "try again": we lift the quarantine,
        // otherwise a server disabled after a core refusal can't be brought back by anything except
        // clearing data. If it's still broken, the core will say so again.
        clearNodeQuarantine();
        const tx = await mutateSource("sub", id, () => refreshSubscription(id), t("conn.applyingSettings"));
        const r = tx.result;
        toast(t("prof.toastUpdated", { srv: tn("prof.srvN", r.profiles.length) }), "success", 1800);
        if (r.skipped > 0) toast(t("subs.skippedNote", { n: r.skipped }), "warn", 6000);
        await offerHwidAndReload(id, r.hwidSignal);
      } catch (err) {
        toast(t("prof.toastErr", { err: err?.message || err }), "error", 2800);
        await offerHwidAndReload(id, err?.hwid);
      }
      renderProfilesView();
      refreshSubCardFromActive();
    } else if (act === "copy") {
      const sub = loadSubscriptions().find(s => s.id === id);
      await copySubscriptionUrl(sub, toast);
    } else if (act === "qr") {
      const sub = loadSubscriptions().find(s => s.id === id);
      if (sub) openQRModal(sub);
    } else if (act === "export") {
      const sub = loadSubscriptions().find(s => s.id === id);
      if (sub) await exportSingboxJson({ kind: "sub", subscription: sub, nodes: sub.profiles }, toast);
    } else if (act === "activate") {
      activateSource("sub", id);
    } else if (act === "reset-traffic") {
      resetMeasured(`sub:${id}`);
      renderProfilesView();
      refreshSubCardFromActive();
      toast(t("prof.toastTrafficReset"), "info", 1600);
    } else if (act === "remove") {
      await deleteSource("sub", id);
    }
  } });
}

function openProfileMenu(anchor, id, opts) {
  const menuProfile = loadProfiles().find(x => x.id === id);
  return openPMenu(anchor, [
    { id: "edit",     label: t("prof.menu.edit"),    icon: ICON_EDIT },
    // WireGuard and OpenVPN share a file: we show the matching extension.
    ...(menuProfile?.proto === "wireguard"
      ? [{ id: "wg-conf", label: t("prof.menu.copyConf"), icon: ICON_COPY }]
      : []),
    ...(menuProfile?.proto === "openvpn"
      ? [{ id: "ovpn-conf", label: t("prof.menu.copyOvpn"), icon: ICON_COPY }]
      : []),
    { id: "activate", label: t("prof.menu.activateProfile"), icon: ICON_CHECK },
    { id: "reset-traffic", label: t("prof.menu.resetTraffic"), icon: ICON_REFRESH },
    { id: "remove",   label: t("prof.menu.remove"),          icon: ICON_TRASH, danger: true },
  ], { ...opts, onSelect: async (act) => {
    if (act === "edit") {
      const p = loadProfiles().find(x => x.id === id);
      const before = sourceFingerprint(sourceById("single", id));
      if (p) openEditProfile(p, {
        onSaved: () => mutateSource("single", id, async () => p, t("conn.applyingSettings"), before),
        onToast: toast,
      });
      return;
    }
    if (act === "wg-conf") {
      await copyWireguardConf(loadProfiles().find(x => x.id === id), toast);
      return;
    }
    if (act === "ovpn-conf") {
      await copyOpenvpnConf(loadProfiles().find(x => x.id === id), toast);
      return;
    }
    if (act === "activate") {
      activateSource("single", id);
    } else if (act === "reset-traffic") {
      resetMeasured(`profile:${id}`);
      renderProfilesView();
      refreshSubCardFromActive();
      toast(t("prof.toastTrafficReset"), "info", 1600);
    } else if (act === "remove") {
      await deleteSource("single", id);
    }
  } });
}

/** Profiles row menu (.pf): a subscription or a single profile. */
function openRowMenu(row, anchor, opts) {
  if (row.dataset.subId) return openSubscriptionMenu(anchor, row.dataset.subId, opts);
  if (row.dataset.id) return openProfileMenu(anchor, row.dataset.id, opts);
  return null;
}

// Right click on a row → the same menu as "⋯", at the cursor.
profilesView?.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".pf");
  if (!row) return;
  e.preventDefault();
  openRowMenu(row, { x: e.clientX, y: e.clientY }, { returnFocus: row });
});

profilesView?.addEventListener("click", async (e) => {
  // FAB → open add-modal
  if (e.target.closest("#profiles-fab")) {
    openAddModal();
    return;
  }

  // Subscription menu (3 dots)
  const subMenuBtn = e.target.closest("[data-menu-sub]");
  if (subMenuBtn) {
    e.stopPropagation();
    // detail === 0 — a keyboard press: focus goes straight to the first item.
    openSubscriptionMenu(subMenuBtn, subMenuBtn.dataset.menuSub, { focusFirst: e.detail === 0 });
    return;
  }

  // "Delete all" in the header of the single configs group
  if (e.target.closest("[data-profiles-clear]")) {
    e.stopPropagation();
    await deleteAllProfiles();
    return;
  }

  // Single profile menu (3 dots)
  const profileMenuBtn = e.target.closest("[data-menu-profile]");
  if (profileMenuBtn) {
    e.stopPropagation();
    openProfileMenu(profileMenuBtn, profileMenuBtn.dataset.menuProfile, { focusFirst: e.detail === 0 });
    return;
  }

  // A click on a row → activation. Caught on the whole row, not only on the left
  // block: the row is declared role="button", and the traffic/term columns must
  // react the same way.
  const row = e.target.closest(".pf");
  if (row) {
    if (row.dataset.subId) { activateSource("sub", row.dataset.subId); return; }
    if (row.dataset.id) { activateSource("single", row.dataset.id); return; }
  }
});

// ── HERO ───────────────────────────────────────────────────
const hero = document.getElementById("hero");
const heroDisc = document.getElementById("hero-disc");
const heroMask = document.getElementById("hero-mask");
const heroLabel = document.getElementById("hero-label");
const sidebarState = document.querySelector(".sidebar-state");
const sidebarStateLabel = document.getElementById("sidebar-state-label");
const heroHint = document.getElementById("hero-hint");
const heroHintText = document.getElementById("hero-hint-text");
const tfDown = document.getElementById("tf-down");
const tfUp = document.getElementById("tf-up");
const tfDownUnit = document.getElementById("tf-down-unit");
const tfUpUnit = document.getElementById("tf-up-unit");
const tfDot = document.getElementById("tf-dot");
const locCard = document.getElementById("location-card");
const statsStrip = document.getElementById("stats-strip");
const statsServer = document.getElementById("stats-server");
const statsFlag = document.getElementById("stats-flag");
const statsMode = document.getElementById("stats-mode");
// Telemetry strip (secured): Ping · Channel · Session
const telePing = document.getElementById("tele-ping");
const statsPing = document.getElementById("stats-ping");
const statsUptime = document.getElementById("stats-uptime");
const statsTotal = document.getElementById("stats-total");
const locPing = document.getElementById("loc-ping");
const locIpRow = document.getElementById("loc-ip-row");
const locIp = document.getElementById("loc-ip");

// Map names for CSS data-state
const STATE_HERO = {
  idle: "standby", connecting: "linking", connected: "secured",
  disconnecting: "unlinking", cleanup_error: "standby",
};
const STATE_KICKER = {
  idle:       "STAND-BY · DISCONNECTED",
  connecting: "LINKING · NEGOTIATING",
  disconnecting: "DISCONNECTING · CLEANUP",
  connected:  "SECURED · TUNNEL ACTIVE", // default; in connected we take connectedKicker() by mode
};
// The kicker in the connected state depends on the mode: TUNNEL ACTIVE only in TUN,
// system proxy → SYSTEM PROXY, proxy → PROXY ACTIVE (previously always "TUNNEL ACTIVE").
const CONNECTED_KICKER = {
  tun:         "SECURED · TUNNEL ACTIVE",
  systemProxy: "SECURED · SYSTEM PROXY",
  proxy:       "SECURED · PROXY ACTIVE",
};
function connectedKicker() { return CONNECTED_KICKER[getMode()] || STATE_KICKER.connected; }
const modeLabel = (m) => t("mode." + m);

function applyHeroState(internalState) {
  if (!hero) return;
  const ds = STATE_HERO[internalState] || "standby";
  hero.dataset.state = ds;
}

// Stats strip vs location card: connected → the stats strip with live metrics.
// When the VPN is off (idle/connecting) the bottom server tile isn't needed,
// we hide both (previously the loc card was shown in standby — extra noise).
// The "Ready" line under the HUD before connecting: a manually chosen server or "Auto" if
// the subscription picks the node itself after the core starts, and the connection mode.
const homeReady = document.getElementById("home-ready");
const homeReadyFlag = document.getElementById("home-ready-flag");
const homeReadySrv = document.getElementById("home-ready-srv");
const homeReadyMode = document.getElementById("home-ready-mode");
// applyHomeBottom("idle") is called before state/currentEffectiveNode (let) are declared:
// until this flag we don't touch the line, otherwise accessing them would fail in the dead zone.
let homeReadyBooted = false;
function readyTarget() {
  if (currentEffectiveNode) return currentEffectiveNode;
  const src = activeDisplaySource();
  if (!src) return null;
  if (src.kind !== "sub") return src.profile || null;
  if ((src.nodes?.length || 0) === 1) return src.nodes[0];
  const tag = getRememberedProxySelection(src);
  return (tag && src.nodes?.find((n, i) => nodeTag(i, n) === tag)) || "auto";
}
function updateHomeReady() {
  if (!homeReady || !homeReadyBooted) return;
  const target = state === "idle" ? readyTarget() : null;
  homeReady.hidden = !target;
  if (!target) return;
  const node = target === "auto" ? null : target;
  homeReadySrv.textContent = node ? (stripFlag(node.name) || node.host || "—") : t("proxies.auto");
  const iso = node ? (isoFromNodeName(node.name) || isoFromNodeName(node.host)) : null;
  homeReadyFlag.innerHTML = iso ? `<img src="${FLAGS_BASE}/${iso}.svg" alt="">` : "";
  homeReadyFlag.hidden = !iso;
  homeReadyMode.textContent = modeLabel(getMode());
}

function applyHomeBottom(internalState) {
  if (!locCard || !statsStrip) return;
  locCard.hidden = true;
  // The stats strip is ALWAYS in the flow (keeps the height), it's made visible only in connected.
  // Otherwise its appearance on connect squeezes .hero from below → the centered scene/mask
  // moves up (and back down on disconnect). Reserved space = the scene doesn't move.
  statsStrip.hidden = false;
  statsStrip.classList.toggle("stats--reserved", internalState !== "connected");
  updateHomeReady();
}

// The active server in the stats strip — updated on connect and on an effective node change.
function updateStatsServer() {
  if (!statsServer) return;
  const p = activeNodeForDisplay();
  // The name without the flag emoji: the SVG flag in the cell already shows the country (otherwise a duplicate flag).
  const label = stripFlag(p?.name) || p?.host || "—";
  statsServer.textContent = label;
  statsServer.title = label;
  if (statsFlag) {
    const iso = p ? (isoFromNodeName(p.name) || isoFromNodeName(p.host)) : null;
    statsFlag.innerHTML = iso ? `<img src="${FLAGS_BASE}/${iso}.svg" alt="">` : "";
    statsFlag.hidden = !iso;
  }
  updateHomeReady(); // the node or source changed — update the "Ready" line
}

let lastPublicIp = null;
if (locIp) bindIpReveal(locIp, () => lastPublicIp);

async function refreshPublicIp(epoch = connectAttempts.current()) {
  if (state !== "connected" || !connectAttempts.isCurrent(epoch)) return;
  // Privacy: the user disabled geo requests → we don't poke external IP services
  // at all, the IP tile goes dark with an explanatory tooltip.
  if (activeStrictPrivacyRuntime || loadOptions().general?.disableGeoLookup) {
    lastPublicIp = null;
    if (locIpRow) locIpRow.hidden = false;
    if (locIp) {
      locIp.textContent = "—";
      locIp.dataset.revealed = "false";
      locIp.title = t("hero.ipGeoOff");
    }
    return;
  }
  // The IP is always pulled THROUGH the local sing-box inbound, in all modes:
  //   proxy/systemProxy — mixed-in (reqwest doesn't honor the system proxy, so
  //     even in systemProxy without an explicit address the request would go direct → past
  //     the tunnel and would show the user's real IP);
  //   tun — probe-in listens on the same port; "direct" isn't allowed because Ninety.exe's own
  //     traffic in TUN goes direct via the bypass rule (loop protection)
  //     and the IP service would see the real IP, not the exit.
  const proxyHostPort = runtimeProbeHostPort();
  if (!proxyHostPort) return;
  try {
    const info = await fetchPublicIp({ proxyHostPort });
    if (state !== "connected" || !connectAttempts.isCurrent(epoch)) return;
    if (!info?.success && info?.ip == null) {
      // Rust normalizes the response (fetch_public_ip goes through providers); when
      // all fail an Err usually arrives → catch, this branch is a safeguard.
      throw new Error(info?.message || "no ip");
    }
    lastPublicIp = info.ip;
    if (locIpRow) locIpRow.hidden = false;
    if (locIp) {
      locIp.textContent = maskIp(info.ip);
      locIp.dataset.revealed = "false";
      const flag = info.country_code?.toLowerCase();
      const country = info.country || info.country_code || "";
      if (flag) locIp.title = t("hero.ipTooltip", { country });
    }
  } catch (e) {
    if (state !== "connected" || !connectAttempts.isCurrent(epoch)) return;
    if (locIpRow) locIpRow.hidden = false;
    if (locIp) locIp.textContent = "— · —";
    console.warn("public ip failed", e?.message || e);
  }
}
const locName = document.querySelector(".loc-card__name");
const locProto = document.querySelector(".loc-card__sub b");
const locFlag = document.querySelector(".loc-card__flag");

// flags: FLAGS_BASE + isoFromNodeName are imported from /lib/flags.js
function setLocationFlag(iso) {
  if (!locFlag) return;
  if (iso) {
    locFlag.innerHTML = `<img src="${FLAGS_BASE}/${iso}.svg" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
  }
}

if (heroMask) heroMask.playbackRate = 0.7;

// Initial home-bottom + hero-state (standby)
applyHomeBottom("idle");
applyHeroState("idle");

let state = "idle";
let networkBootstrapInProgress = true;
let needsReconnect = false;
let publicIpTimer = null;
let runtimeSnapshotCache = null;

function runtimeProbeHostPort(snapshot = runtimeSnapshotCache) {
  if (!runtimeEndpointMatchesGeneration(snapshot)) return null;
  const address = snapshot?.probeProxyEndpoint?.address;
  return typeof address === "string" && address ? address : null;
}
// The connect attempt generation: "Disconnect" during the core start increments
// it, and the finished start_singbox sees the cancellation (see the heroDisc handler) —
// previously a quick connect→cancel still ended with "Protected".
const connectAttempts = createConnectionAttemptGate();

// The obsidian HUD (styles/obsidian-hud.css) moves only when visible: in the tray, without
// focus and on other screens its animations stand still — the GPU doesn't heat up for nothing.
function syncHeroMotion(snapshot = activityController.snapshot()) {
  if (!hero) return;
  const live = snapshot.visible && snapshot.focused && snapshot.view === "home";
  if (live) delete hero.dataset.motion;
  else hero.dataset.motion = "paused";
}
activityController.subscribe((snapshot) => syncHeroMotion(snapshot));
syncHeroMotion();
// The calm main screen is toggled in settings on the fly.
bus.on(CALM_HUD_EVENT, () => syncHeroMaskPlayback());
syncHeroMaskPlayback();

function setHeroHintText(text) {
  if (heroHintText) heroHintText.textContent = text;
  else if (heroHint) heroHint.textContent = text;
}

function updateHeroHint() {
  if (state !== "idle") return;
  if (networkBootstrapInProgress) {
    if (heroDisc) {
      heroDisc.disabled = true;
      heroDisc.setAttribute("aria-disabled", "true");
    }
    return;
  }
  const src = activeDisplaySource();
  if (!src) {
    setHeroHintText(t("home.importHint"));
    if (heroDisc) {
      heroDisc.disabled = true;
      heroDisc.setAttribute("aria-disabled", "true");
    }
  } else {
    setHeroHintText(STATE_KICKER.idle);
    if (heroDisc && !networkBootstrapInProgress) {
      heroDisc.disabled = false;
      heroDisc.removeAttribute("aria-disabled");
    }
  }
}

// The current node the traffic actually goes through — arrives from the clash API
// as the ninety:node-changed event. When null — fall back to nodes[0]/profile.
let currentEffectiveNode = null;
let currentEffectiveTag = null;

function activeNodeForDisplay() {
  if (currentEffectiveNode) return currentEffectiveNode;
  const src = activeDisplaySource();
  return src?.kind === "sub" ? src.nodes[0] : src?.profile;
}

// The node name as in the node list (not the address). host is the fallback.
function nodeDisplayLabel(n) {
  return n?.name || n?.host || "";
}

// A guaranteed non-empty server name for a toast/notification. A chain of fallbacks:
// the actual node from clash → the source's first node/profile → the subscription name.
// Returns "" only if there's no active source at all.
function resolveServerLabel() {
  const eff = currentEffectiveNode;
  if (eff?.name || eff?.host) return eff.name || eff.host;
  const src = activeDisplaySource();
  if (src?.kind === "sub") {
    const n0 = src.nodes?.[0];
    if (n0?.name || n0?.host) return n0.name || n0.host;
    return src.subscription?.name || "";
  }
  const p = src?.profile;
  return p?.name || p?.host || "";
}

// An OS notification + a catch-up toast about the connection with the NAME of the actually chosen
// node. For a subscription with >=2 nodes the balancer picks the server only AFTER the core
// starts — we poll clash until the actual server appears (up to ~3.5 s),
// otherwise we'd show nodes[0] (the first in the list), not the actual one. For a single
// profile there's one node — nothing to wait for.
async function notifyConnectedWithRealNode(isMultiSub) {
  if (isMultiSub) {
    for (let i = 0; i < 7; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (state !== "connected") return; // we got disconnected in the meantime
      try { await syncEffectiveFromClash(); } catch {}
      if (currentEffectiveNode) break;
    }
  }
  if (state !== "connected") return;
  const label = resolveServerLabel();
  // For a subscription the initial toast was generic (the balancer hadn't chosen yet) —
  // we follow up with the real server once it's known.
  if (label && isMultiSub) {
    toast(t("conn.protected"), "connected", 2000, { group: "conn", desc: t("conn.serverDesc", { label }) });
  }
  notify(t("conn.notifyConnected"), label ? t("conn.serverDesc", { label }) : t("conn.tunnelUp"));
}

function updateHeroForActive() {
  const src = activeDisplaySource();
  const p = activeNodeForDisplay();
  if (locName) {
    if (src?.kind === "sub") {
      const nodeLabel = p?.name || p?.host || "—";
      locName.textContent = `${src.subscription.name} · ${nodeLabel}`;
    } else if (src?.kind === "warp") {
      locName.textContent = "WARP";
    } else if (p) {
      locName.textContent = p.name || p.host;
    }
  }
  if (locProto && p) {
    const proto = (p.proto || "vless").toUpperCase();
    const parts = [proto];
    const sec = p.security || p.tlsMode;
    if (sec && sec !== "none") parts.push(sec);
    if (p.type) parts.push(p.type.toUpperCase());
    locProto.textContent = parts.join(" · ");
  }
  if (p) {
    const iso = isoFromNodeName(p.name) || isoFromNodeName(p.host);
    setLocationFlag(iso);
  }
  updateStatsServer();
  if (state === "idle") updateHeroHint();
}

function applySidebarState(next = state) {
  if (sidebarState) sidebarState.dataset.state = next;
  if (!sidebarStateLabel) return;
  const key = {
    idle: "sidebar.ready",
    connecting: "hero.connecting",
    connected: "hero.secured",
    disconnecting: "hero.disconnecting",
    cleanup_error: "conn.cleanupFail",
  }[next] || "sidebar.ready";
  sidebarStateLabel.textContent = t(key);
}

// For "On launch: as it was". We write "on" on every connection and "off" only
// on a manual "Disconnect": closing the app with the VPN up leaves "on".
function rememberVpnLastState(value) {
  try { localStorage.setItem(STORAGE_KEYS.vpnLastState, value); } catch {}
}

function setState(next, opts = {}) {
  state = next;
  applySidebarState(next);
  applyHeroState(next);
  applyHomeBottom(next);

  if (next === "idle") {
    runtimeSnapshotCache = null;
    needsReconnect = false;
    if (pendingReconnectTimer) { clearTimeout(pendingReconnectTimer); pendingReconnectTimer = null; }
    stopWarpRescanLoop();
    clearVpnNodeExclusion();
    invoke("warp_scan_cancel").catch(() => {});
    stopDnsGuard();
    applyKillSwitch(false, {
      preserve: !!opts.preserveKillSwitch,
      policyMode: opts.preserveKillSwitch ? preservedKillSwitchPolicyMode() : null,
    });
    activeStrictPrivacyRuntime = false;
    if (!opts.preserveKillSwitch) {
      strictFailClosedLatched = false;
      ordinaryFailClosedLatched = false;
    }
    syncHealthWatchdogForState();
    stopQualityEngine("disconnected");
    showQualityChip(false);
    applyReconnectUI();
    if (heroLabel) heroLabel.textContent = t("hero.notConnected");
    stopSession();
    if (heroDisc) heroDisc.setAttribute("aria-label", t("heroAria.connect"));
    if (tfDown) tfDown.textContent = "0";
    if (tfUp) tfUp.textContent = "0";
    if (tfDownUnit) tfDownUnit.textContent = t("units.rateKiB");
    if (tfUpUnit) tfUpUnit.textContent = t("units.rateKiB");
    if (tfDot) tfDot.dataset.live = "false";
    if (heroMask) heroMask.playbackRate = 0.7;
    stopClashStream();
    stopMeter();
    if (publicIpTimer) { clearInterval(publicIpTimer); publicIpTimer = null; }
    lastPublicIp = null;
    if (locIpRow) locIpRow.hidden = true;
    currentEffectiveNode = null;
    currentEffectiveTag = null;
    if (heroHint) heroHint.hidden = false;
    updateHeroHint();
  } else if (next === "connecting") {
    if (heroLabel) heroLabel.textContent = t("hero.connecting");
    if (heroHint) heroHint.hidden = false;
    setHeroHintText(STATE_KICKER.connecting);
    if (heroDisc) heroDisc.setAttribute("aria-label", t("heroAria.cancelConnect"));
    if (heroMask) heroMask.playbackRate = 1.4;
  } else if (next === "disconnecting") {
    if (opts.preserveKillSwitch) syncHealthWatchdogForState();
    else stopHealthWatchdog();
    stopWarpRescanLoop();
    clearVpnNodeExclusion();
    invoke("warp_scan_cancel").catch(() => {});
    stopDnsGuard();
    stopClashStream();
    stopMeter();
    stopQualityEngine("disconnected");
    // The stop is confirmed by the backend (processes exited, ports released),
    // so this is a separate transitional state, not a new connect.
    if (heroLabel) heroLabel.textContent = t("hero.disconnecting");
    if (heroHint) heroHint.hidden = false;
    setHeroHintText(STATE_KICKER.disconnecting);
    if (heroDisc) heroDisc.disabled = true;
  } else if (next === "cleanup_error") {
    stopWarpRescanLoop();
    invoke("warp_scan_cancel").catch(() => {});
    stopDnsGuard();
    stopClashStream();
    stopMeter();
    applyKillSwitch(false, {
      preserve: !!opts.preserveKillSwitch,
      policyMode: opts.preserveKillSwitch ? preservedKillSwitchPolicyMode() : null,
    });
    if (!opts.preserveKillSwitch) {
      strictFailClosedLatched = false;
      ordinaryFailClosedLatched = false;
    }
    syncHealthWatchdogForState();
    stopQualityEngine("disconnected");
    if (heroLabel) heroLabel.textContent = t("conn.cleanupFail");
    if (heroDisc && !networkBootstrapInProgress) heroDisc.disabled = false;
    toast(t("conn.cleanupFail"), "error", 6000, { desc: t("conn.cleanupFailDesc") });
  } else if (next === "connected") {
    rememberVpnLastState("on");
    if (heroLabel) heroLabel.textContent = t("hero.secured");
    if (heroHint) heroHint.hidden = false;
    setHeroHintText(connectedKicker());
    applyPingDisplay(opts.ping ?? null);
    startSession();
    if (tfDot) tfDot.dataset.live = "true";
    if (heroDisc) heroDisc.setAttribute("aria-label", t("heroAria.disconnect"));
    if (heroDisc && !networkBootstrapInProgress) {
      heroDisc.disabled = false;
      heroDisc.removeAttribute("aria-disabled");
    }
    if (heroMask) heroMask.playbackRate = 1.0;
    if (statsMode) statsMode.textContent = modeLabel(getMode());
    updateStatsServer();
    startTrafficStream();
    // Tracking actually measured traffic of the active source (for the hybrid tile).
    startMeter({
      sourceKey: sourceKeyOf(activeDisplaySource()),
      token: runtimeIdentity.capture(),
      onUpdate: refreshSubCardFromActive,
    });
    if (!activeStrictPrivacyRuntime) startWarpRescanLoop();
    else stopWarpRescanLoop();
    startHealthWatchdog();
    // DNS watchdog: if direct DNS goes down mid-session, it switches to a fallback
    // and reconnects (sing-box will reread DNS from the fresh config).
    if (!activeStrictPrivacyRuntime) {
      startDnsGuard({
        toast,
        isConnected: () => state === "connected",
        onDnsSwitched: () => reconnectForSourceChange(t("dns.reconnect")),
      });
    } else {
      // The strict runtime uses its own fixed IP-hosted DoH.
      // The watchdog reads/changes the saved direct DNS and therefore isn't needed here.
      stopDnsGuard();
    }
    // The probe always goes through the local sing-box inbound: mixed-in (proxy/systemProxy)
    // or probe-in (TUN, the same port). "Direct" isn't allowed in TUN — the Ninety.exe
    // bypass rule would send the probe direct, and the bare channel would be measured instead of the tunnel.
    if (activeStrictPrivacyRuntime) {
      stopQualityEngine("monitoringOff");
      showQualityChip(false);
    } else {
      qualityEngine.onConnected({
        ...loadOptions().quality,
        expectedGeneration: runtimeIdentity.capture()?.processGeneration || null,
      });
      showQualityChip(loadOptions().quality?.enabled !== false);
    }
    updateWarpBadge();
    // Repeating the exclusion after a confirmed connection: the regular path sets
    // it BEFORE the core starts, but adopting someone else's runtime and a node switch
    // by the balancer also come here — there was no early call there.
    try { excludeVpnNode(activeNodeForDisplay()?.host); } catch {}
    // The update endpoints became reachable through the tunnel — finish the check if direct
    // checks didn't go through (with some ISPs gitlab/github are cut when accessed directly).
    updateCheckIfStale();
    // The session resume journal after OTA is one-time: any confirmed
    // connection closes it. Otherwise after a failed auto-resume it lived until
    // the next successful launch and all that time silently disabled regular
    // state backups (backupNow skips the write while it exists).
    try {
      if (localStorage.getItem("ninety.update.resume") != null
          || localStorage.getItem("ninety.dpi.resumeAfterUpdate") != null) {
        void markUpdateRuntimeReady().catch(() => {});
      }
    } catch {}
    // Wizard: connected — move on to the final step.
    if (wizardActive && wizardStepNum === 2) showOnbStep(3);
    maybeAutoLaunchProtectedBrowser();
  }

  syncTrayMenu();
  runtimeIdleGate.notify();
}

// A single ping renderer: the telemetry "Ping" cell + the location card.
// delay > 0 && < 65000 → number + grade; 0/null → "— ms"; >= 65000 → "Timeout"
let lastPingDelay = null;
function applyPingDisplay(delay) {
  lastPingDelay = delay;
  const num = Number(delay);
  let text, grade, valOnly;
  if (!num || num <= 0) { text = `— ${t("units.ms")}`; grade = "dead"; valOnly = "—"; }
  else if (num >= 65000) { text = t("units.timeout"); grade = "dead"; valOnly = "—"; }
  else { text = `${num} ${t("units.ms")}`; grade = gradeDelay(num); valOnly = String(num); }

  if (statsPing) statsPing.textContent = valOnly;
  if (telePing) telePing.dataset.grade = grade;
  if (locPing) locPing.textContent = text;
}

// ── Session (secured telemetry): uptime + accumulated totals ──
// The instant speed lives in the sidebar; here — the total volume for the session.
let sessionTimer = null, sessionStart = 0, sessionDownBytes = 0, sessionUpBytes = 0;
function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}${t("units.hour")} ${String(m).padStart(2, "0")}${t("units.min")}`;
  return `${m}${t("units.min")} ${String(sec).padStart(2, "0")}${t("units.sec")}`;
}
function paintSession() {
  if (statsUptime) statsUptime.textContent = fmtUptime(Math.floor((Date.now() - sessionStart) / 1000));
  if (statsTotal) statsTotal.textContent = `↓ ${fmtTraffic(sessionDownBytes)} · ↑ ${fmtTraffic(sessionUpBytes)}`;
}
function startSession() {
  sessionStart = Date.now();
  sessionDownBytes = 0;
  sessionUpBytes = 0;
  paintSession();
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = setInterval(paintSession, 1000);
}
function stopSession() {
  if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
  if (statsUptime) statsUptime.textContent = "—";
  if (statsTotal) statsTotal.textContent = "↓ 0 · ↑ 0";
  if (statsPing) statsPing.textContent = "—";
  setChannelState("UNKNOWN");
}

// ── real-time WS stream from the clash API ────────────────────────
function applyTrafficValues({ up, down }) {
  if (state !== "connected" || !runtimeIdentity.capture()) return;
  qualityEngine.updatePassive({ down });
  // down/up are bytes/sec; we integrate them into the session totals (tick ≈ 1 s).
  sessionDownBytes += Math.max(0, down) || 0;
  sessionUpBytes += Math.max(0, up) || 0;
  const d = formatRate(down);
  const u = formatRate(up);
  if (tfDown) tfDown.textContent = d.value;
  if (tfUp) tfUp.textContent = u.value;
  if (tfDownUnit) tfDownUnit.textContent = d.unit;
  if (tfUpUnit) tfUpUnit.textContent = u.unit;
}

function applyPingValue({ delay }) {
  if (state !== "connected") return;
  applyPingDisplay(delay);
}

// A click on the "Ping" cell = a forced latency test of the current node.
// On timeout/unreachability we show "Timeout".
let manualTestInFlight = false;
telePing?.addEventListener("click", async () => {
  if (state !== "connected") return;
  if (manualTestInFlight) return;
  manualTestInFlight = true;
  const token = runtimeIdentity.capture();
  telePing.dataset.testing = "true";
  if (statsPing) statsPing.textContent = "···";
  try {
    // A click = a test of the URLTest GROUP (like urlTest("")), not a single
    // /proxies/{name}/delay. The number is read from the effective node's history → matches
    // the node list. Details in refreshEffectiveDelay.
    const { delay } = await refreshEffectiveDelay({ timeoutMs: 5000, token });
    if (runtimeIdentity.isCurrent(token)) applyPingDisplay(delay > 0 ? delay : 65000);
  } catch (e) {
    if (e?.code !== "STALE_RUNTIME") console.warn("manual delay test failed", e);
  } finally {
    delete telePing.dataset.testing;
    manualTestInFlight = false;
  }
});

async function startTrafficStream() {
  const epoch = connectAttempts.current();
  const token = runtimeIdentity.capture();
  if (!token) return;
  try {
    await startClashStream({
      port: token.clashPort,
      token,
      onTraffic: (v) => { if (runtimeIdentity.isCurrent(token)) applyTrafficValues(v); },
      onPing: (v) => { if (runtimeIdentity.isCurrent(token)) applyPingValue(v); },
      onNodeChange: ({ tag }) => {
        if (!runtimeIdentity.isCurrent(token)) return;
        // The effective node actually changed (URLTest reselected or the user chose)
        syncEffectiveFromClash({ knownTag: tag, token });
      },
    });
  } catch (e) {
    console.warn("startClashStream failed", e);
  }
  if (state !== "connected" || !connectAttempts.isCurrent(epoch) || !runtimeIdentity.isCurrent(token)) return;
  // Public IP — deferred (sing-box takes a second to start), then every 5 min
  setTimeout(() => refreshPublicIp(epoch), 2500);
  if (publicIpTimer) clearInterval(publicIpTimer);
  publicIpTimer = setInterval(() => refreshPublicIp(epoch), 5 * 60_000);
}

// Pulls the effective node via clash → updates hero/location/IP.
// If knownTag is passed — we use it (without an extra request to clash).
async function syncEffectiveFromClash({ knownTag, token = runtimeIdentity.capture() } = {}) {
  if (!token || !runtimeIdentity.isCurrent(token)) return;
  let tag = knownTag || null;
  if (!tag) {
    try {
      const data = await getProxies(undefined, { token });
      tag = pickEffectiveNode(data);
    } catch { return; }
  }
  if (!runtimeIdentity.isCurrent(token)) return;
  if (!tag) return;
  const src = getActiveSource();
  if (!src || src.kind !== "sub") return;
  // The outbound tag uses the single formula from singbox.js (nodeTag) so they don't diverge.
  const node = src.nodes.find((n, i) => nodeTag(i, n) === tag);
  if (!node) return;
  onEffectiveNodeChanged(token, tag, node);
}

function onEffectiveNodeChanged(token, tag, node) {
  if (!runtimeIdentity.isCurrent(token) || !node) return false;
  const prevHost = currentEffectiveNode?.host;
  currentEffectiveNode = node;
  currentEffectiveTag = tag;
  updateHeroForActive();
  syncTrayMenu();
  if (state === "connected" && prevHost !== node.host) {
    try { excludeVpnNode(node.host); } catch {}
    // The server actually changed — the IP needs to be reread
    if (locIp) locIp.textContent = "— · —";
    setTimeout(refreshPublicIp, 600);
  }
  return true;
}

// We listen to the event from proxies-view: the user clicked a node / URLTest switched
window.addEventListener("ninety:node-changed", (ev) => {
  const tag = ev.detail?.tag;
  syncEffectiveFromClash({ knownTag: tag });
});

// DPI bypass and the selected node are critical state: besides localStorage we immediately
// update the disk snapshot. Otherwise after clearing WebView2 the previous DPI flag
// or an old "auto" could be restored.
window.addEventListener("ninety:dpi-changed", () => {
  syncTrayMenu();
  void backupNow();
});
window.addEventListener("ninety:proxy-selection-saved", () => { void backupNow(); });

// ── Tray — moved to /lib/tray.js; here only the main state context ──
// Declared in advance (before initTray and bootstrap): getUpdateVersion reads
// pendingUpdate already at startup — if we left the let in the Auto-update section below,
// the first syncTrayMenu would fail in the TDZ.
let pendingUpdate = null;
// Declared next to pendingUpdate: the first bootstrap syncTrayMenu reads this
// flag before the Auto-update section at the bottom of the file.
let updateInstalling = false;
initTray({
  getState: () => state,
  getEffectiveTag: () => currentEffectiveTag,
  getUpdateVersion: () => pendingUpdate?.version || null,
  isUpdateBusy: () => updateInstalling,
  isStrictPrivacy: strictPrivacyRequested,
  onSetMode: (m) => changeMode(m),
  onToggleVpn: () => handleConnectionIntent(),
  onUpdateClick: () => flushPendingUpdate(),
  // A minimized window gets neither focus nor online — until the icon is hovered
  // the only source of checks is the schedule. A one-minute threshold keeps
  // an accidental mouse pass over the tray from poking the endpoints.
  onTrayActivity: () => updateCheckIfStale(60_000),
  // "All servers…" from the tray: the window is already shown by the Rust handler, what's left is
  // to open the list screen — that's where search and the full node set are.
  onOpenServers: () => switchView("proxies"),
  // A successful server choice from the tray: update the effective node + hero/location.
  onServerSelected: (tag, _node, { reconnect = false } = {}) => {
    if (reconnect) reconnectForSourceChange(t("conn.applyingSettings"));
    else syncEffectiveFromClash({ knownTag: tag });
  },
});

function runtimeSnapshotMatchesExpected(snapshot, source = activeDisplaySource()) {
  const options = loadOptions();
  const strictPrivacyExpected = !!options.privacy?.strictTunnel;
  let expectedPinnedNodeTag = null;
  if (strictPrivacyExpected) {
    const nodes = source?.kind === "sub"
      ? (source.nodes || [])
      : source?.kind === "single" && source.profile
        ? [source.profile]
        : [];
    try {
      expectedPinnedNodeTag = selectStrictPrivacyCandidate(
        nodes.map((node, index) => ({ tag: nodeTag(index, node), value: node })),
        getRememberedProxySelection(source),
      ).tag;
    } catch {
      return false;
    }
  }
  const killSwitchExpected = strictPrivacyExpected
    || (!!options.general?.killSwitch && getMode() !== "tun");
  return !!snapshot?.running
    && snapshot.clashReady === true
    && runtimeEndpointMatchesGeneration(snapshot)
    && snapshot.sourceFingerprint === sourceFingerprint(source)
    && snapshot.mode === getMode()
    && snapshot.strictPrivacy === strictPrivacyExpected
    && typeof snapshot.controlEndpoint?.address === "string"
    && (strictPrivacyExpected || typeof snapshot.probeProxyEndpoint?.address === "string")
    && (!strictPrivacyExpected || snapshot.pinnedNodeTag === expectedPinnedNodeTag)
    && runtimeSnapshotReadyForMode(snapshot, getMode())
    && (killSwitchExpected
      ? snapshot.killSwitchActive === true
      : snapshot.killSwitchActive !== true);
}

function finalizeConnected(snapshot, {
  epoch,
  source = activeDisplaySource(),
  token,
} = {}) {
  if (!isCurrentNetworkIntent(epoch, "connected")) return false;
  if (!runtimeSnapshotMatchesExpected(snapshot, source)) return false;
  if (token && !runtimeIdentity.isCurrent(token)) return false;
  runtimeIdentity.adopt(snapshot, { source });
  runtimeSnapshotCache = snapshot;
  activeStrictPrivacyRuntime = snapshot.strictPrivacy === true;
  strictFailClosedLatched = snapshot.strictPrivacy === true;
  ordinaryFailClosedLatched = snapshot.strictPrivacy !== true
    && !!loadOptions().general?.killSwitch
    && snapshot.mode !== "tun"
    && snapshot.killSwitchActive === true;
  setState("connected", { ping: null });
  return true;
}

function adoptRuntimeSnapshot(snapshot, source = activeDisplaySource(), context = {}) {
  const adopted = finalizeConnected(snapshot, { ...context, source });
  // A WebView reload doesn't kill the WFP session: the previous attempt's barrier may have
  // survived it and stayed on top of the adopted live runtime.
  if (adopted) void releaseTransitionBarrier(snapshot?.processGeneration);
  return adopted;
}

async function connectNetwork({ epoch = networkIntentEpoch, operationToken = null } = {}) {
  if (!isCurrentNetworkIntent(epoch, "connected")) return false;
  if (state !== "idle") return state === "connected";
  const stopCurrentOperation = () => invoke(
    "stop_singbox",
    operationToken ? { operationToken } : {},
  );
  // Click ripple — spreads from the center of the disc (anim 520 ms). The disc may not exist
  // (autostart got here before the markup, someone else's view) — a decoration has no
  // right to break the connection.
  const stage = heroDisc?.closest(".hero__stage");
  if (stage) {
    const ripple = document.createElement("div");
    ripple.className = "hero__ripple";
    stage.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }
  if (state === "idle") {
    // Fail-safe against startup reconcile/autoconnect races: idle UI does not
    // imply an idle backend. A running snapshot means this click is a user
    // disconnect intent, never a second start_singbox.
    let observed;
    try {
      observed = await invoke("runtime_snapshot");
    } catch (e) {
      console.warn("runtime snapshot before start failed", e);
      // This branch also shows "failed to disconnect", but goes neither through
      // stop nor through the start catch — without a record it would look in the log like
      // a confirmed stop followed by nothing.
      logSourceSwitchReconnect("preflight", operationToken, "failed", "runtime_snapshot_unavailable");
      setState("cleanup_error", {
        preserveKillSwitch: killSwitchMustSurviveRuntimeStop(),
      });
      return false;
    }
    if (!isCurrentNetworkIntent(epoch, "connected")) return false;
    restoreFailClosedLatch(observed);
    if (observed?.running) {
      if (await runtimeSnapshotIsLive(observed)
        && adoptRuntimeSnapshot(observed, activeDisplaySource(), { epoch })) return true;
      await shutdownRuntimeForPolicyReplacement(observed);
      return false;
    }
    if (getMode() === "tun") {
      const elevated = await ensureElevatedForTun({ connect: true });
      if (!elevated) return false;
    }
    if (!isCurrentNetworkIntent(epoch, "connected")) return false;
    const src = getActiveSource();
    const savedOptions = loadOptions();
    const strictPrivacy = !!savedOptions.privacy?.strictTunnel;
    const runtimeSource = src || activeDisplaySource();
    const preparedRuntime = strictPrivacy
      ? prepareStrictPrivacyRuntime({
          options: savedOptions,
          selectedNodeTag: getRememberedProxySelection(runtimeSource),
        })
      : {
          mode: getMode(),
          options: savedOptions,
          runtimePolicy: null,
        };
    const { mode, options, runtimePolicy } = preparedRuntime;
    const warpOnly = !strictPrivacy && !src && warpOnlyEnabled();
    if (!src && !warpOnly) { toast(t("conn.needSource"), "error"); return false; }
    // Ownership of the attempt is captured BEFORE the first await: the DNS/WARP/port preflight
    // no longer leaves state=idle, so a second click cancels this attempt
    // rather than starting a parallel start_singbox.
    const attemptEpoch = connectAttempts.begin();
    let connectStage = "preflight";
    // The "outbound → node" map is already needed in catch: the core refusal is parsed with it
    // «initialize outbound[N]».
    let outboundNodes = null;
    let endpointNodes = null;
    setState("connecting");
    try {
      if (strictPrivacy) {
        const preflightProtected = await applyKillSwitch(true, { phase: "preconnect" });
        if (!preflightProtected) {
          const error = new Error("строгий WFP не подтвердил fail-closed preflight");
          error.code = "STRICT_PRIVACY_GUARD_FAILED";
          throw error;
        }
        ordinaryFailClosedLatched = false;
        strictFailClosedLatched = true;
        startHealthWatchdog();
      }
      // DNS watchdog: the node's server name is resolved via direct DNS BEFORE the tunnel —
      // if it's dead (Google/Cloudflare DoH in Russia), the start fails with a vague
      // "i/o timeout". We probe and on failure switch to a fallback BEFORE buildConfig,
      // so that the config is built with a working resolver. Only while the user hasn't left.
      // The Kill Switch transitional barrier doesn't let Ninety.exe itself out: the probe would see
      // all resolvers as dead and raise a false alarm with a watchdog pause.
      if (!strictPrivacy && !killSwitchMustSurviveRuntimeStop()) {
        await ensureWorkingDirectDns({
          toast,
          onlyIf: () => state === "connecting" && connectAttempts.isCurrent(attemptEpoch),
        });
      }
      if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch) || state !== "connecting") return false;
      // If WARP is enabled — pull the registration from the writable config dir/warp.json
      // and pass it to the builder. Without warpInfo the builder silently skips the warp endpoint.
      let warpInfo = null;
      if (options.warp?.enabled) {
        try { warpInfo = await invoke("warp_status"); } catch {}
        if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch) || state !== "connecting") return false;
        if (!warpInfo) {
          // A reconnect on top of a saved Kill Switch also comes here: a bare
          // idle would remove the barrier, and traffic would go direct.
          setState("idle", { preserveKillSwitch: killSwitchMustSurviveRuntimeStop() });
          toast(t("conn.warpUnreg"), "error", 3500);
          return false;
        }
      }
      // Loopback bridge ports (xhttp/naive/TT): the default 31100+ bases may be
      // taken by a foreign process — Rust picks free ranges with a bind probe.
      // A planning error doesn't block the start: the builder falls back to the static
      // defaults, and a busy port is caught by fail-fast in start_singbox.
      let bridgePorts = null;
      const needs = bridgeNeeds(src ? (src.kind === "sub" ? src.nodes : [src.profile]) : []);
      if (needs.xray || needs.naive || needs.trusttunnel) {
        try { bridgePorts = await invoke("plan_bridge_ports", { needs }); }
        catch (e) { console.warn("plan_bridge_ports failed", e); }
        if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch) || state !== "connecting") return false;
      }
      // Whether the system supports IPv6 at all. Needed only in TUN: there the core assigns
      // an address to the interface, and on a machine with IPv6 disabled in Windows the whole
      // TUN mode failed entirely ("set ipv6 address: Element not found").
      // The probe is local and synchronous, doesn't touch the network. An error doesn't block
      // the start: the builder reads undefined as "don't know" and keeps
      // today's behavior with the IPv6 address.
      // IP forwarding on the external adapter loops TUN (#168). The start doesn't
      // wait for it and doesn't depend on it — we only warn.
      if (mode === "tun") void warnAboutForwarding();
      let systemIpv6;
      if (mode === "tun") {
        try { systemIpv6 = await invoke("system_ipv6_available"); }
        catch (e) { console.warn("system_ipv6_available failed", e); }
        if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch) || state !== "connecting") return false;
      }
      // Two-core: xhttp nodes go into the xray bridge (config.xray), sing-box gets
      // a socks redirect. xray=null when the source has no xhttp.
      const {
        config,
        xray,
        sidecars,
        outboundNodes: builtOutboundNodes,
        endpointNodes: builtEndpointNodes,
        runtime: runtimeInfo,
      } = buildConfig({
        source: src,
        mode,
        options,
        runtimePolicy,
        warpInfo,
        xray: true,
        bridgePorts,
        systemIpv6,
      });
      outboundNodes = builtOutboundNodes;
      endpointNodes = builtEndpointNodes;
      const configJson = JSON.stringify(config);
      // The active node's server goes into winws exclude BEFORE the core starts. Previously
      // the exclusion was set only upon connected, i.e. after
      // the first TLS/VLESS handshake to the server: that's exactly what winws could
      // mangle, and the symptom looked like "the first connect doesn't come up".
      // We don't consider the error fatal: DPI bypass may be off altogether.
      try { await excludeVpnNode(activeNodeForDisplay()?.host); } catch {}
      if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch) || state !== "connecting") return false;
      let runtimeToken = runtimeIdentity.begin({
        source: runtimeSource, mode: runtimeInfo.mode, configJson,
        clashPort: runtimeInfo.options.experimental?.clashApiPort || 9090,
      });
      connectStage = "runtime_start";
      const runtimeSnapshot = await coreStartBarrier.track(invoke("start_singbox", {
        configJson,
        mode: runtimeInfo.mode,
        xrayJson: xray ? JSON.stringify(xray) : null,
        // naive/trusttunnel clients (one per node); null when there are no such nodes.
        sidecarsJson: sidecars && sidecars.length ? JSON.stringify(sidecars) : null,
        // "Disable logs completely" → Rust doesn't write files for any component.
        logsDisabled: !!runtimeInfo.options.log?.disabled,
        sourceFingerprint: runtimeToken.sourceFingerprint,
        configHash: runtimeToken.configHash,
        strictPrivacy: !!runtimeInfo.strictPrivacy,
        pinnedNodeTag: runtimeInfo.pinnedNodeTag,
        operationToken,
      }));
      if (!runtimeSnapshot?.running || !Number(runtimeSnapshot.processGeneration)) {
        throw new Error("start_singbox не вернул подтверждённый runtime snapshot");
      }
      // While the core was starting (bridge settle pauses), the user may have pressed "Disconnect":
      // that click finds child=None and has nothing to kill. We catch the cancellation by epoch
      // and stop the just started core — otherwise the UI blinked "disconnected" and
      // went back to "Protected".
      if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch)) {
        try { await stopCurrentOperation(); } catch {}
        try { await disableSystemProxy(invoke); } catch {}
        return false;
      }
      // The backend is the source of truth for processGeneration: the local
      // token is needed only to pass the expected identity to start_singbox,
      // after the actual check we work with the confirmed Rust snapshot.
      runtimeToken = runtimeIdentity.adopt(runtimeSnapshot, { source: runtimeSource });
      connectStage = "topology";
      const topologyReadiness = await waitForMatchingSourceTopology({
        read: () => getProxies(undefined, { token: runtimeToken, fresh: true }),
        matches: topology => runtimeInfo.strictPrivacy || warpOnly
          || snapshotMatchesSource(topology, nodesFromSource()),
        isCurrent: () => isCurrentNetworkIntent(epoch, "connected")
          && connectAttempts.isCurrent(attemptEpoch)
          && runtimeIdentity.isCurrent(runtimeToken),
      });
      if (topologyReadiness.status === "stale") {
        try { await stopCurrentOperation(); } catch {}
        return false;
      }
      if (topologyReadiness.status !== "ready") {
        const error = new Error("Clash topology не успела подтвердить активный источник");
        error.code = topologyReadiness.reason === "clash_api_error"
          ? "SOURCE_TOPOLOGY_API_UNAVAILABLE"
          : "SOURCE_TOPOLOGY_NOT_READY";
        throw error;
      }
      const topology = topologyReadiness.topology;
      connectStage = "selection";
      if (runtimeInfo.strictPrivacy) {
        const pinned = runtimeSource?.kind === "sub"
          ? runtimeSource.nodes?.find((node, index) => nodeTag(index, node) === runtimeInfo.pinnedNodeTag)
          : runtimeSource?.profile;
        currentEffectiveNode = pinned || null;
        currentEffectiveTag = runtimeInfo.pinnedNodeTag;
      } else {
        const restoredSelection = await restoreRememberedProxySelection({
          source: runtimeSource,
          topology,
          apply: (tag) => selectProxy("proxy", tag, { token: runtimeToken, closeConnections: false }),
          isCurrent: () => runtimeIdentity.isCurrent(runtimeToken)
            && isCurrentNetworkIntent(epoch, "connected")
            && connectAttempts.isCurrent(attemptEpoch),
        });
        if (restoredSelection.status === "stale") {
          await shutdownCore({
            preserveKillSwitch: killSwitchMustSurviveRuntimeStop(),
            operationToken,
          });
          return false;
        }
        if (restoredSelection.status === "reset") {
          const reason = restoredSelection.reason || "remembered_selection_reset";
          console.warn("remembered proxy selection reset", reason);
          if (operationToken?.kind === "sourceSwitch") {
            logSourceSwitchReconnect("selection", operationToken, "reset", reason);
          }
        }
        // Fatal only when the selector has no explicit automatic recovery
        // route. Ordinary mode never substitutes an arbitrary child node.
        if (restoredSelection.status === "unavailable") {
          const error = new Error("Active selector has no valid recovery route");
          error.code = "SELECTION_POLICY_UNAVAILABLE";
          throw error;
        }
      }
      // The system proxy is set ONLY for mode=systemProxy. For bare
      // "proxy" the user configures the HTTP/SOCKS client themselves, for "tun" there's already
      // full interception through the TUN interface.
      connectStage = "system_proxy";
      if (mode === "systemProxy") {
        const probeHostPort = runtimeSnapshot.probeProxyEndpoint?.address;
        if (typeof probeHostPort !== "string" || !probeHostPort) {
          throw new Error("runtime snapshot не содержит probe endpoint для system proxy");
        }
        await enableSystemProxy(invoke, {
          hostPort: probeHostPort,
          bypassLan: options.route?.bypassLan !== false,
          expectedGeneration: runtimeSnapshot.processGeneration,
          operationToken,
        });
        if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch)) {
          try { await disableSystemProxy(invoke); } catch {}
          try { await stopCurrentOperation(); } catch {}
          return false;
        }
      }
      if (!isCurrentNetworkIntent(epoch, "connected") || !runtimeIdentity.isCurrent(runtimeToken)) {
        await shutdownCore({
          preserveKillSwitch: killSwitchMustSurviveRuntimeStop(),
          operationToken,
        });
        return false;
      }
      // On proxy→TUN the old ordinary barrier lived until TUN was fully ready.
      // We stop the guard-only watcher before the final disarm: stop invalidates
      // the snapshot in flight, and an already queued rearm is serialized before the next
      // apply and therefore can't remain the last operation.
      const retiringOrdinaryBarrier = ordinaryFailClosedLatched
        && !runtimeInfo.strictPrivacy
        && mode === "tun";
      if (retiringOrdinaryBarrier) stopHealthWatchdog();
      // The kill switch is part of readiness, not a background best-effort after connected.
      connectStage = "kill_switch";
      const killSwitchReady = await applyKillSwitch(true);
      if (!isCurrentNetworkIntent(epoch, "connected") || !runtimeIdentity.isCurrent(runtimeToken)) {
        try { await stopCurrentOperation(); } catch {}
        return false;
      }
      if (killSwitchReady === false) {
        const error = new Error("WFP readiness не подтверждена");
        if (runtimeInfo.strictPrivacy) error.code = "STRICT_PRIVACY_GUARD_FAILED";
        throw error;
      }
      ordinaryFailClosedLatched = !runtimeInfo.strictPrivacy
        && !!loadOptions().general?.killSwitch
        && getMode() !== "tun";
      // A failure of the final check with a LIVE intent is a start failure: we throw
      // into catch (shutdownCore → idle + toast). A silent stop left the UI forever
      // in "connecting" with the core already stopped. We exit silently only on cancellation —
      // the status was set for the user by their own click.
      connectStage = "final_snapshot";
      let finalSnapshot;
      try { finalSnapshot = await invoke("runtime_snapshot"); }
      catch (e) {
        if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch)) {
          try { await stopCurrentOperation(); } catch {}
          return false;
        }
        throw new Error(`финальный runtime snapshot не получен: ${e}`, { cause: e });
      }
      connectStage = "endpoint_verification";
      if (!(await runtimeSnapshotIsLive(finalSnapshot, runtimeSource))) {
        throw new Error("финальный runtime endpoint не прошёл live-проверку");
      }
      connectStage = "finalize";
      const connected = completeSuccessfulConnect({
        finalizeConnected: () => finalizeConnected(finalSnapshot, {
          epoch,
          source: runtimeSource,
          token: runtimeToken,
        }),
        onConnected: () => {
          const src0 = activeDisplaySource();
          const isMultiSub = !runtimeInfo.strictPrivacy
            && src0?.kind === "sub"
            && Array.isArray(src0.nodes)
            && src0.nodes.length >= 2;
          // An in-app toast right away. For a subscription the balancer hasn't chosen the node yet —
          // we show the subscription name (not lying with a specific server), then
          // notifyConnectedWithRealNode will follow up the toast with the actual server. For
          // a single profile — its name right away.
          const initLabel = isMultiSub
            ? (src0.subscription?.name || t("conn.subFallback"))
            : nodeDisplayLabel(activeNodeForDisplay());
          toast(t("conn.protected"), "connected", 2200, {
            group: "conn",
            desc: initLabel || t("conn.tunnelUp"),
          });
          syncTrayMenu(); // tray → "Disconnect" (for a sub it will be updated once more after sync)
          // Effective node + an OS notification with the actual server's name (inside it
          // does syncEffectiveFromClash → updates hero/location/tray).
          notifyConnectedWithRealNode(isMultiSub);
        },
      });
      if (!connected) {
        if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch)
          || !runtimeIdentity.isCurrent(runtimeToken)) {
          try { await stopCurrentOperation(); } catch {}
          return false;
        }
        throw new Error("финальный runtime snapshot не прошёл проверку готовности");
      }
      await releaseTransitionBarrier(finalSnapshot.processGeneration);
      return true;
    } catch (e) {
      if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch)) {
        // The user has already cancelled the connection — the state/toasts were set by their click,
        // here only a safety stop without overwriting the UI.
        try { await stopCurrentOperation(); } catch {}
        try { await disableSystemProxy(invoke); } catch {}
        return false;
      }
      console.error("start failed", e);
      // Diagnostics of a failed start used to be written only for a source
      // switch. A mode change reconnects with the qualityRemediation token,
      // so its failure left nothing in the log: after a confirmed
      // stop the log just broke off, while an error appeared on screen. The stage and
      // code are needed for any operation, including a reconnect with no token at all.
      const code = safeSourceSwitchReason(e?.code || e?.name || "error");
      logSourceSwitchReconnect("connect", operationToken, "failed", `${connectStage}_${code}`);
      const preserveGuard = killSwitchMustSurviveRuntimeStop();
      const cleaned = await shutdownCore({
        preserveKillSwitch: preserveGuard,
        operationToken,
      });
      if (!cleaned) {
        // With BFE unavailable we don't stop a still live runtime without a barrier.
        // We exit the endless connecting into a recoverable error; setState also
        // queues the preserve-reconcile once more. An explicit disconnect stays
        // available to the user and removes the session-scoped policy.
        if (state !== "cleanup_error") {
          setState("cleanup_error", { preserveKillSwitch: preserveGuard });
        }
        return false;
      }
      // The core refused to bring up a specific outbound — so the node has a parameter
      // the static checks don't know yet. The core named the index itself:
      // we disable this node and say which one exactly, instead of "start failed".
      const rejected = matchCoreOutboundRejection(
        `${e?.message || ""}\n${e || ""}`,
        outboundNodes,
        endpointNodes,
      );
      if (rejected) {
        quarantineNode(rejected.node, rejected.reason);
        runtimeIdentity.invalidate();
        refreshProfilesSummary();
        toast(t("conn.nodeRejected", { name: nodeDisplayLabel(rejected.node) }), "warn", 8000, {
          desc: `${rejected.reason} · ${t("conn.nodeRejectedDesc")}`,
        });
        return false;
      }
      if (e?.code === "STRICT_PRIVACY_NODE_REQUIRED") {
        toast(t("privacyToast.nodeRequired"), "warn", 6000);
        switchView("proxies");
      } else if (e?.code === "STRICT_PRIVACY_NODE_UNAVAILABLE") {
        toast(t("privacyToast.nodeUnavailable"), "error", 6000);
        switchView("proxies");
      } else if (e?.code === "STRICT_PRIVACY_BOOTSTRAP_UNSAFE") {
        toast(t("privacyToast.nodeUnavailable"), "error", 7500, {
          desc: t("privacyToast.bootstrapUnsafe"),
        });
        switchView("proxies");
      } else {
        toast(t("conn.startFail"), "error", 4500, { desc: t("conn.startFailDesc") });
        switchView("logs");
      }
    }
  }
  return false;
}

let connectionIntentInFlight = null;
// A newer intent (reconnect, source switch) may take ownership right
// in the middle of a disconnect. The state must then be closed by whoever set it:
// by this point the runtime has been confirmedly stopped, and "disconnecting" is awaited
// by both the hero disc and runtimeIdleGate — without idle the reconnect queue hangs forever, and
// the UI gets unstuck only with the user's next click.
function finalizeStoppedRuntime() {
  if (state === "disconnecting") setState("idle");
  return false;
}

async function disconnectNetwork({ epoch, userInitiated = false } = {}) {
  cancelPendingReconnect();
  // Manual disconnect is the highest-priority lifecycle intent.  Cancel the
  // source transaction itself so a late target/rollback completion cannot
  // re-arm reconnect after the verified stop.
  sourceSwitchController?.cancel?.();
  connectAttempts.cancel();
  const lateStart = coreStartBarrier.isPending();
  if (!(await shutdownCore({ finalize: false }))) return false;
  if (lateStart) {
    await coreStartBarrier.wait();
    // A late start may have brought up the core — we stop it in any case, even
    // if the intent has already changed. Previously there was a bare return false here:
    // the state stayed "Disconnecting…", and the reconnect queue waited for idle
    // forever. It can be released only after a confirmed stop.
    if (!(await shutdownCore({ finalize: false }))) return false;
  }
  if (!isCurrentNetworkIntent(epoch, "idle")) return finalizeStoppedRuntime();
  let snapshot = null;
  let snapshotConfirmed = false;
  try { snapshot = await invoke("runtime_snapshot"); snapshotConfirmed = true; }
  catch (e) { console.warn("disconnect snapshot failed", e); }
  if (snapshot?.running || snapshot?.starting) {
    if (!(await shutdownCore({ finalize: false }))) return false;
    try { snapshot = await invoke("runtime_snapshot"); snapshotConfirmed = true; }
    catch { snapshot = null; snapshotConfirmed = false; }
  }
  if (!snapshotConfirmed || snapshot?.running || snapshot?.starting || !isCurrentNetworkIntent(epoch, "idle")) {
    setState("cleanup_error");
    return false;
  }
  // A manual "Disconnect" must confirm not only the runtime's death but also
  // the release of the WFP lease. Otherwise the UI would show idle, the watchdog would already be silent,
  // while the saved Rust session kept blocking the whole computer.
  const killSwitchReleased = await applyKillSwitch(false);
  // An unreleased lease matters more than someone else's intent: whoever's step is next,
  // WFP still blocks the whole computer, and this state must be shown.
  if (!killSwitchReleased) {
    setState("cleanup_error", {
      preserveKillSwitch: killSwitchMustSurviveRuntimeStop(),
    });
    return false;
  }
  if (!isCurrentNetworkIntent(epoch, "idle")) return finalizeStoppedRuntime();
  strictFailClosedLatched = false;
  ordinaryFailClosedLatched = false;
  setState("idle");
  if (userInitiated) {
    rememberVpnLastState("off");
    protectedBrowserAutoLaunched = false;
    toast(t("conn.disconnected"), "info", 2000, { group: "conn", desc: t("conn.disconnectedDesc") });
    notify(t("conn.notifyDisconnected"), t("conn.notifyDisconnectedBody"));
  }
  return true;
}

async function userToggleNetwork(onResolvedKind) {
  const epoch = beginNetworkIntent("idle");
  let snapshot = null;
  try { snapshot = await invoke("runtime_snapshot"); } catch (e) { console.warn("toggle snapshot failed", e); }
  // A repeated click may have already replaced the intent while runtime_snapshot was in IPC.
  // The old toggle then has no right to start yet another disconnect on its own.
  if (!isCurrentNetworkIntent(epoch, "idle")) return false;
  // connectionIntentInFlight must NOT be included here: handleConnectionIntent
  // assigns it the promise of THIS very call before we wake up after
  // await runtime_snapshot — the check saw itself, backendActive was
  // always true, and the "Connect" click deterministically went into disconnect.
  // Concurrent clicks are cut off by the in-flight guard in handleConnectionIntent.
  const backendActive = snapshot?.running === true
    || snapshot?.starting === true
    || coreStartBarrier.isPending()
    || reconnectQueue.isRunning()
    || state !== "idle";
  if (backendActive || needsReconnect) {
    onResolvedKind?.("disconnect");
    return disconnectNetwork({ epoch, userInitiated: true });
  }
  onResolvedKind?.("connect");
  const connectEpoch = beginNetworkIntent("connected");
  return connectNetwork({ epoch: connectEpoch });
}

async function handleConnectionIntent({ internal = false } = {}) {
  if (!internal && networkBootstrapInProgress) return;
  if (connectionIntentInFlight) {
    const repeatedAction = repeatedConnectionIntentAction({
      internal,
      inFlightKind: connectionIntentInFlight.kind,
      state,
    });
    if (repeatedAction === "join") {
      return connectionIntentInFlight.promise;
    }
    // A repeated click cancels only the launch. A repeated click during an already
    // running disconnect joins the same Promise and doesn't create a second
    // stop_singbox on top of the first.
    const epoch = beginNetworkIntent("idle");
    const run = disconnectNetwork({ epoch, userInitiated: true });
    const intent = { kind: "disconnect", promise: run };
    connectionIntentInFlight = intent;
    try {
      return await run;
    } finally {
      if (connectionIntentInFlight === intent) connectionIntentInFlight = null;
    }
  }
  const intent = {
    kind: (state === "idle" && !needsReconnect) ? "connect" : "disconnect",
    promise: null,
  };
  const run = userToggleNetwork((kind) => { intent.kind = kind; });
  intent.promise = run;
  connectionIntentInFlight = intent;
  try {
    return await run;
  } finally {
    if (connectionIntentInFlight === intent) connectionIntentInFlight = null;
  }
}

async function runtimeSnapshotIsLive(snapshot, source = activeDisplaySource()) {
  if (!runtimeSnapshotMatchesExpected(snapshot, source)) return false;
  try {
    const verified = await invoke("verify_runtime_endpoint", {
      expectedGeneration: Number(snapshot.processGeneration),
      expectedEndpoint: snapshot.probeProxyEndpoint?.address || null,
    });
    return runtimeSnapshotMatchesExpected(verified, source)
      && Number(verified.processGeneration) === Number(snapshot.processGeneration)
      && verified.probeProxyEndpoint?.address === snapshot.probeProxyEndpoint?.address;
  } catch {
    return false;
  }
}

heroDisc?.addEventListener("click", () => handleConnectionIntent());

// ── Bootstrap ──────────────────────────────────────────────
// All module lets are already declared — the "Ready" line can read the source and the node.
homeReadyBooted = true;
updateHomeReady();
if (locPing) locPing.textContent = `— ${t("units.ms")}`;
window.addEventListener("ninety:profile-store-ready", (ev) => {
  refreshProfilesSummary();
  syncTrayMenu();
  // The main storage copy couldn't be read, the data was loaded from .bak — it
  // may be older. The user must know about this.
  if (ev?.detail?.source === "backup") {
    toast(t("store.recoveredTitle"), "warn", 9000, {
      group: "profile-store",
      desc: t("store.recoveredDesc"),
    });
  }
});

// A failure of the protected profile storage used to be visible only in the WebView
// console: the app kept working, changes lived in memory, and the user learned
// that they wouldn't survive a restart from the missing profiles.
// One message per session — failure stages come in a batch, there's no reason to spam.
// The same logic for the state backup: three failures in a row mean that
// there will be nothing to restore after losing the WebView2 profile.
let stateBackupErrorShown = false;
window.addEventListener("ninety:state-backup-error", (ev) => {
  console.warn("state backup unhealthy:", ev?.detail?.failures, ev?.detail?.reason);
  if (stateBackupErrorShown) return;
  stateBackupErrorShown = true;
  toast(t("store.backupErrorTitle"), "warn", 9000, {
    group: "state-backup",
    desc: t("store.backupErrorDesc"),
  });
});

let profileStoreErrorShown = false;
window.addEventListener("ninety:profile-store-error", (ev) => {
  const stage = ev?.detail?.stage || "";
  console.warn("profile store error:", stage, ev?.detail?.code || "");
  // The storage is fine, there's just more data than the limit: we say exactly that, and
  // every time — the user may retry the action.
  if (ev?.detail?.code === "too_large") {
    toast(t("store.tooLargeTitle"), "error", 12000, {
      group: "profile-store-size",
      desc: t("store.tooLargeDesc"),
    });
    return;
  }
  if (profileStoreErrorShown) return;
  profileStoreErrorShown = true;
  toast(t("store.errorTitle"), "error", 9000, {
    group: "profile-store",
    desc: t("store.errorDesc"),
  });
  notify(t("store.errorTitle"), t("store.errorDesc"));
});
// Portable after the broken 0.15.0–0.16.0 update: the backend has already returned
// the program to the original folder and the settings to their place — we report it once.
invoke("portable_repair_report")
  .then((report) => {
    if (!report) return;
    const desc = report.recovered
      ? t("portableRepair.descRecovered", { folder: report.recovered })
      : t("portableRepair.desc");
    toast(t("portableRepair.title"), "info", 15000, { group: "portable-repair", desc });
  })
  .catch(() => {});
refreshProfilesSummary();
updateHeroHint();
syncTrayMenu();

// Subscription updates go through the tunnel when it's up (mixed-in, in TUN —
// probe-in on the same port): the panel doesn't see the real IP. If it didn't work through the proxy,
// subscriptions.js retries directly.
setSubscriptionProxy(() =>
  state === "connected" && runtimeProbeHostPort()
    ? `http://${runtimeProbeHostPort()}`
    : null
);

setSubscriptionTunnelTransit(() => state === "connecting" || state === "disconnecting");

// ── State backup (localStorage → writable config dir) ────
// Mutations are backed up at specific points (backupSoon in refreshProfilesSummary/settings);
// a periodic tick covers keys that change outside these points
// (traffic-meter, quality engine learning, etc.).
setTimeout(backupNow, 15_000);
setInterval(backupNow, 10 * 60_000);

async function reconcileNetworkRuntime() {
  try {
    const snapshot = await invoke("runtime_snapshot");
    restoreFailClosedLatch(snapshot);
    if (!snapshot?.running) return;
    const source = activeDisplaySource();
    if (await runtimeSnapshotIsLive(snapshot, source)) {
      const epoch = beginNetworkIntent("connected");
      adoptRuntimeSnapshot(snapshot, source, { epoch });
      return;
    }
    // The old runtime doesn't match the current source/mode: first we
    // confirmedly stop it, then autostart decides whether a new launch is needed.
    if (!(await shutdownRuntimeForPolicyReplacement(snapshot))) {
      throw new Error("не удалось очистить старый runtime");
    }
  } catch (e) {
    console.warn("startup runtime reconcile failed", e);
    let retrySnapshot = null;
    try {
      retrySnapshot = await invoke("runtime_snapshot");
      if (retrySnapshot?.running) console.warn("startup snapshot retry still running; stopping runtime");
    } catch (retryError) {
      console.warn("startup runtime snapshot retry failed", retryError);
    }
    try {
      const cleaned = await shutdownRuntimeForPolicyReplacement(retrySnapshot);
      if (!cleaned) {
        console.warn("startup runtime cleanup not confirmed");
        setState("cleanup_error", {
          preserveKillSwitch: killSwitchMustSurviveRuntimeStop(),
        });
      }
    } catch (cleanupError) {
      console.warn("startup runtime cleanup failed", cleanupError);
      setState("cleanup_error", {
        preserveKillSwitch: killSwitchMustSurviveRuntimeStop(),
      });
    }
  }
}

// startMinimized: on a manual launch hide the window if the option is on.
// (With --autostarted Rust has already hidden the window in setup() — repeating it here is harmless.)
(async () => {
  try {
    const opts = loadOptions();
    if (opts.general?.startMinimized && tauriWin?.hide) {
      await tauriWin.hide();
    }
  } catch {}
})();

// Auto-start after reconcile: on autostart via Windows login
// (--autostarted) OR on a restart requested by the connection
// (--connect), we bring up the VPN with the last server. DPI bypass is brought up if
// it was enabled — and without the VPN if nobody asked to connect. Elevation is done with ONE
// restart: TUN mode and DPI require admin rights; if the process isn't
// elevated yet and any of them is needed — a silent relaunch_elevated.
async function autostartNetworkRuntime() {
    // After an OTA update the process restarts WITHOUT --autostarted/--connect, and
    // should_autoconnect=false → the block wouldn't be entered. Before installing update-modal
    // writes what was up (ninety.update.resume = {vpn,dpi}) — we use it
    // to restore the session. The legacy key ninety.dpi.resumeAfterUpdate was written by versions
    // ≤0.1.88 (DPI only); we still read it for a release or two with the old semantics.
    const resume = (() => {
      try {
        const raw = localStorage.getItem("ninety.update.resume");
        if (raw) {
          const journal = JSON.parse(raw);
          return journal?.schemaVersion === 2
            ? { ...journal.desired, journal }
            : journal;
        }
        return localStorage.getItem("ninety.dpi.resumeAfterUpdate") === "1"
          ? { vpn: true, dpi: true }
          : null;
      } catch { return null; }
    })();
    const launchAutoconnect = await invoke("should_autoconnect");
    // A regular launch: connecting per the "On launch" setting. Autostart at
    // Windows sign-in and a restart for connecting decide on their own (the flags above).
    const settingAutoconnect = !launchAutoconnect && !resume?.vpn && startupConnectRequested({
      setting: loadOptions()?.general?.startupConnect,
      lastState: (() => {
        try { return localStorage.getItem(STORAGE_KEYS.vpnLastState); } catch { return null; }
      })(),
    });
    const autoconnect = launchAutoconnect || settingAutoconnect;
    // TUN without rights: we don't show a UAC window for a single launch setting —
    // this session connects via the system proxy.
    if (settingAutoconnect && getMode() === "tun" && !(await invoke("is_elevated"))) {
      setSessionMode("systemProxy");
      toast(t("elev.tunSkippedOnStart"), "warn", 6000, { group: "conn" });
    }
    const mode = getMode();
    const splitDiscord = mode === "tun"
      && !strictPrivacyRequested()
      && !!loadOptions()?.route?.tunSplitDiscord;
    const plan = startupRuntimePlan({
      autoconnect,
      resume,
      dpiEnabled: localStorage.getItem("ninety.dpi.enabled") === "true",
      mode,
      tunSplitDiscord: splitDiscord,
    });
    if (!plan.shouldRun) return;
    const { vpnWanted, tunWanted, dpiWanted } = plan;
    // Elevation for TUN — only if we're actually going to bring up the VPN.
    if (((tunWanted && vpnWanted) || dpiWanted) && !(await invoke("is_elevated"))) {
      if (tunWanted) setMode("tun"); // the restarted admin instance will come up in TUN
      // Only DPI bypass — without the VPN: otherwise every launch of such a user without
      // rights ended with the tunnel up.
      // The autostart scenario: the new process stays in the tray, like the previous one.
      const started = await invoke("relaunch_elevated", { connect: vpnWanted, keepInTray: true });
      if (started) return; // the current process is about to exit
      // Elevation failed (UAC refusal, a policy). The promised fallback must
      // be real: previously the mode stayed tun, sing-box without rights didn't bring up
      // the interface, and autostart ended with a second UAC prompt or a silent
      // "won't connect". We drop down to a mode that works without rights.
      // Only for this session: the refusal applied to one launch, not to choosing TUN.
      if (tunWanted && getMode() === "tun") {
        setSessionMode("systemProxy");
        console.warn("elevation refused: autostart falls back to system proxy");
        toast(t("elev.tunCancelled"), "warn", 6000, { group: "conn" });
      }
    }

    // The second snapshot after reconcile is the last fail-safe before the start:
    // no frontend idle is proof that the backend is idle.
    let runningSnapshot = await invoke("runtime_snapshot");
    if (runningSnapshot?.running) {
      if (await runtimeSnapshotIsLive(runningSnapshot)) {
        const epoch = beginNetworkIntent("connected");
        adoptRuntimeSnapshot(runningSnapshot, activeDisplaySource(), { epoch });
      } else if (!(await shutdownRuntimeForPolicyReplacement(runningSnapshot))) {
        throw new Error("не удалось очистить runtime перед autostart");
      }
      runningSnapshot = null;
    }
    if (vpnWanted && !runningSnapshot?.running && state !== "connected" && hasConnectSource()) {
      await new Promise(r => setTimeout(r, 600)); // let the UI finish mounting
      const beforeStart = await invoke("runtime_snapshot");
      if (beforeStart?.running) {
        if (await runtimeSnapshotIsLive(beforeStart)) {
          const epoch = beginNetworkIntent("connected");
          adoptRuntimeSnapshot(beforeStart, activeDisplaySource(), { epoch });
        }
        else if (!(await shutdownRuntimeForPolicyReplacement(beforeStart))) {
          throw new Error("runtime занято и cleanup не подтверждён");
        }
      } else if (state === "idle") {
        const epoch = beginNetworkIntent("connected");
        await connectNetwork({ epoch });
      }
    }
    // The node exclusion survives a hard termination with the VPN connected: the files
    // live in app_data, and the cleanup hangs on the transition to idle, which didn't happen in this
    // scenario. A stuck value changes winws profile matching, so
    // we always remove it at startup, not only when bringing up DPI.
    if (state !== "connected") await clearVpnNodeExclusion();
    // DPI is started only after the VPN bootstrap finishes. The endpoint first
    // goes into the managed exclusion, the backend creates the empty files itself anyway.
    if (dpiWanted) {
      if (state === "connected") await excludeVpnNode(activeNodeForDisplay()?.host);
      await autostartDpiIfEnabled();
    }
    if (resume) {
      const vpnReady = !resume.vpn || state === "connected" || await invoke("singbox_running");
      const dpiReady = !resume.dpi
        || (tunWanted && !splitDiscord)
        || (dpiWanted && await invoke("dpi_running"));
      if (resumeRuntimeReady(resume.journal || resume, { vpnReady, dpiReady })) await markUpdateRuntimeReady();
    }
}

const bootstrapCoordinator = createBootstrapCoordinator({
  reconcile: async () => {
    if (await restoreStateOnLaunch) return;
    beginNetworkIntent("idle");
    await reconcileNetworkRuntime();
  },
  autostart: async () => {
    if (await restoreStateOnLaunch) return;
    try {
      await autostartNetworkRuntime();
    } catch (e) {
      console.warn("autostart failed", e);
      try {
        const snapshot = await invoke("runtime_snapshot");
        if (snapshot?.running && !(await shutdownRuntimeForPolicyReplacement(snapshot))) {
          setState("cleanup_error", {
            preserveKillSwitch: killSwitchMustSurviveRuntimeStop(),
          });
        }
      } catch (cleanupError) {
        console.warn("autostart cleanup failed", cleanupError);
        setState("cleanup_error", {
          preserveKillSwitch: killSwitchMustSurviveRuntimeStop(),
        });
      }
    }
  },
  setBusy: (busy) => {
    networkBootstrapInProgress = busy;
    if (heroDisc) {
      heroDisc.disabled = busy;
      heroDisc.toggleAttribute("aria-disabled", busy);
    }
    if (!busy) updateHeroHint();
  },
});

async function bootstrapNetworkRuntime() {
  return bootstrapCoordinator.run();
}

// 0.8.0 kept the login and password for network neighbors in settings, i.e.
// in plain text in localStorage. We move them into the backend storage and
// rewrite the settings without them. This comes before bootstrap: the first
// connection must find the pair at the backend, otherwise the neighbors' inbound will close.
(async () => {
  const legacy = takeLegacyLanCredentials();
  if (!legacy) return;
  try {
    await invoke("lan_auth_update", legacy);
    saveOptions(loadOptions());
  } catch (e) {
    console.warn("LAN credentials migration failed", e?.message || e);
  }
})();

bootstrapNetworkRuntime();

// Syncing the autostart flag with the actual Windows state (the Task Scheduler
// task). If the user deleted the task via Task Scheduler / Settings —
// we pull the actual state into options here.
(async () => {
  try {
    const enabled = await invoke("autostart_is_enabled");
    const opts = loadOptions();
    if (typeof enabled === "boolean" && opts.general?.autostart !== enabled) {
      updateOption("general.autostart", enabled);
    }
  } catch {}
})();

// If the user enabled the vless:// / tt:// / naive+... handlers,
// we refresh the registry path at startup: after OTA/a reinstall the exe may have moved.
(async () => {
  try {
    if (loadOptions().general?.linkHandlers) await applyLinkHandlers(true);
  } catch (e) {
    console.warn("link handlers refresh failed", e);
  }
})();

// ── Auto-update ────────────────────────────────────────────
// An update found by the background check while the window is minimized to the tray accumulates in
// pendingUpdate (declared above, before syncTrayMenu). We don't pull the window out with a modal —
// we show it when the user comes back (window focus / a click on the tray item).
let updateModalShowing = false;
let activeUpdateVersion = null;
// The OS notification about an update — once per version per session: background checks
// repeat, and without dedup a user in the tray would get a toast about the same version every tick.
let lastNotifiedUpdateVersion = null;

async function markUpdateRuntimeReady() {
  try {
    localStorage.removeItem("ninety.update.resume");
    localStorage.removeItem("ninety.dpi.resumeAfterUpdate");
  } catch {}
  await backupNow();
}

// Is the window really in front of the user? We check focus last: this
// closes the race window when CloseRequested/hide arrives between two IPC calls.
async function windowIsForeground() {
  if (!tauriWin) return true;
  try {
    const visible = await tauriWin.isVisible?.();
    if (visible === false) return false;
    const min = await tauriWin.isMinimized?.();
    if (min) return false;
    const focused = await tauriWin.isFocused?.();
    return focused !== false;
  } catch { return true; }
}

async function showUpdateModal(update, opts = {}) {
  if (!update) return;
  if (updateModalShowing) {
    if (String(update.version) !== String(activeUpdateVersion)) {
      pendingUpdate = update;
      syncTrayMenu();
    }
    return;
  }
  updateModalShowing = true;
  activeUpdateVersion = update.version;
  try {
    let portable = false;
    try { portable = !!(await invoke("is_portable")); } catch {}
    await openUpdateModal(update, {
      ...opts,
      portable,
      portableProxy: updaterProxy,
      acquireUpdate: () => acquireUpdateForCurrentRoute({
        check: ({ proxy }) => checkForUpdate({ proxy }),
        getProxy: updaterProxy,
        unstableMessage: t("update.checkFailed"),
      }),
      onVersionChanged: (version) => { activeUpdateVersion = version; },
      onInstalling: (v) => {
        updateInstalling = v;
        syncTrayMenu();
      },
      onBeforeInstall: backupForUpdate,
      onBeforeRuntimeStop: () => {
        beginNetworkIntent("idle");
        cancelPendingReconnect();
        connectAttempts.cancel();
      },
      resumeContext: {
        sourceFingerprint: sourceFingerprint(activeDisplaySource()),
        mode: getMode(),
      },
      onRuntimeStopped: () => {
        runtimeIdentity.invalidate();
        setState("idle");
      },
      onRecovery: async (journal) => {
        const desired = journal?.desired || journal || {};
        let recovered = true;
        if (desired.vpn && hasConnectSource()) {
          if (state !== "idle") setState("idle");
          const epoch = beginNetworkIntent("connected");
          await connectNetwork({ epoch });
          recovered = state === "connected";
        }
        if (desired.dpi) {
          try {
            await autostartDpiIfEnabled();
            const tunPaused = getMode() === "tun"
              && (strictPrivacyRequested() || !loadOptions()?.route?.tunSplitDiscord);
            if (!tunPaused && !(await invoke("dpi_running"))) recovered = false;
          } catch { recovered = false; }
        }
        if (recovered) await markUpdateRuntimeReady();
        else setState("cleanup_error");
        return recovered;
      },
    });
  } finally {
    updateModalShowing = false;
    activeUpdateVersion = null;
    updateInstalling = false;
    syncTrayMenu();
    if (pendingUpdate) {
      queueMicrotask(() => {
        void flushPendingUpdate({ requireForeground: true, respectSkip: true });
      });
    }
  }
}

// Show the pending update. respectSkip=false (default) — the call
// came from an explicit user action (the tray item, the "Check" button), and
// with this action they re-asked about the previous "Later". respectSkip=true — the call
// is automatic (window focus, the tail of a closed modal): we don't impose the skipped version,
// but it doesn't disappear from the tray.
async function flushPendingUpdate({ requireForeground = false, respectSkip = false } = {}) {
  if (!pendingUpdate || updateModalShowing) return;
  if (respectSkip && updateShouldSkip(pendingUpdate.version)) return;
  if (requireForeground && !(await windowIsForeground())) return;
  // While we waited for the window IPC, OTA may have taken the focus/tray handler.
  if (!pendingUpdate || updateModalShowing) return;
  const u = pendingUpdate;
  pendingUpdate = null;
  syncTrayMenu(); // remove the "Update" item from the tray
  await showUpdateModal(u, { respectSkip: false });
}

// Proxy for checking/downloading the update: with the VPN up — our own local
// inbound (like subscription refresh). Without it the check ALWAYS goes "direct"
// (reqwest doesn't honor the system proxy, in TUN Ninety.exe's traffic goes direct via
// the bypass rule) — with some ISPs the endpoints aren't reachable that way at all.
function updaterProxy() {
  const hostPort = state === "connected" ? runtimeProbeHostPort() : null;
  return hostPort ? `http://${hostPort}` : null;
}

// OTA in the tray used to leave no trace: any failure (no network, a blocked
// endpoint, a Resource that didn't close) was silent in the WebView console, and from the outside it was
// indistinguishable from "no updates". We write the outcome of every check into the runtime log —
// it's visible in the "Logs" section.
// "About" listens to this event: without it the updates card would come alive
// only on a section redraw, i.e. after everything had happened.
function emitUpdateState() {
  try { window.dispatchEvent(new CustomEvent("ninety:update-state")); } catch {}
}

function recordUpdateEvent(phase, result, reason = null) {
  void invoke("record_frontend_runtime_event", {
    token: null,
    phase,
    result,
    reason,
    generation: null,
  }).catch(error => console.warn("update diagnostic failed", error));
}

// true — the check REACHED the server (there's an update or there isn't); false — we couldn't
// check (no network / endpoints unreachable) → the scheduler goes into a backoff retry.
async function performUpdateCheck(request) {
  emitUpdateState(); // the check has started — the card shows it right away
  if (!updaterAvailable()) {
    if (request.interactive) toast(t("update.unavailable"), "error", 2500);
    return false;
  }
  // We don't create a new Rust Update until the Resource from the previous
  // failed cleanup attempt is closed.
  if (!(await drainUpdateResourceCleanup())) {
    recordUpdateEvent("update_check", "failed", "cleanup_pending");
    if (request.interactive) toast(t("update.checkFailed"), "error", 4000);
    return false;
  }
  let update;
  try {
    const proxy = updaterProxy();
    // With an active VPN we don't fall back to a direct request: regular TUN deliberately
    // lets Ninety.exe out via direct, and in proxy/systemProxy reqwest doesn't pick it up.
    // The error goes into the regular backoff and is retried through the tunnel after recovery.
    update = await checkForUpdate({ proxy });
  } catch (e) {
    console.warn("update check failed", e);
    // The reason is only the transport: endpoint addresses and the error text don't go into
    // the log, the very fact of unreachability is recorded there anyway.
    recordUpdateEvent("update_check", "failed", updaterProxy() ? "unreachable_via_tunnel" : "unreachable_direct");
    if (request.interactive) toast(t("update.checkFailed"), "error", 4000);
    return false;
  }
  if (!update) {
    if (pendingUpdate) {
      pendingUpdate = null;
      syncTrayMenu();
    }
    emitUpdateState();
    // We record an empty result too: without it "OTA is silent because there's nothing
    // to install" is indistinguishable from "checks aren't running at all" — and in the tray these are different
    // diagnoses with different treatments.
    recordUpdateEvent("update_check", "none", null);
    if (request.interactive) toast(t("update.none"), "info", 2400);
    return true;
  }

  // For waiting in the tray we keep plain metadata. The native Update holds a Rust
  // Resource and the HTTP client/proxy of the check() moment, so we release it right away.
  const metadata = snapshotUpdate(update);

  // Pending is published FIRST — before cleaning up the resource and before the window IPC.
  // The update has already been found, and the tray item with the tooltip must depend neither on
  // the success of close() nor on a race with the focus handler: previously a failed cleanup
  // threw away a perfectly valid finding, and nothing appeared in the tray.
  if (!(updateModalShowing && String(activeUpdateVersion) === String(metadata.version))) {
    pendingUpdate = metadata;
    syncTrayMenu();
    emitUpdateState();
  }

  // A failed cleanup of the Rust resource is a leak problem, not a check problem. The gate on
  // creating new Updates sits at the start of the function (drainUpdateResourceCleanup),
  // and here it's important not to turn this into "no updates": the check reached the server,
  // and the scheduler must not go into a backoff loop.
  if (!(await closeUpdateResource(update))) {
    recordUpdateEvent("update_resource", "degraded", "close_failed");
    if (request.interactive) toast(t("update.checkFailed"), "error", 4000);
  }

  const plan = planUpdateNotice({
    interactive: request.interactive,
    skipped: updateShouldSkip(metadata.version),
    foreground: request.interactive ? true : await windowIsForeground(),
    alreadyNotified: lastNotifiedUpdateVersion === metadata.version,
    modalBusy: updateModalShowing && String(activeUpdateVersion) === String(metadata.version),
  });
  recordUpdateEvent("update_found", plan.action, plan.reason);

  // A manual click may have joined the background flight while it was waiting for the window
  // IPC: then the promised modal matters more than the plan made for the background.
  if (request.interactive) {
    await flushPendingUpdate();
    return true;
  }
  if (plan.action === UPDATE_NOTICE.MODAL && pendingUpdate === metadata) {
    await flushPendingUpdate({ requireForeground: true });
  } else if (plan.action === UPDATE_NOTICE.NOTIFY && pendingUpdate === metadata) {
    lastNotifiedUpdateVersion = metadata.version;
    notify(t("update.notifyTitle"),
      t("update.notifyBody", { version: metadata.version }));
  }
  return true;
}

const updateChecks = createPromotableSingleFlight(performUpdateCheck);

function runUpdateCheck({ silent = true } = {}) {
  return updateChecks.run({ interactive: !silent });
}

// ── Check schedule — by timestamps, not by setInterval ──
// The former setInterval(6h) broke in two scenarios: (1) autostart with Windows —
// the first check after 3 s consistently died on a network that wasn't up yet, and until
// the next one there were 6 hours of silence; (2) sleep/hibernation — an interval timer doesn't
// tick during sleep, the real period drifted far beyond 6 h. Now:
//   success → the next one in 30 min (a check = one ~1 KB JSON, cheap);
//   failure → backoff 30 s → 2 m → 5 m → 15 m (then every 15 m) until the first success;
//   a light tick every 60 s compares the clock (survives sleep and throttling of a hidden
//   window — Chromium in the tray coalesces timers to exactly 1/min);
//   unscheduled triggers: the network appeared (online), the window was restored, the VPN
//   came up (the endpoints become reachable through the tunnel), hover/right click on the icon in
//   the tray. All of this works in the tray too: the update arrives as an OS notification, a badge on
//   the icon and the "Update to vX" item in the menu.
//
// The period is 30 minutes, not two hours: a minimized window has neither focus nor online,
// and between a release and the sign appearing in the tray there was a random pause of up to two
// hours. A check costs one JSON, this frequency costs nothing.
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_RETRY_STEPS_MS = [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];
const UPDATE_STALE_MS = 30 * 60_000; // "not checked for a long time" for focus/connect
let updateNextCheckAt = Date.now() + 3000; // the first one — 3 s after start
let updateLastSuccessAt = 0;
let updateRetryIdx = 0;

function updateCheckSucceeded() {
  updateLastSuccessAt = Date.now();
  updateRetryIdx = 0;
  updateNextCheckAt = Date.now() + UPDATE_CHECK_INTERVAL_MS;
  emitUpdateState();
}

async function scheduledUpdateCheck() {
  // The modal is open — we don't trigger a check under it (and don't disrupt the installation).
  if (updateChecks.isRunning() || updateModalShowing) return;
  if (await runUpdateCheck({ silent: true })) {
    updateCheckSucceeded();
  } else {
    const step = UPDATE_RETRY_STEPS_MS[Math.min(updateRetryIdx, UPDATE_RETRY_STEPS_MS.length - 1)];
    updateRetryIdx++;
    updateNextCheckAt = Date.now() + step;
  }
}

// An unscheduled check (focus/online/connect) — only if there hasn't been a successful one
// for a long time, so that every Alt-Tab/reconnect doesn't poke the endpoints.
function updateCheckIfStale(staleMs = UPDATE_STALE_MS) {
  if (Date.now() - updateLastSuccessAt >= staleMs) scheduledUpdateCheck();
}

setTimeout(scheduledUpdateCheck, 3000);
setInterval(() => { if (Date.now() >= updateNextCheckAt) scheduledUpdateCheck(); }, 60_000);

// The network appeared (Wi-Fi caught up after login, airplane mode was turned off).
window.addEventListener("online", () => updateCheckIfStale(60_000));

// Came back to the window (focus from the tray/taskbar) → show the pending update;
// also finish the check if half an hour has passed since the last successful one.
(async () => {
  try {
    await tauriWin?.onFocusChanged?.(({ payload: focused }) => {
      activityController.setFocused(!!focused);
      if (!focused) return;
      // Focus isn't consent to look at a skipped version: it stays in the tray.
      flushPendingUpdate({ respectSkip: true });
      updateCheckIfStale();
      // A safeguard against an icon desync: we apply the state forcibly,
      // bypassing dedup — precisely in the failure case the payload doesn't differ from the one
      // that never reached the icon.
      syncTrayMenu({ force: true });
    });
  } catch (e) { console.warn("focus listener failed", e); }
})();

// A global function for the "Check for updates" button in settings
window.__ninetyUpdateCheck = async () => {
  if (await runUpdateCheck({ silent: false })) updateCheckSucceeded();
};

// ── Subscriptions auto-refresh ─────────────────────────────
// A tick every 30 minutes (the first after 60 s so as not to slow down the start), but
// each subscription is updated by ITS OWN interval: profile-update-interval from
// the panel header, without a header — every 6 hours. Previously the header was saved
// but ignored — everything was polled every 30 minutes. A manual "Update all"
// still updates immediately. We don't show errors — it's a background task.
const SUBS_REFRESH_DEFAULT_HOURS = 6;
async function silentRefreshSubs() {
  // In strict mode a background request without the tunnel would reveal the real IP to the panel.
  if (loadOptions().privacy?.strictTunnel && state !== "connected") return;
  const now = Date.now();
  let refreshed = 0;
  for (const s of loadSubscriptions()) {
    if (s.autoUpdate === false) continue;
    const hours = Number(s.updateIntervalHours) > 0
      ? Number(s.updateIntervalHours)
      : SUBS_REFRESH_DEFAULT_HOURS;
    if (s.lastUpdate && now - s.lastUpdate < hours * 3600_000) continue;
    try {
      await mutateSource("sub", s.id, () => refreshSubscription(s.id), t("conn.applyingSettings"));
      refreshed++;
    } catch (e) {
      console.warn("sub auto-refresh failed", s.id, e);
    }
  }
  if (refreshed) {
    refreshSubCardFromActive();
    refreshProfilesSummary();
  }
}
setTimeout(silentRefreshSubs, 60_000);
setInterval(silentRefreshSubs, 30 * 60_000);

// "Just now" / "N min ago" is updated every 30 s
setInterval(refreshSubCardFromActive, 30_000);

// ── Deep links ──────────────────────────────────────────────
// Format parsing is in /lib/deeplink.js (a pure function, covered by tests).
// Windows launches Ninety with argv, the single-instance plugin intercepts it and
// emits onOpenUrl into the first process. There's no auto-import — the user sees the prefilled
// URL in add-modal and confirms (protection against malicious links).
// Deduplication is needed only against ONE event duplicated by different
// channels (listen + onOpenUrl + getCurrent arrive almost simultaneously on
// cold start). An indefinite memory of the URL turned this into a different problem:
// the user closed the modal, clicked the same invitation link again — and
// the app did nothing until a restart. So we remember for a short
// window, not forever.
const DEEP_LINK_DEDUPE_MS = 4000;
const handledDeepLinks = new Map();
function handleDeepLinkUrl(rawUrl) {
  try {
    const key = String(rawUrl || "");
    if (!key) return;
    const now = Date.now();
    for (const [seen, at] of handledDeepLinks) {
      if (now - at > DEEP_LINK_DEDUPE_MS) handledDeepLinks.delete(seen);
    }
    if (handledDeepLinks.has(key)) return;
    handledDeepLinks.set(key, now);
    const intent = parseDeepLink(rawUrl);
    if (intent) openAddModal({ prefillUrl: intent.url, prefillName: intent.name });
  } catch (e) {
    console.warn("deeplink handle failed", e);
  }
}

(async () => {
  const dl = window.__TAURI__?.deepLink;
  const ev = window.__TAURI__?.event;
  try {
    if (ev?.listen) {
      await ev.listen("deep-link:open", (event) => {
        const urls = event?.payload;
        if (Array.isArray(urls)) for (const u of urls) handleDeepLinkUrl(u);
      });
    }
    // onOpenUrl receives URLs both on cold start (if Windows launched Ninety
    // with ninety://... itself) and on a warm second instance via single-instance.
    if (dl?.onOpenUrl) {
      await dl.onOpenUrl((urls) => {
        if (!Array.isArray(urls)) return;
        for (const u of urls) handleDeepLinkUrl(u);
      });
    }
    // We also check getCurrent in case the URL was passed before
    // we subscribed (cold-start race).
    if (dl?.getCurrent) {
      try {
        const initial = await dl.getCurrent();
        if (Array.isArray(initial)) for (const u of initial) handleDeepLinkUrl(u);
      } catch {}
    }
    try {
      const initial = await invoke("startup_deep_links");
      if (Array.isArray(initial)) for (const u of initial) handleDeepLinkUrl(u);
    } catch {}
  } catch (e) {
    console.warn("deeplink subscribe failed", e);
  }
})();

// ── The "Diagnostics" screen ────────────────────────────────────
// Mounted lazily, on the first visit: the screen is heavier than the others (three checks,
// the incident feed), and it's opened far from every session. The run does NOT
// start by itself — probes go to the network, and that decision stays with the person.
let diagnoseCtl = null;
function ensureDiagnoseView() {
  if (diagnoseCtl) return diagnoseCtl;
  const root = document.getElementById("diagnose-root");
  if (!root) return null;
  diagnoseCtl = mountDiagnoseView(root, {
    invoke,
    getGeneration: () => Number(runtimeIdentity.capture()?.processGeneration) || null,
    isConnected: () => state === "connected",
    isTunMode: () => getMode() === "tun",
    // Direct probes physically won't get through with the kill switch on and are forbidden
    // by the strict tunnel policy: the "direct" column honestly stays empty
    // instead of a made-up "unreachable".
    allowDirect: () => !strictPrivacyRequested() && !loadOptions().general?.killSwitch,
    getNodeEndpoint: () => (currentEffectiveNode?.host
      ? { host: currentEffectiveNode.host, port: Number(currentEffectiveNode.port) || 443 }
      : null),
    getOptions: loadOptions,
    saveOption: (path, value) => updateOption(path, value),
    onToast: toast,
    onAction: handleDiagnoseAction,
    onFindings: (count) => {
      const hint = document.getElementById("diagnose-nav-hint");
      if (hint) hint.textContent = count ? String(count) : "";
    },
  });
  return diagnoseCtl;
}

function onDiagnoseViewEnter() {
  ensureDiagnoseView()?.refreshFeed();
}

// Windows forwards traffic between networks: in TUN the core's connections go into a loop,
// and from the outside it looks like an endless "Checking" (#168). We don't touch
// the setting — it's sometimes needed deliberately; we say it once per launch, and the fix
// command is given by "Diagnostics".
let forwardingWarned = false;
async function warnAboutForwarding() {
  if (forwardingWarned) return;
  let status;
  try {
    status = await invoke("system_forwarding_status");
  } catch (e) {
    console.warn("system_forwarding_status failed", e);
    return;
  }
  if (forwardingWarned || !forwardingProblem(status)) return;
  forwardingWarned = true;
  const iface = forwardingAliases(status);
  incidentLog.record("system.forwarding", { severity: "warn", params: { iface } });
  toast(t("conn.forwarding"), "warn", 0, { desc: t("conn.forwardingDesc", { iface }) });
}

// An action from the verdict or from a matrix row. The routing rule is written into the same
// options.route.customRules as the rules screen does, and we trigger a reconnect the same way:
// otherwise the rule would get into the config only on the next connection.
async function handleDiagnoseAction(action, params = {}) {
  if (action === "dpi") { switchView("dpi"); return; }
  if (action === "switchNode") { switchView("proxies"); return; }
  if (action !== "ruleDirect" && action !== "ruleTunnel") return;

  const domain = String(params.domain || "").trim();
  if (!domain) return;
  const { rule } = sanitizeRule(newRule({
    type: "domain",
    match: "suffix",
    values: [domain],
    action: action === "ruleDirect" ? "direct" : "proxy",
  }));
  if (!rule.values.length) {
    toast(t("dg.err.rule", { domain }), "error", 3500);
    return;
  }
  updateOption("route.customRules", [...(loadOptions().route?.customRules || []), rule]);
  toast(t("dg.ruleAdded", { domain }), "success", 2600);
  if (state === "connected" || state === "connecting") scheduleAutoReconnect();
}

document.getElementById("diagnose-run")?.addEventListener("click", () => ensureDiagnoseView()?.run());
document.getElementById("diagnose-copy")?.addEventListener("click", () => ensureDiagnoseView()?.copyReport());
