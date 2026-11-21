// Tracks a native start_singbox that has already gone out through IPC. The generation
// gate cancels its result, and the barrier keeps a new start from colliding with
// the Rust `starting` sentinel until the old call has physically finished.
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
