// Ninety · health-watchdog (liveness ядер + bridge-reconnect). Вынесено из main.js.
// Пока connected — раз в 5с дёргаем health_snapshot:
//   sing-box упал → туннель закрыт: снять прокси, idle, нотифай с причиной, логи.
//   xray/naive/TT-мост упал → авто-реконнект (пересобирает конфиг и поднимает ядра).
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
  beginRuntimeOperation = null,
  completeRuntimeOperation = async () => false,
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

  const current = (run) => run === generation && !isUpdateInstalling();
  const active = (run) => current(run) && getState() === "connected";

  async function withFrontendRecovery(dataplane, run) {
    const token = typeof beginRuntimeOperation === "function"
      ? await beginRuntimeOperation("frontendRecovery", dataplane)
      : null;
    if (typeof beginRuntimeOperation === "function" && !token) return false;
    try {
      return await run(token);
    } finally {
      if (token) await completeRuntimeOperation(token);
    }
  }

  function withOperationToken(payload, operationToken) {
    return operationToken ? { ...payload, operationToken } : payload;
  }

  function bridgeReconnectAllowed() {
    const cut = Date.now() - BRIDGE_RECONNECT_WINDOW_MS;
    bridgeReconnects = bridgeReconnects.filter((ts) => ts > cut);
    if (bridgeReconnects.length >= BRIDGE_RECONNECT_MAX) return false;
    bridgeReconnects.push(Date.now());
    return true;
  }

  // Бюджет исчерпан — мост падает системно, реконнекты не лечат. Закрываем туннель
  // целиком (как при смерти sing-box): честная ошибка вместо вечного цикла.
  async function stopForBridgeLoop(run) {
    if (!active(run)) return;
    const stopped = await withFrontendRecovery(
      { reason: "bridge_reconnect_budget_exhausted" },
      (operationToken) => shutdownCore(withOperationToken({
        preserveKillSwitch: shouldPreserveKillSwitch(),
      }, operationToken)),
    );
    if (!stopped) return;
    toastFn(tr("conn.bridgeLoop"), "error", 8000, { group: "conn", desc: tr("conn.bridgeLoopDesc") });
    notifyFn(tr("conn.notifyClosedTitle"), tr("conn.bridgeLoopDesc"));
    switchView("logs");
  }

  function start() {
    if (timer) return;
    generation++;
    killSwitchAlerted = false;
    timer = setIntervalFn(tick, HEALTH_TICK_MS);
  }

  function stop() {
    generation++;
    killSwitchAlerted = false;
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
        const stopped = await withFrontendRecovery(
          { reason: "process_dead" },
          (operationToken) => shutdownCore(withOperationToken({
            preserveKillSwitch: shouldPreserveKillSwitch(),
          }, operationToken)),
        );
        if (!stopped) return;
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
        void withFrontendRecovery(
          { reason: "xhttp_bridge_dead" },
          (operationToken) => reconnectForSourceChange(
            tr("conn.xhttpReconnect"),
            withOperationToken({}, operationToken),
          ),
        ).catch((error) => console.warn("xhttp bridge recovery failed", error));
        return;
      }
      // sidecar-клиенты naive/trusttunnel — та же логика, что у xray-моста.
      if (snap.sidecar === "died") {
        if (!bridgeReconnectAllowed()) { await stopForBridgeLoop(run); return; }
        if (!active(run)) return;
        toastFn(tr("conn.clientDown"), "warn", 4000, { group: "conn", connecting: true });
        notifyFn("Ninety", tr("conn.clientNotify"));
        void withFrontendRecovery(
          { reason: "sidecar_bridge_dead" },
          (operationToken) => reconnectForSourceChange(
            tr("conn.clientReconnect"),
            withOperationToken({}, operationToken),
          ),
        ).catch((error) => console.warn("sidecar bridge recovery failed", error));
        return;
      }
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
