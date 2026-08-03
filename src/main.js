import {
  buildConfig,
  bridgeNeeds,
  loadProfiles,
  getActiveProfileId,
  setActiveProfileId,
  removeProfile,
  getMode,
  setMode,
  getActiveKind,
  setActiveKind,
  getActiveSource,
  nodeTag,
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
} from "/lib/subscriptions.js";
import { loadOptions, updateOption, REGIONS } from "/lib/options.js";
import { backupForUpdate, backupNow, backupSoon, restoreIfEmpty } from "/lib/state-backup.js";
import { mountSettings } from "/lib/settings-view.js";
import { pathNeedsRestart } from "/lib/restart-policy.js";
import { a11ySwitch } from "/lib/switch-a11y.js";
import { escapeAttr, escapeHtml } from "/lib/esc.js";
import { isAvailable as updaterAvailable, checkForUpdate } from "/lib/updater.js";
import { openUpdateModal, resumeRuntimeReady, shouldSkip as updateShouldSkip } from "/lib/update-modal.js";
import { mountAddModal, openAddModal } from "/lib/add-modal.js";
import { openEditSubscription, openEditProfile } from "/lib/edit-modal.js";
import { copySubscriptionUrl, exportSingboxJson, openQRModal } from "/lib/share.js";
import { mountProxiesView, nodesFromSource, onProxiesViewEnter, onProxiesViewLeave, rerenderProxiesView, resetProxiesViewForSourceChange, snapshotMatchesSource } from "/lib/proxies-view.js";
import {
  applyActiveSourceTransaction,
  createSourceSwitchController,
  sameSourceRef,
} from "/lib/source-activation.js";
import { mountDpiView, prepareDpiVpnMode, setDpiVpnMode, excludeVpnNode, clearVpnNodeExclusion, autostartDpiIfEnabled, rerenderDpiView, onDpiViewEnter } from "/lib/dpi-view.js";
import { mountLogsView, onLogsViewEnter, onLogsViewLeave, rerenderLogsView } from "/lib/logs-view.js";
import { initTray, syncTrayMenu } from "/lib/tray.js";
import { startClashStream, stopClashStream, formatRate } from "/lib/clash-stream.js";
import { createConnectionAttemptGate } from "/lib/connection-attempt.js";
import { createCoreStartBarrier } from "/lib/connection-start-barrier.js";
import { createRuntimeIdleGate } from "/lib/runtime-idle-gate.js";
import { completeSuccessfulConnect, runReconnectAttempt } from "/lib/connect-network-result.js";
import { waitForMatchingSourceTopology } from "/lib/source-switch-readiness.js";
import { runtimeEndpointMatchesGeneration, runtimeSnapshotReadyForMode } from "/lib/runtime-lifecycle.js";
import { cancelPendingSelections, configureClashRuntime, gradeDelay, pickEffectiveNode, pickSelectorNow, getProxies, lastDelay, selectProxy, refreshEffectiveDelay, testGroup, testNode } from "/lib/clash-api.js";
import { fetchPublicIp, maskIp, bindIpReveal } from "/lib/ip-info.js";
import { notify } from "/lib/notify.js";
import { toast } from "/lib/toast.js";
import { FLAGS_BASE, flagIsoFromName as isoFromNodeName, stripFlag } from "/lib/flags.js";
import { configureTrafficRuntime, startMeter, stopMeter, getMeasured, resetMeasured, sourceKeyOf } from "/lib/traffic-meter.js";
import { clearProfileStorage } from "/lib/storage-policy.js";
import {
  clearProfileStore,
  hasLegacySensitiveData,
  initializeProfileStore,
} from "/lib/profile-store.js";
import { createQualityEngine } from "/lib/quality-engine.js";
import { bus } from "/lib/bus.js";
import { openQualityScope } from "/lib/quality-scope.js";
import { initHeroHud } from "/lib/hero-hud.js";
import { parseDeepLink } from "/lib/deeplink.js";
import {
  applyKillSwitch,
  maybeWarnKillSwitchProxy,
  snapshotConfirmsOrdinaryKillSwitch,
  snapshotConfirmsStrictKillSwitch,
} from "/lib/kill-switch.js";
import { initWifiGuard, forgetWifiAutoRestore } from "/lib/wifi-guard.js";
import { initWarpRescan } from "/lib/warp-rescan.js";
import { initHealthWatchdog } from "/lib/health-watchdog.js";
import { initTitlebar } from "/lib/titlebar.js";
import { initPopovers } from "/lib/popovers.js";
import { ensureWorkingDirectDns, startDnsGuard, stopDnsGuard } from "/lib/dns-guard.js";
import { initI18n, setLang, getLang, onLangChange, applyDom, availableLangs, t } from "/lib/i18n/index.js";
import { detectRegion } from "/lib/i18n/region-detect.js";
import { applyLinkHandlers } from "/lib/link-handlers.js";
import { DEFAULT_THEME_ID, THEMES, isThemeId } from "/lib/themes.js";
import { createRuntimeIdentityController, sourceFingerprint, sourceKey } from "/lib/runtime-identity.js";
import { createSourceMutationController, planSourceDeletion } from "/lib/source-mutations.js";
import { createBootstrapCoordinator } from "/lib/bootstrap-coordinator.js";
import { createNetworkIntentArbiter, repeatedConnectionIntentAction } from "/lib/network-intent.js";
import { createLatestWinsReconnectQueue } from "/lib/reconnect-queue.js";
import { shouldShowOnboarding } from "/lib/onboarding-state.js";
import { getRememberedProxySelection, restoreRememberedProxySelection } from "/lib/proxy-selection.js";
import { startupRuntimePlan } from "/lib/startup-runtime-policy.js";
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

// ── Tauri 2 (withGlobalTauri:true) ───────────────────────────
const tauriWin = window.__TAURI__?.window?.getCurrentWindow?.()
  ?? window.__TAURI__?.window?.getCurrent?.();
const invoke = window.__TAURI__?.core?.invoke
  ?? ((cmd, args) => {
    console.warn("Tauri invoke недоступен:", cmd, args);
    return Promise.reject(new Error("Tauri invoke недоступен (web preview)"));
  });
const protectedBrowser = createProtectedBrowserService({ invoke });

function strictPrivacyRequested() {
  return !!loadOptions().privacy?.strictTunnel;
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
  // Проверка установки — IPC и может завершиться уже после disconnect/reconnect.
  // Перед фактическим spawn подтверждаем тот же runtime и сетевое намерение.
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

// ── Восстановление состояния из бэкапа ──────────────────────
// Профиль WebView2 (EBWebView) могли снести чистилки диска/антивирус: если
// localStorage пуст, а снапшот в writable config dir есть — возвращаем ключи и
// перезагружаем webview, чтобы все модули перечитали хранилище с нуля
// (тема/язык/опции уже прочитаны дефолтами к этому моменту).
async function unlockPortableSecretsForRecovery() {
  try {
    const status = await invoke("portable_secrets_status");
    if (!status?.portable || status.configured
      || (!status.hasPersistedSecrets && !hasLegacySensitiveData())) return;
    const prompt = getLang() === "ru"
      ? "В Ninety уже есть данные профилей. Введите passphrase portable-хранилища для защищённого переноса (он не будет сохранён):"
      : "Ninety already has profile data. Enter the Portable storage passphrase for protected storage (it will not be saved):";
    const passphrase = window.prompt(prompt);
    if (passphrase == null || passphrase === "") return;
    await invoke("portable_secrets_set_passphrase", { passphrase });
  } catch (error) {
    console.warn("portable secret unlock failed", error);
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
// data-theme вешаем на <html> (documentElement), а НЕ только на #app-root: иначе
// портал-UI вне #app-root (модалки/тосты/контекст-меню, аппендятся в body) берёт
// :root-дефолт (kurogane) вместо активной темы. #app-root держим в синхроне тем же
// значением — его собственный [data-theme] иначе перебьёт наследование для app-поддерева.
function applyThemeAttr(t) {
  document.documentElement.dataset.theme = t;
  if (appRoot) appRoot.dataset.theme = t;
}
export function setTheme(t) {
  if (!isThemeId(t)) return;
  localStorage.setItem(THEME_KEY, t);
  applyThemeAttr(t);
  window.dispatchEvent(new CustomEvent("ninety:theme-changed", { detail: { theme: t } }));
}
// Применяем сохранённую тему сразу — до первого рендера остального
applyThemeAttr(getTheme());
window.__ninetySetTheme = setTheme;

// ── i18n: язык применяется ДО первого показа (каталог уже в памяти, синхронно).
// Module-script отложен → DOM готов, applyDom внутри initI18n находит элементы.
initI18n();

// ── Version (dynamic из Tauri) ─────────────────────────────
// ВАЖНО: НЕ использовать MutationObserver на settings-root — apply() меняет
// textContent #settings-version, это создаёт новую мутацию → бесконечный
// цикл → фриз WebView2 при входе в Settings/Общие (alpha14 bug).
let appVersionCached = "—";

function applySettingsVersion() {
  const el = document.getElementById("settings-version");
  if (el && el.textContent !== appVersionCached) el.textContent = appVersionCached;
}

async function fillAppVersion() {
  let v = "—";
  try {
    const app = window.__TAURI__?.app;
    if (app?.getVersion) v = await app.getVersion();
  } catch {}
  appVersionCached = v;
  const sidebar = document.getElementById("sidebar-version");
  if (sidebar) sidebar.textContent = v === "—" ? "v—" : `v${v}`;
  applySettingsVersion();
}
fillAppVersion();

// ── Titlebar + поповеры — /lib/titlebar.js, /lib/popovers.js ──
// Оконные кнопки и поповер «Режим» вынесены в модули. closeAllPopovers остаётся
// доступен как алиас — его зовёт add-sub при открытии модалки.
initTitlebar(tauriWin);
const { closeAll: closeAllPopovers } = initPopovers();

// ── Mode segmented (3 режима как у Hiddify) ─────────────────
const modeSeg = document.getElementById("mode-seg");
const modeHint = document.getElementById("mode-hint");
const warpSwitch = document.getElementById("warp-switch");

// Подсказки режимов живут в каталоге i18n (mode.hint.*) — берутся t() при apply.
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
  // DPI-обход слушает режим: вход в TUN → пауза, выход → восстановление.
  void setDpiVpnMode(m);
}
// Строгая политика никогда не существует в proxy/systemProxy: восстанавливаем
// согласованный режим ещё до первого рендера и bootstrap runtime.
if (strictPrivacyRequested() && getMode() !== "tun") setMode("tun");
applyModeToUI(getMode());

// WARP switch в popover'е
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
  // Кликабельна вся строка лейбла, не только тумблер — как строки настроек.
  const warpRow = warpSwitch.closest(".popover__warp");
  warpRow?.addEventListener("click", (e) => {
    if (warpSwitch.contains(e.target)) return;
    e.preventDefault();
    warpSwitch.click();
  });
})();

// warp.enabled управляется из двух мест — свитч в поповере «Режим» и тумблер
// в Настройки → WARP. Ни один не перерисовывается при изменении опции извне,
// поэтому на любую запись (событие из updateOption) выравниваем оба контрола.
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

// Единая смена режима подключения — из сегмента на главной И из меню трея.
// auto=true — переключение сделала Wi-Fi-авто-защита (см. /lib/wifi-guard.js);
// ручной выбор юзера отменяет её авто-возврат прежнего режима.
async function changeMode(requested, { auto = false, reconnect = true } = {}) {
  if (!["proxy", "systemProxy", "tun"].includes(requested)) return false;
  if (strictPrivacyRequested() && requested !== "tun") {
    applyModeToUI("tun");
    if (!auto) toast(t("privacyToast.modeLocked"), "warn", 4200);
    return false;
  }
  if (!auto) forgetWifiAutoRestore();
  const prevMode = getMode();
  // TUN (Throne-style) требует чтобы всё приложение было запущено от админа.
  // Если мы не elevated — ensureElevatedForTun перезапустит Ninety с UAC
  // (и вернёт false: текущий процесс умирает, дальше идти незачем).
  if (requested === "tun") {
    const ok = await ensureElevatedForTun();
    if (!ok) return false;
    // До записи mode и реконнекта обязаны подтвердить остановку winws. Иначе
    // TUN поднимется поверх всё ещё активного перехвата пакетов.
    if (!(await prepareDpiVpnMode(requested))) return false;
  }
  // Обычный Kill Switch относится к proxy/systemProxy, но его заслон должен
  // пережить и переход через границу TUN. До записи нового mode подтверждаем
  // старую policy либо заранее ставим block-all для целевого non-TUN режима.
  // Иначе reconnect увидел бы уже новый mode и снял фильтр до готовности ядра.
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
  // Режим меняет inbound (TUN vs mixed) и системный прокси — при поднятом VPN
  // надо пересобрать конфиг. reconnectForSourceChange сам уходит в idle (сбросит
  // системный прокси старого режима) и поднимается заново. Если не connected —
  // no-op, режим применится при следующем connect.
  if (reconnect && requested !== prevMode) reconnectForSourceChange(t("conn.switchMode"));
  return true;
}

