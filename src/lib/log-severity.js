// Health-checker urltest опрашивает КАЖДУЮ ноду подписки — балансеру нужны
// задержки всех, чтобы выбирать лучшую. К работе выбранного сервера отчёты по
// остальным отношения не имеют, а на большой подписке вытесняют из журнала всё
// остальное. Возвращает тег ноды, о которой отчитывается строка; вызывающий
// оставляет только активную. В файле на диске строки остаются: «Копировать»
// отдаёт его как есть.
const NODE_PROBE_RE = /^(?:monitoring:\s*)?outbound\s+(\S+)\s+URL test\b/i;

// Health-модуль hiddify-форка ходит за внешним IP и страной к своим публичным
// провайдерам (api.country.is, myip.expert, ipapi.co). Ninety этот результат не
// использует — IP, страну и ASN отдаёт собственный fetch_public_ip (clash.rs) со
// своим пулом. То есть в журнале это чужая телеметрия: её 429 (free-tier лимит),
// 404 и EOF ни на что не влияют, но идут пачками по числу провайдеров и попыток,
// да ещё и с телом ответа на отдельной строке. Прячем весь класс целиком —
// вместе с продолжением, иначе в журнале остаются висячие «429»/«404».
const GEO_LOOKUP_RE = /^monitoring:\s*Failed try \d+ to get IP info:/i;

// WSAECONNABORTED и его Go-эквиваленты: локальное приложение (браузер, Steam,
// игра) закрыло сокет раньше, чем ядро дописало ответ. Инициатор — клиент на
// этой же машине, туннель тут ни при чём, но sing-box печатает такое уровнем
// ERROR, и на активном трафике фильтр «Ошибки» состоит почти целиком из них.
// Не прячем: массовый всплеск обрывов бывает и симптомом (kill switch рубит
// сессии, ядро перезапустилось) — понижаем до отладочного уровня.
const LOCAL_ABORT_RE = /(aborted by the software in your host machine|use of closed network connection)/i;

export function healthProbeNodeTag(message) {
  const match = NODE_PROBE_RE.exec(String(message || "").trim());
  return match ? match[1] : null;
}

export function isGeoLookupNoise(message) {
  return GEO_LOOKUP_RE.test(String(message || "").trim());
}

export function classifyEngineLogSeverity(level, message) {
  const normalizedLevel = String(level || "").toUpperCase();
  const text = String(message || "");
  if (LOCAL_ABORT_RE.test(text)) {
    return { level: "DEBUG", grade: "ok", nonFatal: true };
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
