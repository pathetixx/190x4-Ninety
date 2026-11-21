// Ninety · the user's public IP (through the local sing-box inbound).
// A Rust command tries several IP providers and normalizes the response. The request
// ALWAYS goes through the sing-box loopback proxy (mixed-in / probe-in) — even in
// systemProxy and TUN: reqwest doesn't honor the system proxy, and Ninety.exe's own
// traffic in TUN goes direct via bypass, so "direct" would show
// the user's real IP, not the exit. main.js sets the explicit proxyHostPort.

import { maskIp } from "/lib/address-mask.js";
import { localizedInvoke } from "/lib/backend-errors.js";

const invoke = localizedInvoke(window.__TAURI__?.core?.invoke)
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

export async function fetchPublicIp({ proxyHostPort } = {}) {
  const proxy = proxyHostPort ? `http://${proxyHostPort}` : null;
  const info = await invoke("fetch_public_ip", { proxy });
  return info;
}

// Masking lives in /lib/address-mask.js — the diagnostics report uses it too.
// We re-export it: callers (main.js) know it from this module, and bindIpReveal
// below calls it directly.
export { maskIp };

// 20-second auto-hide reveal
let revealTimer = null;
export function bindIpReveal(el, getFullIp) {
  el.addEventListener("click", () => {
    const full = getFullIp();
    if (!full) return;
    el.dataset.revealed = "true";
    el.textContent = full;
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      el.dataset.revealed = "false";
      el.textContent = maskIp(full);
    }, 20_000);
  });
}
