const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Clash can accept requests before the complete selector/outbound graph is
// visible through /proxies. A source switch therefore waits for a bounded,
// fresh, generation-scoped topology instead of destroying the target runtime
// after a single transient snapshot.
export async function waitForMatchingSourceTopology({
  read,
  matches,
  isCurrent = () => true,
  attempts = 6,
  retryDelayMs = 120,
  wait = sleep,
} = {}) {
  if (typeof read !== "function" || typeof matches !== "function") {
    throw new TypeError("source topology readiness requires read and matches");
  }

  const maxAttempts = Math.max(1, Number(attempts) || 1);
  let lastTopology = null;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!isCurrent()) return { status: "stale", topology: lastTopology };
    try {
      lastTopology = await read();
      if (!isCurrent()) return { status: "stale", topology: lastTopology };
      if (matches(lastTopology)) {
        return { status: "ready", topology: lastTopology, attempts: attempt + 1 };
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt + 1 < maxAttempts) {
      await wait(retryDelayMs * (attempt + 1));
    }
  }

  return {
    status: "unavailable",
    topology: lastTopology,
    attempts: maxAttempts,
    reason: lastError ? "clash_api_error" : "topology_mismatch",
  };
}
