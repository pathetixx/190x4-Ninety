// Отслеживает нативный start_singbox, который уже ушёл через IPC. Generation
// gate отменяет его результат, а barrier не даёт новому старту столкнуться с
// Rust sentinel `starting`, пока старый вызов физически не завершился.
export function createCoreStartBarrier() {
  let pending = null;

  function track(promise) {
    const current = Promise.resolve(promise);
    pending = current;
    void current.then(
      () => { if (pending === current) pending = null; },
      () => { if (pending === current) pending = null; },
    );
    return current;
  }

  async function wait() {
    const current = pending;
    if (!current) return false;
    try { await current; } catch {}
    return true;
  }

  return { track, wait, isPending: () => pending !== null };
}
