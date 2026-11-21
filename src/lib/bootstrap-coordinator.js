// Sequential bootstrap of the network runtime. Reconcile and autoconnect must
// have a single owner: parallel IIFEs at startup raced over state/runtime.
export function createBootstrapCoordinator({ reconcile, autostart, setBusy } = {}) {
  let inFlight = null;

  function run() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      setBusy?.(true);
      try {
        await reconcile?.();
        await autostart?.();
      } finally {
        setBusy?.(false);
      }
    })();
    inFlight = inFlight.finally(() => { inFlight = null; });
    return inFlight;
  }

  return { run, isRunning: () => inFlight !== null };
}
