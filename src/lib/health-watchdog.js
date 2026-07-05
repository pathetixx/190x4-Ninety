// Ninety · health-watchdog (liveness ядер + bridge-reconnect). Вынесено из main.js.
// Пока connected — раз в 5с дёргаем health_snapshot:
//   sing-box упал → туннель закрыт: снять прокси, idle, нотифай с причиной, логи.
//   xray/naive/TT-мост упал → авто-реконнект (пересобирает конфиг и поднимает ядра).
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
}) {
  let timer = null;
  let busy = false;
  let bridgeReconnects = [];

  function bridgeReconnectAllowed() {
    const cut = Date.now() - BRIDGE_RECONNECT_WINDOW_MS;
    bridgeReconnects = bridgeReconnects.filter((ts) => ts > cut);
    if (bridgeReconnects.length >= BRIDGE_RECONNECT_MAX) return false;
    bridgeReconnects.push(Date.now());
    return true;
  }

  // Бюджет исчерпан — мост падает системно, реконнекты не лечат. Закрываем туннель
  // целиком (как при смерти sing-box): честная ошибка вместо вечного цикла.
  async function stopForBridgeLoop() {
    await shutdownCore();
    toast(t("conn.bridgeLoop"), "error", 8000, { group: "conn", desc: t("conn.bridgeLoopDesc") });
    notify(t("conn.notifyClosedTitle"), t("conn.bridgeLoopDesc"));
    switchView("logs");
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, HEALTH_TICK_MS);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  async function tick() {
    if (getState() !== "connected" || busy || isUpdateInstalling()) return;
    busy = true;
    try {
      // Один агрегирующий вызов вместо четырёх (singbox_running/vpn_last_error/
      // xray_status/sidecar_status) — снимает лишний IPC-трафик на каждом тике.
      const snap = await invoke("health_snapshot");
      if (!snap.singbox_running) {
        // Причину смерти snapshot читает синхронно с running-статусом (до
        // shutdownCore, который сбрасывает флаги).
        const why = snap.last_error;
        await shutdownCore();
        toast(t("conn.coreStopped"), "error", 7000, { group: "conn", desc: t("conn.coreStoppedDesc") });
        notify(t("conn.notifyClosedTitle"), t("conn.notifyClosedBody"));
        if (why) console.warn("sing-box died:", why);
        switchView("logs");
        return;
      }
      // sing-box жив — проверяем xray-мост (xhttp).
      if (snap.xray === "died") {
        if (!bridgeReconnectAllowed()) { await stopForBridgeLoop(); return; }
        toast(t("conn.xhttpDown"), "warn", 4000, { group: "conn", connecting: true });
        notify("Ninety", t("conn.xhttpNotify"));
        // reconnectForSourceChange сам ставит needsReconnect и зовёт реконнект,
        // который поднимет sing-box И xray заново из свежего конфига.
        reconnectForSourceChange(t("conn.xhttpReconnect"));
        return;
      }
      // sidecar-клиенты naive/trusttunnel — та же логика, что у xray-моста.
      if (snap.sidecar === "died") {
        if (!bridgeReconnectAllowed()) { await stopForBridgeLoop(); return; }
        toast(t("conn.clientDown"), "warn", 4000, { group: "conn", connecting: true });
        notify("Ninety", t("conn.clientNotify"));
        reconnectForSourceChange(t("conn.clientReconnect"));
        return;
      }
      // Liveness OK — отдаём ход движку качества (детект троттла/деградации).
      // Fire-and-forget: проба до 4с не должна держать busy и тормозить следующий
      // liveness-тик; у движка свои guard'ы probing/remediating.
      getQualityEngine()?.tick().catch(() => {});
    } catch (e) {
      console.warn("healthTick failed", e);
    } finally {
      busy = false;
    }
  }

  return { start, stop };
}
