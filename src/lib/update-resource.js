// Tauri updater Update наследует Resource и не имеет GC-finalizer: каждый
// ненужный результат check() нужно закрывать явно и ровно один раз.

const closed = new WeakSet();
const closing = new WeakMap();
// Сильные ссылки на Resource, которые не удалось закрыть, со счётчиком раундов
// уборки. Пока quarantine не очищен, новые updater.check() запрещены — иначе
// Rust resource table росла бы по одному объекту на каждый scheduler retry.
const quarantined = new Map();
const CLOSE_ATTEMPTS = 2;
// Сколько раундов уборки терпим, прежде чем отпустить безнадёжный Resource.
// Типичная причина вечного отказа — rid на Rust-стороне уже освобождён, то есть
// утечки на самом деле нет, а держать из-за неё ВСЮ проверку обновлений
// выключенной до перезапуска приложения — цена несоизмеримо выше.
const QUARANTINE_ROUNDS = 3;

export function snapshotUpdate(update) {
  if (!update) return null;
  return {
    currentVersion: update.currentVersion ?? null,
    version: update.version ?? null,
    date: update.date ?? null,
    body: update.body ?? "",
  };
}

export function closeUpdateResource(update) {
  if ((!update || (typeof update !== "object" && typeof update !== "function"))
    || typeof update.close !== "function" || closed.has(update)) {
    return Promise.resolve(false);
  }
  const current = closing.get(update);
  if (current) return current;

  const operation = (async () => {
    for (let attempt = 1; attempt <= CLOSE_ATTEMPTS; attempt++) {
      try {
        await update.close();
        closed.add(update);
        quarantined.delete(update);
        return true;
      } catch (e) {
        // Короткий bounded retry не даёт transient IPC-ошибке оставить Rust
        // Resource без владельца. После последней ошибки caller не продолжает
        // создавать следующие Update-ресурсы.
        if (attempt === CLOSE_ATTEMPTS) {
          console.warn("update resource cleanup failed", e);
        }
      }
    }
    quarantined.set(update, (quarantined.get(update) ?? 0) + 1);
    return false;
  })()
    .finally(() => {
      closing.delete(update);
    });
  closing.set(update, operation);
  return operation;
}

export async function drainUpdateResourceCleanup() {
  if (quarantined.size === 0) return true;
  await Promise.all([...quarantined.keys()].map((update) => closeUpdateResource(update)));
  for (const [update, rounds] of [...quarantined.entries()]) {
    if (rounds >= QUARANTINE_ROUNDS) quarantined.delete(update);
  }
  return quarantined.size === 0;
}

// Получить Update с клиентом под актуальное состояние маршрута. Если VPN успел
// включиться/выключиться во время check(), устаревший Resource закрывается и
// check повторяется уже с новым proxy (не более трёх попыток).
export async function acquireUpdateForCurrentRoute({
  check,
  getProxy,
  unstableMessage = "Update route did not stabilize",
}) {
  if (!(await drainUpdateResourceCleanup())) {
    throw new Error(unstableMessage);
  }
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const proxy = getProxy();
    const update = await check({ proxy });
    if (getProxy() === proxy) return update;
    if (!(await closeUpdateResource(update))) {
      throw new Error(unstableMessage);
    }
  }
  throw new Error(unstableMessage);
}
