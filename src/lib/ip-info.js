// Ninety · публичный IP юзера (через локальный inbound sing-box).
// Rust-команда перебирает несколько IP-провайдеров и нормализует ответ. Запрос
// ВСЕГДА идёт через loopback-прокси sing-box (mixed-in / probe-in) — даже в
// systemProxy и TUN: reqwest не чтит системный прокси, а собственный трафик
// Ninety.exe в TUN уходит в direct bypass'ом, поэтому «напрямую» показал бы
// реальный IP юзера, а не exit. Явный proxyHostPort задаёт main.js.

import { maskIp } from "/lib/address-mask.js";

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

export async function fetchPublicIp({ proxyHostPort } = {}) {
  const proxy = proxyHostPort ? `http://${proxyHostPort}` : null;
  const info = await invoke("fetch_public_ip", { proxy });
  return info;
}

// Маскировка живёт в /lib/address-mask.js — её же использует отчёт диагностики.
// Реэкспортируем: вызывающие (main.js) знают её по этому модулю, а bindIpReveal
// ниже зовёт её напрямую.
export { maskIp };

// 20-секундный auto-hide reveal
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
