// The final connect branch is deliberately small and dependency-injected so
// its boolean contract can be exercised without importing the DOM-bound main.
export function completeSuccessfulConnect({ finalizeConnected, onConnected = () => {} } = {}) {
  if (typeof finalizeConnected !== "function") {
    throw new TypeError("successful connect requires finalizeConnected");
  }
  if (finalizeConnected() !== true) return false;
  onConnected();
  return true;
}

export async function runReconnectAttempt(connectNetwork, request) {
  if (typeof connectNetwork !== "function") {
    throw new TypeError("reconnect attempt requires connectNetwork");
  }
  return (await connectNetwork(request)) === true;
}
