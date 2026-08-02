// Latest-wins arbitration for reconnect requests. Every caller receives a
// structured result, so replacement/cancellation is never misreported as a
// normal connection failure.
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
      (value) => { next.resolve({ status: "completed", value }); finalize(active); },
      (error) => { next.resolve({ status: "failed", error }); finalize(active); },
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
    else next.resolve({ status: "cancelled" });
  }

  function enqueue(request) {
    const next = entry(request);
    if (inFlight) {
      // Заменённый pending-запрос никогда не будет выполнен и обязан завершить
      // именно свой Promise, а не ждать/наследовать результат текущего запуска.
      pending?.resolve({ status: "superseded" });
      pending = next;
      return next.completion;
    }
    return start(next);
  }

  function cancel() {
    pending?.resolve({ status: "cancelled" });
    pending = null;
  }

  return {
    enqueue,
    cancel,
    isRunning: () => inFlight !== null,
    hasPending: () => pending !== null,
  };
}
