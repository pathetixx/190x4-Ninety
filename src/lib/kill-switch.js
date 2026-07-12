// Ninety · WFP kill switch glue (вынесено из main.js).
//
// В режимах proxy/systemProxy при включённой опции на время соединения поднимаем
// WFP-блок (весь исходящий, кроме loopback и движков Ninety по app-id) — при
// падении ядра трафик не утекает мимо туннеля. В TUN не нужен (strict_route).
// WFP требует админ-прав: если процесс не elevated — не армим и подсказываем
// тостом (один раз). Rust-сторона — src-tauri/src/killswitch.rs.

import { loadOptions } from "/lib/options.js";
import { getMode } from "/lib/singbox.js";
import { toast } from "/lib/toast.js";
import { t } from "/lib/i18n/index.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

export function createKillSwitchController(deps = {}) {
  const call = deps.invoke || invoke;
  const options = deps.loadOptions || loadOptions;
  const mode = deps.getMode || getMode;
  const showToast = deps.toast || toast;
  const tr = deps.t || t;
  const warn = deps.warn || ((...args) => console.warn(...args));
  let desiredConnected = false;
  let revision = 0;
  let queue = Promise.resolve();
  let killSwitchHintShown = false;

  async function reconcile() {
    const mine = revision;
    const wanted = desiredConnected;
    try {
      if (!wanted) {
        await call("killswitch_disarm");
        return true;
      }
      const opts = options();
      if (!opts.general?.killSwitch || mode() === "tun") {
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
      await call("killswitch_arm", { allowLan: options().route?.bypassLan !== false });
      const active = await call("killswitch_active");
      return active === true;
    } catch (e) {
      warn("kill switch", e);
      return false;
    }
  }

  // Все arm/disarm выполняются строго последовательно. Если disconnect пришёл
  // во время arm, его disarm стоит в той же очереди и гарантированно идёт после.
  function apply(connected) {
    desiredConnected = !!connected;
    revision++;
    queue = queue.then(reconcile, reconcile);
    return queue;
  }

  return { apply };
}

const killSwitchController = createKillSwitchController();

// connected=true → поднять блок (если опция вкл и не TUN и elevated);
// connected=false → снять. Идемпотентно на стороне Rust.
export function applyKillSwitch(connected) {
  return killSwitchController.apply(connected);
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
