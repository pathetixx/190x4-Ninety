// Ninety · WFP kill switch glue (вынесено из main.js).
//
// В режимах proxy/systemProxy при включённой опции на время соединения поднимаем
// WFP-блок (весь исходящий, кроме loopback и движков Ninety по app-id) — при
// падении ядра трафик не утекает мимо туннеля. В обычном TUN достаточно
// strict_route. Высокоуровневый «Строгий туннель» дополнительно армит TUN-WFP:
// разрешён трафик через интерфейс ninety-tun и движки, а после смерти ядра
// block-all остаётся активен, пока пользователь явно не отключит соединение.
// WFP требует админ-прав: если процесс не elevated — не армим и подсказываем
// тостом (один раз). Rust-сторона — src-tauri/src/killswitch.rs.

import { loadOptions } from "/lib/options.js";
import { getMode } from "/lib/singbox.js";
import { toast } from "/lib/toast.js";
import { t } from "/lib/i18n/index.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// После перезагрузки WebView локальные latch-переменные исчезают, но backend и
// его dynamic WFP session продолжают жить. Runtime мог уже упасть, поэтому
// running здесь намеренно не требуется: подтверждённого active policy +
// сохранённой опции достаточно, чтобы продолжить guard-only наблюдение.
export function snapshotConfirmsOrdinaryKillSwitch(snapshot, options) {
  return !!options?.general?.killSwitch
    && snapshot?.killSwitchActive === true
    && snapshot?.strictPrivacy === false
    && ["proxy", "systemProxy"].includes(snapshot?.mode);
}

export function snapshotConfirmsStrictKillSwitch(snapshot, options) {
  return !!options?.privacy?.strictTunnel
    && snapshot?.killSwitchActive === true;
}

export function createKillSwitchController(deps = {}) {
  const call = deps.invoke || invoke;
  const options = deps.loadOptions || loadOptions;
  const mode = deps.getMode || getMode;
  const showToast = deps.toast || toast;
  const tr = deps.t || t;
  const warn = deps.warn || ((...args) => console.warn(...args));
  let desiredConnected = false;
  let desiredPhase = "connected";
  let preserveDisconnected = false;
  let desiredPolicyMode = null;
  let revision = 0;
  let queue = Promise.resolve();
  let killSwitchHintShown = false;

  async function reconcile() {
    const mine = revision;
    const wanted = desiredConnected;
    const policyMode = desiredPolicyMode;
    try {
      const opts = options();
      const currentMode = policyMode || mode();
      const strictTunnel = !!opts.privacy?.strictTunnel && currentMode === "tun";
      const ordinaryKillSwitch = !!opts.general?.killSwitch && currentMode !== "tun";
      if (!wanted && preserveDisconnected) {
        if (!strictTunnel && !ordinaryKillSwitch) {
          await call("killswitch_disarm");
          return true;
        }
        if (await call("killswitch_active") === true) return true;
        const elevated = await call("is_elevated");
        if (mine !== revision || desiredConnected || !preserveDisconnected) return false;
        if (!elevated) {
          if (!killSwitchHintShown) {
            killSwitchHintShown = true;
            showToast(tr("elev.killSwitchHint"), "warn", 6000);
          }
          return false;
        }
        // Core уже остановлен или сейчас будет остановлен: восстанавливаем
        // fail-closed barrier без TUN-permit. Для strict это preconnect policy,
        // для обычного Kill Switch — тот же аварийный block-all, который не
        // выпускает приложения напрямую после смерти sing-box.
        await call("killswitch_arm", {
          allowLan: strictTunnel ? false : opts.route?.bypassLan !== false,
          tunInterface: null,
          strictTunnel,
        });
        return await call("killswitch_active") === true;
      }
      if (!wanted) {
        await call("killswitch_disarm");
        return true;
      }
      if (!strictTunnel && (!opts.general?.killSwitch || currentMode === "tun")) {
        await call("killswitch_disarm");
        return true;
      }
      const elevated = await call("is_elevated");
      // Пока ждали UAC/IPC, пользователь мог отключиться или сменить режим.
      // Следующая queued reconciliation применит последнее желаемое состояние.
      if (mine !== revision || !desiredConnected) return false;
      if (!elevated) {
        if (!killSwitchHintShown) {
          killSwitchHintShown = true;
          showToast(tr("elev.killSwitchHint"), "warn", 6000);
        }
        return false;
      }
      // До старта ядра строгий WFP работает как fail-closed заслон: разрешены
      // только движки, которым нужно дозвониться до VPN. После появления TUN
      // переармируем фильтр на LUID виртуального интерфейса.
      // Rust собирает новую dynamic-session целиком и только затем атомарно
      // меняет её со старой. Поэтому здесь нельзя делать disarm-first: даже
      // короткое окно между сессиями выпустило бы приложения в физическую сеть.
      await call("killswitch_arm", {
        allowLan: strictTunnel ? false : opts.route?.bypassLan !== false,
        tunInterface: strictTunnel && desiredPhase === "connected" ? "ninety-tun" : null,
        strictTunnel,
      });
      const active = await call("killswitch_active");
      return active === true;
    } catch (e) {
      warn("kill switch", e);
      return false;
    }
  }

  // Все arm/disarm выполняются строго последовательно. Если disconnect пришёл
  // во время arm, его disarm стоит в той же очереди и гарантированно идёт после.
  function apply(connected, {
    preserve = false,
    phase = "connected",
    policyMode = null,
  } = {}) {
    desiredConnected = !!connected;
    desiredPhase = phase === "preconnect" ? "preconnect" : "connected";
    preserveDisconnected = !desiredConnected && !!preserve;
    desiredPolicyMode = ["proxy", "systemProxy", "tun"].includes(policyMode)
      ? policyMode
      : null;
    revision++;
    queue = queue.then(reconcile, reconcile);
    return queue;
  }

  return { apply };
}

const killSwitchController = createKillSwitchController();

// connected=true → поднять блок (если опция вкл и не TUN и elevated);
// connected=false → снять. Идемпотентно на стороне Rust.
export function applyKillSwitch(connected, options) {
  return killSwitchController.apply(connected, options);
}

// Предупреждение при включении kill switch в режиме «Прокси»: там armed-блок
// режет ВЕСЬ трафик, кроме приложений, вручную направленных в локальный прокси
// (в systemProxy/TUN трафик и так идёт через 127.0.0.1/туннель). Иначе юзер
// удивляется «пропавшему интернету». Показываем один раз за сессию.
let proxyWarnShown = false;
export function maybeWarnKillSwitchProxy() {
  if (loadOptions().general?.killSwitch && getMode() === "proxy" && !proxyWarnShown) {
    proxyWarnShown = true;
    toast(t("elev.killSwitchProxyHint"), "warn", 7000);
  }
}
