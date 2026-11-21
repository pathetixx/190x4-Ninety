// A single arbiter of network intent. An old async completion may finish,
// but has no right to accept the runtime after a new user/auto intent.
export function createNetworkIntentArbiter(initial = "idle") {
  let epoch = 0;
  let desired = initial;
  return {
    begin(next) {
      desired = next;
      return ++epoch;
    },
    isCurrent(token, expected) {
      return token === epoch && desired === expected;
    },
    desired: () => desired,
    epoch: () => epoch,
  };
}

export function repeatedConnectionIntentAction({ internal = false, inFlightKind, state }) {
  if (internal || inFlightKind === "disconnect" || state === "disconnecting") return "join";
  return "cancel-connect";
}
