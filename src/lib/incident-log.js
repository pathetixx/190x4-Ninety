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

import { STORAGE_KEYS } from "/lib/storage-policy.js";

const KEY = STORAGE_KEYS.incidents;
const CAP = 200;
const TTL_MS = 14 * 24 * 3600 * 1000;
// Инцидент считается закрытым, если после него не было событий дольше этого
// окна: программа могла починить связь молча (или пользователь сам переключил
// сервер), и вечно открытый инцидент врал бы про «идёт до сих пор».
const IDLE_CLOSE_MS = 10 * 60_000;

// Уровни: err/warn открывают инцидент, ok закрывает его подтверждённым
// восстановлением, end — закрывает без вердикта (сессия кончилась раньше:
// отключение, смена источника, выключенное наблюдение), info — контекст внутри.
export const INCIDENT_SEVERITIES = ["info", "ok", "end", "warn", "err"];

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
// кончилось». Открывает инцидент первое warn/err. Закрыть его может:
//   ok  — восстановление подтверждено замером (outcome "resolved");
//   end — сессия кончилась раньше замера (outcome "ended"): исход неизвестен,
//         но длительность известна — до этого момента связь была плохой;
//   тишина дольше idleMs (outcome "unmeasured") — замеров больше не было, и
//         сколько ещё длилась деградация, приложение не знает.
// info вне открытого инцидента — отдельная однособытийная заметка (outcome
// "note"): пользователю важно видеть и «просто переключил сервер», иначе лента
// выглядит пустой в спокойные дни. end вне инцидента не показываем — обычное
// отключение само по себе не событие связи.
export function groupIncidents(entries, { idleMs = IDLE_CLOSE_MS, now = Date.now } = {}) {
  const sorted = [...(entries || [])].filter((e) => e && Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
  const groups = [];
  let open = null;

  const close = (group, endTs, outcome) => {
    group.endTs = endTs;
    group.outcome = outcome;
    // Прежнее поле остаётся: «восстановлено» — только подтверждённое ok, всё
    // остальное для старых потребителей по-прежнему false.
    group.resolved = outcome === "resolved";
    group.durationMs = Math.max(0, endTs - group.startTs);
  };

  for (const entry of sorted) {
    if (open && entry.ts - open.lastTs > idleMs) {
      close(open, open.lastTs, "unmeasured");
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

    if (entry.severity === "end") {
      // Конец сессии закрывает только уже открытый инцидент. Вне его это
      // рядовое отключение, и заметкой в ленте оно быть не должно.
      if (!open) continue;
      open.events.push(entry);
      open.lastTs = entry.ts;
      close(open, entry.ts, "ended");
      open = null;
      continue;
    }

    if (open) {
      open.events.push(entry);
      open.lastTs = entry.ts;
      if (entry.severity === "ok") {
        close(open, entry.ts, "resolved");
        open = null;
      }
      continue;
    }

    // Событие вне инцидента.
    const solo = { startTs: entry.ts, lastTs: entry.ts, severity: entry.severity, events: [entry] };
    close(solo, entry.ts, entry.severity === "ok" ? "resolved" : "note");
    groups.push(solo);
  }

  if (open) {
    // Инцидент без развязки: если тишина уже дольше окна — он закрыт по
    // таймауту, иначе идёт прямо сейчас.
    const silent = now() - open.lastTs > idleMs;
    close(open, open.lastTs, "unmeasured");
    open.ongoing = !silent;
  }

  return groups.reverse(); // свежие сверху — так их и показывает лента
}

// Суммарное время деградации за период (для строки «за неделю связь
// деградировала N минут»). Считаем только закрытые/идущие инциденты уровня
// warn+, одиночные info в счёт не идут.
//
// Для "resolved" и "ended" это точная длительность, для "unmeasured" — нижняя
// граница: после последнего события измерений не было, и деградация могла идти
// ещё долго. Поэтому сумма — оценка снизу, а сводка обязана говорить «не менее»
// и показывать рядом unmeasuredIncidents(); иначе инцидент из одной записи
// (длительность 0) молча улучшает картину недели.
export function degradedMs(groups, { since = 0 } = {}) {
  return (groups || [])
    .filter((g) => isOpener(g.severity) && g.startTs >= since)
    .reduce((total, g) => total + (g.durationMs || 0), 0);
}

// Сколько инцидентов за период закрылись без исхода — те самые, чьё время
// degradedMs недосчитывает. Идущий прямо сейчас инцидент сюда не попадает: он
// ещё может закончиться замером.
export function unmeasuredIncidents(groups, { since = 0 } = {}) {
  return (groups || []).filter((g) => isOpener(g.severity)
    && g.startTs >= since
    && g.outcome === "unmeasured"
    && !g.ongoing).length;
}

// Общая лента приложения. Тесты создают свою через createIncidentLog.
export const incidentLog = createIncidentLog();
