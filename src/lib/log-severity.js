// Health-checker urltest опрашивает КАЖДУЮ ноду подписки — балансеру нужны
// задержки всех, чтобы выбирать лучшую. К работе выбранного сервера отчёты по
// остальным отношения не имеют, а на большой подписке вытесняют из журнала всё
// остальное. Возвращает тег ноды, о которой отчитывается строка; вызывающий
// оставляет только активную. В файле на диске строки остаются: «Копировать»
// отдаёт его как есть.
const NODE_PROBE_RE = /^(?:monitoring:\s*)?outbound\s+(\S+)\s+URL test\b/i;

// WSAECONNABORTED и его Go-эквиваленты: локальное приложение (браузер, Steam,
// игра) закрыло сокет раньше, чем ядро дописало ответ. Инициатор — клиент на
// этой же машине, туннель тут ни при чём, но sing-box печатает такое уровнем
// ERROR, и на активном трафике фильтр «Ошибки» состоит почти целиком из них.
// Не прячем: массовый всплеск обрывов бывает и симптомом (kill switch рубит
// сессии, ядро перезапустилось) — понижаем до отладочного уровня.
const LOCAL_ABORT_RE = /(aborted by the software in your host machine|use of closed network connection)/i;

// Тот же случай, но Windows отдаёт другой код: приложение не «прервало», а
// сбросило соединение (WSAECONNRESET). «remote host» в тексте — это тот же
// 127.0.0.1, то есть локальный клиент, поэтому якорь стоит на адресе источника,
// а не на формулировке: reset от настоящего удалённого пира обязан остаться
// ошибкой.
const LOOPBACK_RESET_RE = /^inbound\/\S+:\s*process connection from 127\.0\.0\.1:\d+:.*forcibly closed by the remote host/i;

export function healthProbeNodeTag(message) {
  const match = NODE_PROBE_RE.exec(String(message || "").trim());
  return match ? match[1] : null;
}

export function classifyEngineLogSeverity(level, message) {
  const normalizedLevel = String(level || "").toUpperCase();
  const text = String(message || "");
  if (LOCAL_ABORT_RE.test(text) || LOOPBACK_RESET_RE.test(text)) {
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
