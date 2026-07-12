// Последовательный bootstrap сетевого runtime. Reconcile и autoconnect должны
// иметь одного владельца: параллельные IIFE на старте гоняли state/runtime.
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
