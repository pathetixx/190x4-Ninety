// Ninety · какие настройки реально приводят к изменению sing-box конфига и
// требуют рестарта ядра. Всё остальное (Windows-state, неактивные ветки
// config'а) применяется мгновенно, без переподключения.
// Чистая функция: opts (loadOptions()) и mode (getMode()) передаёт вызывающий —
// покрыта тестами в tests/restart-policy.test.mjs.
export function pathNeedsRestart(path, opts, mode) {
  if (!path) return true;
  // Windows-сторона, sing-box не трогает
  if (path === "general.autostart") return false;
  if (path === "general.startMinimized") return false;
  if (path === "general.linkHandlers") return false;
  // Автозапуск защищённого браузера не меняет сетевой runtime.
  if (path === "privacy.protectedBrowserAutoLaunch") return false;
  // Строгий туннель меняет режим, DNS, маршруты, outbound и TUN strict_route.
  if (path === "privacy.strictTunnel") return true;
  // Kill switch — WFP-фильтр, применяется вживую (см. onChange); ядро не трогает.
  if (path === "general.killSwitch") return false;
  // WARP register/reset — переразложить config нужно только если WARP активен
  if (path === "warp.registered") return !!opts?.warp?.enabled;
  // warp.deepScan и warp.autoRescan* — не идут в config sing-box, только в UI/JS-loop
  if (path === "warp.deepScan") return false;
  if (path.startsWith("warp.autoRescan")) return false;
  // customNoise активна только при noisePreset=="custom"; если другой — игнор
  if (path.startsWith("warp.customNoise.") && opts?.warp?.noisePreset !== "custom") return false;
  // WARP-настройки при выключенном WARP в config не попадают
  if (path.startsWith("warp.") && path !== "warp.enabled" && !opts?.warp?.enabled) return false;
  // TUN-only поля в proxy-режиме не используются (см. inbound в singbox.js)
  if (path === "inbound.mtu" || path === "inbound.tunStack" || path === "inbound.strictRoute") {
    return mode === "tun";
  }
  // split-routing Discord влияет только на TUN-маршруты
  if (path === "route.tunSplitDiscord") return mode === "tun";
  return true;
}
