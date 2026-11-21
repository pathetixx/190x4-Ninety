// Ninety · auto-protection on foreign Wi-Fi (III.3) — moved out of main.js.
//
// The policy is in the frontend (Rust only returns the current network, wifi.rs::current_wifi):
// on an OPEN network that isn't trusted, with the option on, we auto-enable
// TUN (changeMode brings up UAC itself). Secured networks are left alone. lastWifiHandled
// suppresses a repeat on the same network so as not to trigger UAC in a loop. The previous mode
// is remembered in WIFI_PREV_MODE_KEY and restored when the network is safe again;
// a manual mode change cancels the restore (main.js::changeMode → forgetWifiAutoRestore).

import { getOptionsSnapshot } from "/lib/options.js";
import { STORAGE_KEYS } from "/lib/storage-policy.js";
import { getMode } from "/lib/singbox.js";
import { toast } from "/lib/toast.js";
import { t } from "/lib/i18n/index.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

// Key names come from the storage policy: it decides what gets backed up and what
// gets cleared, and a literal in the module would silently drift away from it.
const WIFI_TRUSTED_KEY = STORAGE_KEYS.wifiTrusted;
const WIFI_PREV_MODE_KEY = STORAGE_KEYS.wifiPrevMode;

function wifiTrusted() {
  try { return JSON.parse(localStorage.getItem(WIFI_TRUSTED_KEY) || "[]"); }
  catch { return []; }
}

// A manual mode change by the user cancels the auto-restore of the previous mode.
export function forgetWifiAutoRestore() {
  try { localStorage.removeItem(WIFI_PREV_MODE_KEY); } catch {}
}

// changeMode is injected from main.js (it closes over setMode/UI/reconnect) — this way the module
// doesn't pull a reverse dependency on main.js.
export function initWifiGuard({ changeMode }) {
  let lastWifiHandled = null;

  async function checkWifiProtect() {
    try {
      if (!getOptionsSnapshot().general?.autoProtectWifi) return;
      const w = await invoke("current_wifi");
      const onOpenUntrusted = !!w?.connected && !w.secured && !wifiTrusted().includes(w.ssid);
      if (!onOpenUntrusted) {
        lastWifiHandled = null;
        // The network is safe (or Wi-Fi is off) — restore the mode that was there before the auto-TUN.
        const prev = localStorage.getItem(WIFI_PREV_MODE_KEY);
        if (prev) {
          forgetWifiAutoRestore();
          if (getMode() === "tun") {
            toast(t("wifi.autoRestore"), "info", 3500);
            changeMode(prev, { auto: true });
          }
          // getMode() !== "tun": the user left TUN themselves — just forget the key.
        }
        return;
      }
      if (getMode() === "tun") return; // already protected
      if (lastWifiHandled === w.ssid) return; // already reacted to this network
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
