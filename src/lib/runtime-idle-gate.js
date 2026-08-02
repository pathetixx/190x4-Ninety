// Event/Promise-based handoff point for lifecycle operations that arrive while
// the runtime is disconnecting.  A waiter is resolved only when the backend
// has already published idle, or when its network intent became stale.
export function createRuntimeIdleGate({ getState, isCurrent } = {}) {
  if (typeof getState !== "function" || typeof isCurrent !== "function") {
    throw new TypeError("runtime idle gate requires state and intent readers");
  }

  const waiters = new Set();

  function resultFor(waiter) {
    return getState() === "idle" && isCurrent(waiter.epoch, waiter.desired);
  }

  function notify() {
    const state = getState();
    for (const waiter of [...waiters]) {
      if (state === "disconnecting" && isCurrent(waiter.epoch, waiter.desired)) continue;
      waiters.delete(waiter);
      waiter.resolve(resultFor(waiter));
    }
  }

  function wait(epoch, desired = "connected") {
    const waiter = { epoch, desired, resolve: null };
    if (getState() === "idle" && isCurrent(epoch, desired)) return Promise.resolve(true);
    if (!isCurrent(epoch, desired)) return Promise.resolve(false);
    const promise = new Promise((resolve) => { waiter.resolve = resolve; });
    waiters.add(waiter);
    return promise;
  }

  function cancel() {
    for (const waiter of waiters) waiter.resolve(false);
    waiters.clear();
  }

  return {
    wait,
    notify,
    cancel,
    pending: () => waiters.size,
  };
}
