// Generation gate shared by connection preflight and session-scoped effects.
export function createConnectionAttemptGate() {
  let generation = 0;
  return {
    begin() { generation += 1; return generation; },
    cancel() { generation += 1; return generation; },
    isCurrent(token) { return token === generation; },
    current() { return generation; },
  };
}