// ── Авто-защита на чужих Wi-Fi (III.3) — /lib/wifi-guard.js ──
// changeMode инжектится (замыкает setMode/UI/реконнект); forgetWifiAutoRestore
// зовётся из changeMode при ручной смене режима, отменяя авто-возврат.
initWifiGuard({ changeMode });

// ── Kill Switch (I.2) — /lib/kill-switch.js ─────────────────
// applyKillSwitch(connected) зовётся из setState; maybeWarnKillSwitchProxy — из
// settings onChange при включении опции в режиме «Прокси».

// TUN поднимает сетевой интерфейс — для этого sing-box (наш child) должен
// работать от админа, значит и всё приложение тоже. Если уже elevated — ок,
// продолжаем. Иначе перезапускаем Ninety от админа через UAC: перезапущенный
// инстанс читает mode=tun из localStorage и авто-подключается (--elevated).
// Возврат: true — можно продолжать в текущем (уже admin) процессе; false —
// идёт перезапуск ИЛИ юзер отказался от UAC.
let elevationRelaunchPending = false;
async function ensureElevatedForTun() {
  elevationRelaunchPending = false;
  const prevMode = getMode();
  let modeStoredForRelaunch = false;
  try {
    if (await invoke("is_elevated")) return true;
    const yes = confirm(t("elev.tunConfirm"));
    if (!yes) return false;
    // Запоминаем режим заранее — перезапущенный admin-инстанс поднимется в TUN.
    setMode("tun");
    modeStoredForRelaunch = true;
    const started = await invoke("relaunch_elevated");
    if (!started) {
      setMode(prevMode);
      applyModeToUI(prevMode);
      updateHeroHint();
      syncTrayMenu();
      toast(t("elev.tunCancelled"), "error", 3000);
      return false;
    }
    elevationRelaunchPending = true;
    toast(t("elev.relaunching"), "info", 2500);
    return false; // текущий процесс вот-вот завершится — не продолжаем
  } catch (e) {
    elevationRelaunchPending = false;
    if (modeStoredForRelaunch) {
      setMode(prevMode);
      applyModeToUI(prevMode);
      updateHeroHint();
      syncTrayMenu();
    }
    toast(t("elev.failed", { err: e?.message || e }), "error", 3500);
    return false;
  }
}

// DPI-обход: winws грузит kernel-драйвер WinDivert → нужны админ-права. Та же
// схема, что у TUN, но без смены режима: уже elevated → продолжаем; иначе
// перезапуск с UAC (текущий процесс умрёт, вернём false).
async function ensureElevatedForDpi() {
  try {
    if (await invoke("is_elevated")) return true;
    const yes = confirm(t("elev.dpiConfirm"));
    if (!yes) return false;
    // relaunch_elevated при успехе завершает текущий процесс прямо внутри Rust,
    // поэтому намерение включить DPI обязано попасть в storage и backup ДО UAC.
    const started = await persistDpiIntentForRelaunch({
      getEnabled: () => localStorage.getItem("ninety.dpi.enabled") === "true",
      setEnabled: (enabled) => localStorage.setItem("ninety.dpi.enabled", enabled ? "true" : "false"),
      backup: () => backupNow(),
      relaunch: () => invoke("relaunch_elevated"),
    });
    if (!started) {
      toast(t("elev.dpiCancelled"), "error", 3000);
      return false;
    }
    toast(t("elev.relaunching"), "info", 2500);
    return false; // процесс вот-вот завершится
  } catch (e) {
    toast(t("elev.failed", { err: e?.message || e }), "error", 3500);
    return false;
  }
}

// ── Add Profile Modal — Hiddify-style ──────────────────────
const profilesSummary = document.getElementById("profiles-summary");

mountAddModal({
  onCommit: async (res) => {
    toast(res.message, "success", 2000);
    if (res.source) {
      const reason = res.source.kind === "sub" ? t("conn.switchSub") : t("conn.switchProfile");
      applyActiveSource(res.source.kind, res.source.id, { reconnect: true, silent: true, reason });
    } else {
      refreshProfilesSummary();
    }
    // Wizard: после импорта переходим на «подключение».
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
  backupSoon(); // профили/подписки изменились — обновить снапшот-бэкап
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

// Empty-state: нет ни подписки ни конфига → показываем onboarding wizard
// (если он ещё не пройден). Wizard также удерживает onboarding visible пока
// юзер не дошёл до step 4 — даже если empty уже false (подписка добавлена).
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

// ── sub-card sync с активной подпиской ─────────────────────
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
    const limit = subscriptionLimitBytes(sub); // null = безлимит/не метится (total=0)
    if (subTraffic) {
      // Гибрид: есть реальный лимит провайдера → квота used/total. Иначе показываем
      // наш измеренный трафик (заголовок провайдера ненадёжен/0).
      subTraffic.innerHTML = limit != null
        ? `<b>${fmtTraffic(used)}</b> / <b>${fmtTraffic(limit)}</b>`
        : `<b>${fmtTraffic(getMeasured(`sub:${sub.id}`).total)}</b> · ${t("home.unlimited")}`;
    }
    // Прогресс-бар: при лимите ГБ — расход квоты (used/total); при безлимите — доля
    // ОСТАВШЕГОСЯ СРОКА подписки. Период провайдер не отдаёт → самокалибровка по пику
    // виденных дней (= длина периода/последнего продления): полный при продлении,
    // убывает к концу. Без срока и без лимита показывать нечего — прячем.
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
    // У одиночного профиля (hysteria/naive/tt) нет квоты — показываем измеренный трафик.
    if (subTraffic) subTraffic.innerHTML = `<b>${fmtTraffic(getMeasured(`profile:${src.profile.id}`).total)}</b>`;
    if (subBar) subBar.style.display = "none";
    if (subProgressFill) subProgressFill.style.width = "0%";
    if (subUpdated) subUpdated.textContent = "—";
  } else if (src?.kind === "warp") {
    if (subName) subName.textContent = "WARP";
    if (subExpire) subExpire.textContent = "—";
    if (subExpireUnit) subExpireUnit.style.display = "none";
    if (subTraffic) subTraffic.innerHTML = `<b>${fmtTraffic(getMeasured("warp").total)}</b>`;
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

// ── Навигация ───────────────────────────────────────────────
const navItems = document.querySelectorAll(".nav__item[data-view]");
const views = document.querySelectorAll("section.screen[data-view]");

function switchView(target) {
  activityController.setView(target);
  navItems.forEach((n) => n.classList.toggle("nav__item--active", n.dataset.view === target));
  views.forEach((v) => { v.hidden = v.dataset.view !== target; });
  // Видео-маска декодится только пока главный экран виден — оффскрин обнуляем декод.
  if (heroMask) { if (target === "home") heroMask.play?.().catch(() => {}); else heroMask.pause?.(); }
  if (target === "logs") onLogsViewEnter();
  else onLogsViewLeave();
  if (target === "proxies") onProxiesViewEnter();
  else onProxiesViewLeave();
  if (target === "dpi") onDpiViewEnter();
  if (target === "settings") setTimeout(applySettingsVersion, 0);
}

navItems.forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

// Карточка активной подписки на главной → открыть «Профили» (как в hiddify):
// явная кнопка-шеврон + клик/Enter по самой карточке.
const subCardEl = document.querySelector(".sub-card");
const subOpenBtn = document.getElementById("sub-open-profiles");
subOpenBtn?.addEventListener("click", (e) => { e.stopPropagation(); switchView("profiles"); });
subCardEl?.addEventListener("click", () => switchView("profiles"));
subCardEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchView("profiles"); }
});

// В строгом runtime остаётся только один физический outbound: смена узла
// сохраняет новый pin и пересобирает соединение вместо Clash hot-switch.
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

// Mount DPI-обход (экран + чип на главной). Синхронизируем режим VPN сразу:
// в TUN обход авто-паузится (см. dpi-view.js::effState).
mountDpiView({ onToast: toast, switchView, ensureElevated: ensureElevatedForDpi });
void setDpiVpnMode(getMode());

