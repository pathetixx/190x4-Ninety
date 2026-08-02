// Ninety · health-watchdog (liveness ядер + dataplane recovery + bridge-reconnect).
// Вынесено из main.js.
// Пока connected — раз в 5с дёргаем health_snapshot:
//   sing-box упал → туннель закрыт: снять прокси, idle, нотифай с причиной, логи.
//   xray/naive/TT-мост упал → авто-реконнект (пересобирает конфиг и поднимает ядра).
//   native dataplane failed → bounded node switch/full reconnect; pressure не
//   запускает quality-лесенку и ждёт восстановления ресурсов.
// После аварийного fail-closed shutdown тот же таймер остаётся в guard-only
// режиме и следит только за WFP, пока пользователь явно не снимет блок.
// Всё, что тянется из main (текущее состояние, флаг установки апдейта, гашение ядра,
// реконнект, переключение вью, движок качества), инжектится — тот же паттерн, что у
// /lib/warp-rescan.js, /lib/dns-guard.js, /lib/wifi-guard.js.

import { toast } from "/lib/toast.js";
import { notify } from "/lib/notify.js";
import { t } from "/lib/i18n/index.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const HEALTH_TICK_MS = 5000;
const DATAPLANE_RECOVERY_COOLDOWN_MS = 60_000;
const DATAPLANE_RECOVERY_WINDOW_MS = 15 * 60_000;
const DATAPLANE_RECOVERY_MAX = 3;
const DATAPLANE_RECOVERY_GRACE_MS = 30_000;
// Кап догоняющих реконнектов мостов (xray/naive/TT). Смерть моста сразу на старте
// фейлит start_singbox (fail-fast в Rust), но смерть в середине сессии лечится
// реконнектом — без капа стабильно падающий мост зациклил бы «упал → реконнект →
// упал» с тостами каждые ~10 секунд навсегда.
const BRIDGE_RECONNECT_MAX = 3;
const BRIDGE_RECONNECT_WINDOW_MS = 10 * 60_000;

