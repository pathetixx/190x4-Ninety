// Emits only when the derived payload key changes. Used to avoid repeated DOM
// updates for telemetry snapshots that are byte-for-byte equivalent.

export function createDistinctEmitter(callback, keyOf = (value) => JSON.stringify(value)) {
  let hasValue = false;
  let lastKey;

  function emit(value) {
    if (typeof callback !== "function") return false;
    const key = keyOf(value);
    if (hasValue && Object.is(key, lastKey)) return false;
    hasValue = true;
    lastKey = key;
    callback(value);
    return true;
  }

  emit.reset = () => {
    hasValue = false;
    lastKey = undefined;
  };

  return emit;
}
