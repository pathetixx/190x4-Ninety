// Health-checker urltest опрашивает КАЖДУЮ ноду подписки — балансеру нужны
// задержки всех, чтобы выбирать лучшую. К работе выбранного сервера отчёты по
// остальным отношения не имеют, а на большой подписке вытесняют из журнала всё
// остальное. Возвращает тег ноды, о которой отчитывается строка; вызывающий
// оставляет только активную. В файле на диске строки остаются: «Копировать»
// отдаёт его как есть.
const NODE_PROBE_RE = /^(?:monitoring:\s*)?outbound\s+(\S+)\s+URL test\b/i;

export function healthProbeNodeTag(message) {
  const match = NODE_PROBE_RE.exec(String(message || "").trim());
  return match ? match[1] : null;
}

export function classifyEngineLogSeverity(level, message) {
  const normalizedLevel = String(level || "").toUpperCase();
  const text = String(message || "");
  const geoLookup = /monitoring:\s*Failed try \d+ to get IP info:/i.test(text);
  const expectedProviderFailure = /(\b429\b|\b404\b|non-200 response|EOF|context deadline exceeded|server gave HTTP response to HTTPS client)/i.test(text);
  if ((normalizedLevel === "WARN" || normalizedLevel === "WARNING")
    && geoLookup && expectedProviderFailure) {
    return { level: "INFO", grade: "info", nonFatal: true };
  }
  const grade = normalizedLevel === "ERROR" || normalizedLevel === "FATAL" || normalizedLevel === "PANIC"
    ? "err"
    : normalizedLevel === "WARN" || normalizedLevel === "WARNING"
      ? "warn"
      : normalizedLevel === "TRACE" || normalizedLevel === "DEBUG"
        ? "ok"
        : "info";
  return { level: normalizedLevel, grade, nonFatal: false };
}
