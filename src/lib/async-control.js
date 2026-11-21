// Small coordinators for async operations that must not own the same
// state in parallel.

// Runs task sequentially and guarantees one more pass with fresh
// state if request() was called during a pass already in progress.
export function createLatestRunner(task) {
  let requested = false;
  let inFlight = null;

  function request() {
    requested = true;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      do {
        requested = false;
        await task();
      } while (requested);
    })();
    inFlight = inFlight.finally(() => {
      inFlight = null;
      // Protection against request() being called at the boundary of drain completion.
      // We return a new flight so that a boundary caller doesn't get resolved
      // before the fresh state it requested has been applied.
      if (requested) return request();
    });
    return inFlight;
  }

  return { request, isRunning: () => inFlight !== null };
}

// Merges parallel operations into one flight. An interactive request may
// upgrade an already running background one: task reads the mutable request.interactive after
// its awaits and shows the result as a manual one.
export function createPromotableSingleFlight(task) {
  let active = null;

  function run({ interactive = false } = {}) {
    if (active) {
      if (interactive) active.interactive = true;
      return active.promise;
    }

    const request = { interactive: !!interactive, promise: null };
    active = request;
    request.promise = Promise.resolve()
      .then(() => task(request))
      .finally(() => {
        if (active === request) active = null;
      });
    return request.promise;
  }

  return { run, isRunning: () => active !== null };
}
