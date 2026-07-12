// Latest-wins arbitration for reconnect requests. A request already running
// cannot be interrupted safely, so a newer request replaces the pending one
// and starts immediately after the current run settles.
export function createLatestWinsReconnectQueue({ run, canRun = () => true } = {}) {
  if (typeof run !== "function") throw new TypeError("reconnect queue requires run");

  let inFlight = null;
  let pending = null;

  function start(request) {
    const current = Promise.resolve().then(() => run(request));
    inFlight = current;
    void current.then(finalize, finalize);
    return current;
  }

  function finalize() {
    if (!inFlight) return;
    inFlight = null;
    const next = pending;
    pending = null;
    if (next && canRun(next)) void start(next);
  }

  function enqueue(request) {
    if (inFlight) {
      pending = request;
      return inFlight.catch(() => {});
    }
    return start(request);
  }

  function cancel() {
    pending = null;
  }

  return {
    enqueue,
    cancel,
    isRunning: () => inFlight !== null,
    hasPending: () => pending !== null,
  };
}
