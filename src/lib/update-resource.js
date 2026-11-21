// Tauri updater Update inherits Resource and has no GC finalizer: every
// unneeded check() result must be closed explicitly and exactly once.

const closed = new WeakSet();
const closing = new WeakMap();
// Strong references to Resources that couldn't be closed, with a counter of cleanup
// rounds. Until the quarantine is cleared, new updater.check() calls are forbidden — otherwise
// the Rust resource table would grow by one object on every scheduler retry.
const quarantined = new Map();
const CLOSE_ATTEMPTS = 2;
// How many cleanup rounds we tolerate before letting go of a hopeless Resource.
// The typical cause of a permanent refusal is that the rid on the Rust side is already released, i.e.
// there's actually no leak, and keeping the WHOLE update check
// disabled until the app restarts because of it costs incomparably more.
const QUARANTINE_ROUNDS = 3;

export function snapshotUpdate(update) {
  if (!update) return null;
  return {
    currentVersion: update.currentVersion ?? null,
    version: update.version ?? null,
    date: update.date ?? null,
    body: update.body ?? "",
  };
}

export function closeUpdateResource(update) {
  if ((!update || (typeof update !== "object" && typeof update !== "function"))
    || typeof update.close !== "function" || closed.has(update)) {
    return Promise.resolve(false);
  }
  const current = closing.get(update);
  if (current) return current;

  const operation = (async () => {
    for (let attempt = 1; attempt <= CLOSE_ATTEMPTS; attempt++) {
      try {
        await update.close();
        closed.add(update);
        quarantined.delete(update);
        return true;
      } catch (e) {
        // A short bounded retry keeps a transient IPC error from leaving the Rust
        // Resource without an owner. After the last error the caller doesn't continue
        // creating further Update resources.
        if (attempt === CLOSE_ATTEMPTS) {
          console.warn("update resource cleanup failed", e);
        }
      }
    }
    quarantined.set(update, (quarantined.get(update) ?? 0) + 1);
    return false;
  })()
    .finally(() => {
      closing.delete(update);
    });
  closing.set(update, operation);
  return operation;
}

export async function drainUpdateResourceCleanup() {
  if (quarantined.size === 0) return true;
  await Promise.all([...quarantined.keys()].map((update) => closeUpdateResource(update)));
  for (const [update, rounds] of [...quarantined.entries()]) {
    if (rounds >= QUARANTINE_ROUNDS) quarantined.delete(update);
  }
  return quarantined.size === 0;
}

// Get an Update with a client for the current route state. If the VPN managed
// to turn on/off during check(), the stale Resource is closed and
// check is repeated with the new proxy (at most three attempts).
export async function acquireUpdateForCurrentRoute({
  check,
  getProxy,
  unstableMessage = "Update route did not stabilize",
}) {
  if (!(await drainUpdateResourceCleanup())) {
    throw new Error(unstableMessage);
  }
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const proxy = getProxy();
    const update = await check({ proxy });
    if (getProxy() === proxy) return update;
    // The route changed while the check was running — the result belongs to the previous
    // route, so we try again. There's nothing to close if
    // there's no update: `check` returned null, and closeUpdateResource honestly answers
    // "nothing to close" (false). Previously this answer counted as a close failure, and
    // a calm "no updates" turned into "couldn't check".
    if (update && !(await closeUpdateResource(update))) {
      throw new Error(unstableMessage);
    }
  }
  throw new Error(unstableMessage);
}