// ── Settings view ──────────────────────────────────────────
const settingsRoot = document.getElementById("settings-root");
let settingsCtl = null;
if (settingsRoot) {
  let killSwitchToggleEpoch = 0;
  let strictTunnelToggleEpoch = 0;
  settingsCtl = mountSettings(settingsRoot, {
    onChange: async (path, value) => {
      backupSoon(); // настройки изменились — обновить снапшот-бэкап состояния
      if (path === "privacy.strictTunnel") {
        const toggleEpoch = ++strictTunnelToggleEpoch;
        const stillCurrent = () => toggleEpoch === strictTunnelToggleEpoch
          && !!loadOptions().privacy?.strictTunnel === !!value;
        if (value) {
          const previousMode = getMode();
          // Строгая политика — runtime-overlay: после её выключения надо
          // вернуть пользовательский режим, который был до принудительного TUN.
          // Записываем до ensureElevatedForTun(), потому что успешный UAC-relaunch
          // завершает текущий процесс прямо внутри backend-команды.
          rememberStrictTunnelPreviousMode(previousMode);
          const modeReady = await changeMode("tun", { reconnect: false });
          if (!stillCurrent()) return;
          // При успешном UAC-relaunch текущий процесс уже завершается, а новый
          // прочитает сохранённый strict=true. При отмене/ошибке явно откатываем
          // свитчер даже если прежний сохранённый режим уже был TUN.
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
            // Закрываем окно между остановкой обычного runtime и стартом strict:
            // barrier ставится ДО reconnect, а latch заставляет shutdown
            // сохранить его до готовности нового TUN.
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
          // Мог остаться fail-closed WFP после аварии предыдущей строгой сессии.
          const disarmed = await applyKillSwitch(false);
          if (!stillCurrent()) return;
          if (disarmed) {
            strictFailClosedLatched = false;
            ordinaryFailClosedLatched = false;
          } else {
            // UI не должен обещать снятую защиту, если WFP lease не удалось
            // отпустить. Возвращаем настройку и guard-only retry; выйти из
            // приложения (dynamic session) остаётся гарантированным recovery.
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
          // Для прежнего TUN ничего переключать не нужно, но stale-маркер всё
          // равно удаляем: следующее включение должно запомнить свежий режим.
          clearStrictTunnelPreviousMode();
        }
        syncHealthWatchdogForState();
        // setDpiVpnMode умеет переоценивать тот же TUN-режим: при выключении
        // strict возвращает split-Discord/winws согласно сохранённой опции.
        if (!(await setDpiVpnMode(getMode(), { reevaluate: true }))) return;
        if ((state === "connected" || state === "connecting") && !restoredPreviousMode) {
          scheduleAutoReconnect();
        } else {
          updateHeroHint();
        }
        settingsCtl?.refresh();
        return;
      }
      // Kill switch — чистый WFP-фильтр, конфиг sing-box не трогает: применяем
      // вживую (arm/disarm по текущему состоянию), БЕЗ реконнекта туннеля (прежде
      // тоггл ронял и поднимал VPN зря). В режиме «Прокси» — разовое предупреждение.
      if (path === "general.killSwitch") {
        const toggleEpoch = ++killSwitchToggleEpoch;
        maybeWarnKillSwitchProxy();
        const shouldArm = state === "connected";
        const ready = await applyKillSwitch(shouldArm);
        if (toggleEpoch === killSwitchToggleEpoch && ready !== false) {
          ordinaryFailClosedLatched = !!value
            && shouldArm
            && state === "connected"
            && getMode() !== "tun";
        }
        // Армирование WFP — часть контракта настройки, а не fire-and-forget.
        // Если ядро уже поднято, не оставляем переключатель включённым при
        // фактически неактивной защите: откатываем запись и DOM к безопасному
        // состоянию, затем явно снимаем возможный частично поднятый фильтр.
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
      // Тогглы periodic re-scan и его интервал — не трогают sing-box, только
      // фоновый JS-loop. Пересоздаём loop сразу, реконнект не нужен.
      if (path === "warp.autoRescan" || path === "warp.autoRescanIntervalMin" || path === "warp.autoRescanThresholdMs") {
        startWarpRescanLoop();
        return;
      }
      // Badge с активным endpoint должен реагировать на любое изменение warp.*
      if (path === "warp.enabled" || path === "warp.endpoint") updateWarpBadge();
      if (path === "warp.enabled" || path === "warp.mode") {
        syncEmptyState();
        updateHeroForActive();
      }
      // Качество связи — опции читает движок, ядро не трогаем. Применяем вживую
      // через setOptions; вкл/выкл прячет/показывает индикатор «КАНАЛ».
      if (path.startsWith("quality.")) {
        qualityEngine.setOptions(loadOptions().quality);
        if (activeStrictPrivacyRuntime) {
          qualityEngine.onIdle();
          showQualityChip(false);
        } else if (path === "quality.enabled" && state === "connected") {
          showQualityChip(loadOptions().quality?.enabled !== false);
        }
        return;
      }
      if (path === "route.tunSplitDiscord" && getMode() === "tun") {
        // Выключение split должно подтвердить остановку winws до реконнекта;
        // включение — вернуть его только после успешного старта.
        if (!(await setDpiVpnMode(getMode(), { reevaluate: true }))) return;
      }
      if (!pathNeedsRestart(path, loadOptions(), getMode())) return;
      if (state === "connected" || state === "connecting") {
        scheduleAutoReconnect();
      }
      if (state === "idle") updateHeroHint();
    },
    onSensitiveDataClear: async () => {
      connectAttempts.cancel(); // отменить возможный start_singbox в полёте
      if (!(await shutdownCore())) {
        throw new Error("очистка VPN не подтверждена; данные не удалены");
      }
      try {
        await invoke("dpi_stop");
      } catch (e) {
        throw new Error(`остановка DPI не подтверждена: ${e?.message || e}`, { cause: e });
      }
      try { localStorage.setItem("ninety.dpi.enabled", "false"); } catch {}
      await clearProfileStore();
      clearProfileStorage();
      await invoke("state_backup_clear");
      try { sessionStorage.removeItem("ninety.restore.attempted"); } catch {}
      refreshProfilesSummary();
      rerenderDpiView();
      syncTrayMenu();
      toast(t("settings.general.clearSensitiveDone"), "success", 2400);
    },
    getProtectedBrowserStatus: () => protectedBrowser.status(),
    onProtectedBrowserLaunch: () => requestProtectedBrowserLaunch(),
    onProtectedBrowserCheck: () => requestProtectedBrowserLaunch("https://mullvad.net/en/check"),
    onProtectedBrowserDownload: openProtectedBrowserDownload,
    onRender: () => applySettingsVersion(),
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
  // Latch описывает уже подтверждённый ordinary barrier. Во время
  // proxy↔TUN-transition текущий сохранённый mode может быть TUN, но старый
  // block-all всё равно обязан дожить до final readiness нового runtime.
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

// WebView может перезагрузиться уже после смерти ядра. Backend snapshot тогда
// сообщает running=false, но WFP и RuntimeRecord всё ещё подтверждают активную
// fail-closed policy. Восстанавливаем потерянный JS-latch до любых ранних
// return и оставляем watchdog в guard-only режиме.
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

// Единое гашение ядра: системный прокси → ядро → UI в idle. Все пути
// отключения (ручное, авто-реконнект, watchdog, отказ моста, фейл старта)
// идут через него, чтобы сброс системного прокси не потерялся ни в одном.
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

// Любой уже запущенный runtime, который не совпадает с сохранённой политикой,
// гасится только после fail-closed barrier. Это покрывает startup/WebView reload
// посередине активации, когда JS-latch ещё не восстановлен.
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
      if (!ownedOperationToken) return false;
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
    // Более новый source intent мог прийти, пока предыдущий reconnect уже был в
    // disconnecting. После его подтверждённого stop очередь просыпается в idle —
    // это штатная точка старта latest-профиля, а не причина потерять запрос.
    if (state === "idle") {
      needsReconnect = false;
      applyReconnectUI();
      return runReconnectAttempt(connectNetwork, { epoch, operationToken });
    }
    if (state !== "connected" && state !== "connecting") return false;
    connectAttempts.cancel(); // инвалидировать возможный start_singbox в полёте
    reconnectToastId = toast(reason, "info", 0, { group: "conn", connecting: true });
    const nativeStartWasPending = coreStartBarrier.isPending();
    if (!(await shutdownCore({ preserveKillSwitch: preserveGuard, operationToken }))) {
      if (preserveGuard && isCurrentNetworkIntent(epoch, "connected")) {
        pendingReconnectTimer = setTimeout(
          () => performAutoReconnect(reason, epoch, operationToken),
          5000,
        );
      }
      return false;
    }
    if (!isCurrentNetworkIntent(epoch, "connected")) return false;
    // stop_singbox не может отменить IPC-start, который ещё находится в settle-
    // фазе и не записал child. Ждём его физического завершения, затем повторно
    // гасим поздно поднявшийся комплект. Только после этого стартует новый source.
    if (nativeStartWasPending) {
      await coreStartBarrier.wait();
      if (!isCurrentNetworkIntent(epoch, "connected")) return false;
      if (!(await shutdownCore({ preserveKillSwitch: preserveGuard, operationToken }))) {
        if (preserveGuard && isCurrentNetworkIntent(epoch, "connected")) {
          pendingReconnectTimer = setTimeout(
            () => performAutoReconnect(reason, epoch, operationToken),
            5000,
          );
        }
        return false;
      }
    }
    needsReconnect = false;
    applyReconnectUI();
    return runReconnectAttempt(connectNetwork, { epoch, operationToken });
  } finally {
    if (ownedOperationToken) await completeRuntimeOperation(ownedOperationToken);
    if (reconnectToastId) toast.dismiss(reconnectToastId);
  }
}

async function verifyEmergencyDataplane() {
  try {
    const snapshot = await invoke("runtime_snapshot");
    runtimeSnapshotCache = runtimeEndpointMatchesGeneration(snapshot) ? snapshot : null;
    const expectedGeneration = Number(snapshot?.processGeneration) || 0;
    if (!snapshot?.running || !expectedGeneration) return false;
    const result = await invoke("probe_health", { expectedGeneration });
    return result?.ok === true;
  } catch {
    return false;
  }
}

// Аварийный путь отделён от anti-throttle лесенки: он не спрашивает юзера,
// не использует её часовой бюджет и сначала пробует дешёвое переключение на
// проверенную альтернативу. Если локальный Clash API завис, сразу сработает
// controlled full reconnect через уже существующий lifecycle-барьер.
async function recoverDataplane({ operationToken = null } = {}) {
  if (state !== "connected") return false;
  if (!(await runtimeOperationIsCurrent(operationToken))) return false;
  const token = runtimeIdentity.capture();
  if (!token) return false;

  const nodes = qualityNodesFromSource();
  if (nodes.length >= 2) {
    let proxies;
    try {
      proxies = (await getProxies(undefined, { token, fresh: true }))?.proxies || {};
    } catch {
      proxies = {};
    }
    if (!(await runtimeOperationIsCurrent(operationToken))) return false;
    const originalSelector = pickSelectorNow(proxies) || "auto";
    const originalEffective = currentEffectiveTag || pickEffectiveNode({ proxies });
    const sourceScope = `${token.sourceKey || "source"}:${token.sourceRevision || 0}`;
    const now = Date.now();
    for (const [key, expiry] of dataplaneCandidateCooldown) {
      if (expiry <= now) dataplaneCandidateCooldown.delete(key);
    }
    const current = originalEffective;
    const candidates = rankByDelay(
      nodes.filter((node) => node.clashTag
        && node.clashTag !== current
        && !dataplaneCandidateCooldown.has(`${sourceScope}:${node.clashTag}`)),
      proxies,
    ).slice(0, 3);

    for (const candidate of candidates) {
      if (!(await runtimeOperationIsCurrent(operationToken))
        || !runtimeIdentity.isCurrent(token) || state !== "connected") return false;
      try {
        const tested = await testNode(candidate.clashTag, { token, timeoutMs: 3000 });
        if (!(await runtimeOperationIsCurrent(operationToken))) return false;
        const delay = Number(tested?.delay) || 0;
        if (delay <= 0 || delay >= 65_000) continue;
        const selected = await selectProxy("proxy", candidate.clashTag, { token });
        if (!(await runtimeOperationIsCurrent(operationToken))) return false;
        if (selected?.stale || !runtimeIdentity.isCurrent(token)) continue;
        if (operationToken
          ? await verifyRuntimeOperationDataplane(operationToken)
          : await verifyEmergencyDataplane()) return true;
        dataplaneCandidateCooldown.set(`${sourceScope}:${candidate.clashTag}`, Date.now() + DATAPLANE_CANDIDATE_COOLDOWN_MS);
      } catch {
        // Следующая candidate либо полный reconnect — ниже.
        dataplaneCandidateCooldown.set(`${sourceScope}:${candidate.clashTag}`, Date.now() + DATAPLANE_CANDIDATE_COOLDOWN_MS);
      }
    }

    // Candidate validation may have changed Clash's selector. Restore the
    // original selector before falling back to a full lifecycle reconnect;
    // never leave a failed emergency candidate active by accident.
    if ((await runtimeOperationIsCurrent(operationToken))
      && runtimeIdentity.isCurrent(token) && originalSelector) {
      try {
        const restored = await selectProxy("proxy", originalSelector, { token });
        if (!(await runtimeOperationIsCurrent(operationToken))) return false;
        if (!restored?.stale && originalEffective) currentEffectiveTag = originalEffective;
      } catch {
        // Full reconnect below will still rebuild the original runtime policy.
      }
    }
  }

  if (!(await runtimeOperationIsCurrent(operationToken))) return false;
  const request = beginSourceReconnect(t("conn.applyingSettings"), operationToken);
  if (!request) return false;
  const connected = await request.completion;
  if (!(await runtimeOperationIsCurrent(operationToken))) return false;
  if (!reconnectCompleted(connected) || state !== "connected") return false;
  return operationToken
    ? verifyRuntimeOperationDataplane(operationToken)
    : verifyEmergencyDataplane();
}

async function failDataplane(dataplane = {}, operationToken = null) {
  // Native recovery has already failed closed by the time this callback is
  // reached. If WebView2 is responsive, give the existing bounded candidate /
  // reconnect path one chance to recover the session. The native path remains
  // the safety net when the frontend is hung, and strict privacy keeps its
  // pinned-node policy instead of trying alternate candidates here.
  const strictRuntime = strictPrivacyRequested() || dataplane?.unmonitoredPrivacyMode === true;
  if (!strictRuntime) {
    try {
      if (await recoverDataplane({
        reason: dataplane.reason || "all_candidates_failed",
        snapshot: dataplane,
        operationToken,
      })) return true;
    } catch (error) {
      console.warn("frontend dataplane fallback failed", error);
    }
  }
  const preserved = killSwitchMustSurviveRuntimeStop();
  const closed = await shutdownCore({ preserveKillSwitch: preserved, operationToken });
  if (!closed) return false;
  toast(t("conn.coreStopped"), "error", 7000, { group: "conn", desc: t("conn.coreStoppedDesc") });
  notify(t("conn.notifyClosedTitle"), t("conn.notifyClosedBody"));
  switchView("logs");
  return true;
}

// ── health-watchdog — /lib/health-watchdog.js ──────────────
// Liveness ядер, native dataplane recovery и bridge-reconnect вынесены в модуль;
// здесь инстанс с инжектом
// состояния/реконнекта/движка качества. Алиасы сохраняют имена вызовов из setState
// (start/stopHealthWatchdog) — их не трогаем. getQualityEngine — геттер, т.к.
// qualityEngine определяется ниже по файлу; вызывается только в runtime-тике.
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
  recoverDataplane,
  onDataplaneFailed: failDataplane,
  beginRuntimeOperation: (kind) => beginRuntimeOperation(kind),
  completeRuntimeOperation,
  onDataplaneState: (dataplaneState) => {
    if (dataplaneState === "inactive") return;
    setChannelState(dataplaneState === "failed" ? "DEAD" : "UNKNOWN");
  },
});
const startHealthWatchdog = healthWatchdog.start;
const stopHealthWatchdog = healthWatchdog.stop;

// ── Движок качества связи ──────────────────────────────────
// Декаплинг: движок не знает про DOM/main.js, все «руки» инжектим здесь.
// Ступени лесенки, которых пока нет (R2 exclude-node, R5 switch-transport),
// просто не передаём в actions — движок их пропускает.
const qualityEngine = createQualityEngine({
  invoke,
  actions: {
    // R1 — перевыбор ноды балансером без реконнекта: форсим re-test группы
    // lowest, urltest переберёт живые задержки и подвинет эффективную ноду.
    selectNextNode: async () => {
      const token = runtimeIdentity.capture();
      try { await refreshEffectiveDelay({ timeoutMs: 5000, token }); return runtimeIdentity.isCurrent(token); }
      catch { return false; }
    },
    // R2 — увести с конкретной плохой ноды: текущую кладём на cooldown и вручную
    // выбираем лучшую из оставшихся (selectProxy). Селектор "proxy" собран с
    // interrupt_exist_connections=true → застрявшие соединения рвутся сами. Без
    // реконнекта. false (ступень пропускается) если альтернатив нет.
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
      try { const r = await selectProxy("proxy", pick, { token }); return !r?.stale && runtimeIdentity.isCurrent(token); }
      catch { return false; }
    },
    // R3 — маскировка трафика фрагментацией TLS (реконнект). Если выключена —
    // включаем; если уже включена — эскалируем сменой режима record↔tcp.
    applyFragmentation: async () => {
      const token = runtimeIdentity.capture();
      if (!token || !runtimeIdentity.isCurrent(token)) return false;
      // НЕ называть локальную переменную t: затенение i18n-функции здесь уже
      // ломало R3 (TypeError после updateOption → настройки мутировали без
      // реконнекта, лесенка щёлкала record↔tcp вхолостую).
      const tricks = loadOptions().tlsTricks;
      if (!tricks.enableFragment) {
        updateOption("tlsTricks.enableFragment", true);
      } else {
        updateOption("tlsTricks.fragmentMode", tricks.fragmentMode === "record" ? "tcp" : "record");
      }
      return reconnectForQualityRemediation(t("qToast.masking"));
    },
    // R4 — пересканировать WARP-endpoint и применить лучший (реконнект). Только
    // если WARP включён, иначе ступень неприменима → false (движок пропустит).
    rescanWarp: async () => {
      const token = runtimeIdentity.capture();
      if (!token) return false;
      if (!loadOptions().warp.enabled) return false;
      try {
        // warp_scan_endpoints отдаёт ScanResult[] с полями ip/port (scanner.rs) —
        // прежний код ждал endpoint/host, всегда получал null и ступень
        // молча пропускалась (R4 был мёртв).
        const res = await invoke("warp_scan_endpoints", { topN: 5, deep: false, mode: "auto" });
        if (!runtimeIdentity.isCurrent(token) || !loadOptions().warp.enabled) return false;
        const best = Array.isArray(res) ? res[0] : null;
        if (!best?.ip || !best?.port) return false;
        updateOption("warp.endpoint", `${best.ip}:${best.port}`);
        return reconnectForQualityRemediation(t("qToast.backup"));
      } catch { return false; }
    },
    // R5 — перейти на ноду ДРУГОГО транспорта/протокола (proto:type), лучшую по
    // пингу: меняет саму сигнатуру трафика на проводе. selectProxy + interrupt →
    // застрявшие соединения рвутся, реконнект ядра не нужен. false если ноды
    // другого транспорта в источнике нет.
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
      try { const r = await selectProxy("proxy", pick, { token }); return !r?.stale && runtimeIdentity.isCurrent(token); }
      catch { return false; }
    },
    // Гибрид-гейт перед реконнект-ступенью (когда aggressive=false). Простым языком.
    // Окно в трее → нативный confirm повис бы невидимым и заблокировал лесенку
    // (remediating не снимается, пока промис висит). Вместо этого OS-уведомление
    // и отказ от дорогой ступени: юзер вернётся к окну — следующий прогон
    // лесенки спросит нормально.
    confirmReconnect: async (label) => {
      if (!(await windowIsForeground())) {
        notify(t("qToast.hiddenNotifyTitle"), t("qToast.hiddenNotifyBody"));
        return false;
      }
      return confirm(t("qToast.confirmSpeedup", { label }));
    },
    // R6 — сдаёмся честно, без жаргона.
    giveUp: (st) => {
      toast(t("qToast.giveUp"), "error", 8000, {
        group: "quality",
        desc: t("qToast.giveUpDesc"),
      });
      notify(t("qToast.giveUpNotifyTitle"), t("qToast.giveUpNotifyBody"));
    },
    // Контекст для обучения (что было активно в момент успеха).
    getContext: () => {
      const o = loadOptions();
      return {
        node: currentEffectiveNode?.name || currentEffectiveNode?.host || null,
        tlsTrick: o.tlsTricks.enableFragment ? o.tlsTricks.fragmentMode : null,
        warpEndpoint: o.warp.enabled ? o.warp.endpoint : null,
      };
    },
    // ASN локального ISP (не exit'а): ip-info БЕЗ proxy-арга → напрямую. Даже в
    // TUN этот запрос идёт мимо туннеля (собственный трафик Ninety.exe уходит в
    // direct bypass-правилом), поэтому вернётся именно локальный ISP — то, что
    // нужно для ключа обучения ISP×час. Фолбэк "unknown".
    localAsn: async () => {
      // Приватность: этот запрос идёт НАПРЯМУЮ (мимо туннеля) и раскрыл бы
      // реальный IP geo-сервису. Если юзер отключил geo-lookup — не ходим,
      // движок качества обучается по глобальному профилю (ASN "unknown").
      if (strictPrivacyRequested() || loadOptions().general?.disableGeoLookup) return "unknown";
      try {
        const info = await invoke("fetch_public_ip", {});
        const asn = info?.connection?.asn ?? info?.asn;
        return asn != null ? String(asn) : "unknown";
      } catch { return "unknown"; }
    },
    onState: (st) => {
      if (!qualityDot) return;
      setChannelState(st);
      if (qualityDot.dataset.active !== "true") qualityDot.dataset.active = "true";
    },
    // Каждая проба → в шину; осциллограмма канала (раскрытый чип) подписана на неё.
    onSample: (s) => bus.emit("quality:sample", s),
    toast, notify,
    log: (m) => console.info("[quality]", m),
  },
});

