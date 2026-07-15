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
