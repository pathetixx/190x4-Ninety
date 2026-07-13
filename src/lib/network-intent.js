// Единый арбитр сетевого намерения. Старое async-завершение может закончиться,
// но не имеет права принимать runtime после нового user/auto intent.
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