// ── Хелперы лесенки качества (R2/R5) ───────────────────────
// Cooldown нод, забракованных R2 — чтобы не выбирать их снова сразу.
const QUALITY_EXCLUDE_MS = 5 * 60_000;
const qualityExcluded = new Map(); // clashTag → expiry ts
const DATAPLANE_CANDIDATE_COOLDOWN_MS = 5 * 60_000;
const dataplaneCandidateCooldown = new Map(); // source/revision/tag → expiry ts
// Ноды активного источника с clash-тэгами (зеркало proxies-view.nodesFromSource).
function qualityNodesFromSource() {
  const src = getActiveSource();
  if (!src) return [];
  const raw = src.kind === "sub" ? (src.nodes || []) : [src.profile];
  const list = raw.filter(Boolean);
  return list.map((n, i) => ({ ...n, clashTag: list.length >= 2 ? nodeTag(i, n) : "proxy" }));
}
// Класс транспорта ноды (протокол + сеть). R5 ищет ноду с ДРУГИМ классом.
function transportClass(n) {
  return `${n?.proto || "vless"}:${n?.type || "-"}`;
}
// Сортировка нод по живому пингу (без пинга — в конец).
function rankByDelay(nodes, proxies) {
  return nodes
    .map(n => ({ ...n, _d: lastDelay(proxies[n.clashTag]) }))
    .sort((a, b) => {
      const da = Number.isFinite(a._d) && a._d > 0 ? a._d : Infinity;
      const db = Number.isFinite(b._d) && b._d > 0 ? b._d : Infinity;
      return da - db;
    });
}

// ── Индикатор качества канала (ячейка «Канал» в телеметрии-полосе) ──
// Состояние правит движок через onState; ячейка живёт в stats-strip (secured),
// показывается/прячается вместе с полосой. Человеческий язык, без техножаргона.
const qChannelLabel = (st) => t("qToast.channel." + String(st).toLowerCase());
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
// Клик по ячейке «Канал» при активном мониторинге → осциллограмма goodput-проб.
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

// Сменился активный источник (подписка/профиль) при поднятом VPN — немедленно
// пересобираем конфиг с новыми нодами. Без дебаунса (явное действие юзера),
// в отличие от scheduleAutoReconnect для правок настроек. Реконнект уходит в
// idle (сбросит currentEffectiveNode) → buildConfig читает свежий getActiveSource()
// → AUTO-селектор по новым нодам, они пингуются URLTest'ом.
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

// Quality engine обязан получить результат уже НОВОЙ сессии: только после
// подтверждённого connect можно учитывать дорогую ступень и проверять эффект.
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
    return verifyRuntimeOperationDataplane(operationToken);
  } catch {
    return false;
  } finally {
    await completeRuntimeOperation(operationToken);
  }
}

// Единая активация источника (подписка/профиль). Зовётся И из pmenu «Сделать
// активным», И из клика по телу карточки — раньше реконнект был только в pmenu,
// поэтому клик по карточке менял активный источник, а VPN оставался на старом
// конфиге. При поднятом VPN и реальной смене источника — немедленный реконнект.
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
    resetQuality: () => { qualityExcluded.clear(); qualityEngine.onIdle(); },
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
    console.warn(`unable to begin ${kind} runtime operation`, error);
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

