// Ninety · публичный IP юзера (через прокси-mode).
// Тянет ipwho.is через системный мини-прокси sing-box; в TUN-режиме можно вызывать
// и без proxy-arg — трафик автоматически пойдёт через интерфейс ядра.

const invoke = window.__TAURI__?.core?.invoke
  ?? (() => Promise.reject(new Error("Tauri invoke недоступен")));

export async function fetchPublicIp({ proxyHostPort } = {}) {
  const proxy = proxyHostPort ? `http://${proxyHostPort}` : null;
  const info = await invoke("fetch_public_ip", { proxy });
  return info;
}

// 1.2.3.4 → 1.2.*.* (Hiddify-style маскировка)
export function maskIp(ip) {
  if (!ip || typeof ip !== "string") return "—";
  if (ip.includes(":")) {
    // IPv6: первые две группы оставляем, остальное — *
    const parts = ip.split(":");
    return parts.slice(0, 2).join(":") + ":·:·";
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.*.*`;
}

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
