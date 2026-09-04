// Ninety · Диагностика — вердикт: одна фраза вместо простыни замеров.
//
// Здесь только правила вывода, без DOM и IPC: на вход — сырые результаты трёх
// проверок, на выход — { kind, severity, params, action }. Подпись собирает
// каталог i18n по kind, действие исполняет экран.
//
// Порядок правил = приоритет. Он не случайный: сначала то, что ломает
// соединение целиком (фильтр в пути, мёртвый сервер), потом то, что ломает
// отдельные сервисы, и лишь потом наблюдения про приватность. Иначе вердикт
// говорил бы про утечку IPv6 в момент, когда у человека вообще ничего не
// открывается.

// Доля целей, ниже которой «часть сервисов» не превращается в вывод про сеть:
// одна упавшая цель — это упавшая цель, а не блокировка.
const BLOCK_SHARE = 0.34;

const isBlockedState = (state) => state === "timeout" || state === "refused" || state === "dns" || state === "tls";
const isOkState = (state) => state === "ok";

function shareOf(rows, predicate) {
  const considered = rows.filter((row) => row.direct?.state !== "skipped" || row.tunnel?.state !== "skipped");
  if (!considered.length) return 0;
  return considered.filter(predicate).length / considered.length;
}

/// Строки, где туннель спасает: напрямую не открывается, через Ninety — да.
export function blockedDirectRows(rows) {
  return (rows || []).filter((row) => isBlockedState(row.direct?.state) && isOkState(row.tunnel?.state));
}

/// Строки, где мешает сам туннель: напрямую открывается, через Ninety — нет.
/// Это и есть кандидаты на правило «пустить напрямую».
export function blockedTunnelRows(rows) {
  return (rows || []).filter(
    (row) =>
      isOkState(row.direct?.state) &&
      (isBlockedState(row.tunnel?.state) || row.tunnel?.state === "http"),
  );
}

/// Строки, где сервис ответил отказом именно адресу сервера (403/429 и т.п.).
export function refusedByServiceRows(rows) {
  return (rows || []).filter((row) => row.tunnel?.state === "http" && (row.tunnel?.httpStatus ?? 0) >= 400);
}

/// Вердикт по собранным данным. Любая часть может отсутствовать (проверку не
/// запускали или она не смогла отработать) — правила это учитывают.
export function buildVerdict({ reach = [], trace = null, leaks = null, connected = false } = {}) {
  const rows = Array.isArray(reach) ? reach : [];

  // 1. Соединение до сервера. Вывод строится на ТРЁХ замерах сразу: дошёл ли
  // ping, открылся ли порт и открылся ли контрольный адрес. Поодиночке они
  // ничего не доказывают: закрытый порт и мёртвая сеть выглядят одинаково.
  if (trace && !trace.tcpOpen) {
    const controlOk = trace.control?.state === "open";
    const params = { ip: trace.resolvedIp || "", port: trace.port };
    if (!controlOk) {
      // Даже контрольный адрес не открывается — рвётся не сервер, а сеть.
      return { kind: "localNetwork", severity: "err", action: null, params };
    }
    if (trace.tcp?.state === "refused") {
      // На той стороне ответили отказом: порт закрыт или сервер не наш.
      return { kind: "serverPortSilent", severity: "err", action: "switchNode", params };
    }
    if (trace.icmpReached) {
      // Пакеты до сервера доходят, а соединение на порт молча съедают.
      return { kind: "filterInPath", severity: "err", action: "dpi", params };
    }
    return { kind: "serverUnreachable", severity: "err", action: "switchNode", params };
  }

  // 3. Туннель мешает конкретным сервисам (банк, госуслуги, локальные сервисы).
  const tunnelBroken = blockedTunnelRows(rows);
  const serviceRefused = refusedByServiceRows(rows);

  // 4. Сеть блокирует часть интернета, а туннель её открывает.
  const rescued = blockedDirectRows(rows);
  const rescuedShare = shareOf(rows, (row) => isBlockedState(row.direct?.state) && isOkState(row.tunnel?.state));

  if (rescued.length && rescuedShare >= BLOCK_SHARE) {
    return {
      kind: "networkBlocks",
      severity: "warn",
      action: tunnelBroken.length ? "ruleDirect" : null,
      params: { count: rescued.length, first: rescued[0]?.id || "" },
    };
  }

  if (tunnelBroken.length) {
    return {
      kind: "tunnelBlocksLocal",
      severity: "warn",
      action: "ruleDirect",
      params: { count: tunnelBroken.length, first: tunnelBroken[0]?.id || "" },
    };
  }

  if (serviceRefused.length) {
    return {
      kind: "serviceRefusesNode",
      severity: "warn",
      action: "switchNode",
      params: { count: serviceRefused.length, first: serviceRefused[0]?.id || "" },
    };
  }

  // 5. Приватность: смотрим только когда со связью всё в порядке.
  if (leaks) {
    if (leaks.dnsInTunnel?.state === "err") {
      return { kind: "dnsBroken", severity: "warn", action: null, params: {} };
    }
    if (leaks.dnsAnswerMatch?.state === "warn") {
      return { kind: "dnsMismatch", severity: "warn", action: null, params: {} };
    }
    if (leaks.ipv6Open?.state === "warn") {
      return { kind: "ipv6Open", severity: "warn", action: null, params: {} };
    }
  }

  if (!rows.length && !trace && !leaks) {
    return { kind: "idle", severity: "info", action: "run", params: {} };
  }

  return {
    kind: connected ? "clean" : "cleanOffline",
    severity: "ok",
    action: null,
    params: {},
  };
}