async function runtimeOperationIsCurrent(operationToken) {
  if (networkIntent.desired() !== "connected" || state !== "connected") return false;
  if (!operationToken) return true;
  try {
    const active = await invoke("runtime_operation_snapshot");
    return active?.id === operationToken.id && active.cancelled !== true;
  } catch {
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
      // A fresh lowest-delay balancer falls back to the first node until its
      // URLTest group publishes delays. Force one bounded initial pass so one
      // dead first node cannot make a healthy multi-node subscription appear
      // offline to the source verifier.
      try {
        await testGroup("lowest", { token: runtimeToken, timeoutMs: 4500 });
      } catch {
        logSourceSwitchReconnect("selector", token, "unverified", "urltest_not_converged");
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

function applyActiveSource(kind, id, options = {}) {
  const target = { kind: kind === "sub" ? "sub" : "single", id };
  if (sameSourceRef(activeSourceRef(), target)) {
    return Promise.resolve({ changed: false, ready: true, target });
  }
  const shouldReconnect = options.reconnect !== false
    && networkIntent.desired() === "connected";
  const isSub = target.kind === "sub";
  return sourceSwitchController.activate(target, {
    reconnect: shouldReconnect,
    silent: !!options.silent,
    reason: options.reason || (isSub ? t("conn.switchSub") : t("conn.switchProfile")),
    rollbackReason: t("conn.restorePrevious"),
  });
}

function activateSource(kind, id) {
  return applyActiveSource(kind, id);
}

function sourceById(kind, id) {
  if (kind === "sub") {
    const subscription = loadSubscriptions().find(s => s.id === id);
    return subscription ? { kind: "sub", subscription, nodes: subscription.profiles || [] } : null;
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
configureTrafficRuntime(runtimeIdentity);

sourceSwitchController = createSourceSwitchController({
  getActiveSource: activeSourceRef,
  applySource: (source) => commitActiveSource(source.kind, source.id),
  reconnect: reconnectCommittedSource,
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
  resetQuality: () => { qualityExcluded.clear(); qualityEngine.onIdle(); },
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

async function deleteSource(kind, id) {
  const plan = planSourceDeletion({
    kind, id, activeKey: sourceKey(getActiveSource()),
    subscriptions: loadSubscriptions(), profiles: loadProfiles(), state,
  });
  const { active: isActive, fallback } = plan;

  if (plan.mustStopBeforeDelete) {
    connectAttempts.cancel();
    const stopped = await shutdownCore();
    if (!stopped) return false;
  }

  if (kind === "sub") removeSubscription(id);
  else removeProfile(id);

  if (isActive && fallback) {
    // remove* выбирает fallback внутри своего типа. Сбрасываем этот скрытый
    // side-effect, чтобы applyActiveSource видел настоящую смену и дал один reconnect.
    if (fallback.kind === "sub") {
      setActiveProfileId(null);
      setActiveSubscriptionId(null);
      setActiveKind("single");
    } else {
      setActiveSubscriptionId(null);
      setActiveProfileId(null);
      setActiveKind("sub");
    }
    applyActiveSource(fallback.kind, fallback.id, { reason: t("conn.applyingSettings") });
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

// ── WARP UX (hero badge + авто-ротация + история) — /lib/warp-rescan.js ──
// Подсистема вынесена в модуль; здесь только инстанс с инжектом состояния/реконнекта.
// Алиасы сохраняют прежние имена вызовов (updateWarpBadge/start/stopWarpRescanLoop),
// разбросанные по setState/onChange/warp-switch — их не трогаем.
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

// ── Logs view — вынесен в /lib/logs-view.js ────────────────
mountLogsView();

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
const ICON_GLOBE   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></svg>`;
const ICON_FILE    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></svg>`;

function renderProfilesView() {
  if (!profilesList) return;
  const profsList = loadProfiles();
  const subsList = loadSubscriptions();
  const activeProfileId = getActiveProfileId();
  const activeKind = getActiveKind();
  const activeSubId = getActiveSubscriptionId();

  if (profsList.length === 0 && subsList.length === 0) {
    profilesList.innerHTML = `
      <div class="onb" style="margin: 32px auto 0; text-align: center;">
        <div class="onb__kicker">SUBSCRIPTIONS · EMPTY</div>
        <h2 class="onb__title" style="font-size:20px">${t("prof.emptyTitle")}</h2>
        <p class="onb__sub">${t("prof.emptySub")}</p>
      </div>
    `;
    return;
  }

  const subItems = subsList.map(s => {
    const isActive = activeKind === "sub" && s.id === activeSubId;
    const days = subscriptionDaysLeft(s);
    const used = subscriptionUsedBytes(s);
    const limit = subscriptionLimitBytes(s); // null = безлимит (total=0)
    const updated = relativeTime(s.lastUpdate) || "—";
    const nodesCount = s.profiles?.length || 0;
    const trafficStr = limit != null
      ? `${fmtTraffic(used)} / ${fmtTraffic(limit)}`
      : `${fmtTraffic(getMeasured(`sub:${s.id}`).total)} · ∞`;
    return `
      <article class="prof-card" data-active="${isActive}" data-sub-id="${escapeAttr(s.id)}">
        <div class="prof-card__icon">${ICON_GLOBE}</div>
        <div class="prof-card__main" data-sub-activate="${escapeAttr(s.id)}">
          <div class="prof-card__head">
            <span class="prof-card__name">${escapeHtml(s.name)}</span>
            ${isActive ? `<span class="prof-card__badge">${t("prof.badgeActive")}</span>` : ""}
          </div>
          <div class="prof-card__url">${escapeHtml(s.url || "")}</div>
        </div>
        <div class="prof-card__stats">
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${nodesCount}</span>
            <span class="prof-card__stat-lbl">${t("prof.statNodes")}</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${trafficStr}</span>
            <span class="prof-card__stat-lbl">${t("prof.statTraffic")}</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${days == null ? "—" : days}${days != null ? `<span style="color:var(--text-faint);font-size:9px;margin-left:3px;">${t("prof.daysUnit")}</span>` : ""}</span>
            <span class="prof-card__stat-lbl">${t("prof.statExpires")}</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val" style="font-size:11px;color:var(--text-mid);">${escapeHtml(updated)}</span>
            <span class="prof-card__stat-lbl">${t("prof.statUpdated")}</span>
          </div>
        </div>
        <button class="prof-card__menu" data-menu-sub="${escapeAttr(s.id)}" type="button" aria-label="${escapeAttr(t("prof.menuAria"))}">${ICON_DOTS}</button>
      </article>
    `;
  }).join("");

  const profileItems = profsList.map(p => {
    const isActive = activeKind === "single" && p.id === activeProfileId;
    const proto = (p.proto || "vless").toUpperCase();
    const security = (p.security || "tcp").toUpperCase();
    return `
      <article class="prof-card" data-active="${isActive}" data-id="${escapeAttr(p.id)}">
        <div class="prof-card__icon">${ICON_FILE}</div>
        <div class="prof-card__main" data-profile-activate="${escapeAttr(p.id)}">
          <div class="prof-card__head">
            <span class="prof-card__name">${escapeHtml(p.name)}</span>
            ${isActive ? `<span class="prof-card__badge">${t("prof.badgeActive")}</span>` : ""}
          </div>
          <div class="prof-card__url">${escapeHtml(`${p.host}:${p.port}`)}</div>
        </div>
        <div class="prof-card__stats">
          <div class="prof-card__stat">
            <span class="prof-card__stat-val" style="font-size:11px;">${escapeHtml(proto)}</span>
            <span class="prof-card__stat-lbl">${t("prof.statProto")}</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val" style="font-size:11px;">${escapeHtml(security)}</span>
            <span class="prof-card__stat-lbl">TLS</span>
          </div>
          <div class="prof-card__stat">
            <span class="prof-card__stat-val tnum">${fmtTraffic(getMeasured(`profile:${p.id}`).total)}</span>
            <span class="prof-card__stat-lbl">${t("prof.statTraffic")}</span>
          </div>
        </div>
        <button class="prof-card__menu" data-menu-profile="${escapeAttr(p.id)}" type="button" aria-label="${escapeAttr(t("prof.menuAria"))}">${ICON_DOTS}</button>
      </article>
    `;
  }).join("");

  profilesList.innerHTML = `${subItems}${profileItems}`;
}

// Кнопки header'а profiles экрана
document.getElementById("profiles-add")?.addEventListener("click", () => openAddModal());

// ── Onboarding wizard (импорт → подключение → готово) ───────
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
  populateOnbPrefs();
  showOnbStep(step);
}
function closeWizard() {
  markOnboardingDone();
  wizardActive = false;
  if (appRoot) appRoot.dataset.wizard = "false";
  syncEmptyState();
}

// Делегированные обработчики кнопок wizard
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
    if (!wizardActive) openWizardAt(1); // на всякий случай — фиксируем wizard-state
    try {
      const text = await navigator.clipboard.readText();
      openAddModal({ prefillUrl: (text || "").trim() });
    } catch { openAddModal(); }
  } else if (action === "manual") {
    if (!wizardActive) openWizardAt(1);
    openAddModal();
  }
});
// ── Онбординг · пикеры язык/регион/тема (Hiddify-style welcome) ──────────────
// Подписи локализованы (t / availableLangs), тема и регион применяются сразу.
function populateOnbPrefs() {
  const langSel = document.getElementById("onb-lang");
  const regionSel = document.getElementById("onb-region");
  const themesWrap = document.getElementById("onb-themes");
  if (langSel) {
    langSel.innerHTML = availableLangs()
      .map(l => `<option value="${escapeAttr(l.code)}"${l.code === getLang() ? " selected" : ""}>${escapeHtml(l.name)}</option>`)
      .join("");
  }
  if (regionSel) {
    const cur = loadOptions().region;
    regionSel.innerHTML = REGIONS
      .map(r => `<option value="${escapeAttr(r)}"${r === cur ? " selected" : ""}>${escapeHtml(t("region." + r))}</option>`)
      .join("");
  }
  if (themesWrap) {
    const cur = getTheme();
    themesWrap.innerHTML = THEMES
      .map(theme => `<button type="button" class="onb-theme${theme.id === cur ? " onb-theme--on" : ""}" data-onb-theme="${escapeAttr(theme.id)}" title="${escapeAttr(theme.name)}" style="--sw:${escapeAttr(theme.accent)}"></button>`)
      .join("");
  }
}

// Первый запуск: регион предвыбран по таймзоне (один раз; выбор вернувшегося юзера не трогаем).
if (!localStorage.getItem("ninety.region.detected") && !isOnboardingDone()) {
  updateOption("region", detectRegion());
  localStorage.setItem("ninety.region.detected", "1");
}

document.getElementById("onb-lang")?.addEventListener("change", (e) => { setLang(e.target.value); });
document.getElementById("onb-region")?.addEventListener("change", (e) => {
  updateOption("region", e.target.value);
  localStorage.setItem("ninety.region.detected", "1");
});
document.getElementById("onb-themes")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-onb-theme]");
  if (!b) return;
  setTheme(b.dataset.onbTheme);
  populateOnbPrefs();
});

// Живой ре-рендер при смене языка: static-строки index.html + подписи пикеров + динамика главной.
onLangChange(() => {
  applyDom(document);
  applySidebarState();
  populateOnbPrefs();
  refreshDynamicText();
  settingsCtl?.refresh();
  syncTrayMenu(); // меню/tooltip трея — на новый язык
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
  rerenderLogsView(); // no-op, если экран Логи не активен
});

// Перерисовать динамические подписи главной (статус hero, подсказка режима, режим в
// телеметрии) без побочных эффектов — сессии/таймеры/ядро не трогаем.
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
}

populateOnbPrefs();

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

// Popup-меню действий
let openMenu = null;
function closePMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener("click", onDocClickClosePMenu); }
}
function onDocClickClosePMenu(e) {
  if (openMenu && !openMenu.contains(e.target)) closePMenu();
}
function openPMenu(anchor, items) {
  closePMenu();
  const menu = document.createElement("div");
  menu.className = "pmenu";
  menu.innerHTML = items.map(it => `
    <button class="pmenu__item${it.danger ? " pmenu__item--danger" : ""}" data-act="${escapeAttr(it.id)}" type="button">
      ${it.icon || ""}<span>${escapeHtml(it.label)}</span>
    </button>
  `).join("");
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left;
  if (top + m.height > window.innerHeight - 12) top = rect.top - m.height - 6;
  if (left + m.width > window.innerWidth - 12) left = window.innerWidth - m.width - 12;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  openMenu = menu;
  setTimeout(() => document.addEventListener("click", onDocClickClosePMenu), 10);
  return menu;
}

