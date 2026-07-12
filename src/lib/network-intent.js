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
