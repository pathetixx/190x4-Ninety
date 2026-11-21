// Ninety · which settings actually change the sing-box config and
// require a core restart. Everything else (Windows state, inactive branches
// of the config) applies instantly, without reconnecting.
// A pure function: opts (loadOptions()) and mode (getMode()) are passed by the caller —
// covered by tests in tests/restart-policy.test.mjs.
export function pathNeedsRestart(path, opts, mode) {
  if (!path) return true;
  // The Windows side, doesn't touch sing-box
  if (path === "general.autostart") return false;
  if (path === "general.startMinimized") return false;
  if (path === "general.startupConnect") return false;
  if (path === "general.linkHandlers") return false;
  // These switches are read on the fly: Wi-Fi auto-protection by its own loop,
  // geo requests by the IP tile, direct subscription updates on load.
  // Reconnecting for them tore down all connections for no reason.
  if (path === "general.autoProtectWifi") return false;
  if (path === "general.disableGeoLookup") return false;
  if (path === "general.allowDirectSubscriptionFallback") return false;
  // Protected browser autostart doesn't change the network runtime.
  if (path === "privacy.protectedBrowserAutoLaunch") return false;
  // Strict tunnel changes the mode, DNS, routes, outbound and TUN strict_route.
  if (path === "privacy.strictTunnel") return true;
  // Kill switch is a WFP filter, applied live (see onChange); doesn't touch the core.
  if (path === "general.killSwitch") return false;
  // "Diagnostics" screen settings (the target set, pinned addresses) don't get into the core
  // config at all.
  if (path.startsWith("diagnose.")) return false;
  // A user rule's label is only for the list, it doesn't go into the config.
  if (path === "route.customRules.label") return false;
  // WARP register/reset — the config needs to be rebuilt only if WARP is active
  if (path === "warp.registered") return !!opts?.warp?.enabled;
  // warp.deepScan and warp.autoRescan* don't go into the sing-box config, only into the UI/JS loop
  if (path === "warp.deepScan") return false;
  if (path.startsWith("warp.autoRescan")) return false;
  // customNoise is active only with noisePreset=="custom"; otherwise ignored
  if (path.startsWith("warp.customNoise.") && opts?.warp?.noisePreset !== "custom") return false;
  // WARP settings don't get into the config while WARP is off
  if (path.startsWith("warp.") && path !== "warp.enabled" && !opts?.warp?.enabled) return false;
  // FakeDNS gets into the config only in TUN (see buildDns in singbox.js).
  if (path === "dns.enableFakeDns") return mode === "tun";
  // TUN-only fields aren't used in proxy mode (see inbound in singbox.js)
  if (path === "inbound.mtu" || path === "inbound.tunStack" || path === "inbound.strictRoute") {
    return mode === "tun";
  }
  // Discord split routing affects only TUN routes
  if (path === "route.tunSplitDiscord") return mode === "tun";
  // The inbound for network neighbors exists only outside TUN and only with network access;
  // the login and password (kept by the backend) — only with the password enabled.
  if (path === "inbound.lanAuth" || path === "inbound.lanPort" || path === "inbound.lanCredentials") {
    const lan = mode !== "tun" && !!opts?.inbound?.allowConnectionFromLan;
    return path === "inbound.lanAuth" ? lan : lan && !!opts?.inbound?.lanAuth;
  }
  return true;
}
