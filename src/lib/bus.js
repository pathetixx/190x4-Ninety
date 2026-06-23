// Ninety · крошечная pub/sub-шина (IV.1). Расцепляет кросс-модульные сигналы:
// издатель emit'ит событие, подписчики on() его слушают — без прямого дёрганья
// DOM/состояния друг у друга и без фреймворка. Поверх нативного EventTarget,
// нулевые зависимости. on() возвращает функцию-отписку.
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
