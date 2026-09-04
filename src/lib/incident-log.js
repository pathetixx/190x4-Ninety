// Ninety · «чёрный ящик» — лента инцидентов связи.
//
// Зачем: движок качества, вотчдоги, карантин нод и kill switch уже чинят связь
// сами, но наружу их работа видна только тостом, который живёт три секунды.
// Лента хранит короткую историю: что случилось, что программа сделала и сколько
// это заняло — вкладка «Лента» в разделе «Диагностика».
//
// Записи хранят ДАННЫЕ, а не готовый текст: подпись собирается из каталога i18n
// в момент отрисовки. Иначе история, записанная на русском, так и осталась бы
// русской после смены языка (и наоборот).
//
// Ограничения хранилища: кольцо на CAP записей + TTL. Лента — не журнал (для
// него есть «Логи»), а обозримая история за последние дни; расти без границ ей
// незачем, а localStorage у пользователя один на всё приложение.

const KEY = "ninety.incidents.v1";
const CAP = 200;
const TTL_MS = 14 * 24 * 3600 * 1000;
// Инцидент считается закрытым, если после него не было событий дольше этого
// окна: программа могла починить связь молча (или пользователь сам переключил
// сервер), и вечно открытый инцидент врал бы про «идёт до сих пор».
const IDLE_CLOSE_MS = 10 * 60_000;

// Уровни: err/warn открывают инцидент, ok закрывает, info — контекст внутри.
export const INCIDENT_SEVERITIES = ["info", "ok", "warn", "err"];

const isOpener = (severity) => severity === "warn" || severity === "err";

function safeStorage(storage) {
  // Приватное окно, отключённые site data, ранний старт — доступ к localStorage
  // может бросить на самом обращении, не только на чтении ключа.
  try {
    if (storage) return storage;
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function createIncidentLog({
  storage,
  now = Date.now,
  cap = CAP,
  ttlMs = TTL_MS,
  key = KEY,
} = {}) {
  const store = safeStorage(storage);
  const listeners = new Set();
  let memory = null; // фолбэк, когда localStorage недоступен

  function read() {
    if (memory) return memory;
    if (!store) return (memory = []);
    try {
      const raw = store.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      memory = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      memory = [];
    }
    return memory;
  }

  function write(entries) {
    memory = entries;
    if (!store) return;
    try {
      store.setItem(key, JSON.stringify(entries));
    } catch {
      // Переполненное хранилище не должно ронять запись инцидента: лента
      // продолжит жить в памяти до конца сессии.
    }
  }

  function isEntry(e) {
    return !!e && typeof e === "object" && typeof e.kind === "string" && Number.isFinite(e.ts);
  }

  function prune(entries) {
    const edge = now() - ttlMs;
    const fresh = entries.filter((e) => e.ts >= edge);
    return fresh.length > cap ? fresh.slice(fresh.length - cap) : fresh;
  }

  function record(kind, { severity = "info", params = {}, ts = now() } = {}) {
    const normalizedKind = String(kind || "").trim();
    if (!normalizedKind) return null;
    const entry = {
      id: `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ts,
      kind: normalizedKind,
      severity: INCIDENT_SEVERITIES.includes(severity) ? severity : "info",
      params: params && typeof params === "object" ? params : {},
    };
    const entries = prune([...read(), entry]);
    write(entries);
    for (const fn of listeners) {
      try { fn(entry); } catch { /* подписчик не должен ронять запись */ }
    }
    return entry;
  }

  function list() {
    const entries = prune(read());
    write(entries);
    return [...entries].sort((a, b) => a.ts - b.ts);
  }

  function clear() {
    write([]);
    for (const fn of listeners) {
      try { fn(null); } catch { /* см. выше */ }
    }
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { record, list, clear, subscribe };
}

// Группировка записей в инциденты: «что-то сломалось → что делали → чем
// кончилось». Открывает инцидент первое warn/err, закрывает первое ok после
// него либо тишина дольше idleMs. info вне открытого инцидента — отдельная
// однособытийная запись: пользователю важно видеть и «просто переключил
// сервер», иначе лента выглядит пустой в спокойные дни.
export function groupIncidents(entries, { idleMs = IDLE_CLOSE_MS, now = Date.now } = {}) {
  const sorted = [...(entries || [])].filter((e) => e && Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
  const groups = [];
  let open = null;

  const close = (group, endTs, resolved) => {
    group.endTs = endTs;
    group.resolved = resolved;
    group.durationMs = Math.max(0, endTs - group.startTs);
  };

  for (const entry of sorted) {
    if (open && entry.ts - open.lastTs > idleMs) {
      close(open, open.lastTs, false);
      open = null;
    }

    if (isOpener(entry.severity)) {
      if (!open) {
        open = { startTs: entry.ts, lastTs: entry.ts, severity: entry.severity, events: [] };
        groups.push(open);
      }
      // Инцидент наследует худший уровень своих событий: пара warn с одним err
      // внутри — это всё-таки обрыв, а не замедление.
      if (entry.severity === "err") open.severity = "err";
      open.events.push(entry);
      open.lastTs = entry.ts;
      continue;
    }

    if (open) {
      open.events.push(entry);
      open.lastTs = entry.ts;
      if (entry.severity === "ok") {
        close(open, entry.ts, true);
        open = null;
      }
      continue;
    }

    // Событие вне инцидента.
    const solo = { startTs: entry.ts, lastTs: entry.ts, severity: entry.severity, events: [entry] };
    close(solo, entry.ts, entry.severity === "ok");
    groups.push(solo);
  }

  if (open) {
    // Инцидент без развязки: если тишина уже дольше окна — он закрыт по
    // таймауту, иначе идёт прямо сейчас.
    const silent = now() - open.lastTs > idleMs;
    close(open, open.lastTs, false);
    open.ongoing = !silent;
  }

  return groups.reverse(); // свежие сверху — так их и показывает лента
}

// Суммарное время деградации за период (для строки «за неделю связь
// деградировала N минут»). Считаем только закрытые/идущие инциденты уровня
// warn+, одиночные info в счёт не идут.
export function degradedMs(groups, { since = 0 } = {}) {
  return (groups || [])
    .filter((g) => isOpener(g.severity) && g.startTs >= since)
    .reduce((total, g) => total + (g.durationMs || 0), 0);
}

// Общая лента приложения. Тесты создают свою через createIncidentLog.
export const incidentLog = createIncidentLog();
