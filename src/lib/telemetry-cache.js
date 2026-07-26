// Small TTL + single-flight cache used by Clash telemetry readers.
// Values are kept in-memory only and invalidated on runtime generation changes.

export function createTelemetryCache({ clock = () => Date.now() } = {}) {
  const values = new Map();
  const inFlight = new Map();
  const versions = new Map();
  let clearGeneration = 0;

  function now() {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  function versionOf(key) {
    return versions.get(key) || 0;
  }

  async function get(key, loader, { ttlMs = 0, force = false } = {}) {
    const normalizedKey = String(key);
    const ttl = Math.max(0, Number(ttlMs) || 0);
    const current = values.get(normalizedKey);
    const at = now();
    if (!force && current && at - current.at <= ttl) return current.value;

    const pending = inFlight.get(normalizedKey);
    if (pending) return pending.task;

    const generation = clearGeneration;
    const version = versionOf(normalizedKey);

    const task = Promise.resolve()
      .then(loader)
      .then((value) => {
        // An invalidated request may still finish, but its result must not
        // resurrect a snapshot that a runtime transition or mutation made
        // obsolete while the loader was awaiting IPC.
        if (generation === clearGeneration && version === versionOf(normalizedKey)) {
          values.set(normalizedKey, { at: now(), value });
        }
        return value;
      })
      .finally(() => {
        if (inFlight.get(normalizedKey)?.task === task) inFlight.delete(normalizedKey);
      });
    inFlight.set(normalizedKey, { task, generation, version });
    return task;
  }

  function invalidate(prefix = null) {
    if (prefix == null) {
      clear();
      return;
    }
    const normalized = String(prefix);
    const keys = new Set([...values.keys(), ...inFlight.keys()]);
    for (const key of keys) {
      if (key.startsWith(normalized)) {
        values.delete(key);
        versions.set(key, versionOf(key) + 1);
        inFlight.delete(key);
      }
    }
  }

  function peek(key) {
    return values.get(String(key))?.value;
  }

  function clear() {
    values.clear();
    inFlight.clear();
    versions.clear();
    clearGeneration++;
  }

  return { get, invalidate, peek, clear };
}
