// Latest-wins arbitration for reconnect requests. A request already running
// cannot be interrupted safely, so a newer request replaces the pending one
// and starts immediately after the current run settles.
export function createLatestWinsReconnectQueue({ run, canRun = () => true } = {}) {
  if (typeof run !== "function") throw new TypeError("reconnect queue requires run");

  let inFlight = null;
  let pending = null;

  function entry(request) {
    let resolve;
    const completion = new Promise((done) => { resolve = done; });
    return { request, completion, resolve };
  }

  function start(next) {
    const execution = Promise.resolve().then(() => run(next.request));
    const active = { entry: next, execution };
    inFlight = active;
    void execution.then(
      (value) => { next.resolve(value); finalize(active); },
      () => { next.resolve(false); finalize(active); },
    );
    return next.completion;
  }

  function finalize(active) {
    if (inFlight !== active) return;
    inFlight = null;
    const next = pending;
    pending = null;
    if (!next) return;
    if (canRun(next.request)) void start(next);
    else next.resolve(false);
  }

  function enqueue(request) {
    const next = entry(request);
    if (inFlight) {
      // Заменённый pending-запрос никогда не будет выполнен и обязан завершить
      // именно свой Promise, а не ждать/наследовать результат текущего запуска.
      pending?.resolve(false);
      pending = next;
      return next.completion;
    }
    return start(next);
  }

  function cancel() {
    pending?.resolve(false);
    pending = null;
  }

  return {
    enqueue,
    cancel,
    isRunning: () => inFlight !== null,
    hasPending: () => pending !== null,
  };
}
