// Ninety · IP forwarding on the external interface (issue #168).
//
// The probe lives in Rust (forwarding.rs): that's also where the explanation of why forwarding
// loops TUN is. Here — only what the interface needs: whether there's a problem
// and which command removes it. Ninety doesn't change the settings itself: forwarding is sometimes
// needed deliberately (Hyper-V, WSL, sharing), it's up to the person.

/// There's a problem only if forwarding is enabled on an interface with internet
/// access right now. The registry flag alone breaks nothing without it.
export function forwardingProblem(status) {
  return Array.isArray(status?.interfaces) && status.interfaces.length > 0;
}

/// Adapter names separated by commas, without repeats (IPv4 and IPv6 of the same adapter).
export function forwardingAliases(status) {
  const names = (status?.interfaces || []).map((entry) => String(entry?.alias || "").trim()).filter(Boolean);
  return [...new Set(names)].join(", ");
}

// A string in PowerShell single quotes: the only special character is the quote itself.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/// Commands for PowerShell run as administrator. They turn forwarding off on
/// the found interfaces immediately, and the registry flag too, so it doesn't come back after
/// a reboot.
export function forwardingFixCommand(status) {
  const lines = [];
  for (const entry of status?.interfaces || []) {
    if (!entry?.alias) continue;
    const family = entry.family === "ipv6" ? "IPv6" : "IPv4";
    lines.push(`Set-NetIPInterface -InterfaceAlias ${psQuote(entry.alias)} -AddressFamily ${family} -Forwarding Disabled`);
  }
  if (status?.routerEnabled) {
    lines.push("Set-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters' -Name IPEnableRouter -Value 0");
  }
  return lines.join("\n");
}
