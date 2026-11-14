export const STARTUP_CONNECT_MODES = ["off", "restore", "always"];

// Подключаться ли при обычном (ручном) запуске по настройке «При запуске».
// restore — только если VPN был подключён, когда Ninety закрылась: ручное
// «Отключить» записывает "off", и следующий запуск остаётся без VPN.
export function startupConnectRequested({ setting, lastState }) {
  if (setting === "always") return true;
  if (setting === "restore") return lastState === "on";
  return false;
}

export function startupRuntimePlan({ autoconnect, resume, dpiEnabled, mode, tunSplitDiscord }) {
  const vpnWanted = !!autoconnect || !!resume?.vpn;
  const tunWanted = mode === "tun";
  const dpiWanted = !!dpiEnabled && (!tunWanted || !!tunSplitDiscord);
  return {
    vpnWanted,
    tunWanted,
    dpiWanted,
    shouldRun: vpnWanted || dpiWanted,
  };
}