// getState() → "idle"|"connecting"|"connected"; isUpdateInstalling() → модалка
// апдейта сама гасит ядра (иначе watchdog найдёт «труп» и слал бы ложную ошибку);
// shutdownCore/reconnectForSourceChange/switchView — управляющие руки из main;
// getQualityEngine() → инстанс движка качества (создаётся в main позже, поэтому геттер).
export function initHealthWatchdog({
  getState,
  isUpdateInstalling,
  shutdownCore,
  reconnectForSourceChange,
  switchView,
  getQualityEngine,
  shouldPreserveKillSwitch = () => false,
  isKillSwitchRequired = () => false,
  rearmKillSwitch = async () => false,
  reconcileKillSwitch = async () => true,
  recoverDataplane = async () => false,
  onDataplaneFailed = async () => false,
  onDataplaneState = () => {},
  invoke: invokeFn = invoke,
  toast: toastFn = toast,
  notify: notifyFn = notify,
  t: tr = t,
  now: nowFn = Date.now,
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
}) {
  let timer = null;
  let busy = false;
  let bridgeReconnects = [];
  let generation = 0;
  let killSwitchAlerted = false;
  let dataplaneRecoveries = [];
  let dataplaneRecoveryBusy = false;
  let dataplaneRecoveryGraceUntil = 0;
  let dataplaneTerminal = false;
  let dataplaneTerminalBusy = false;
  let dataplaneTerminalRetryAt = 0;
  let dataplaneTerminalAttempts = [];
  let dataplaneEmergencyPaused = false;
  let lastDataplaneState = null;
  let frontendHandoffAttempted = false;

  const current = (run) => run === generation && !isUpdateInstalling();
  const active = (run) => current(run) && getState() === "connected";

  function bridgeReconnectAllowed() {
    const cut = nowFn() - BRIDGE_RECONNECT_WINDOW_MS;
    bridgeReconnects = bridgeReconnects.filter((ts) => ts > cut);
    if (bridgeReconnects.length >= BRIDGE_RECONNECT_MAX) return false;
    bridgeReconnects.push(nowFn());
    return true;
  }

  function dataplaneRecoveryDecision() {
    const now = nowFn();
    const cut = now - DATAPLANE_RECOVERY_WINDOW_MS;
    dataplaneRecoveries = dataplaneRecoveries.filter((ts) => ts > cut);
    const last = dataplaneRecoveries.at(-1);
    if (dataplaneRecoveries.length >= DATAPLANE_RECOVERY_MAX) {
      return { state: "exhausted", attempts: dataplaneRecoveries.length, retryAt: null };
    }
    if (last !== undefined && now - last < DATAPLANE_RECOVERY_COOLDOWN_MS) {
      return {
        state: "cooldown",
        attempts: dataplaneRecoveries.length,
        retryAt: last + DATAPLANE_RECOVERY_COOLDOWN_MS,
      };
    }
    return { state: "allowed", attempts: dataplaneRecoveries.length, retryAt: null };
  }

  function resetEmergencyPause() {
    if (!dataplaneEmergencyPaused) return;
    dataplaneEmergencyPaused = false;
    getQualityEngine()?.resumeAfterEmergency?.();
  }

  async function failClosedAfterExhaustion(run, dataplane) {
    const now = nowFn();
    const cut = now - DATAPLANE_RECOVERY_WINDOW_MS;
    dataplaneTerminalAttempts = dataplaneTerminalAttempts.filter((ts) => ts > cut);
    if (dataplaneTerminal || dataplaneTerminalBusy
      || now < dataplaneTerminalRetryAt
      || dataplaneTerminalAttempts.length >= DATAPLANE_RECOVERY_MAX
      || !active(run)) return true;

    dataplaneTerminalAttempts.push(now);
    dataplaneTerminalBusy = true;
    try {
      // A failed shutdown is not terminal: cleanup_error remains retryable, but
      // retries are bounded and delayed so a stuck process cannot cause a loop.
      const confirmed = await onDataplaneFailed(dataplane);
      if (confirmed === true) {
        dataplaneTerminal = true;
        dataplaneTerminalRetryAt = 0;
      } else {
        dataplaneTerminalRetryAt = nowFn() + DATAPLANE_RECOVERY_COOLDOWN_MS;
      }
    } finally {
      dataplaneTerminalBusy = false;
    }
    return true;
  }

  async function runFrontendHandoff(run, dataplane) {
    if (!active(run) || frontendHandoffAttempted
      || dataplaneRecoveryBusy || nowFn() < dataplaneRecoveryGraceUntil) {
      return true;
    }
    const decision = dataplaneRecoveryDecision();
    // Native controller держит fail-closed deadline. Здесь нужен один быстрый
    // handoff на знающий профили WebView, а не второй независимый retry-loop.
    if (decision.state !== "allowed") return true;

    frontendHandoffAttempted = true;
    dataplaneRecoveries.push(nowFn());
    dataplaneRecoveryBusy = true;
    dataplaneEmergencyPaused = true;
    getQualityEngine()?.pauseForEmergency?.();
    toastFn(tr("conn.applyingSettings"), "warn", 5000, { group: "conn", connecting: true });
    try {
      const recovered = await recoverDataplane({
        reason: dataplane.reason || "dataplane_failed",
        snapshot: dataplane,
      });
      if (recovered && current(run)) {
        dataplaneRecoveryGraceUntil = nowFn() + DATAPLANE_RECOVERY_GRACE_MS;
        dataplaneTerminal = false;
        resetEmergencyPause();
      }
    } catch (error) {
      console.warn("frontend dataplane handoff failed", error);
    } finally {
      dataplaneRecoveryBusy = false;
    }
    return true;
  }

  async function handleDataplaneHealth(run, snap) {
    const dataplane = snap?.dataplane;
    if (!dataplane) return false;
    const operationKind = snap?.runtimeOperation?.kind;
    const lifecycleOperationActive = [
      "sourceSwitch", "userConnect", "userDisconnect", "nativeRecovery",
      "frontendRecovery", "qualityRemediation",
    ].includes(operationKind);
    if (dataplane.state === "inactive") return false;
    const dataplaneState = dataplane.dataplaneState || dataplane.state;
    const pressure = dataplane.hostPressure === true || dataplane.state === "pressure";
    getQualityEngine()?.setHostPressure?.(pressure);
    if (lifecycleOperationActive) {
      // Rust owns the token and will reject stale callbacks.  Frontend only
      // renders health evidence while a switch/recovery/connect/disconnect is
      // active; it must not create a second handoff or remediation owner.
      getQualityEngine()?.pauseForEmergency?.();
      return true;
    }
    if (dataplaneState !== lastDataplaneState) {
      lastDataplaneState = dataplaneState;
      onDataplaneState(dataplaneState, dataplane);
      if (dataplaneState === "healthy") {
        frontendHandoffAttempted = false;
        // Native liveness уже дала туннелю settle-time. Теперь нужна одна
        // настоящая quality-проба, чтобы UI не висел в «Проверка» пять минут.
        getQualityEngine()?.requestProbeSoon?.();
      }
    }

    if (dataplaneState === "healthy" || dataplaneState === "unmonitoredPrivacyMode") {
      dataplaneRecoveryGraceUntil = 0;
      dataplaneTerminal = false;
      dataplaneTerminalRetryAt = 0;
      dataplaneTerminalAttempts = [];
      resetEmergencyPause();
      return false;
    }
    if (dataplaneState !== "failed") return true;

    // Native health owns every real runtime. The WebView may display the
    // evidence and pause quality work, but it must never race native restart or
    // turn a native cooldown into a frontend node switch.
    const nativeOwner = dataplane.nativeRecoveryOwner === "native"
      || ["recovering", "cooldown", "pressure_wait", "handoff", "exhausted", "terminal", "cleanup_error"]
        .includes(dataplane.nativeRecoveryState);
    if (nativeOwner) {
      if (dataplane.nativeRecoveryState === "handoff") {
        return runFrontendHandoff(run, dataplane);
      }
      if (dataplane.nativeRecoveryState === "terminal" && active(run) && !dataplaneTerminal) {
        // The native monitor normally performs this action itself. If a
        // terminal snapshot reaches WebView2, keep the same confirmation,
        // retry delay, and bounded budget instead of calling cleanup on every
        // five-second health tick after a failed shutdown.
        await failClosedAfterExhaustion(run, dataplane);
      }
      if (!dataplaneEmergencyPaused) {
        dataplaneEmergencyPaused = true;
        getQualityEngine()?.pauseForEmergency?.();
      }
      return true;
    }

    // Legacy/fallback snapshots without a native owner still fail closed under
    // pressure; pressure is not evidence that the dataplane recovered.
    if (pressure) return true;
    if (!active(run)) return true;
    if (nowFn() < dataplaneRecoveryGraceUntil || dataplaneRecoveryBusy) return true;

    const decision = dataplaneRecoveryDecision();
    if (decision.state === "cooldown") return true;
    if (decision.state === "exhausted") {
      return failClosedAfterExhaustion(run, dataplane);
    }

    dataplaneRecoveries.push(nowFn());
    dataplaneRecoveryBusy = true;
    dataplaneEmergencyPaused = true;
    getQualityEngine()?.pauseForEmergency?.();
    toastFn(tr("conn.applyingSettings"), "warn", 5000, { group: "conn", connecting: true });
    try {
      const recovered = await recoverDataplane({
        reason: dataplane.reason || "dataplane_failed",
        snapshot: dataplane,
      });
      if (recovered) {
        dataplaneRecoveryGraceUntil = nowFn() + DATAPLANE_RECOVERY_GRACE_MS;
        dataplaneTerminal = false;
      }
    } catch (error) {
      console.warn("dataplane recovery failed", error);
    } finally {
      dataplaneRecoveryBusy = false;
      resetEmergencyPause();
    }
    return true;
  }

  // Бюджет исчерпан — мост падает системно, реконнекты не лечат. Закрываем туннель
  // целиком (как при смерти sing-box): честная ошибка вместо вечного цикла.
  async function stopForBridgeLoop(run) {
    if (!active(run)) return;
    if (!(await shutdownCore({ preserveKillSwitch: shouldPreserveKillSwitch() }))) return;
    toastFn(tr("conn.bridgeLoop"), "error", 8000, { group: "conn", desc: tr("conn.bridgeLoopDesc") });
    notifyFn(tr("conn.notifyClosedTitle"), tr("conn.bridgeLoopDesc"));
    switchView("logs");
  }

  function start() {
    if (timer) return;
    generation++;
    killSwitchAlerted = false;
    dataplaneRecoveryBusy = false;
    dataplaneRecoveryGraceUntil = 0;
    dataplaneTerminal = false;
    dataplaneTerminalBusy = false;
    dataplaneTerminalRetryAt = 0;
    dataplaneTerminalAttempts = [];
    dataplaneEmergencyPaused = false;
    dataplaneRecoveries = [];
    lastDataplaneState = null;
    frontendHandoffAttempted = false;
    timer = setIntervalFn(tick, HEALTH_TICK_MS);
  }

  function stop() {
    generation++;
    killSwitchAlerted = false;
    dataplaneRecoveryBusy = false;
    dataplaneRecoveryGraceUntil = 0;
    dataplaneTerminal = false;
    dataplaneTerminalBusy = false;
    dataplaneTerminalRetryAt = 0;
    dataplaneTerminalAttempts = [];
    dataplaneEmergencyPaused = false;
    dataplaneRecoveries = [];
    lastDataplaneState = null;
    frontendHandoffAttempted = false;
    if (timer) { clearIntervalFn(timer); timer = null; }
  }

  async function verifyKillSwitch(run, snap, { connected = false } = {}) {
    const stillCurrent = connected ? active : current;
    if (!isKillSwitchRequired()) {
      killSwitchAlerted = false;
      return true;
    }
    if (snap.kill_switch_active === true) {
      if (killSwitchAlerted) {
        toastFn(tr("privacyToast.guardRestored"), "success", 2400, {
          group: "privacy-guard",
        });
      }
      killSwitchAlerted = false;
      return true;
    }

    const restored = await rearmKillSwitch();
    // Настройку или transition-latch могли снять, пока IPC-rearm уже стоял в
    // очереди. Side effect к этому моменту мог успеть вернуть старый block-all,
    // поэтому одной проверки флага недостаточно: последней queued операцией
    // обязана стать актуальная policy.
    if (!isKillSwitchRequired()) {
      await reconcileKillSwitch();
      killSwitchAlerted = false;
      return true;
    }
    if (!stillCurrent(run)) return false;
    if (!restored) {
      if (!killSwitchAlerted) {
        killSwitchAlerted = true;
        toastFn(tr("privacyToast.guardLost"), "error", 0, { group: "privacy-guard" });
        notifyFn("Ninety", tr("privacyToast.guardLost"));
        switchView("logs");
      }
      return false;
    }
    if (killSwitchAlerted) {
      toastFn(tr("privacyToast.guardRestored"), "success", 2400, {
        group: "privacy-guard",
      });
    }
    killSwitchAlerted = false;
    return true;
  }

  async function tick() {
    const connectedAtStart = getState() === "connected";
    const guardOnly = !connectedAtStart && isKillSwitchRequired();
    if ((!connectedAtStart && !guardOnly) || busy || isUpdateInstalling()) return;
    const run = generation;
    busy = true;
    try {
      // Один агрегирующий вызов вместо четырёх (singbox_running/vpn_last_error/
      // xray_status/sidecar_status) — снимает лишний IPC-трафик на каждом тике.
      const snap = await invokeFn("health_snapshot");
      if (!current(run)) return;

      // После аварийного shutdown state уже idle/cleanup_error, но сохранённый
      // fail-closed WFP должен жить до явного disconnect/выключения настройки.
      // В этом режиме не проверяем умершее ядро — только dynamic WFP objects.
      if (guardOnly) {
        await verifyKillSwitch(run, snap);
        return;
      }

      if (!active(run)) return;
      if (!snap.singbox_running) {
        // Native health owns the runtime lifecycle. A process death is still
        // evidence for its local recovery/terminal path; do not let this older
        // WebView branch race native stop/start between two health snapshots.
        if (snap.dataplane?.nativeRecoveryOwner === "native") {
          await handleDataplaneHealth(run, snap);
          return;
        }
        // Причину смерти snapshot читает синхронно с running-статусом (до
        // shutdownCore, который сбрасывает флаги).
        const why = snap.last_error;
        if (!(await shutdownCore({ preserveKillSwitch: shouldPreserveKillSwitch() }))) return;
        toastFn(tr("conn.coreStopped"), "error", 7000, { group: "conn", desc: tr("conn.coreStoppedDesc") });
        notifyFn(tr("conn.notifyClosedTitle"), tr("conn.notifyClosedBody"));
        if (why) console.warn("sing-box died:", why);
        switchView("logs");
        return;
      }
      // BFE/Windows Firewall может быть перезапущен независимо от Ninety:
      // dynamic WFP objects тогда исчезнут, хотя ядро и TUN останутся живы.
      // На каждом liveness-тике подтверждаем два block-фильтра и атомарно
      // переармируем policy. Пока восстановление не удалось, не запускаем
      // автоматические реконнекты: остановка живого TUN без WFP только увеличила
      // бы риск выхода приложений через физический интерфейс.
      if (!(await verifyKillSwitch(run, snap, { connected: true }))) return;
      // sing-box жив — проверяем xray-мост (xhttp).
      if (snap.xray === "died") {
        if (!bridgeReconnectAllowed()) { await stopForBridgeLoop(run); return; }
        if (!active(run)) return;
        toastFn(tr("conn.xhttpDown"), "warn", 4000, { group: "conn", connecting: true });
        notifyFn("Ninety", tr("conn.xhttpNotify"));
        // reconnectForSourceChange сам ставит needsReconnect и зовёт реконнект,
        // который поднимет sing-box И xray заново из свежего конфига.
        reconnectForSourceChange(tr("conn.xhttpReconnect"));
        return;
      }
      // sidecar-клиенты naive/trusttunnel — та же логика, что у xray-моста.
      if (snap.sidecar === "died") {
        if (!bridgeReconnectAllowed()) { await stopForBridgeLoop(run); return; }
        if (!active(run)) return;
        toastFn(tr("conn.clientDown"), "warn", 4000, { group: "conn", connecting: true });
        notifyFn("Ninety", tr("conn.clientNotify"));
        reconnectForSourceChange(tr("conn.clientReconnect"));
        return;
      }
      if (await handleDataplaneHealth(run, snap)) return;
      // Liveness OK — отдаём ход движку качества (детект троттла/деградации).
      // Fire-and-forget: проба до 4с не должна держать busy и тормозить следующий
      // liveness-тик; у движка свои guard'ы probing/remediating.
      if (active(run)) getQualityEngine()?.tick().catch(() => {});
    } catch (e) {
      console.warn("healthTick failed", e);
    } finally {
      busy = false;
    }
  }

  return { start, stop, tick };
}
