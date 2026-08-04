// Ninety · health-watchdog (liveness ядер + bridge-reconnect). Вынесено из main.js.
// Пока connected — раз в 5с дёргаем health_snapshot:
//   sing-box упал → туннель закрыт: снять прокси, idle, нотифай с причиной, логи.
//   xray/naive/TT-мост упал → авто-реконнект (пересобирает конфиг и поднимает ядра).
// После аварийного fail-closed shutdown тот же таймер остаётся в guard-only
// режиме и следит только за WFP, пока пользователь явно не снимет блок.
// Всё, что тянется из main (текущее состояние, флаг установки апдейта, гашение ядра,
// реконнект, переключение вью, движок качества), инжектится — тот же паттерн, что у
// /lib/warp-rescan.js, /lib/dns-guard.js, /lib/wifi-guard.js.
//
// Разделение слоёв: ФАКТ смерти ядра приходит событием из Rust (vpn:core-died)
// мгновенно, а этот модуль решает, что с ним делать. Таймер остаётся вторым
// контуром: он проверяет WFP, мосты и качество — то, о чём событий нет.

import { toast } from "/lib/toast.js";
import { notify } from "/lib/notify.js";
import { t } from "/lib/i18n/index.js";
import { perfObserver } from "/lib/performance-observer.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const HEALTH_TICK_MS = 5000;
// Ядро может умереть по причине, которую перезапуск не лечит (битый конфиг,
// занятый порт, убитый антивирусом бинарь). Одна попытка на окно: она покрывает
// разовый краш под нагрузкой — сценарий, ради которого восстановление и нужно, —
// и не превращается в цикл «поднялся → умер» с новым туннелем каждые полминуты.
const CORE_RESTORE_MAX = 1;
const CORE_RESTORE_WINDOW_MS = 15 * 60_000;
// Опоздание тика больше этого — таймер WebView задушен (скрытая страница в трее
// или голодание рендерера). Пишем в журнал, потому что в таком режиме проверка
// WFP и движок качества работают не на заявленной частоте, и это надо видеть.
const TICK_LATE_MS = 15_000;
const TICK_LATE_REPORT_GAP_MS = 60_000;
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
  // Поднять runtime заново после смерти ядра. Не инжектится → сторож ведёт себя
  // как раньше: гасит и отдаёт решение пользователю.
  restoreAfterCoreDeath = null,
  // Подписка на vpn:core-died. Возвращает функцию отписки.
  subscribeCoreDeath = null,
  recordDiagnostic = () => {},
  invoke: invokeFn = invoke,
  toast: toastFn = toast,
  notify: notifyFn = notify,
  t: tr = t,
  setInterval: setIntervalFn = setInterval,
  clearInterval: clearIntervalFn = clearInterval,
  perf = perfObserver,
  now = Date.now,
}) {
  let timer = null;
  let busy = false;
  let bridgeReconnects = [];
  let coreRestores = [];
  let generation = 0;
  let killSwitchAlerted = false;
  let unsubscribeCoreDeath = null;
  let lastTimerAt = 0;
  let lastLateReportAt = 0;

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
    const cut = now() - BRIDGE_RECONNECT_WINDOW_MS;
    bridgeReconnects = bridgeReconnects.filter((ts) => ts > cut);
    if (bridgeReconnects.length >= BRIDGE_RECONNECT_MAX) return false;
    bridgeReconnects.push(now());
    return true;
  }

  function coreRestoreAllowed() {
    if (typeof restoreAfterCoreDeath !== "function") return false;
    const cut = now() - CORE_RESTORE_WINDOW_MS;
    coreRestores = coreRestores.filter((ts) => ts > cut);
    if (coreRestores.length >= CORE_RESTORE_MAX) return false;
    coreRestores.push(now());
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

  // Опоздание меряем на самом таймере, а не внутри tick(): tick зовут ещё и
  // событие смерти ядра, и тесты, и такие вызовы не говорят ничего о частоте
  // пробуждений WebView.
  function timerTick() {
    const at = now();
    if (lastTimerAt) {
      const gap = at - lastTimerAt;
      perf.gauge("watchdog.tickGapMs", gap);
      if (gap - HEALTH_TICK_MS >= TICK_LATE_MS) {
        perf.increment("watchdog.tickLate");
        console.warn(`health tick late: gap ${gap}ms (expected ${HEALTH_TICK_MS}ms)`);
        if (at - lastLateReportAt >= TICK_LATE_REPORT_GAP_MS) {
          lastLateReportAt = at;
          recordDiagnostic("watchdog_tick", "degraded", `gap_${Math.round(gap)}ms`);
        }
      }
    }
    lastTimerAt = at;
    void tick();
  }

  function start() {
    if (timer) return;
    generation++;
    killSwitchAlerted = false;
    lastTimerAt = now();
    lastLateReportAt = 0;
    timer = setIntervalFn(timerTick, HEALTH_TICK_MS);
    if (typeof subscribeCoreDeath === "function" && !unsubscribeCoreDeath) {
      const run = generation;
      const settle = (off) => {
        if (typeof off !== "function") return;
        // Подписка едет через IPC. Пока она ехала, сторож могли остановить и
        // запустить заново — тогда она чужая: снимаем её, а не подменяем ею
        // актуальную, иначе на каждый цикл stop/start копился бы лишний слушатель.
        if (run !== generation || !timer || unsubscribeCoreDeath) { off(); return; }
        unsubscribeCoreDeath = off;
      };
      // Событие только СОКРАЩАЕТ задержку: своей логики оно не несёт, а зовёт
      // тот же tick. Все guard'ы (busy, поколение, установка апдейта) и решение
      // остаются в одном месте.
      const result = subscribeCoreDeath(() => { if (run === generation) void tick(); });
      if (typeof result === "function") settle(result);
      else if (result && typeof result.then === "function") {
        result.then(settle).catch((error) => console.warn("core death subscription failed", error));
      }
    }
  }

  function stop() {
    generation++;
    killSwitchAlerted = false;
    lastTimerAt = 0;
    if (timer) { clearIntervalFn(timer); timer = null; }
    if (unsubscribeCoreDeath) {
      try { unsubscribeCoreDeath(); } catch (error) { console.warn("core death unsubscribe failed", error); }
      unsubscribeCoreDeath = null;
    }
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
        if (why) console.warn("sing-box died:", why);
        // Бюджет считаем ДО остановки: после неё state уже idle, и повторный
        // вход сюда невозможен, а списывать попытку надо один раз.
        const mayRestore = coreRestoreAllowed();
        const outcome = await withFrontendRecovery(
          { reason: "process_dead" },
          async (operationToken) => {
            const stopped = await shutdownCore(withOperationToken({
              preserveKillSwitch: shouldPreserveKillSwitch(),
            }, operationToken));
            if (!stopped) return "stop_failed";
            if (!mayRestore) return "stopped";
            // Восстановление держим внутри ТОЙ ЖЕ операции: между остановкой и
            // повторным стартом никакая другая операция не должна вклиниться, а
            // fail-closed WFP всё это время сохранён shutdownCore'ом.
            toastFn(tr("conn.coreRestoring"), "warn", 4000, { group: "conn", connecting: true });
            const restored = await restoreAfterCoreDeath(
              tr("conn.coreRestoring"),
              withOperationToken({}, operationToken),
            );
            return restored ? "restored" : "restore_failed";
          },
        );
        if (!outcome || outcome === "stop_failed") return;
        recordDiagnostic("core_death", outcome, mayRestore ? "restore_attempted" : "restore_budget");
        if (outcome === "restored") {
          toastFn(tr("conn.coreRestored"), "success", 5000, { group: "conn" });
          notifyFn("Ninety", tr("conn.coreRestored"));
          return;
        }
        toastFn(tr("conn.coreStopped"), "error", 7000, { group: "conn", desc: tr("conn.coreStoppedDesc") });
        notifyFn(tr("conn.notifyClosedTitle"), tr("conn.notifyClosedBody"));
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
      if (!active(run)) return;
      const engine = getQualityEngine();
      // Сначала говорим движку, виноват ли хост. Под нехваткой CPU/памяти
      // деградация канала — следствие, а не причина: лечить её сменой ноды и
      // реконнектом значит платить самым дорогим действием ровно тогда, когда
      // машине и так плохо.
      engine?.setHostPressure?.(snap.host_pressure?.active === true);
      engine?.tick().catch(() => {});
    } catch (e) {
      console.warn("healthTick failed", e);
    } finally {
      busy = false;
    }
  }

  return { start, stop, tick };
}
