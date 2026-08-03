export function classifyEngineLogSeverity(level, message) {
  const normalizedLevel = String(level || "").toUpperCase();
  const text = String(message || "");
  const geoLookup = /monitoring:\s*Failed try \d+ to get IP info:/i.test(text);
  const expectedProviderFailure = /(\b429\b|\b404\b|non-200 response|EOF|server gave HTTP response to HTTPS client)/i.test(text);
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
