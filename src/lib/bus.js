// Ninety · a tiny pub/sub bus (IV.1). Decouples cross-module signals:
// the publisher emits an event, subscribers listen with on() — without poking each other's
// DOM/state directly and without a framework. On top of the native EventTarget,
// zero dependencies. on() returns an unsubscribe function.
const target = new EventTarget();

export function on(type, fn) {
  const h = (e) => fn(e.detail);
  target.addEventListener(type, h);
  return () => target.removeEventListener(type, h);
}

export function emit(type, detail) {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

export const bus = { on, emit };