profilesView?.addEventListener("click", async (e) => {
  // FAB → открыть add-modal
  if (e.target.closest("#profiles-fab")) {
    openAddModal();
    return;
  }

  // Меню (3 точки) подписки
  const subMenuBtn = e.target.closest("[data-menu-sub]");
  if (subMenuBtn) {
    e.stopPropagation();
    const id = subMenuBtn.dataset.menuSub;
    const menu = openPMenu(subMenuBtn, [
      { id: "refresh",  label: t("prof.menu.refresh"),  icon: ICON_REFRESH },
      { id: "edit",     label: t("prof.menu.edit"), icon: ICON_EDIT },
      { id: "copy",     label: t("prof.menu.copyUrl"), icon: ICON_COPY },
      { id: "qr",       label: t("prof.menu.qr"), icon: ICON_QR },
      { id: "export",   label: t("prof.menu.export"), icon: ICON_COPY },
      { id: "activate", label: t("prof.menu.activateSub"), icon: ICON_CHECK },
      { id: "reset-traffic", label: t("prof.menu.resetTraffic"), icon: ICON_REFRESH },
      { id: "remove",   label: t("prof.menu.remove"),   icon: ICON_TRASH, danger: true },
    ]);
    menu.addEventListener("click", async (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      closePMenu();
      if (act === "edit") {
        const sub = loadSubscriptions().find(s => s.id === id);
        const before = sourceFingerprint(sourceById("sub", id));
        if (sub) openEditSubscription(sub, {
          onSaved: () => mutateSource("sub", id, async () => sub, t("conn.applyingSettings"), before),
          onToast: toast,
        });
        return;
      }
      if (act === "refresh") {
        try {
          const tx = await mutateSource("sub", id, () => refreshSubscription(id), t("conn.applyingSettings"));
          const r = tx.result;
          toast(t("prof.toastUpdated", { n: r.profiles.length }), "success", 1800);
        } catch (err) {
          toast(t("prof.toastErr", { err: err?.message || err }), "error", 2800);
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
    });
    return;
  }

  // Меню (3 точки) одиночного профиля
  const profileMenuBtn = e.target.closest("[data-menu-profile]");
  if (profileMenuBtn) {
    e.stopPropagation();
    const id = profileMenuBtn.dataset.menuProfile;
    const menu = openPMenu(profileMenuBtn, [
      { id: "edit",     label: t("prof.menu.edit"),    icon: ICON_EDIT },
      { id: "activate", label: t("prof.menu.activateProfile"), icon: ICON_CHECK },
      { id: "reset-traffic", label: t("prof.menu.resetTraffic"), icon: ICON_REFRESH },
      { id: "remove",   label: t("prof.menu.remove"),          icon: ICON_TRASH, danger: true },
    ]);
    menu.addEventListener("click", async (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      closePMenu();
      if (act === "edit") {
        const p = loadProfiles().find(x => x.id === id);
        const before = sourceFingerprint(sourceById("single", id));
        if (p) openEditProfile(p, {
          onSaved: () => mutateSource("single", id, async () => p, t("conn.applyingSettings"), before),
          onToast: toast,
        });
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
    });
    return;
  }

  // Клик по телу карточки → активация (Hiddify-стиль)
  const subActivate = e.target.closest("[data-sub-activate]");
  if (subActivate) {
    activateSource("sub", subActivate.dataset.subActivate);
    return;
  }
  const profileActivate = e.target.closest("[data-profile-activate]");
  if (profileActivate) {
    activateSource("single", profileActivate.dataset.profileActivate);
    return;
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
// Телеметрия-полоса (secured): Пинг · Канал · Сессия
const telePing = document.getElementById("tele-ping");
const statsPing = document.getElementById("stats-ping");
const statsUptime = document.getElementById("stats-uptime");
const statsTotal = document.getElementById("stats-total");
const locPing = document.getElementById("loc-ping");
const locIpRow = document.getElementById("loc-ip-row");
const locIp = document.getElementById("loc-ip");

// Мап-имена для CSS data-state
const STATE_HERO = {
  idle: "standby", connecting: "linking", connected: "secured",
  disconnecting: "linking", cleanup_error: "standby",
};
const STATE_KICKER = {
  idle:       "STAND-BY · DISCONNECTED",
  connecting: "LINKING · NEGOTIATING",
  disconnecting: "DISCONNECTING · CLEANUP",
  connected:  "SECURED · TUNNEL ACTIVE", // дефолт; в connected берём connectedKicker() по режиму
};
// Kicker в состоянии connected зависит от режима: TUNNEL ACTIVE только в TUN,
// системный прокси → SYSTEM PROXY, прокси → PROXY ACTIVE (раньше всегда «TUNNEL ACTIVE»).
const CONNECTED_KICKER = {
  tun:         "SECURED · TUNNEL ACTIVE",
  systemProxy: "SECURED · SYSTEM PROXY",
  proxy:       "SECURED · PROXY ACTIVE",
};
function connectedKicker() { return CONNECTED_KICKER[getMode()] || STATE_KICKER.connected; }
const modeLabel = (m) => t("mode." + m);

// Кибер-HUD вокруг маски (lib/hero-hud.js). Инициализируется ниже, после
// объявления `state` — getState читает его лениво из замыкания.
let heroHud = null;

function applyHeroState(internalState) {
  if (!hero) return;
  const ds = STATE_HERO[internalState] || "standby";
  hero.dataset.state = ds;
  heroHud?.sync(); // обновить SYSTEM STATUS / TARGET / INTEGRITY / ERR под состояние
}

// Stats-strip vs Location-card: connected → stats-strip с live-метриками.
// Когда VPN выключен (idle/connecting) — нижняя плитка сервера не нужна,
// прячем обе (раньше показывали loc-card в standby — лишний шум).
function applyHomeBottom(internalState) {
  if (!locCard || !statsStrip) return;
  locCard.hidden = true;
  // Stats-strip ВСЕГДА в потоке (держит высоту), видимой делаем только в connected.
  // Иначе её появление при connect сжимает .hero снизу → центрированная сцена/маска
  // уезжает вверх (а при disconnect — обратно вниз). Резерв места = сцена не двигается.
  statsStrip.hidden = false;
  statsStrip.classList.toggle("stats--reserved", internalState !== "connected");
}

// Активный сервер в stats-strip — обновляется при connect и смене effective-ноды.
function updateStatsServer() {
  if (!statsServer) return;
  const p = activeNodeForDisplay();
  // Имя без флаг-эмодзи: страну уже показывает SVG-флаг в ячейке (иначе дубль флага).
  const label = stripFlag(p?.name) || p?.host || "—";
  statsServer.textContent = label;
  statsServer.title = label;
  if (statsFlag) {
    const iso = p ? (isoFromNodeName(p.name) || isoFromNodeName(p.host)) : null;
    statsFlag.innerHTML = iso ? `<img src="${FLAGS_BASE}/${iso}.svg" alt="">` : "";
    statsFlag.hidden = !iso;
  }
  heroHud?.sync(); // эффективная нода сменилась → перечитать TARGET LOCKED в HUD
}

let lastPublicIp = null;
if (locIp) bindIpReveal(locIp, () => lastPublicIp);

async function refreshPublicIp(epoch = connectAttempts.current()) {
  if (state !== "connected" || !connectAttempts.isCurrent(epoch)) return;
  // Приватность: юзер отключил geo-запросы → не дёргаем внешние IP-сервисы
  // вовсе, IP-плитка гаснет с поясняющим тултипом.
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
  // IP всегда тянем ЧЕРЕЗ локальный inbound sing-box, во всех режимах:
  //   proxy/systemProxy — mixed-in (reqwest системный прокси не чтит, поэтому
  //     даже в systemProxy без явного адреса запрос ушёл бы напрямую → мимо
  //     туннеля и показывал бы реальный IP юзера);
  //   tun — probe-in слушает тот же порт; «напрямую» нельзя, т.к. собственный
  //     трафик Ninety.exe в TUN уходит в direct bypass-правилом (защита от петли)
  //     и IP-сервис увидел бы реальный IP, а не exit.
  const proxyHostPort = runtimeProbeHostPort();
  if (!proxyHostPort) return;
  try {
    const info = await fetchPublicIp({ proxyHostPort });
    if (state !== "connected" || !connectAttempts.isCurrent(epoch)) return;
    if (!info?.success && info?.ip == null) {
      // Rust нормализует ответ (fetch_public_ip перебирает провайдеров); при
      // неуспехе всех обычно летит Err → catch, эта ветка — страховка.
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

// флаги: FLAGS_BASE + isoFromNodeName импортированы из /lib/flags.js
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
// Поколение попытки подключения: «Отключить» во время старта ядра инкрементит
// его, и завершившийся start_singbox видит отмену (см. heroDisc-обработчик) —
// раньше быстрый connect→cancel всё равно заканчивался «Защищено».
const connectAttempts = createConnectionAttemptGate();

// Запускаем HUD после объявления state. TARGET читает фактический сервер.
function hudTarget() {
  // Тот же источник, что ячейка «Сервер» телеметрии (activeNodeForDisplay) — HUD-таргет
  // всегда совпадает с реально выбранной нодой. Балансировщик подписки выбирает сервер
  // уже ПОСЛЕ старта ядра, поэтому при коннекте сюда раньше попадал nodes[0] (Germany #1),
  // а телеметрия позже показывала фактический (Latvia #2) — теперь оба тянут одно и то же.
  const p = activeNodeForDisplay();
  const l = stripFlag(p?.name) || p?.host || "190X4";
  return l.toUpperCase().replace(/\s+/g, "-").slice(0, 16);
}
heroHud = initHeroHud(document.getElementById("hero-hud"), {
  getState: () => STATE_HERO[state] || "standby",
  getTarget: hudTarget,
});

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

// Текущая нода через которую реально идёт трафик — приходит из clash-API
// event'ом ninety:node-changed. Когда null — fallback на nodes[0]/profile.
let currentEffectiveNode = null;
let currentEffectiveTag = null;

function activeNodeForDisplay() {
  if (currentEffectiveNode) return currentEffectiveNode;
  const src = activeDisplaySource();
  return src?.kind === "sub" ? src.nodes[0] : src?.profile;
}

// Имя ноды как в списке нод (не адрес). host — запасной вариант.
function nodeDisplayLabel(n) {
  return n?.name || n?.host || "";
}

// Гарантированно непустое имя сервера для тоста/уведомления. Цепочка фолбэков:
// фактическая нода из clash → первая нода/профиль источника → имя подписки.
// Возвращает "" только если активного источника вообще нет.
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

// OS-уведомление + догоняющий тост о подключении с ИМЕНЕМ реально выбранной
// ноды. Для подписки из >=2 нод балансировщик выбирает сервер уже ПОСЛЕ старта
// ядра — опрашиваем clash, пока не появится фактический сервер (до ~3.5с),
// иначе показали бы nodes[0] (первый в списке), а не фактический. Для одиночного
// профиля нода одна — ждать нечего.
async function notifyConnectedWithRealNode(isMultiSub) {
  if (isMultiSub) {
    for (let i = 0; i < 7; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (state !== "connected") return; // успели отключиться
      try { await syncEffectiveFromClash(); } catch {}
      if (currentEffectiveNode) break;
    }
  }
  if (state !== "connected") return;
  const label = resolveServerLabel();
  // Для подписки стартовый тост был обобщённым (балансировщик ещё не выбрал) —
  // догоняем реальным сервером, когда он стал известен.
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
    qualityEngine.onIdle();
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
    qualityEngine.onIdle();
    // Остановка подтверждается backend'ом (процессы завершены, порты освобождены),
    // поэтому это отдельное переходное состояние, а не новый connect.
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
    qualityEngine.onIdle();
    if (heroLabel) heroLabel.textContent = t("conn.cleanupFail");
    if (heroDisc && !networkBootstrapInProgress) heroDisc.disabled = false;
    toast(t("conn.cleanupFail"), "error", 6000, { desc: t("conn.cleanupFailDesc") });
  } else if (next === "connected") {
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
    // Учёт реально измеренного трафика активного источника (для гибрид-плитки).
    startMeter({
      sourceKey: sourceKeyOf(activeDisplaySource()),
      token: runtimeIdentity.capture(),
      onUpdate: refreshSubCardFromActive,
    });
    if (!activeStrictPrivacyRuntime) startWarpRescanLoop();
    else stopWarpRescanLoop();
    startHealthWatchdog();
    // DNS-watchdog: если direct-DNS ляжет в середине сессии — переключит на резерв
    // и реконнектит (sing-box перечитает DNS из свежего конфига).
    if (!activeStrictPrivacyRuntime) {
      startDnsGuard({
        toast,
        isConnected: () => state === "connected",
        onDnsSwitched: () => reconnectForSourceChange(t("dns.reconnect")),
      });
    } else {
      // Строгий runtime использует собственный фиксированный IP-hosted DoH.
      // Watchdog читает/меняет сохранённый direct-DNS и потому здесь не нужен.
      stopDnsGuard();
    }
    // Проба всегда через локальный инбаунд sing-box: mixed-in (proxy/systemProxy)
    // либо probe-in (TUN, тот же порт). «Напрямую» в TUN нельзя — bypass-правило
    // Ninety.exe увело бы пробу в direct, и мерился бы голый канал, а не туннель.
    if (activeStrictPrivacyRuntime) {
      qualityEngine.onIdle();
      showQualityChip(false);
    } else {
      qualityEngine.onConnected({
        ...loadOptions().quality,
        expectedGeneration: runtimeIdentity.capture()?.processGeneration || null,
      });
      showQualityChip(loadOptions().quality?.enabled !== false);
    }
    updateWarpBadge();
    // DPI-обход: вносим сервер активной ноды в исключения winws, чтобы он не
    // трогал зашифрованный трафик к VPN-серверу (главный риск из спайка).
    try { excludeVpnNode(activeNodeForDisplay()?.host); } catch {}
    // Эндпоинты апдейта стали достижимы через туннель — дочекать, если прямые
    // проверки не проходили (у части провайдеров gitlab/github режутся напрямую).
    updateCheckIfStale();
    // Wizard: подключились — переходим на финальный шаг.
    if (wizardActive && wizardStepNum === 2) showOnbStep(3);
    maybeAutoLaunchProtectedBrowser();
  }

  syncTrayMenu();
  runtimeIdleGate.notify();
}

// Единый рендерер пинга: ячейка «Пинг» телеметрии + location-card.
// delay > 0 && < 65000 → число + grade; 0/null → "— мс"; >= 65000 → "Тайм-аут"
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

// ── Сессия (телеметрия secured): аптайм + накопленные тоталы ──
// Мгновенная скорость живёт в сайдбаре; здесь — суммарный объём за сессию.
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

// ── real-time WS-стрим из clash-API ────────────────────────
function applyTrafficValues({ up, down }) {
  if (state !== "connected" || !runtimeIdentity.capture()) return;
  qualityEngine.updatePassive({ down });
  // down/up — байт/сек; интегрируем в session-тоталы (тик ≈ 1с).
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

// Клик по ячейке «Пинг» = принудительный force-test задержки текущей ноды.
// При timeout/недоступности — показываем «Тайм-аут».
let manualTestInFlight = false;
telePing?.addEventListener("click", async () => {
  if (state !== "connected") return;
  if (manualTestInFlight) return;
  manualTestInFlight = true;
  const token = runtimeIdentity.capture();
  telePing.dataset.testing = "true";
  if (statsPing) statsPing.textContent = "···";
  try {
    // Hiddify-style: клик = тест URLTest-ГРУППЫ (как urlTest("")), а не одиночный
    // /proxies/{name}/delay. Число читается из history эффективной ноды → совпадает
    // со списком нод. Подробности в refreshEffectiveDelay.
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
        // Эффективная нода реально поменялась (URLTest перевыбрал или юзер выбрал)
        syncEffectiveFromClash({ knownTag: tag, token });
      },
    });
  } catch (e) {
    console.warn("startClashStream failed", e);
  }
  if (state !== "connected" || !connectAttempts.isCurrent(epoch) || !runtimeIdentity.isCurrent(token)) return;
  // Публичный IP — отложенно (sing-box секунду стартует), потом раз в 5 мин
  setTimeout(() => refreshPublicIp(epoch), 2500);
  if (publicIpTimer) clearInterval(publicIpTimer);
  publicIpTimer = setInterval(() => refreshPublicIp(epoch), 5 * 60_000);
}

// Подтягивает effective node через clash → обновляет hero/location/IP.
// Если knownTag передан — используем его (без лишнего запроса в clash).
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
  // Тэг outbound'а — единая формула из singbox.js (nodeTag), чтобы не разъезжалось.
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
    // Сервер реально сменился — IP надо перечитать
    if (locIp) locIp.textContent = "— · —";
    setTimeout(refreshPublicIp, 600);
  }
  return true;
}

// Слушаем событие из proxies-view: юзер кликнул ноду / URLTest переключился
window.addEventListener("ninety:node-changed", (ev) => {
  const tag = ev.detail?.tag;
  syncEffectiveFromClash({ knownTag: tag });
});

// DPI-обход и выбранная нода — критическое состояние: кроме localStorage сразу
// обновляем дисковый снапшот. Иначе после очистки WebView2 мог восстановиться
// предыдущий флаг DPI или старый "auto".
window.addEventListener("ninety:dpi-changed", () => {
  syncTrayMenu();
  void backupNow();
});
window.addEventListener("ninety:proxy-selection-saved", () => { void backupNow(); });

// ── Трей — вынесен в /lib/tray.js; здесь только контекст main-состояния ──
// Объявлено заранее (до initTray и бутстрапа): getUpdateVersion читает
// pendingUpdate уже на старте — если оставить let в секции Auto-update ниже,
// первый syncTrayMenu падает в TDZ.
let pendingUpdate = null;
// Объявлено рядом с pendingUpdate: первый bootstrap syncTrayMenu читает этот
// флаг раньше секции Auto-update внизу файла.
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
  // Успешный выбор сервера из трея: обновить эффективную ноду + hero/локацию.
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
  return finalizeConnected(snapshot, { ...context, source });
}

async function connectNetwork({ epoch = networkIntentEpoch, operationToken = null } = {}) {
  if (!isCurrentNetworkIntent(epoch, "connected")) return false;
  if (state !== "idle") return state === "connected";
  const stopCurrentOperation = () => invoke(
    "stop_singbox",
    operationToken ? { operationToken } : {},
  );
  // Click ripple — расходится от центра диска (anim 520ms)
  const stage = heroDisc.closest(".hero__stage");
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
      const elevated = await ensureElevatedForTun();
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
    // Владение попыткой захватываем ДО первого await: DNS/WARP/port preflight
    // больше не оставляет state=idle, поэтому второй клик отменяет эту попытку,
    // а не запускает параллельный start_singbox.
    const attemptEpoch = connectAttempts.begin();
    let connectStage = "preflight";
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
      // DNS-watchdog: имя сервера ноды резолвится через direct-DNS ДО туннеля —
      // если он мёртв (Google/Cloudflare DoH в РФ), старт падает с невнятным
      // «i/o timeout». Пробуем и при отказе переключаем на резерв ДО buildConfig,
      // чтобы конфиг собрался уже с рабочим резолвером. Только пока юзер не ушёл.
      if (!strictPrivacy) {
        await ensureWorkingDirectDns({
          toast,
          onlyIf: () => state === "connecting" && connectAttempts.isCurrent(attemptEpoch),
        });
      }
      if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch) || state !== "connecting") return false;
      // Если WARP включён — тянем регистрацию из writable config dir/warp.json
      // и передаём в builder. Без warpInfo builder тихо пропустит warp endpoint.
      let warpInfo = null;
      if (options.warp?.enabled) {
        try { warpInfo = await invoke("warp_status"); } catch {}
        if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch) || state !== "connecting") return false;
        if (!warpInfo) {
          setState("idle");
          toast(t("conn.warpUnreg"), "error", 3500);
          return false;
        }
      }
      // Порты loopback-мостов (xhttp/naive/TT): дефолтные базы 31100+ может
      // занять чужой процесс — Rust подбирает свободные диапазоны bind-пробой.
      // Ошибка планирования не блокирует старт: билдер упадёт на статические
      // дефолты, а занятый порт поймает fail-fast в start_singbox.
      let bridgePorts = null;
      const needs = bridgeNeeds(src ? (src.kind === "sub" ? src.nodes : [src.profile]) : []);
      if (needs.xray || needs.naive || needs.trusttunnel) {
        try { bridgePorts = await invoke("plan_bridge_ports", { needs }); }
        catch (e) { console.warn("plan_bridge_ports failed", e); }
        if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch) || state !== "connecting") return false;
      }
      // Two-core: xhttp-ноды уходят в xray-мост (config.xray), в sing-box —
      // socks-перенаправление. xray=null когда xhttp в источнике нет.
      const {
        config,
        xray,
        sidecars,
        runtime: runtimeInfo,
      } = buildConfig({
        source: src,
        mode,
        options,
        runtimePolicy,
        warpInfo,
        xray: true,
        bridgePorts,
      });
      const configJson = JSON.stringify(config);
      let runtimeToken = runtimeIdentity.begin({
        source: runtimeSource, mode: runtimeInfo.mode, configJson,
        clashPort: runtimeInfo.options.experimental?.clashApiPort || 9090,
      });
      connectStage = "runtime_start";
      const runtimeSnapshot = await coreStartBarrier.track(invoke("start_singbox", {
        configJson,
        mode: runtimeInfo.mode,
        xrayJson: xray ? JSON.stringify(xray) : null,
        // naive/trusttunnel клиенты (по одному на ноду); null когда таких нод нет.
        sidecarsJson: sidecars && sidecars.length ? JSON.stringify(sidecars) : null,
        // «Полностью отключить логи» → Rust не пишет файлы ни одного компонента.
        logsDisabled: !!runtimeInfo.options.log?.disabled,
        sourceFingerprint: runtimeToken.sourceFingerprint,
        configHash: runtimeToken.configHash,
        strictPrivacy: !!runtimeInfo.strictPrivacy,
        pinnedNodeTag: runtimeInfo.pinnedNodeTag,
        systemProxyBypassLan: options.route?.bypassLan !== false,
        killSwitchExpected: !!runtimeInfo.strictPrivacy
          || (!!options.general?.killSwitch && runtimeInfo.mode !== "tun"),
        operationToken,
      }));
      if (!runtimeSnapshot?.running || !Number(runtimeSnapshot.processGeneration)) {
        throw new Error("start_singbox не вернул подтверждённый runtime snapshot");
      }
      // Пока ядро стартовало (settle-паузы мостов), юзер мог нажать «Отключить»:
      // тот клик застаёт child=None и глушить ему нечего. Ловим отмену по epoch
      // и гасим только что поднятое ядро — иначе UI мигал «отключено» и
      // возвращался в «Защищено».
      if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch)) {
        try { await stopCurrentOperation(); } catch {}
        try { await invoke("set_system_proxy", { enable: false }); } catch {}
        return false;
      }
      // Backend является источником истины для processGeneration: локальный
      // токен нужен только чтобы передать ожидаемый identity в start_singbox,
      // после актуальной проверки дальше работаем с подтверждённым snapshot Rust.
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
          apply: (tag) => selectProxy("proxy", tag, { token: runtimeToken }),
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
        // Никогда не маскируем потерю ручного выбора тихим переходом на Auto.
        // Если сервер действительно исчез из подписки, безопаснее не поднимать
        // VPN, чем незаметно отправить трафик через другой маршрут.
        if (restoredSelection.status === "unavailable" && restoredSelection.tag !== "auto") {
          const error = new Error("Remembered server is no longer present in the active subscription");
          error.code = "REMEMBERED_SELECTION_UNAVAILABLE";
          throw error;
        }
      }
      // Системный прокси выставляем ТОЛЬКО для mode=systemProxy. Для голого
      // "proxy" юзер настраивает HTTP/SOCKS клиента сам, для "tun" уже идёт
      // полный intercept через TUN-интерфейс.
      connectStage = "system_proxy";
      if (mode === "systemProxy") {
        const probeHostPort = runtimeSnapshot.probeProxyEndpoint?.address;
        if (typeof probeHostPort !== "string" || !probeHostPort) {
          throw new Error("runtime snapshot не содержит probe endpoint для system proxy");
        }
        await invoke("set_system_proxy", {
          enable: true,
          hostPort: probeHostPort,
          bypassLan: options.route?.bypassLan !== false,
          expectedGeneration: runtimeSnapshot.processGeneration,
        });
        if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch)) {
          try { await invoke("set_system_proxy", { enable: false }); } catch {}
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
      // При proxy→TUN старый ordinary barrier жил до полной готовности TUN.
      // Останавливаем guard-only watcher до финального disarm: stop инвалидирует
      // snapshot в полёте, а уже queued rearm сериализован раньше следующего
      // apply и потому не сможет остаться последней операцией.
      const retiringOrdinaryBarrier = ordinaryFailClosedLatched
        && !runtimeInfo.strictPrivacy
        && mode === "tun";
      if (retiringOrdinaryBarrier) stopHealthWatchdog();
      // Kill switch — часть readiness, а не фоновый best-effort после connected.
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
      // Фейл финальной проверки при ЖИВОМ намерении — это фейл старта: бросаем
      // в catch (shutdownCore → idle + тост). Тихий стоп оставлял UI навсегда
      // в «connecting» при уже погашенном ядре. Тихо выходим только при отмене —
      // статус юзеру выставил его собственный клик.
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
          // In-app тост сразу. Для подписки нода ещё не выбрана балансировщиком —
          // показываем имя подписки (не врём конкретным сервером), затем
          // notifyConnectedWithRealNode догонит тост фактическим сервером. Для
          // одиночного профиля сразу его имя.
          const initLabel = isMultiSub
            ? (src0.subscription?.name || t("conn.subFallback"))
            : nodeDisplayLabel(activeNodeForDisplay());
          toast(t("conn.protected"), "connected", 2200, {
            group: "conn",
            desc: initLabel || t("conn.tunnelUp"),
          });
          syncTrayMenu(); // трей → «Отключиться» (для sub ещё раз обновится после sync)
          // Effective node + OS-уведомление с именем фактического сервера (внутри
          // делает syncEffectiveFromClash → обновляет hero/локацию/трей).
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
      return true;
    } catch (e) {
      if (!isCurrentNetworkIntent(epoch, "connected") || !connectAttempts.isCurrent(attemptEpoch)) {
        // Юзер уже отменил подключение — состояние/тосты выставил его клик,
        // здесь только страховочный стоп без перетирания UI.
        try { await stopCurrentOperation(); } catch {}
        try { await invoke("set_system_proxy", { enable: false }); } catch {}
        return false;
      }
      console.error("start failed", e);
      if (operationToken?.kind === "sourceSwitch") {
        const code = safeSourceSwitchReason(e?.code || e?.name || "error");
        logSourceSwitchReconnect("connect", operationToken, "failed", `${connectStage}_${code}`);
      }
      const preserveGuard = killSwitchMustSurviveRuntimeStop();
      const cleaned = await shutdownCore({
        preserveKillSwitch: preserveGuard,
        operationToken,
      });
      if (!cleaned) {
        // При недоступном BFE не останавливаем ещё живой runtime без barrier.
        // Выходим из вечного connecting в recoverable error; setState заодно
        // ещё раз ставит preserve-reconcile в очередь. Явный disconnect остаётся
        // доступен пользователю и снимает session-scoped policy.
        if (state !== "cleanup_error") {
          setState("cleanup_error", { preserveKillSwitch: preserveGuard });
        }
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
    if (!isCurrentNetworkIntent(epoch, "idle")) return false;
    if (!(await shutdownCore({ finalize: false }))) return false;
  }
  if (!isCurrentNetworkIntent(epoch, "idle")) return false;
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
  // Ручное «Отключить» обязано подтвердить не только смерть runtime, но и
  // освобождение WFP lease. Иначе UI показывал бы idle, watchdog уже молчал,
  // а сохранённая Rust-сессия продолжала блокировать весь компьютер.
  const killSwitchReleased = await applyKillSwitch(false);
  if (!isCurrentNetworkIntent(epoch, "idle")) return false;
  if (!killSwitchReleased) {
    setState("cleanup_error", {
      preserveKillSwitch: killSwitchMustSurviveRuntimeStop(),
    });
    return false;
  }
  strictFailClosedLatched = false;
  ordinaryFailClosedLatched = false;
  setState("idle");
  if (userInitiated) {
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
  // Повторный клик мог уже заменить intent, пока runtime_snapshot был в IPC.
  // Старый toggle после этого не имеет права сам запускать ещё один disconnect.
  if (!isCurrentNetworkIntent(epoch, "idle")) return false;
  // connectionIntentInFlight сюда включать НЕЛЬЗЯ: handleConnectionIntent
  // присваивает его промисом ЭТОГО же вызова до того, как мы проснёмся после
  // await runtime_snapshot — проверка видела саму себя, backendActive был
  // всегда true, и клик «Подключить» детерминированно уходил в disconnect.
  // Конкурентные клики отсекает in-flight guard в handleConnectionIntent.
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
    // Повторный клик отменяет только запуск. Повторный клик во время уже
    // идущего disconnect присоединяется к тому же Promise и не создаёт второй
    // stop_singbox поверх первого.
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
if (locPing) locPing.textContent = `— ${t("units.ms")}`;
window.addEventListener("ninety:profile-store-ready", () => {
  refreshProfilesSummary();
  syncTrayMenu();
});
refreshProfilesSummary();
updateHeroHint();
syncTrayMenu();

// Обновление подписок — через туннель, когда он поднят (mixed-in, в TUN —
// probe-in на том же порту): панель не видит реальный IP. Если через прокси
// не вышло, subscriptions.js повторяет напрямую.
setSubscriptionProxy(() =>
  state === "connected" && runtimeProbeHostPort()
    ? `http://${runtimeProbeHostPort()}`
    : null
);

// ── Бэкап состояния (localStorage → writable config dir) ────
// Мутации бэкапятся точечно (backupSoon в refreshProfilesSummary/settings);
// периодический тик подстраховывает ключи, меняющиеся мимо этих точек
// (traffic-meter, обучение движка качества и т.п.).
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
    // Старый runtime не соответствует текущему источнику/режиму: сначала
    // подтверждённо гасим его, затем autostart решит, нужен ли новый запуск.
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

// startMinimized: на ручном запуске скрыть окно если опция включена.
// (При --autostarted Rust уже скрыл окно в setup() — здесь повтор без вреда.)
(async () => {
  try {
    const opts = loadOptions();
    if (opts.general?.startMinimized && tauriWin?.hide) {
      await tauriWin.hide();
    }
  } catch {}
})();

// Авто-запуск после reconcile: при автостарте через Windows login
// (--autostarted) ИЛИ при перезапуске от админа (--elevated) поднимаем VPN с
// последним сервером И DPI-обход, если он был включён. Элевация — ОДНИМ
// перезапуском: TUN-режим и DPI требуют admin-прав; если процесс ещё не
// elevated и что-то из них нужно — тихо relaunch_elevated.
async function autostartNetworkRuntime() {
    // После OTA-апдейта процесс перезапускается БЕЗ --autostarted/--elevated, и
    // should_autoconnect=false → блок бы не вошёл. update-modal перед установкой
    // пишет, что было поднято (ninety.update.resume = {vpn,dpi}) — по нему
    // возвращаем сессию. Легаси-ключ ninety.dpi.resumeAfterUpdate писали версии
    // ≤0.1.88 (только DPI); читаем ещё релиз-другой с прежней семантикой.
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
    const autoconnect = await invoke("should_autoconnect");
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
    // Элевация ради TUN — только если VPN реально будем поднимать.
    if (((tunWanted && vpnWanted) || dpiWanted) && !(await invoke("is_elevated"))) {
      if (tunWanted) setMode("tun"); // перезапущенный admin-инстанс поднимется в TUN
      const started = await invoke("relaunch_elevated");
      if (started) return; // текущий процесс вот-вот завершится
      // элевация не удалась — продолжаем тем, что доступно без прав (VPN proxy)
    }

    // Второй snapshot после reconcile — последний fail-safe перед стартом:
    // никакой frontend idle не является доказательством, что backend idle.
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
      await new Promise(r => setTimeout(r, 600)); // дать UI домонтироваться
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
    // DPI запускаем только после завершения VPN bootstrap. Endpoint сначала
    // попадает в managed exclusion, backend всё равно создаёт пустые файлы сам.
    if (dpiWanted) {
      await excludeVpnNode(state === "connected" ? activeNodeForDisplay()?.host : null);
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

bootstrapNetworkRuntime();

// Синхронизация флага autostart с реальным состоянием Windows (задача
// Планировщика). Если юзер удалил задачу через Планировщик / Параметры —
// тут подтянем актуальное состояние в options.
(async () => {
  try {
    const enabled = await invoke("autostart_is_enabled");
    const opts = loadOptions();
    if (typeof enabled === "boolean" && opts.general?.autostart !== enabled) {
      updateOption("general.autostart", enabled);
    }
  } catch {}
})();

// Если пользователь включил обработчики vless:// / tt:// / naive+...,
// освежаем registry-путь при старте: после OTA/переустановки exe мог переехать.
(async () => {
  try {
    if (loadOptions().general?.linkHandlers) await applyLinkHandlers(true);
  } catch (e) {
    console.warn("link handlers refresh failed", e);
  }
})();

// ── Auto-update ────────────────────────────────────────────
// Обновление, найденное фоновой проверкой пока окно свёрнуто в трей, копится в
// pendingUpdate (объявлен выше, до syncTrayMenu). Окно модалкой не выдёргиваем —
// показываем когда юзер вернётся (фокус окна / клик по пункту трея).
let updateModalShowing = false;
let activeUpdateVersion = null;
// OS-уведомление об апдейте — один раз на версию за сессию: фоновые проверки
// повторяются, без дедупа юзер в трее ловил бы тост о той же версии каждый тик.
let lastNotifiedUpdateVersion = null;

async function markUpdateRuntimeReady() {
  try {
    localStorage.removeItem("ninety.update.resume");
    localStorage.removeItem("ninety.dpi.resumeAfterUpdate");
  } catch {}
  await backupNow();
}

// Окно действительно перед пользователем? Проверяем focus последним: это
// закрывает окно гонки, когда CloseRequested/hide приходит между двумя IPC.
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
      queueMicrotask(() => { void flushPendingUpdate({ requireForeground: true }); });
    }
  }
}

// Показать отложенное обновление (юзер вернулся к окну). respectSkip=false —
// он сам открыл приложение, значит готов смотреть; «Позже» внутри модалки.
async function flushPendingUpdate({ requireForeground = false } = {}) {
  if (!pendingUpdate || updateModalShowing) return;
  if (requireForeground && !(await windowIsForeground())) return;
  // Пока ждали IPC окна, OTA мог забрать focus/tray-handler.
  if (!pendingUpdate || updateModalShowing) return;
  const u = pendingUpdate;
  pendingUpdate = null;
  syncTrayMenu(); // снять пункт «Обновить» из трея
  await showUpdateModal(u, { respectSkip: false });
}

// Прокси для проверки/скачивания апдейта: при поднятом VPN — свой локальный
// инбаунд (как рефреш подписок). Без него проверка ВСЕГДА идёт «напрямую»
// (reqwest не чтит системный прокси, в TUN трафик Ninety.exe уходит в direct
// bypass-правилом) — у части провайдеров эндпоинты так недоступны вовсе.
function updaterProxy() {
  const hostPort = state === "connected" ? runtimeProbeHostPort() : null;
  return hostPort ? `http://${hostPort}` : null;
}

// true — проверка ДОСТИГЛА сервера (апдейт есть или его нет); false — не смогли
// проверить (нет сети / эндпоинты недоступны) → скедулер уходит в бэкоф-ретрай.
async function performUpdateCheck(request) {
  if (!updaterAvailable()) {
    if (request.interactive) toast(t("update.unavailable"), "error", 2500);
    return false;
  }
  // Не создаём новый Rust Update, пока не закрыт Resource от предыдущей
  // неудачной cleanup-попытки.
  if (!(await drainUpdateResourceCleanup())) {
    if (request.interactive) toast(t("update.checkFailed"), "error", 4000);
    return false;
  }
  let update;
  try {
    const proxy = updaterProxy();
    // При активном VPN не откатываемся на прямой запрос: обычный TUN специально
    // выпускает Ninety.exe через direct, а proxy/systemProxy reqwest не подхватывает.
    // Ошибка уйдёт в штатный backoff и повторится через туннель после восстановления.
    update = await checkForUpdate({ proxy });
  } catch (e) {
    console.warn("update check failed", e);
    if (request.interactive) toast(t("update.checkFailed"), "error", 4000);
    return false;
  }
  if (!update) {
    if (pendingUpdate) {
      pendingUpdate = null;
      syncTrayMenu();
    }
    if (request.interactive) toast(t("update.none"), "info", 2400);
    return true;
  }

  // Для ожидания в трее оставляем plain metadata. Нативный Update держит Rust
  // Resource и HTTP client/proxy момента check(), поэтому сразу освобождаем его.
  const metadata = snapshotUpdate(update);
  if (!(await closeUpdateResource(update))) {
    if (request.interactive) toast(t("update.checkFailed"), "error", 4000);
    return false;
  }

  // Фоновая проверка: уважаем «Позже» по этой версии — не навязываемся.
  if (!request.interactive && updateShouldSkip(metadata.version)) {
    if (String(pendingUpdate?.version) === String(metadata.version)) {
      pendingUpdate = null;
      syncTrayMenu();
    }
    return true;
  }

  // Повторный ответ той же версии, пока её модалка уже открыта, не создаёт
  // второй набор DOM-обработчиков. Более новый релиз остаётся pending.
  if (updateModalShowing && String(activeUpdateVersion) === String(metadata.version)) {
    return true;
  }

  // Pending публикуется ДО async-проверки окна: focus-event на любом await уже
  // увидит OTA и сможет атомарно забрать его через flushPendingUpdate().
  pendingUpdate = metadata;
  syncTrayMenu();

  // Ручной запрос повышает уже идущую фоновую проверку и игнорирует skip.
  if (request.interactive) {
    await flushPendingUpdate();
  } else {
    const foreground = await windowIsForeground();
    // Ручной клик мог присоединиться, пока фоновый flight ждал оконный IPC.
    // Проверяем promotion ещё раз, иначе в скрытом окне ручной запрос
    // завершился бы только уведомлением без обещанной модалки.
    if (request.interactive) {
      await flushPendingUpdate();
    } else if (foreground && pendingUpdate === metadata) {
      await flushPendingUpdate({ requireForeground: true });
    } else if (!foreground && pendingUpdate === metadata
      && lastNotifiedUpdateVersion !== metadata.version) {
      lastNotifiedUpdateVersion = metadata.version;
      notify(t("update.notifyTitle"),
        t("update.notifyBody", { version: metadata.version }));
    }
  }
  return true;
}

const updateChecks = createPromotableSingleFlight(performUpdateCheck);

function runUpdateCheck({ silent = true } = {}) {
  return updateChecks.run({ interactive: !silent });
}

// ── Расписание проверок — по таймстампам, не по setInterval ──
// Прежний setInterval(6ч) ломался о два сценария: (1) автозапуск с Windows —
// первая проверка через 3с стабильно умирала об ещё не поднятую сеть, и до
// следующей было 6 часов тишины; (2) сон/гибернация — интервальный таймер не
// тикает во сне, реальный период уплывал далеко за 6ч. Теперь:
//   успех  → следующая через 2ч (проверка = один JSON ~1КБ, дёшево);
//   провал → бэкоф 30с → 2м → 5м → 15м (дальше по 15м) до первого успеха;
//   лёгкий тик раз в 60с сравнивает часы (переживает сон и троттлинг скрытого
//   окна — Chromium в трее коалесцирует таймеры как раз до 1/мин);
//   внеплановые триггеры: появилась сеть (online), развернули окно, поднялся
//   VPN (эндпоинты станут доступны через туннель). Всё это работает и в трее:
//   апдейт доедет OS-уведомлением + пунктом «Обновить до vX» в меню трея.
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const UPDATE_RETRY_STEPS_MS = [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];
const UPDATE_STALE_MS = 30 * 60_000; // «давно не проверялись» для focus/connect
let updateNextCheckAt = Date.now() + 3000; // первая — через 3с после старта
let updateLastSuccessAt = 0;
let updateRetryIdx = 0;

function updateCheckSucceeded() {
  updateLastSuccessAt = Date.now();
  updateRetryIdx = 0;
  updateNextCheckAt = Date.now() + UPDATE_CHECK_INTERVAL_MS;
}

async function scheduledUpdateCheck() {
  // Модалка открыта — не дёргаем проверку под ней (и не сбиваем установку).
  if (updateChecks.isRunning() || updateModalShowing) return;
  if (await runUpdateCheck({ silent: true })) {
    updateCheckSucceeded();
  } else {
    const step = UPDATE_RETRY_STEPS_MS[Math.min(updateRetryIdx, UPDATE_RETRY_STEPS_MS.length - 1)];
    updateRetryIdx++;
    updateNextCheckAt = Date.now() + step;
  }
}

// Внеплановая проверка (фокус/online/connect) — только если давно не было
// успешной, чтобы каждый Alt-Tab/реконнект не дёргал эндпоинты.
function updateCheckIfStale(staleMs = UPDATE_STALE_MS) {
  if (Date.now() - updateLastSuccessAt >= staleMs) scheduledUpdateCheck();
}

setTimeout(scheduledUpdateCheck, 3000);
setInterval(() => { if (Date.now() >= updateNextCheckAt) scheduledUpdateCheck(); }, 60_000);

// Сеть появилась (Wi-Fi догнал после логина, вышли из самолётного режима).
window.addEventListener("online", () => updateCheckIfStale(60_000));

// Вернулись к окну (фокус из трея/таскбара) → показать отложенный апдейт;
// заодно дочекать, если с последней удачной проверки прошло полчаса.
(async () => {
  try {
    await tauriWin?.onFocusChanged?.(({ payload: focused }) => {
      activityController.setFocused(!!focused);
      if (!focused) return;
      flushPendingUpdate();
      updateCheckIfStale();
    });
  } catch (e) { console.warn("focus listener failed", e); }
})();

// Глобальная функция для кнопки «Проверить обновления» в settings
window.__ninetyUpdateCheck = async () => {
  if (await runUpdateCheck({ silent: false })) updateCheckSucceeded();
};

// ── Subscriptions auto-refresh ─────────────────────────────
// Тик каждые 30 минут (первый — через 60 сек, чтобы не тормозить старт), но
// каждая подписка обновляется по СВОЕМУ интервалу: profile-update-interval из
// заголовка панели, без заголовка — раз в 6 часов. Раньше заголовок сохранялся,
// но игнорировался — всё дёргалось каждые 30 минут. Ручное «Обновить все»
// по-прежнему обновляет немедленно. Ошибки не показываем — фоновая задача.
const SUBS_REFRESH_DEFAULT_HOURS = 6;
async function silentRefreshSubs() {
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

// «Только что» / «N мин назад» обновляем каждые 30 сек
setInterval(refreshSubCardFromActive, 30_000);

// ── Deep links ──────────────────────────────────────────────
// Разбор форматов — в /lib/deeplink.js (чистая функция, покрыта тестами).
// Windows запускает Ninety с argv, single-instance plugin перехватывает и
// emit'ит onOpenUrl в первый процесс. Авто-импорта нет — юзер видит prefilled
// URL в add-modal и подтверждает (защита от malicious links).
const handledDeepLinks = new Set();
function handleDeepLinkUrl(rawUrl) {
  try {
    const key = String(rawUrl || "");
    if (!key || handledDeepLinks.has(key)) return;
    handledDeepLinks.add(key);
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
    // onOpenUrl получает URL'ы и при cold-start (если Windows запустил Ninety
    // самим ninety://...), и при warm second-instance через single-instance.
    if (dl?.onOpenUrl) {
      await dl.onOpenUrl((urls) => {
        if (!Array.isArray(urls)) return;
        for (const u of urls) handleDeepLinkUrl(u);
      });
    }
    // Также проверяем getCurrent на случай если URL был передан до того
    // как мы подписались (cold-start race).
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
