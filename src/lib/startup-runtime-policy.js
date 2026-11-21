export const STARTUP_CONNECT_MODES = ["off", "restore", "always"];

// Whether to connect on a regular (manual) launch per the "On launch" setting.
// restore — only if the VPN was connected when Ninety was closed: a manual
// "Disconnect" writes "off", and the next launch stays without the VPN.
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
