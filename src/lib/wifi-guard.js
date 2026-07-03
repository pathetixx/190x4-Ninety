// Ninety · авто-защита на чужих Wi-Fi (III.3) — вынесено из main.js.
//
// Политика во фронте (Rust только отдаёт текущую сеть, wifi.rs::current_wifi):
// на ОТКРЫТОЙ сети, не входящей в доверенные, при включённой опции — авто-включаем
// TUN (changeMode сам поднимет UAC). Защищённые сети не трогаем. lastWifiHandled
// гасит повтор на той же сети, чтобы не дёргать UAC по кругу. Прежний режим
// запоминаем в WIFI_PREV_MODE_KEY и возвращаем, когда сеть снова безопасна;
// ручная смена режима отменяет возврат (main.js::changeMode → forgetWifiAutoRestore).

import { loadOptions } from "/lib/options.js";
import { getMode } from "/lib/singbox.js";
import { toast } from "/lib/toast.js";
import { t } from "/lib/i18n/index.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

const WIFI_TRUSTED_KEY = "ninety.wifi.trusted";
const WIFI_PREV_MODE_KEY = "ninety.wifi.prevMode";

function wifiTrusted() {
  try { return JSON.parse(localStorage.getItem(WIFI_TRUSTED_KEY) || "[]"); }
  catch { return []; }
}

// Ручная смена режима юзером отменяет авто-возврат прежнего режима.
export function forgetWifiAutoRestore() {
  try { localStorage.removeItem(WIFI_PREV_MODE_KEY); } catch {}
}

// changeMode инжектится из main.js (замыкает setMode/UI/реконнект) — так модуль
// не тянет обратную зависимость на main.js.
export function initWifiGuard({ changeMode }) {
  let lastWifiHandled = null;

  async function checkWifiProtect() {
    try {
      if (!loadOptions().general?.autoProtectWifi) return;
      const w = await invoke("current_wifi");
      const onOpenUntrusted = !!w?.connected && !w.secured && !wifiTrusted().includes(w.ssid);
      if (!onOpenUntrusted) {
        lastWifiHandled = null;
        // Сеть безопасна (или Wi-Fi отключён) — вернуть режим, который был до авто-TUN.
        const prev = localStorage.getItem(WIFI_PREV_MODE_KEY);
        if (prev) {
          forgetWifiAutoRestore();
          if (getMode() === "tun") {
            toast(t("wifi.autoRestore"), "info", 3500);
            changeMode(prev, { auto: true });
          }
          // getMode() !== "tun": юзер сам ушёл из TUN — просто забываем ключ.
        }
        return;
      }
      if (getMode() === "tun") return; // уже защищены
      if (lastWifiHandled === w.ssid) return; // уже отреагировали на эту сеть
      lastWifiHandled = w.ssid;
      try { localStorage.setItem(WIFI_PREV_MODE_KEY, getMode()); } catch {}
      toast(t("wifi.openProtect", { ssid: w.ssid || t("wifi.noName") }), "warn", 4000);
      changeMode("tun", { auto: true });
    } catch {}
  }

  setInterval(checkWifiProtect, 25_000);
  window.addEventListener("focus", checkWifiProtect);
  checkWifiProtect();
}
