// Small TTL + single-flight cache used by Clash telemetry readers.
// Values are kept in-memory only and invalidated on runtime generation changes.

export function createTelemetryCache({ clock = () => Date.now() } = {}) {
  const values = new Map();
  const inFlight = new Map();

  function now() {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  async function get(key, loader, { ttlMs = 0, force = false } = {}) {
    const normalizedKey = String(key);
    const ttl = Math.max(0, Number(ttlMs) || 0);
    const current = values.get(normalizedKey);
    const at = now();
    if (!force && current && at - current.at <= ttl) return current.value;

    const pending = inFlight.get(normalizedKey);
    if (pending) return pending;

    const task = Promise.resolve()
      .then(loader)
      .then((value) => {
        values.set(normalizedKey, { at: now(), value });
        return value;
      })
      .finally(() => {
        if (inFlight.get(normalizedKey) === task) inFlight.delete(normalizedKey);
      });
    inFlight.set(normalizedKey, task);
    return task;
  }

  function invalidate(prefix = null) {
    if (prefix == null) {
      values.clear();
      return;
    }
    const normalized = String(prefix);
    for (const key of values.keys()) {
      if (key.startsWith(normalized)) values.delete(key);
    }
  }

  function peek(key) {
    return values.get(String(key))?.value;
  }

  function clear() {
    values.clear();
    inFlight.clear();
  }

  return { get, invalidate, peek, clear };
}
