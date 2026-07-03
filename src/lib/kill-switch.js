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

let killSwitchHintShown = false;

// connected=true → поднять блок (если опция вкл и не TUN и elevated);
// connected=false → снять. Идемпотентно на стороне Rust.
export async function applyKillSwitch(connected) {
  try {
    if (!connected) { await invoke("killswitch_disarm"); return; }
    if (!loadOptions().general?.killSwitch || getMode() === "tun") {
      await invoke("killswitch_disarm");
      return;
    }
    if (!(await invoke("is_elevated"))) {
      if (!killSwitchHintShown) {
        killSwitchHintShown = true;
        toast(t("elev.killSwitchHint"), "warn", 6000);
      }
      return;
    }
    // allowLan привязан к route.bypassLan (та же семантика «не трогать локалку»);
    // DHCP kill switch пропускает всегда — рвать renew lease нельзя.
    await invoke("killswitch_arm", { allowLan: loadOptions().route?.bypassLan !== false });
  } catch (e) { console.warn("kill switch", e); }
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
