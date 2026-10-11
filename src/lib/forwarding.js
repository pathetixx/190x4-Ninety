// Ninety · пересылка IP на внешнем интерфейсе (issue #168).
//
// Проба живёт в Rust (forwarding.rs): там же объяснение, почему пересылка
// зацикливает TUN. Здесь — только то, что нужно интерфейсу: есть ли проблема
// и какой командой её снять. Сами настройки Ninety не меняет: пересылка бывает
// нужна осознанно (Hyper-V, WSL, раздача), решать человеку.

/// Проблема есть, только если пересылка включена на интерфейсе с выходом в
/// интернет прямо сейчас. Один флаг реестра без неё ничего не ломает.
export function forwardingProblem(status) {
  return Array.isArray(status?.interfaces) && status.interfaces.length > 0;
}

/// Имена адаптеров через запятую, без повторов (IPv4 и IPv6 одного адаптера).
export function forwardingAliases(status) {
  const names = (status?.interfaces || []).map((entry) => String(entry?.alias || "").trim()).filter(Boolean);
  return [...new Set(names)].join(", ");
}

// Строка в одинарных кавычках PowerShell: единственный спецсимвол — сама кавычка.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/// Команды для PowerShell от имени администратора. Выключают пересылку на
/// найденных интерфейсах сразу, а флаг реестра — чтобы она не вернулась после
/// перезагрузки.
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