/// Короткая сводка фактов под вердиктом (плитка «DNS / TCP / канал …»).
/// Возвращает массив { key, state, value } — рендер и перевод на стороне UI.
export function verdictFacts({ trace = null, leaks = null, reach = [] } = {}) {
  const facts = [];
  if (trace) {
    facts.push({
      key: "trace",
      state: trace.tcpOpen ? "ok" : "err",
      // Показываем время соединения на порт, а не RTT последнего хопа: именно
      // оно отвечает на вопрос «дозвонились или нет».
      value: trace.tcpOpen && trace.tcp?.ms != null ? String(trace.tcp.ms) : "",
    });
  }
  if (leaks) {
    facts.push({ key: "dns", state: leaks.dnsInTunnel?.state || "skipped", value: "" });
    facts.push({ key: "ipv6", state: leaks.ipv6Open?.state === "ok" ? "ok" : "warn", value: "" });
    facts.push({ key: "ip", state: leaks.externalIp?.state || "skipped", value: leaks.externalIp?.detail || "" });
  }
  if (reach?.length) {
    const ok = reach.filter((row) => isOkState(row.tunnel?.state)).length;
    facts.push({ key: "reach", state: ok === reach.length ? "ok" : "warn", value: `${ok}/${reach.length}` });
  }
  return facts;
}

/// Сколько находок дал прогон — число для подсказки в меню. Находка это то, что
/// человек может починить: сервис, который открывается только с одной стороны,
/// оборванная трасса, замечание по утечкам. Строки, работающие с обеих сторон,
/// находками не считаются.
export function countFindings({ reach = [], trace = null, leaks = null } = {}) {
  const rows = Array.isArray(reach) ? reach : [];
  let count = blockedTunnelRows(rows).length + refusedByServiceRows(rows).length;
  // Одна строка может попасть в оба списка (403 через туннель при живом
  // прямом доступе) — не считаем её дважды.
  const both = rows.filter(
    (row) => isOkState(row.direct?.state) && row.tunnel?.state === "http" && (row.tunnel?.httpStatus ?? 0) >= 400,
  ).length;
  count -= both;
  count += blockedDirectRows(rows).length;
  if (trace && !trace.tcpOpen) count += 1;
  for (const check of [leaks?.dnsInTunnel, leaks?.dnsAnswerMatch, leaks?.externalIp, leaks?.ipv6Open]) {
    if (check?.state === "warn" || check?.state === "err") count += 1;
  }
  return Math.max(0, count);
}
