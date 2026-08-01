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
  invoke: invokeFn = invoke,
  toast: toastFn = toast,
  notify: notifyFn = notify,
  t: tr = t,
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

  const current = (run) => run === generation && !isUpdateInstalling();
  const active = (run) => current(run) && getState() === "connected";

  function bridgeReconnectAllowed() {
    const cut = Date.now() - BRIDGE_RECONNECT_WINDOW_MS;
    bridgeReconnects = bridgeReconnects.filter((ts) => ts > cut);
    if (bridgeReconnects.length >= BRIDGE_RECONNECT_MAX) return false;
    bridgeReconnects.push(Date.now());
    return true;
  }

  function dataplaneRecoveryAllowed() {
    const now = Date.now();
    const cut = now - DATAPLANE_RECOVERY_WINDOW_MS;
    dataplaneRecoveries = dataplaneRecoveries.filter((ts) => ts > cut);
    const last = dataplaneRecoveries.at(-1) || 0;
    return dataplaneRecoveries.length < DATAPLANE_RECOVERY_MAX
      && now - last >= DATAPLANE_RECOVERY_COOLDOWN_MS;
  }

  async function handleDataplaneHealth(run, snap) {
    const dataplane = snap?.dataplane;
    if (!dataplane) return false;
    if (dataplane.state === "inactive") return false;
    const pressure = dataplane.hostPressure === true || dataplane.state === "pressure";
    getQualityEngine()?.setHostPressure?.(pressure);

    if (dataplane.state === "healthy") {
      dataplaneRecoveryGraceUntil = 0;
      dataplaneTerminal = false;
      return false;
    }
    if (pressure || dataplane.state !== "failed") return true;
    if (!active(run)) return true;
    if (Date.now() < dataplaneRecoveryGraceUntil || dataplaneRecoveryBusy) return true;

    if (!dataplaneRecoveryAllowed()) {
      if (!dataplaneTerminal) {
        dataplaneTerminal = true;
        await onDataplaneFailed(dataplane);
      }
      return true;
    }

    dataplaneRecoveries.push(Date.now());
    dataplaneRecoveryBusy = true;
    getQualityEngine()?.pauseForEmergency?.();
    toastFn(tr("conn.applyingSettings"), "warn", 5000, { group: "conn", connecting: true });
    try {
      const recovered = await recoverDataplane({
        reason: dataplane.reason || "dataplane_failed",
        snapshot: dataplane,
      });
      if (recovered) {
        dataplaneRecoveryGraceUntil = Date.now() + DATAPLANE_RECOVERY_GRACE_MS;
        dataplaneTerminal = false;
      }
    } catch (error) {
      console.warn("dataplane recovery failed", error);
    } finally {
      dataplaneRecoveryBusy = false;
      getQualityEngine()?.resumeAfterEmergency?.();
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
    timer = setIntervalFn(tick, HEALTH_TICK_MS);
  }

  function stop() {
    generation++;
    killSwitchAlerted = false;
    dataplaneRecoveryBusy = false;
    dataplaneRecoveryGraceUntil = 0;
    dataplaneTerminal = false;
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
